// A turn that called no_reply_needed ends silent. Text the model still writes
// after it is a slip, unless the user wrote to that turn and must get a reply.
import type { RuntimeEvent } from "./contracts.ts";
import type { Message } from "./store.ts";

// Claude names it mcp__agents__no_reply_needed, Codex bare; a shell command quoting it must not match.
export const QUIET_TOOL = /^(?:(?:mcp[_./:]+)?agents[_./:]+)?no_reply_needed$/;

const typed = (m: Message) => m.role === "user" && m.kind === "text" && !m.from?.botId;

/** Started by, or joined by, a message the user typed. Notes can land between a send and its start, so they are skipped. */
export function userInTurn(messages: readonly Message[], startedAt: number): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.at >= startedAt) {
      if (typed(m)) return true;
    } else if (m.role === "user" || m.kind === "text") return typed(m);
  }
  return false;
}

export function createQuietTurns(messages: (threadId: string) => readonly Message[]) {
  const started = new Map<string, { turnId?: string; at: number }>();
  const quiet = new Map<string, { turnId?: string; startedAt: number }>();
  /** True when the event is text the user must not see. */
  return (event: RuntimeEvent): boolean => {
    const { threadId, turnId } = event;
    if (event.type === "turn.started") {
      started.set(threadId, { turnId, at: Date.now() });
      quiet.delete(threadId);
      return false;
    }
    if (event.type === "turn.completed") {
      if (started.get(threadId)?.turnId === turnId) started.delete(threadId);
      if (quiet.get(threadId)?.turnId === turnId) quiet.delete(threadId);
      return false;
    }
    if (event.type === "item.started" && event.itemType === "tool" && QUIET_TOOL.test(event.title ?? "")) {
      const start = started.get(threadId);
      quiet.set(threadId, { turnId, startedAt: start && start.turnId === turnId ? start.at : 0 });
      return false;
    }
    const text = (event.type === "content.delta" && event.streamKind === "assistant_text") || (event.type === "item.completed" && event.itemType === "assistant_text");
    const turn = quiet.get(threadId);
    return text && turn !== undefined && turn.turnId === turnId && !userInTurn(messages(threadId), turn.startedAt);
  };
}
