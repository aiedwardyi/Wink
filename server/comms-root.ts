import { randomUUID } from "node:crypto";
import { turnRegistry } from "./turn-registry.ts";

export type RootStart =
  | { kind: "human"; messageKey: string }
  | { kind: "inherit"; rootId: string | null | undefined }
  | { kind: "automatic" };

export interface CallerSnapshot {
  botId: string;
  threadId: string;
  turnId: string;
  rootId: string | null;
  depth: number;
}

export const ROOT_TURNS = 24;
export type StartKind = "ask" | "delegation" | "rerun" | "wake" | "room";
export interface Reservation { readonly id: string; readonly rootId: string; readonly kind: StartKind }
export type ReserveResult =
  | { ok: true; reservation: Reservation }
  | { ok: false; reason: "exhausted" | "reserved" | "missing" };

const MAX_IDLE = 48 * 60 * 60 * 1000;
const roots = new Map<string, number>();
const messages = new Map<string, string>();
const threads = new Map<string, string | null>();
const homes = new Map<string, string>();
const budgets = new Map<string, { committed: number; pending: Set<string> }>();

function liveRoot(rootId: string | null | undefined): string | null {
  if (!rootId) return null;
  const touched = roots.get(rootId);
  if (touched === undefined) return null;
  const now = Date.now();
  if (now - touched >= MAX_IDLE) {
    roots.delete(rootId);
    return null;
  }
  roots.set(rootId, now);
  return rootId;
}

export function rootForStart(threadId: string, start: RootStart): string | null {
  let rootId: string | null;
  if (start.kind === "human") {
    const now = Date.now();
    for (const [id, touched] of roots) {
      if (now - touched < MAX_IDLE) continue;
      roots.delete(id);
      homes.delete(id);
      budgets.delete(id);
    }
    for (const [key, id] of messages) if (!roots.has(id)) messages.delete(key);
    for (const [thread, id] of threads) if (!id || !roots.has(id)) threads.delete(thread);
    rootId = messages.get(start.messageKey) ?? randomUUID();
    messages.set(start.messageKey, rootId);
    roots.set(rootId, now);
    if (!homes.has(rootId)) homes.set(rootId, threadId);
  } else {
    rootId = liveRoot(start.kind === "inherit" ? start.rootId : threads.get(threadId));
  }
  threads.set(threadId, rootId);
  return rootId;
}

export function adoptHumanRoot(threadId: string, messageKey: string): string {
  const rootId = rootForStart(threadId, { kind: "human", messageKey })!;
  turnRegistry.adoptRoot(threadId, rootId, messageKey);
  return rootId;
}

export function callerSnapshot(botId: string, threadId: string): CallerSnapshot | null {
  const turn = turnRegistry.current(threadId);
  if (!turn || turn.botId !== botId) return null;
  return { botId, threadId, turnId: turn.turnId, rootId: liveRoot(turn.rootId), depth: turn.depth };
}

export function reserve(rootId: string | null | undefined, kind: StartKind): ReserveResult {
  const live = liveRoot(rootId);
  if (!live) return { ok: false, reason: "missing" };
  const budget = budgets.get(live) ?? { committed: 0, pending: new Set<string>() };
  budgets.set(live, budget);
  if (budget.committed >= ROOT_TURNS) return { ok: false, reason: "exhausted" };
  if (budget.committed + budget.pending.size >= ROOT_TURNS) return { ok: false, reason: "reserved" };
  const reservation: Reservation = { id: randomUUID(), rootId: live, kind };
  budget.pending.add(reservation.id);
  return { ok: true, reservation };
}

// Both are no-ops once the reservation left pending: one terminal outcome each.
export function commit(reservation: Reservation): void {
  const budget = budgets.get(reservation.rootId);
  if (budget?.pending.delete(reservation.id)) budget.committed++;
}

export function release(reservation: Reservation): void {
  budgets.get(reservation.rootId)?.pending.delete(reservation.id);
}

export function rootThreadOf(rootId: string): string | null {
  return homes.get(rootId) ?? null;
}

export function _resetCommsRoots(): void {
  roots.clear();
  messages.clear();
  threads.clear();
  homes.clear();
  budgets.clear();
}
