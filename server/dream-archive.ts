// memory/dreamed.md: every line Dreaming moves out of MEMORY.md, word for word, where recall and sync still reach it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pickStamp } from "./picks.ts";
import { twinKey, type Move } from "./memory-sleep.ts";
import { workspaceDir } from "./workspace.ts";

export const DREAMED_FILE = "memory/dreamed.md";
export const DREAMED_HEAD =
  "# Dreamed notes\n\nLines Dreaming moved out of MEMORY.md, word for word, oldest first. Recall still finds them; Undo on the morning note puts a night's lines back.\n";

/** A moved line, the nearest kept line above it, its own line ending and how many copies of it MEMORY.md kept, so Undo can put it back exactly. */
export type ArchivedMove = Move & { after: string | null; cr: boolean; left: number };

const BULLET = /^[-*+]\s+\S/;
const RUN = (runId: string) => ` (run ${runId})`;

export const dreamedPath = (botId: string) => join(workspaceDir(botId), ...DREAMED_FILE.split("/"));

// the newer note's words stay out: a second row with them hides this one from recall
const REASONS: Record<Move["why"], string> = { duplicate: "a newer note says all of it", replaced: "a newer note replaces it", expired: "every date it names is past" };

/** The moves with their anchors in raw: a run of moved lines shares the kept line above the first. */
export function anchored(raw: string, moves: readonly Move[]): ArchivedMove[] {
  const rows = raw.split("\n");
  const lines = rows.map((line) => line.replace(/\r$/, ""));
  const gone = new Set(moves.map(({ at }) => at));
  return moves.map((move) => ({
    ...move,
    after: lines[above(move.at, gone)] ?? null,
    cr: rows[move.at]?.endsWith("\r") ?? false,
    left: lines.filter((line, at) => line === move.text && !gone.has(at)).length,
  }));
}

// the nearest line above that the run kept, -1 for none
function above(at: number, gone: ReadonlySet<number>): number {
  let index = at - 1;
  while (index >= 0 && gone.has(index)) index -= 1;
  return index;
}

export function dreamedEntry(runId: string, moves: readonly Move[], now: number): string {
  const date = pickStamp(now).slice(0, 10);
  return [`## ${date}${RUN(runId)}`, ...moves.flatMap((move) => [move.text, `  - from MEMORY.md:${move.at + 1} on ${date}: ${REASONS[move.why]}`])].join("\n");
}

/** A fixed note's old line, word for word, with the owner's words that showed it wrong. */
export function fixedEntry(id: string, item: { text: string; evidence: { at: number; quote: string } }, line: number, now: number): string {
  const date = pickStamp(now).slice(0, 10);
  return [`## ${date}${RUN(id)}`, item.text, `  - from MEMORY.md:${line + 1} on ${date}: the user wrote on ${pickStamp(item.evidence.at).slice(0, 10)}: "${item.evidence.quote}"`].join("\n");
}

/** The twin key of every line the archive holds: one back in MEMORY.md was put back, so it never moves again. */
export function dreamedKeys(botId: string): Set<string> {
  let text = "";
  try {
    text = readFileSync(dreamedPath(botId), "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return new Set(text.split("\n").filter((line) => BULLET.test(line)).map((line) => twinKey(line.replace(/\r$/, ""))));
}

/** The archive with this run's heading marked undone; its lines stay, so their keys still hold. */
export function markUndone(text: string, runId: string, now: number): string {
  return text.replace(`${RUN(runId)}\n`, `${RUN(runId)}, undone ${pickStamp(now).slice(0, 10)}\n`);
}

/** The archive with this fix's heading marked put back: a line the user wrote before the OK reached this PC after it. */
export function markPutBack(text: string, id: string, now: number): string {
  return text.replace(`${RUN(id)}\n`, `${RUN(id)}, put back ${pickStamp(now).slice(0, 10)}: the user wrote before this OK and it reached this PC later\n`);
}

/** raw with each move back under its anchor, with its own line ending; a copy beyond what the move left is one someone already put back, so that move is skipped. */
export function putBack(raw: string, moves: readonly ArchivedMove[]): { text: string; restored: number; skipped: number } {
  const lines = raw.split("\n");
  const plain = (at: number) => lines[at]!.replace(/\r$/, "");
  const sorted = [...moves].sort((p, q) => p.at - q.at);
  const gone = new Set(sorted.map(({ at }) => at));
  const back = new Map(sorted.map((move) => [move.text, lines.filter((_, at) => plain(at) === move.text).length - move.left]));
  let restored = 0;
  let skipped = 0;
  let last: { anchor: number; at: number } | undefined;
  for (const move of sorted) {
    const extra = back.get(move.text)!;
    if (extra > 0) {
      back.set(move.text, extra - 1);
      skipped += 1;
      continue;
    }
    // every earlier line is back, so the anchor sits where it sat before the run: the copy of it nearest there, else that place
    const anchor = above(move.at, gone);
    let at: number;
    if (last?.anchor === anchor) at = last.at + 1;
    else if (move.after === null) at = 0;
    else {
      const found = lines.map((_, index) => index).filter((index) => plain(index) === move.after).sort((p, q) => Math.abs(p - anchor) - Math.abs(q - anchor))[0];
      at = found === undefined ? Math.min(anchor + 1, lines.length) : found + 1;
    }
    lines.splice(at, 0, move.text + (move.cr ? "\r" : ""));
    restored += 1;
    last = { anchor, at };
  }
  return { text: lines.join("\n"), restored, skipped };
}
