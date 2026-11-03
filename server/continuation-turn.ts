// A turn.started the harness did not dispatch: a retained CLI woke on its own
// after `result` (a background task's notification) and the driver opened a
// continuation turn. An idle 1:1 bot adopts it like a user-sent turn, so the
// composer locks, the watchdog runs, and queued sends wait for its settle.
import type { ProviderAdapter, SendTurnInput, TurnStartResult } from "./contracts.ts";

export interface ContinuationBot {
  id: string;
  busy?: boolean;
  activeThreadId?: string;
}

export interface ContinuationDeps {
  botByThread(threadId: string): ContinuationBot | null | undefined;
  /** startTurn holds this bot's claim but may not have flipped busy yet. */
  claimed(botId: string): boolean;
  adopt(botId: string, threadId: string, turnId: string): void;
  /** Busy elsewhere: its completion must not mark the bot idle. */
  disown(turnId: string): void;
}

export type ContinuationFold = "ignored" | "owned" | "adopted" | "disowned";

export function foldContinuationStart(
  event: { threadId: string; turnId?: string },
  deps: ContinuationDeps,
): ContinuationFold {
  const bot = deps.botByThread(event.threadId);
  if (!bot || !event.turnId) return "ignored";
  if (bot.busy && bot.activeThreadId === event.threadId) return "owned";
  if (bot.busy || deps.claimed(bot.id)) {
    deps.disown(event.turnId);
    return "disowned";
  }
  deps.adopt(bot.id, event.threadId, event.turnId);
  return "adopted";
}

/** A dispatch whose thread the engine took after the busy gate joins that turn like a mid-turn send; null sends as usual. */
export async function joinRunningTurn(
  adapter: Pick<ProviderAdapter, "capabilities" | "hasSession" | "steer">,
  turn: Pick<SendTurnInput, "threadId" | "text" | "resumeCursor" | "systemUpdate">,
  runningTurnId: string | undefined,
): Promise<TurnStartResult | null> {
  if (!runningTurnId || adapter.capabilities.queueing !== true || !adapter.steer || !adapter.hasSession(turn.threadId)) return null;
  // a fresh session's text replays the thread, and a steer carries no systemUpdate
  if (turn.resumeCursor === undefined || turn.systemUpdate) return null;
  return (await adapter.steer(turn.threadId, turn.text).catch(() => false)) ? { turnId: runningTurnId } : null;
}
