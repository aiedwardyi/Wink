import { randomUUID } from "node:crypto";
import { findDelegationReceipt } from "./delegation-ledger.ts";
import type { Message, Store } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";

export type RootStart =
  | { kind: "human"; messageKey: string }
  // someone other than the owner typed it: a chain, but not one the owner started
  | { kind: "guest"; messageKey: string }
  | { kind: "inherit"; rootId: string | null | undefined }
  | { kind: "automatic" };

export interface CallerSnapshot {
  botId: string;
  threadId: string;
  turnId: string;
  rootId: string | null;
  depth: number;
}

/** A live root an owner-typed line minted, or a stored room ask the owner wrote, carried with the work: the only key to a peer turn's opened tools. */
export type OwnerOrigin = string & { readonly __ownerOrigin: true };

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
const owned = new Set<string>();
// handles that spend their root's budget but never carry its owner origin
const shadows = new Map<string, string>();
const budgetRoot = (rootId: string) => shadows.get(rootId) ?? rootId;

function shadow(rootId: string | null): string | null {
  if (!rootId || shadows.has(rootId)) return rootId;
  const id = randomUUID();
  shadows.set(id, rootId);
  return id;
}

function liveRoot(rootId: string | null | undefined): string | null {
  if (!rootId) return null;
  const base = budgetRoot(rootId);
  const touched = roots.get(base);
  if (touched === undefined) return null;
  const now = Date.now();
  if (now - touched >= MAX_IDLE) {
    roots.delete(base);
    owned.delete(base);
    return null;
  }
  roots.set(base, now);
  return rootId;
}

export function rootForStart(threadId: string, start: RootStart): string | null {
  let rootId: string | null;
  if (start.kind === "human" || start.kind === "guest") {
    const now = Date.now();
    for (const [id, touched] of roots) {
      if (now - touched < MAX_IDLE) continue;
      roots.delete(id);
      homes.delete(id);
      budgets.delete(id);
      owned.delete(id);
    }
    for (const [id, base] of shadows) if (!roots.has(base)) shadows.delete(id);
    for (const [key, id] of messages) if (!roots.has(id)) messages.delete(key);
    for (const [thread, id] of threads) if (!id || !roots.has(budgetRoot(id))) threads.delete(thread);
    rootId = messages.get(start.messageKey) ?? randomUUID();
    messages.set(start.messageKey, rootId);
    roots.set(rootId, now);
    if (start.kind === "human") owned.add(rootId);
    else owned.delete(rootId);
    if (!homes.has(rootId)) homes.set(rootId, threadId);
  } else if (start.kind === "inherit") {
    rootId = liveRoot(start.rootId);
  } else {
    // the harness's own starts read the thread for budget alone
    rootId = shadow(liveRoot(threads.get(threadId)));
  }
  threads.set(threadId, rootId);
  return rootId;
}

export function adoptHumanRoot(threadId: string, messageKey: string, current = turnRegistry.rootOf(threadId)): string {
  // an owner line folded into a turn someone else started never upgrades it
  const live = liveRoot(current);
  if (live && !owned.has(budgetRoot(live))) return live;
  const human = rootForStart(threadId, { kind: "human", messageKey })!;
  // nor one the harness started or whose root expired: the budget resets, the origin stays shut
  const rootId = live && owned.has(live) ? human : shadow(human)!;
  turnRegistry.adoptRoot(threadId, rootId);
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
  const budget = budgets.get(budgetRoot(live)) ?? { committed: 0, pending: new Set<string>() };
  budgets.set(budgetRoot(live), budget);
  if (budget.committed >= ROOT_TURNS) return { ok: false, reason: "exhausted" };
  if (budget.committed + budget.pending.size >= ROOT_TURNS) return { ok: false, reason: "reserved" };
  const reservation: Reservation = { id: randomUUID(), rootId: live, kind };
  budget.pending.add(reservation.id);
  return { ok: true, reservation };
}

// Both are no-ops once the reservation left pending: one terminal outcome each.
export function commit(reservation: Reservation): void {
  const budget = budgets.get(budgetRoot(reservation.rootId));
  if (budget?.pending.delete(reservation.id)) budget.committed++;
}

export function release(reservation: Reservation): void {
  budgets.get(budgetRoot(reservation.rootId))?.pending.delete(reservation.id);
}

export function ownerOrigin(rootId: string | null | undefined): OwnerOrigin | null {
  const live = liveRoot(rootId);
  // SAFETY: owned holds only live roots an owner-typed line minted.
  return live && owned.has(live) ? (live as OwnerOrigin) : null;
}

export function ownerRoot(rootId: string | null | undefined): boolean {
  return ownerOrigin(rootId) !== null;
}

/** Someone else's text in a turn's prompt ends the owner origin of the request it carries. */
export function othersInPrompt(store: Pick<Store, "group" | "row">, threadId: string, rootId: string | null | undefined, ids: readonly string[], rows: readonly Message[] = [], hostSeats: readonly string[] = []): boolean {
  const foreign = [...ids.flatMap((id) => store.row(threadId, id) ?? []), ...rows].some((row) => {
    if (row.reportIds || row.snagIds) return true;
    if (row.roomEcho) {
      const group = store.group(row.roomEcho.groupId);
      return !group || Boolean(group.hosted);
    }
    if (row.comm?.peer === "reply") return !ownerRoot(row.comm.taskId ? findDelegationReceipt(row.comm.taskId)?.root : null);
    const author = row.author;
    return author?.kind === "person" ? !hostSeats.includes(author.id) : author?.kind === "bot" && author.owner !== undefined && !hostSeats.includes(author.owner);
  });
  if (foreign && rootId) owned.delete(rootId);
  return foreign;
}

export function rootThreadOf(rootId: string): string | null {
  return homes.get(budgetRoot(rootId)) ?? null;
}

export function _resetCommsRoots(): void {
  roots.clear();
  messages.clear();
  threads.clear();
  homes.clear();
  budgets.clear();
  owned.clear();
  shadows.clear();
}
