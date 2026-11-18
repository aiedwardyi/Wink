// Forum replay, read-only: every ask_user card and phone call in a window, searched against the
// Board as it stood then. Reads a copy of ~/.orbit, never the live folder, and writes nothing.
// node scripts/forum-replay.ts <orbit copy> [--days 7] [--end <iso>]
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createBoardCalls, FORUM_HOLDS_FILE, type ForumHold } from "../server/board-calls.ts";
import { BOARD_USER, projectIdOf, REPLY_REF, searchBoard, type Board, type BoardPost } from "../server/board.ts";

const [dir, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
};
if (!dir) throw new Error("usage: node scripts/forum-replay.ts <orbit copy> [--days 7] [--end <iso>]");
const live = join(homedir(), ".orbit");
if (realpathSync(dir).toLowerCase() === realpathSync(live).toLowerCase()) throw new Error(`${dir} is the live ~/.orbit; copy it first`);

const posts: BoardPost[] = readdirSync(join(dir, "board"))
  .filter((name) => /^p[0-9a-f]{24}\.json$/.test(name))
  .map((name) => JSON.parse(readFileSync(join(dir, "board", name), "utf8")) as BoardPost);
// what Board.list() hides: chat answers saved before chat stayed out of the Board
const copied = (post: BoardPost) => post.author_bot_id === BOARD_USER && !post.source_ref.startsWith(REPLY_REF);
const copiedFix = new Set(posts.filter(copied).map((post) => `${post.parent_id}\n${post.fix || post.body}`));
const boardAt = (at: number): Board => {
  const view = posts.filter((post) => !copied(post) && post.created_at < at).map((post) => {
    const fix = copiedFix.has(`${post.id}\n${post.fix}`) ? "" : post.fix;
    return post.status === "solved" && post.updated_at > at ? { ...post, status: "open" as const, fix: "" } : { ...post, fix };
  });
  return { search: (input) => searchBoard(view, input) } as Board;
};
// the server's boardProject, from today's bots.json
type Bot = { threadId: string; cwd?: string | null; tasks?: Array<{ threadId: string; cwd?: string | null }> };
const bots = JSON.parse(readFileSync(join(dir, "bots.json"), "utf8")) as Bot[];
const projectOf = (threadId: string) => {
  const bot = bots.find((each) => each.threadId === threadId || each.tasks?.some((task) => task.threadId === threadId));
  const pinned = bot?.tasks?.find((task) => task.threadId === threadId)?.cwd;
  return bot ? projectIdOf(pinned === undefined ? bot.cwd : pinned) : "";
};
const callsAt = (at: number) => createBoardCalls({ board: boardAt(at), projectOf, room: () => false });

const db = new DatabaseSync(join(dir, "messages.db"), { readOnly: true });
const end = flag("end") ? Date.parse(flag("end")!) : Number((db.prepare("SELECT max(at) AS at FROM messages").get() as { at: number }).at);
const start = end - Number(flag("days") ?? 7) * 86_400_000;

type Card = { thread_id: string; at: number; json: string };
const cards = (db.prepare("SELECT thread_id, at, json FROM messages WHERE kind = 'options' AND at BETWEEN ? AND ?").all(start, end) as Card[])
  .map((row) => ({ ...row, message: JSON.parse(row.json) as { from?: unknown; card?: { askUser?: boolean; requestId?: string; subtitle: string; options?: string[] } } }))
  .filter((row) => row.message.card?.askUser && !row.message.card.requestId);
// rooms never hold, like the live server
const solo = cards.filter((row) => !row.message.from);
const answerable = solo.filter((row) => callsAt(row.at).ask("replay", row.thread_id, row.message.card!.subtitle.trim(), row.message.card!.options ?? []));

// the holds the server logged; one with no card on its thread within the hour may have hidden the question: a false hold
const holdsFile = join(dir, FORUM_HOLDS_FILE);
const holds = (existsSync(holdsFile) ? readFileSync(holdsFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ForumHold & { at: number }) : [])
  .filter((hold) => hold.kind === "ask" && hold.at >= start && hold.at <= end);
const falseHolds = holds.filter((hold) => !cards.some((row) => row.thread_id === hold.threadId && row.at > hold.at && row.at - hold.at < 3_600_000));

const calls = posts.filter((post) => post.kind === "stuck" && post.source_ref.startsWith("call:") && post.created_at >= start && post.created_at <= end);
const heldCalls = calls.filter((post) => callsAt(post.created_at).hold("replay", "replay", [], [{ kind: "engine", note: post.title }]).notice);

const fixes = posts.filter((post) => post.fix && post.updated_at >= start && post.updated_at <= end);
const junk = fixes.filter((post) => post.fix.trim().length < 30 || post.fix.trim().endsWith("?"));

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "n/a");
console.log(JSON.stringify({
  estimate: "snapshot estimate: today's posts and folders stand in for the Board and threads as they were; holds come from the server's hold log",
  window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
  board: posts.length,
  asks: cards.length,
  asksSolo: solo.length,
  answerableButAsked: answerable.length,
  holdsShown: holds.length,
  reasked: holds.length - falseHolds.length,
  falseHold: `${falseHolds.length} (${pct(falseHolds.length, holds.length)})`,
  calls: calls.length,
  callsWithBoardHit: heldCalls.length,
  fixes: fixes.length,
  junkFix: `${junk.length} (${pct(junk.length, fixes.length)})`,
}, null, 2));
