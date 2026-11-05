// A handoff's reply is its whole turn's text, by ask_bot's rules (turn-reply.ts).
// Collection starts before dispatch, so an ask adopted at its time limit keeps
// what it wrote before; engine summaries are not the bot's words and stay out.
import type { RuntimeEvent } from "./contracts.ts";
import { ownTurnReply } from "./turn-reply.ts";

export interface PeerTurnReply {
  /** The turn's text so far; undefined until it wrote some. */
  text(): string | undefined;
  /** Stops collecting; the text stays readable. */
  release(): void;
}

export function peerTurnReplies(stale: (threadId: string, turnId: string | undefined) => boolean) {
  const live = new Map<string, Set<(event: RuntimeEvent) => void>>();
  return {
    /** Collects the next turn on `threadId`. A competing ask that never starts leaves another collection there intact. */
    start(threadId: string): PeerTurnReply {
      const reply = ownTurnReply(stale);
      let text: string | undefined;
      let done = false;
      const release = () => {
        const observers = live.get(threadId);
        if (observers?.delete(observe) && !observers.size) live.delete(threadId);
      };
      const observe = (event: RuntimeEvent) => {
        if (done || (event.type === "item.completed" && event.itemType === "assistant_text" && event.summarized)) return;
        const step = reply.fold(event);
        if (step === "completed") {
          done = true;
          release();
        } else if (step) text = step.replace || text === undefined ? step.text : `${text}\n${step.text}`;
      };
      live.set(threadId, (live.get(threadId) ?? new Set()).add(observe));
      return { text: () => text, release };
    },
    observe(event: RuntimeEvent): void {
      for (const observe of live.get(event.threadId) ?? []) observe(event);
    },
    _live: () => [...live.values()].reduce((count, observers) => count + observers.size, 0),
  };
}
