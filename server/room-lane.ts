// A bot busy elsewhere answers a room on its second lane. The lane keeps its
// own claim, account hold and Stop epoch under laneKey, and never touches the
// bot's busy flag, so the 1:1's bookkeeping cannot see it.
import type { Message } from "./store.ts";

/** Room lanes running at once across all bots: each is one more CLI process. */
export const MAX_ROOM_LANES = 2;

export const laneKey = (botId: string) => `${botId}\0room`;

export function createRoomLanes(max = MAX_ROOM_LANES) {
  // an entry lives from claim until its turn is released and settled, so a later ordinary turn in that room is never read as a lane turn
  const lanes = new Map<string, { threadId: string; running: boolean; ending: boolean; settled: boolean }>();
  const full = () => lanes.size >= max;
  return {
    /** The room thread this bot's lane is working on, if any. */
    thread: (botId: string) => lanes.get(botId)?.threadId,
    free: (botId: string) => !lanes.has(botId) && !full(),
    claim(botId: string, threadId: string): boolean {
      if (lanes.has(botId) || full()) return false;
      lanes.set(botId, { threadId, running: true, ending: false, settled: false });
      return true;
    },
    /** ending: a stopped turn whose terminal event is still to come. */
    release(botId: string, threadId: string, ending = false) {
      const lane = lanes.get(botId);
      if (lane?.threadId !== threadId) return;
      if ((lane.ending || ending) && !lane.settled) Object.assign(lane, { running: false, ending: true });
      else lanes.delete(botId);
    },
    /** The thread's terminal event has been handled. */
    settle(threadId: string) {
      for (const [botId, lane] of lanes) {
        if (lane.threadId !== threadId) continue;
        if (lane.running) lane.settled = true;
        else lanes.delete(botId);
      }
    },
  };
}

/** A lane cannot edit, so a full room turn follows once the bot is free. */
export const LANE_HANDOFF_LINE = " Edits or new work asked here start once you're free; confirm plainly, like 'On it.', and never mention this limit.";

const ASK_CHARS = 600;
const said = (message: Message) => message.kind === "text" && !message.summarized && Boolean(message.text?.trim());

/** The person's ask a lane turn answers, when a full turn must do its work; a teammate's runs only under the host's Auto setting, as on any room turn. */
export function laneHandoff(turn: { lane: boolean; hop: number; teammate: boolean; autoApprove?: boolean; rows: readonly Message[]; botId: string; owner: string; instructionId?: string }): { asker: string; ask: string } | null {
  if (!turn.lane || turn.hop || (turn.teammate && !turn.autoApprove)) return null;
  const own = (message: Message) => message.role === "bot" && message.from?.botId === turn.botId;
  const asked = turn.rows.find((message) => message.id === turn.instructionId && said(message)) ?? turn.rows.findLast((message) => said(message) && !own(message));
  if (asked?.role !== "user") return null;
  return { asker: asked.author?.name ?? turn.owner, ask: asked.text!.trim().slice(0, ASK_CHARS) };
}

export const laneHandoffNote = (room: string, asker: string, ask: string) =>
  `[Wink note, automated: ${asker} asked you in ${JSON.stringify(room)}: ${JSON.stringify(ask)}. You answered while busy; now you can edit and run things. Do any edits or new work it asked for, then report here. If it needed nothing more, end with no text (call no_reply_needed first if you have it).]`;
