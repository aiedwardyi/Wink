// UI-only lines for a spent or missing root budget. No tool.ok, so model
// context never replays them (context-compaction admits activity by ok).

import { rootThreadOf } from "./comms-root.ts";
import type { Message, Store } from "./store.ts";

export type CommsNotice = "paused" | "unavailable";
export type NoticeStore = Pick<Store, "appendMessage" | "activePath">;

const NAMES: Record<CommsNotice, string> = {
  paused: "Bot messaging limit reached. Send a message to reset it.",
  unavailable: "Bot messaging paused. Send a message to reset it.",
};

const isHuman = (row: Message) => row.role === "user" && row.kind === "text" && !row.from;

/** Once per request and thread, read from the rows themselves, so nothing is kept per root. */
export function postCommsNotice(store: NoticeStore, notice: CommsNotice, dedupeKey: string, threadIds: string[]): void {
  // a pair channel never holds the human's message: the request began at the last one where its root lives
  const home = rootThreadOf(dedupeKey);
  const asked = (home && store.activePath(home).findLast(isHuman)?.at) || 0;
  for (const threadId of new Set(threadIds)) {
    const since = store.activePath(threadId);
    const human = since.findLastIndex(isHuman);
    if (since.slice(human + 1).some((row) => row.at >= asked && row.kind === "activity" && row.tool?.name === NAMES[notice])) continue;
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: NAMES[notice] } });
  }
}

export function refusalText(reason: "exhausted" | "reserved" | "missing"): string {
  if (reason === "exhausted") return "This request reached its 24 bot turn limit. Finish with what you have; the user can send a message to continue.";
  if (reason === "reserved") return "This request's remaining bot turns are reserved. Collect pending replies before asking again.";
  return "This request's bot turn budget is no longer available. Finish with what you have; the user can send a message to continue.";
}

/** The refused start's lines: where the human typed (else the caller's own thread) and the pair channel. */
export function postRefusalNotice(
  store: NoticeStore,
  reason: "exhausted" | "reserved" | "missing",
  rootId: string | null | undefined,
  fallbackKey: string,
  ownThreadId: string,
  channelThreadId?: string,
): void {
  if (reason === "reserved") return;
  const home = (rootId && rootThreadOf(rootId)) || ownThreadId;
  postCommsNotice(store, reason === "exhausted" ? "paused" : "unavailable", rootId || fallbackKey, channelThreadId ? [home, channelThreadId] : [home]);
}
