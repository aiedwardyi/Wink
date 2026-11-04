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

const MAX_IDLE = 48 * 60 * 60 * 1000;
const roots = new Map<string, number>();
const messages = new Map<string, string>();
const threads = new Map<string, string | null>();

function liveRoot(rootId: string | null | undefined): string | null {
  if (!rootId || !roots.has(rootId)) return null;
  roots.set(rootId, Date.now());
  return rootId;
}

export function rootForStart(threadId: string, start: RootStart): string | null {
  let rootId: string | null;
  if (start.kind === "human") {
    const now = Date.now();
    for (const [id, touched] of roots) if (now - touched >= MAX_IDLE) roots.delete(id);
    for (const [key, id] of messages) if (!roots.has(id)) messages.delete(key);
    for (const [thread, id] of threads) if (!id || !roots.has(id)) threads.delete(thread);
    rootId = messages.get(start.messageKey) ?? randomUUID();
    messages.set(start.messageKey, rootId);
    roots.set(rootId, now);
  } else {
    rootId = liveRoot(start.kind === "inherit" ? start.rootId : threads.get(threadId));
  }
  threads.set(threadId, rootId);
  return rootId;
}

export function adoptHumanRoot(threadId: string, messageKey: string): string {
  const rootId = rootForStart(threadId, { kind: "human", messageKey })!;
  turnRegistry.adoptRoot(threadId, rootId);
  return rootId;
}

export function callerSnapshot(botId: string, threadId: string): CallerSnapshot | null {
  const turn = turnRegistry.current(threadId);
  if (!turn || turn.botId !== botId) return null;
  return { botId, threadId, turnId: turn.turnId, rootId: liveRoot(turn.rootId), depth: turn.depth };
}

export function _resetCommsRoots(): void {
  roots.clear();
  messages.clear();
  threads.clear();
}
