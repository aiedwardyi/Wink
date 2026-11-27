// Local files outside a bot's folders: only the owner's own typed 1:1 turn, decided from what the server dispatched, never from the request.
import type { FileScope } from "./attachments.ts";
import type { LiveTurn } from "./turn-registry.ts";

export type OwnerTurnFacts = {
  current: (threadId: string) => LiveTurn | undefined;
  /** the bot's own task threads with its owner: no routine runs or joined rooms' tasks */
  ownerChats: (botId: string) => readonly string[];
  /** a hosted room, a joined room, or a guest's or teammate's turn */
  roomTurn: (botId: string, threadId: string) => boolean;
};

// a token outlives its turn and a peer ask runs in the owner's 1:1, so the thread alone proves nothing
export function ownerOwnTurn(facts: OwnerTurnFacts, botId: string, threadId: string): boolean {
  const turn = facts.current(threadId);
  return turn?.botId === botId && turn.owner === "user" && turn.depth === 0 && turn.typed === true
    && !facts.roomTurn(botId, threadId) && facts.ownerChats(botId).includes(threadId);
}

/** The only place a scope opens past the given folders. */
export function fileScope(ownerTurn: boolean, roots: readonly string[]): FileScope {
  return ownerTurn ? { kind: "any" } : { kind: "roots", roots };
}
