// A bot busy elsewhere answers a room on its second lane. The lane keeps its
// own claim, account hold and Stop epoch under laneKey, and never touches the
// bot's busy flag, so the 1:1's bookkeeping cannot see it.

/** Room lanes running at once across all bots: each is one more CLI process. */
export const MAX_ROOM_LANES = 2;

export const laneKey = (botId: string) => `${botId}\0room`;

export function createRoomLanes(threadLive: (threadId: string) => boolean, max = MAX_ROOM_LANES) {
  const lanes = new Map<string, { threadId: string; running: boolean; ending: boolean }>();
  // held until the driver lets go too: a timed-out turn still owns its thread
  const busy = (botId: string) => {
    const lane = lanes.get(botId);
    if (!lane) return false;
    if (lane.running || lane.ending || threadLive(lane.threadId)) return true;
    lanes.delete(botId);
    return false;
  };
  const full = () => [...lanes.keys()].filter(busy).length >= max;
  return {
    /** The room thread this bot's lane is working on, if any. */
    thread: (botId: string) => (busy(botId) ? lanes.get(botId)!.threadId : undefined),
    free: (botId: string) => !busy(botId) && !full(),
    claim(botId: string, threadId: string): boolean {
      if (busy(botId) || full()) return false;
      lanes.set(botId, { threadId, running: true, ending: false });
      return true;
    },
    /** ending: a stopped turn whose terminal event is still to come. */
    release(botId: string, threadId: string, ending = false) {
      const lane = lanes.get(botId);
      if (lane?.threadId === threadId) Object.assign(lane, { running: false, ending: lane.ending || ending });
    },
    /** The thread's terminal event has been handled. */
    settle(botId: string, threadId: string) {
      const lane = lanes.get(botId);
      if (lane?.threadId === threadId) lane.ending = false;
    },
  };
}
