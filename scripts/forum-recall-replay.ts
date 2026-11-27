// Forum recall replay: solved fix posts replayed as fresh tasks, recall off vs on, through the real board, hold and recall code.
// The engine is a stand-in: a try goes green once its context holds the task's remedy; a failed try writes its error as an
// engine blocker, and a blocker that calls costs one more try for the user's answer. Reads a copy of ~/.orbit; writes only to a temp folder.
// node scripts/forum-recall-replay.ts <orbit copy> <tasks.json>
// tasks.json: [{ "postId": "p...", "task": "the typed ask", "error": "what the failed try sees", "remedy": "words the fix must carry" }]
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createBoard } from "../server/board.ts";
import { createBoardCalls, type ForumHold } from "../server/board-calls.ts";
import { createBoardRecall, withBoardRecall } from "../server/board-recall.ts";
import type { MemoryLookup } from "../server/memory-lookup.ts";

const [dir, tasksPath] = process.argv.slice(2);
if (!dir || !tasksPath) throw new Error("usage: node scripts/forum-recall-replay.ts <orbit copy> <tasks.json>");
const live = (() => {
  try {
    return realpathSync(join(homedir(), ".orbit")).toLowerCase();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
})();
if (live && realpathSync(dir).toLowerCase() === live) throw new Error(`${dir} is the live ~/.orbit; copy it first`);
type Task = { postId: string; task: string; error: string; remedy: string };
// SAFETY: the tasks file is written by hand for this replay
const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as Task[];
const MAX_TRIES = 5;
const memory: MemoryLookup = { refresh: async () => {}, ready: () => undefined, take: () => [], accepted() {}, release() {}, settled: async () => {} };

const temp = mkdtempSync(join(tmpdir(), "forum-recall-replay-"));
const rig = (on: boolean) => {
  const boardDir = mkdtempSync(join(temp, "board-"));
  cpSync(join(dir, "board"), boardDir, { recursive: true });
  const board = createBoard({ dir: boardDir, pcId: () => "replay" });
  const holds: ForumHold[] = [];
  return { board, holds, on };
};

const run = (task: Task, on: boolean) => {
  const { board, holds } = rig(on);
  const post = board.get(task.postId);
  if (!post) throw new Error(`${task.postId} is not on the board copy`);
  const projectOf = () => post.project_id;
  const room = () => false;
  const calls = createBoardCalls({ board, projectOf, room, held: (hold) => holds.push(hold) });
  const lookup = withBoardRecall(memory, createBoardRecall({ on: () => on, board, projectOf, room, calls }));
  // a live server's board is already read
  board.search({ query: "warm" });
  const started = performance.now();
  const lines = lookup.take("replay", "t", undefined, task.task);
  const ms = performance.now() - started;
  if (lines.length) lookup.accepted("replay", "t");
  let context = [...lines, task.task].join("\n");
  const path: string[] = lines.length ? ["recall"] : [];
  let tries = 0;
  let before: Array<{ kind: "engine"; note: string }> = [];
  while (tries < MAX_TRIES) {
    tries++;
    if (context.includes(task.remedy)) {
      path.push("green");
      break;
    }
    const after = [{ kind: "engine" as const, note: task.error }];
    const held = calls.hold("replay", "t", before, after);
    before = held.blockers;
    if (held.notice) {
      path.push("held");
      context += `\n${held.notice}`;
    } else {
      path.push("called");
      context += `\n${post.fix}`;
    }
  }
  calls.turnEnded("t", path.at(-1) === "green");
  return { tries, path: path.join(">"), ms: Number(ms.toFixed(3)), line: lines[0] ?? "", log: holds.map((hold) => hold.kind).join(",") };
};

const pct = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;
// a normal turn: recall on, typed words that match nothing
const noMatch = () => {
  const { board } = rig(true);
  const calls = createBoardCalls({ board, projectOf: () => "desktop", room: () => false });
  const recall = createBoardRecall({ on: () => true, board, projectOf: () => "desktop", room: () => false, calls });
  const asks = ["can you tidy the sidebar spacing on the phone", "what did we ship yesterday", "make the morning summary shorter", "rename the eval chain cards"];
  const cold = performance.now();
  let fired = recall.take("replay", "t", asks[0]!).length;
  const coldMs = performance.now() - cold;
  const times: number[] = [];
  for (let at = 0; at < 2000; at++) {
    const started = performance.now();
    fired += recall.take("replay", "t", asks[at % asks.length]!).length;
    times.push(performance.now() - started);
  }
  return { fired, coldMs: Number(coldMs.toFixed(3)), p50: Number(pct(times, 0.5).toFixed(4)), p95: Number(pct(times, 0.95).toFixed(4)), max: Number(Math.max(...times).toFixed(3)) };
};

try {
  const rows = tasks.map((task) => ({ postId: task.postId, off: run(task, false), on: run(task, true) }));
  const sum = (mode: "off" | "on") => rows.reduce((total, row) => total + row[mode].tries, 0);
  const onMs = rows.map((row) => row.on.ms);
  console.log(JSON.stringify({
    engine: "stand-in: green on the first try whose context carries the remedy; a call costs one try for the user's answer",
    rows,
    triesOff: sum("off"),
    triesOn: sum("on"),
    recallMs: { p95: pct(onMs, 0.95), max: Math.max(...onMs) },
    noMatch: noMatch(),
  }, null, 2));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
