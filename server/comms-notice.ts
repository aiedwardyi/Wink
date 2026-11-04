// UI-only lines for a spent or missing root budget. No tool.ok, so model
// context never replays them (context-compaction admits activity by ok).

import { rootThreadOf } from "./comms-root.ts";
import type { Store } from "./store.ts";

export type CommsNotice = "paused" | "unavailable";
export type NoticeStore = Pick<Store, "appendMessage" | "activePath">;

const NAMES: Record<CommsNotice, string> = {
  paused: "Bots paused: this request reached its 24 bot turn limit. Send a message to keep them going.",
  unavailable: "Bots paused: send a message to keep them going.",
};

const posted = new Set<string>();

export function postCommsNotice(store: NoticeStore, notice: CommsNotice, dedupeKey: string, threadIds: string[]): void {
  for (const threadId of new Set(threadIds)) {
    const key = `${dedupeKey}\0${threadId}`;
    if (posted.has(key)) continue;
    posted.add(key);
    // after a restart the set is empty; the row since the user's last message still counts
    const since = store.activePath(threadId);
    const human = since.findLastIndex((row) => row.role === "user" && row.kind === "text" && !row.from);
    if (since.slice(human + 1).some((row) => row.kind === "activity" && row.tool?.name === NAMES[notice])) continue;
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
