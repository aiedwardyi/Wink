// The CLI hands no_reply_needed's "ok" back and the model keeps calling it, so
// Wink ends the turn at the first result, unless the user wrote to that turn.
import type { ProviderAdapter, RuntimeEvent } from "./contracts.ts";
import { QUIET_TOOL, userInTurn } from "./quiet-turn.ts";
import type { Message } from "./store.ts";

export function createQuietEnd(
  messages: (threadId: string) => readonly Message[],
  adapter: (event: RuntimeEvent) => Pick<ProviderAdapter, "endTurn"> | undefined,
) {
  const started = new Map<string, { turnId?: string; at: number }>();
  const calls = new Set<string>();
  return (event: RuntimeEvent): void => {
    const { threadId, turnId } = event;
    if (event.type === "turn.started") started.set(threadId, { turnId, at: Date.now() });
    else if (event.type === "turn.completed") {
      if (started.get(threadId)?.turnId === turnId) started.delete(threadId);
      for (const key of calls) if (key.startsWith(`${turnId} `)) calls.delete(key);
    } else if (event.type === "item.started" && event.itemType === "tool" && turnId && QUIET_TOOL.test(event.title ?? "")) {
      calls.add(`${turnId} ${event.itemId}`);
    } else if (event.type === "item.completed" && event.itemType === "tool" && turnId && calls.delete(`${turnId} ${event.itemId}`)) {
      const start = started.get(threadId);
      if (userInTurn(messages(threadId), start?.turnId === turnId ? start.at : 0)) return;
      void adapter(event)?.endTurn?.(threadId, turnId).catch(() => {});
    }
  };
}
