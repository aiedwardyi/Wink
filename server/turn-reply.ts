// A collector waiting on one turn's reply. Bus subscribers each see every
// event, so the persistence guard dropping a stopped turn's late text does
// not stop it reaching a collector; each collector applies the same rule.
import type { RuntimeEvent } from "./contracts.ts";
import { ENGINE_SUMMARY_PREFIX } from "./replies.ts";
import type { Message } from "./store.ts";

export type TurnReplyStep = { text: string; replace?: boolean } | "completed" | null;
type Phase = Extract<RuntimeEvent, { itemType: "assistant_text" }>["phase"];

export function ownTurnReply(stale: (threadId: string, turnId: string | undefined) => boolean) {
  let own: string | undefined;
  let final = false;
  const retained: string[] = [];
  // a failed start completes before dispatch returns the id to claim
  const ended = new Set<string>();
  return {
    claim(turnId: string | undefined) {
      own ??= turnId;
      return Boolean(turnId && turnId === own && ended.has(turnId));
    },
    fold(e: RuntimeEvent): TurnReplyStep {
      // the fold settles its own turn before collectors run, so completion
      // is matched by id, never by the stale rule
      if (e.type === "turn.completed") {
        if (!e.turnId || e.turnId === own) return "completed";
        ended.add(e.turnId);
        return null;
      }
      if (stale(e.threadId, e.turnId)) return null;
      if (e.type === "turn.started") own ??= e.turnId;
      if (e.type !== "item.completed" || e.itemType !== "assistant_text") return null;
      own ??= e.turnId;
      if (e.turnId && e.turnId !== own) return null;
      if (e.phase === "commentary" && final) return null;
      const text = e.summarized ? `${ENGINE_SUMMARY_PREFIX}${e.text}` : e.text;
      if (e.phase !== "commentary") retained.push(text);
      if (e.phase !== "final_answer" || final) return { text };
      final = true;
      return { text: retained.join("\n"), replace: true };
    },
  };
}

/** Per thread, the turn's engine summaries. A turn that wrote no other text
 * shows them at its end, or it would look empty; one with a final answer
 * hides its commentary. */
export function turnSummaries(hide?: (threadId: string, ids: string[]) => void) {
  const turns = new Map<string, { turnId?: string; ids: string[]; replied: boolean; commentary: string[]; final: boolean }>();
  return {
    note(threadId: string, turnId: string | undefined, messageId: string, summarized: boolean, phase?: Phase) {
      let turn = turns.get(threadId);
      if (!turn || (turn.turnId && turnId && turn.turnId !== turnId)) turns.set(threadId, (turn = { turnId, ids: [], replied: false, commentary: [], final: false }));
      turn.turnId ??= turnId;
      if (summarized) turn.ids.push(messageId);
      else turn.replied = true;
      if (phase === "commentary") turn.commentary.push(messageId);
      else if (phase === "final_answer") turn.final = true;
    },
    settle(threadId: string, turnId: string | undefined, quiet = false): string[] {
      const turn = turns.get(threadId);
      if (!turn || (turn.turnId && turnId && turn.turnId !== turnId)) return [];
      turns.delete(threadId);
      if (turn.final && turn.commentary.length) hide?.(threadId, turn.commentary);
      return turn.replied || quiet ? [] : turn.ids;
    },
  };
}

export function turnAddedMessage(messages: readonly Message[], start: number): boolean {
  return messages.slice(start).some((message) => {
    if (message.role !== "bot" || message.summarized || message.kind === "compaction" || message.quick) return false;
    if (message.kind === "activity") {
      return Boolean(message.comm || message.tool?.ok === false || message.tool?.name.startsWith("error:") || message.tool?.name === "memory.save");
    }
    if (message.kind === "text") return Boolean(message.text?.trim());
    if (message.kind === "options") return Boolean(message.card);
    if (message.kind === "connector") return Boolean(message.connector);
    if (message.kind === "secret") return Boolean(message.secret);
    if (message.kind === "screen") return Boolean(message.image || message.png || message.hasImage);
    return true;
  });
}

export function turnUnread() {
  const turns = new Map<string, { turnId?: string; start: number }>();
  return {
    start(threadId: string, turnId: string | undefined, messages: readonly Message[]) {
      const turn = turns.get(threadId);
      if (turn && turn.turnId === turnId) return;
      turns.set(threadId, { turnId, start: messages.length });
    },
    settle(threadId: string, turnId: string | undefined, messages: readonly Message[]): boolean {
      const turn = turns.get(threadId);
      if (!turn || (turn.turnId && turnId && turn.turnId !== turnId)) return false;
      turns.delete(threadId);
      return turnAddedMessage(messages, turn.start);
    },
    forget(threadId: string) {
      turns.delete(threadId);
    },
  };
}
