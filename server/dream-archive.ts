// memory/dreamed.md: every line Dreaming moves out of MEMORY.md, word for word, where recall and sync still reach it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pickStamp } from "./picks.ts";
import { twinKey, type Move } from "./memory-sleep.ts";
import { workspaceDir } from "./workspace.ts";

export const DREAMED_FILE = "memory/dreamed.md";
export const DREAMED_HEAD =
  "# Dreamed notes\n\nLines Dreaming moved out of MEMORY.md, word for word, oldest first. Recall still finds them; Undo on the morning note puts a night's lines back.\n";

/** A moved line and the nearest kept line above it, so Undo can put it back where it was. */
export type ArchivedMove = Move & { after: string | null };

const BULLET = /^[-*+]\s+\S/;
const RUN = (runId: string) => ` (run ${runId})`;

export const dreamedPath = (botId: string) => join(workspaceDir(botId), ...DREAMED_FILE.split("/"));

// the newer note's words stay out: a second row with them hides this one from recall
const REASONS: Record<Move["why"], string> = { duplicate: "a newer note says all of it", replaced: "a newer note replaces it", expired: "every date it names is past" };

/** The moves with their anchors in raw: a run of moved lines shares the kept line above the first. */
export function anchored(raw: string, moves: readonly Move[]): ArchivedMove[] {
  const lines = raw.split("\n").map((line) => line.replace(/\r$/, ""));
  const gone = new Set(moves.map(({ at }) => at));
  return moves.map((move) => {
    let above = move.at - 1;
    while (above >= 0 && gone.has(above)) above -= 1;
    return { ...move, after: above >= 0 ? lines[above]! : null };
  });
}

export function dreamedEntry(runId: string, moves: readonly Move[], now: number): string {
  const date = pickStamp(now).slice(0, 10);
  return [`## ${date}${RUN(runId)}`, ...moves.flatMap((move) => [move.text, `  - from MEMORY.md:${move.at + 1} on ${date}: ${REASONS[move.why]}`])].join("\n");
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

/** raw with each move back under its anchor; a line someone already put back word for word is skipped. A twin's keeper is not it. */
export function putBack(raw: string, moves: readonly ArchivedMove[]): { text: string; restored: number; skipped: number } {
  const lines = raw.split("\n");
  const eol = lines[0]?.endsWith("\r") ? "\r" : "";
  const plain = (at: number) => lines[at]!.replace(/\r$/, "");
  const present = new Set(lines.map((_, at) => plain(at)));
  let restored = 0;
  let skipped = 0;
  let last: { after: string | null; at: number } | undefined;
  for (const move of [...moves].sort((p, q) => p.at - q.at)) {
    if (present.has(move.text)) {
      skipped += 1;
      continue;
    }
    let at: number;
    if (last && last.after === move.after) at = last.at + 1;
    else if (move.after === null) at = 0;
    else {
      // the copy of the anchor nearest where the line sat, else where it sat
      const found = lines.map((_, index) => index).filter((index) => plain(index) === move.after).sort((p, q) => Math.abs(p - move.at) - Math.abs(q - move.at))[0];
      at = found === undefined ? Math.min(move.at, lines.length) : found + 1;
    }
    lines.splice(at, 0, move.text + eol);
    present.add(move.text);
    restored += 1;
    last = { after: move.after, at };
  }
  return { text: lines.join("\n"), restored, skipped };
}
