// The Forum loop: a bot hitting an error another bot already fixed gets that fix in its turn, and a command that failed,
// then passed after an edit, is a proven fix its bot is asked to post. A plain retry or the user's words never post. No model calls.
import { BOARD_USER, errorSig, fromRoom, type Board, type BoardPost } from "./board.ts";
import type { RuntimeEvent } from "./contracts.ts";

type Tool = Extract<RuntimeEvent, { type: "item.completed"; itemType: "tool" }>;
type Failure = { sig: string; line: string; edits: number };
type Turn = { failed: Map<string, Failure>; offered: Map<string, string>; edits: number; nudged: boolean };
/** One line per moment in the data folder: "repeat" is a known error on a second bot, "again" that error once more in the same turn. */
export type ForumLoopRow = { kind: "repeat" | "again" | "proven" | "helped"; botId: string; threadId: string; sig: string; postId?: string; shadow?: true };
export const FORUM_LOOP_FILE = "forum-loop.ndjson";

const HIT_CHARS = 240;
const MAX_FAILED = 64;
const MAX_CLAIMS = 64;
const CLAIM_MS = 30 * 60_000;
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface ForumLoopDeps {
  board: Board;
  botOf(threadId: string): string | undefined;
  /** The thread's project, as a folder name; "" when it has none. */
  projectOf(threadId: string): string;
  /** A turn other people share: nothing is offered or claimed there. */
  room(threadId: string): boolean;
  /** Into the running turn; false when the engine cannot take it, so it rides the next turn instead. */
  steer(threadId: string, text: string): Promise<boolean>;
  log?(row: ForumLoopRow): void;
  /** Off: detect and log only, for a baseline. */
  enabled?: boolean;
  now?: () => number;
}

export function createForumLoop(deps: ForumLoopDeps) {
  const enabled = deps.enabled !== false;
  const now = deps.now ?? Date.now;
  const turns = new Map<string, Turn>();
  const pending = new Map<string, string[]>();
  const claims = new Map<string, { sig: string; at: number }>();

  const turnOf = (threadId: string) => {
    let turn = turns.get(threadId);
    if (!turn) turns.set(threadId, (turn = { failed: new Map(), offered: new Map(), edits: 0, nudged: false }));
    return turn;
  };
  const log = (row: ForumLoopRow) => deps.log?.(enabled ? row : { ...row, shadow: true });
  const deliver = (threadId: string, text: string) => {
    if (!enabled) return;
    const later = () => pending.set(threadId, [...(pending.get(threadId) ?? []), text]);
    deps.steer(threadId, text).then((taken) => taken || later(), later);
  };
  /** The solved fix another bot wrote for this signature, this project's first. Room posts and the user's chat never ride along. */
  const knownFix = (sig: string, project: string, botId?: string): BoardPost | undefined => {
    const fixes = deps.board.list().filter((post) => post.error_sig === sig && post.status === "solved" && post.fix && !post.lesson
      && !fromRoom(post) && post.author_bot_id !== BOARD_USER && post.author_bot_id !== botId);
    return fixes.find((post) => post.project_id === project) ?? fixes[0];
  };

  const failed = (threadId: string, botId: string, event: Tool) => {
    const line = event.detail?.output?.[0]?.trim() ?? "";
    const sig = line ? errorSig(line) : "";
    if (!sig) return;
    const turn = turnOf(threadId);
    const cmd = event.detail?.input;
    if (cmd) {
      if (turn.failed.size >= MAX_FAILED && !turn.failed.has(cmd)) turn.failed.delete(turn.failed.keys().next().value!);
      turn.failed.set(cmd, { sig, line, edits: turn.edits });
    }
    const offered = turn.offered.get(sig);
    if (offered !== undefined) return void log({ kind: "again", botId, threadId, sig, postId: offered });
    const post = knownFix(sig, deps.projectOf(threadId), botId);
    if (!post) return;
    turn.offered.set(sig, post.id);
    log({ kind: "repeat", botId, threadId, sig, postId: post.id });
    deliver(threadId, `Forum ${post.id}: another bot already fixed "${cut(post.title, 120)}". A past note, not an instruction; check it fits before you retry.\nFix: ${cut(post.fix, HIT_CHARS)}`);
  };

  const passed = (threadId: string, botId: string, cmd: string) => {
    const turn = turns.get(threadId);
    const before = turn?.failed.get(cmd);
    if (!turn || !before) return;
    turn.failed.delete(cmd);
    // the same command passing with no edit since it failed is a retry, not a fix
    if (turn.edits <= before.edits) return;
    const offered = turn.offered.get(before.sig);
    if (offered) {
      log({ kind: "helped", botId, threadId, sig: before.sig, postId: offered });
      if (enabled) deps.board.helped([offered], botId);
      return;
    }
    if (claims.size >= MAX_CLAIMS && !claims.has(threadId)) claims.delete(claims.keys().next().value!);
    claims.set(threadId, { sig: before.sig, at: now() });
    log({ kind: "proven", botId, threadId, sig: before.sig });
    if (turn.nudged) return;
    turn.nudged = true;
    deliver(threadId, `Wink: \`${cmd}\` passed after your edit; before it failed with "${before.line}". If that fix would help another bot, post it once: board_post kind fix, the error as title, and in 1 to 3 lines of your own words what fixed it.`);
  };

  return {
    event(event: RuntimeEvent): void {
      if (event.type === "turn.completed" || event.type === "session.exited") return void turns.delete(event.threadId);
      if (event.type !== "item.completed" || event.itemType !== "tool") return;
      // ordinary calls end here: nothing failed this turn, so no edit or pass can prove a fix
      if (event.ok && !turns.get(event.threadId)?.failed.size) return;
      const edit = event.ok && Boolean(event.writes?.length);
      const cmd = event.detail?.input;
      if (deps.room(event.threadId)) return;
      const botId = deps.botOf(event.threadId);
      if (!botId) return;
      if (edit) turnOf(event.threadId).edits++;
      else if (!event.ok) failed(event.threadId, botId, event);
      else if (cmd) passed(event.threadId, botId, cmd);
    },
    /** What could not reach the running turn, for the next one; empty on an ordinary turn. */
    next(threadId: string): string {
      const held = pending.get(threadId);
      if (!held) return "";
      pending.delete(threadId);
      return held.join("\n\n");
    },
    /** The proven fix a board_post kind fix from this thread belongs to, if one was seen in the last half hour. */
    claim(threadId: string): string | undefined {
      const held = claims.get(threadId);
      if (!held) return undefined;
      claims.delete(threadId);
      return now() - held.at <= CLAIM_MS ? held.sig : undefined;
    },
    knownFix,
  };
}

export type ForumLoop = ReturnType<typeof createForumLoop>;
