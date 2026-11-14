// A live bot handoff: the room's newest line is a bot's @ to another bot that is working on it.
// Host and joined PCs read it from their own copy of the log for the strip and pings.
import { botLineResponder } from "./room-routing.ts";

/** The strip's count reads this far back. */
export const CHAIN_LINES = 100;

type Line = { author: { kind: string; id: string }; text: string };
type Bot = { id: string; name: string };

export const handsOff = (line: Line, bots: readonly Bot[], people: readonly string[]) =>
  line.author.kind === "bot" && botLineResponder(line.text, bots, people, line.author.id) !== null;

/** A handoff to a bot this PC can't see working counts this long after its line. */
export const CHAIN_PENDING_MS = 2 * 60_000;

/** What this PC knows: `working` is null for a bot it can't see; lines before `since` (this run's start) are no longer pending. */
export type ChainSeen = { working?(botId: string): boolean | null; since?: number; now?: number };

/** Bot lines since a person or the host last spoke, while the newest hands off to a bot that is working or still pending; 0 otherwise. */
export function botChain(lines: readonly (Line & { at: number })[], bots: readonly Bot[], people: readonly string[], seen: ChainSeen = {}): number {
  const last = lines.at(-1);
  const to = last?.author.kind === "bot" ? botLineResponder(last.text, bots, people, last.author.id) : null;
  if (!last || !to) return 0;
  const pending = last.at >= (seen.since ?? 0) && (seen.now ?? Date.now()) - last.at < CHAIN_PENDING_MS;
  if (!(seen.working?.(to.id) ?? pending)) return 0;
  let turn = 0;
  while (turn < lines.length && lines[lines.length - 1 - turn]!.author.kind === "bot") turn++;
  return turn;
}

/** Per room, the republish due when its pending handoff lapses. */
export type ChainLapses = Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>;

/** Republishes the room once the handoff line at `lineAt` stops pending, so its strip clears. */
export function republishWhenLapsed(lapses: ChainLapses, roomId: string, lineAt: number, republish: () => void): void {
  const at = lineAt + CHAIN_PENDING_MS;
  const now = Date.now();
  if (at <= now || lapses.get(roomId)?.at === at) return;
  clearTimeout(lapses.get(roomId)?.timer);
  const timer = setTimeout(() => {
    lapses.delete(roomId);
    republish();
  }, at - now);
  timer.unref?.();
  lapses.set(roomId, { at, timer });
}
