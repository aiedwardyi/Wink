// A bot busy elsewhere answers a room on its second lane. The lane keeps its
// own claim, account hold and Stop epoch under laneKey, and never touches the
// bot's busy flag, so the 1:1's bookkeeping cannot see it.

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
