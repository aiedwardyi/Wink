// A live bot handoff: the room's newest line is a bot's @ to another bot.
// Host and joined PCs read it from their own copy of the log for the strip and pings.
import { botLineResponder } from "./room-routing.ts";

type Line = { author: { kind: string; id: string }; text: string };
type Bot = { id: string; name: string };

export const handsOff = (line: Line, bots: readonly Bot[], people: readonly string[]) =>
  line.author.kind === "bot" && botLineResponder(line.text, bots, people, line.author.id) !== null;

/** Bot lines since a person or the host last spoke, while the newest hands off; 0 when no handoff is live. */
export function botChain(lines: readonly Line[], bots: readonly Bot[], people: readonly string[]): number {
  const last = lines.at(-1);
  if (!last || !handsOff(last, bots, people)) return 0;
  let turn = 0;
  while (turn < lines.length && lines[lines.length - 1 - turn]!.author.kind === "bot") turn++;
  return turn;
}
