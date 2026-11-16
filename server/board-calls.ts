// Bot calls feed the Board: a call leaves a stuck post, the user's answer becomes its fix,
// and a later bot with the same blocker gets that fix instead of calling. No model calls.
import { BOARD_USER, boardLine, errorSig, type Board, type BoardPost } from "./board.ts";
import type { TaskResumePacket } from "./task-state.ts";

type Blocker = TaskResumePacket["blockers"][number];
type Offer = { botId: string; key: string; postIds: string[] };

/** At most this many posts ride back to a held call (~200 tokens). */
export const BOARD_HITS = 2;
const HIT_CHARS = 240;
const MIN_SHARE = 0.6;

/** A message the user typed on a thread, the only kind that answers a call. */
export const userAnswer = (message: { role: string; kind: string; comm?: unknown; from?: unknown }) =>
  message.role === "user" && message.kind === "text" && !message.comm && !message.from;

const calls = (blocker: Blocker) => blocker.kind === "login" || blocker.kind === "engine";
const keyOf = (blocker: Blocker) => `${blocker.kind}\n${blocker.note}`;
const callRef = (threadId: string) => `call:${threadId}:`;

export interface BoardCallDeps {
  board: Board;
  /** The thread's project, as a folder name; "" when it has none. */
  projectOf(threadId: string): string;
  /** False where a blocker would not ring (rooms, hosted threads), so nothing is held there. */
  rings(threadId: string): boolean;
}

export function createBoardCalls(deps: BoardCallDeps) {
  const offers = new Map<string, Offer[]>();

  const hits = (threadId: string, note: string) => deps.board.search({
    query: note,
    errorSig: errorSig(note),
    projectId: deps.projectOf(threadId),
    solvedOnly: true,
    minShare: MIN_SHARE,
    limit: BOARD_HITS,
  });

  return {
    /**
     * Before a write can ring: a new calling blocker with a solved post is held once and
     * its fix goes back to the bot. The same blocker written again calls as usual.
     */
    hold(botId: string, threadId: string, before: readonly Blocker[], after: readonly Blocker[]): { blockers: Blocker[]; notice: string } {
      if (!deps.rings(threadId)) return { blockers: [...after], notice: "" };
      const had = new Set(before.map(keyOf));
      const offered = offers.get(threadId) ?? [];
      const kept: Blocker[] = [];
      const found: BoardPost[] = [];
      for (const blocker of after) {
        const key = keyOf(blocker);
        if (!calls(blocker) || had.has(key)) {
          kept.push(blocker);
          continue;
        }
        const tried = offered.findIndex((offer) => offer.botId === botId && offer.key === key);
        if (tried >= 0) {
          offered.splice(tried, 1);
          kept.push(blocker);
          continue;
        }
        const posts = hits(threadId, blocker.note);
        if (!posts.length) {
          kept.push(blocker);
          continue;
        }
        offered.push({ botId, key, postIds: posts.map((post) => post.id) });
        for (const post of posts) if (!found.some((seen) => seen.id === post.id)) found.push(post);
      }
      if (offered.length) offers.set(threadId, offered);
      else offers.delete(threadId);
      if (!found.length) return { blockers: kept, notice: "" };
      const lines = found.slice(0, BOARD_HITS).map((post) => boardLine(post, HIT_CHARS));
      return {
        blockers: kept,
        notice: `Not called yet: the Board has a fix for this blocker. Try it once. If it still fails, write the same blocker again to call.\n${lines.join("\n")}`,
      };
    },
    /** A call went out: the blocker becomes an open stuck post. */
    called(botId: string, threadId: string, blocker: Blocker): BoardPost {
      return deps.board.post({
        author_bot_id: botId,
        kind: "stuck",
        title: blocker.note,
        body: blocker.note,
        error_sig: errorSig(blocker.note),
        project_id: deps.projectOf(threadId),
        source_ref: `${callRef(threadId)}${blocker.kind}:${blocker.note}`,
      });
    },
    /** The user's next message on a called thread is the answer: a fix reply, and the post is solved. */
    answered(threadId: string, message: { id: string; text?: string }): BoardPost[] {
      const text = message.text?.trim();
      if (!text) return [];
      const open = deps.board.list().filter((post) => post.kind === "stuck" && post.status === "open" && post.source_ref.startsWith(callRef(threadId)));
      return open.map((stuck) => {
        deps.board.post({
          author_bot_id: BOARD_USER,
          parent_id: stuck.id,
          kind: "fix",
          title: stuck.title,
          body: text,
          fix: text,
          error_sig: stuck.error_sig,
          project_id: stuck.project_id,
          source_ref: `answer:${message.id}:${stuck.id}`,
        });
        return deps.board.solve(stuck.id, text)!;
      });
    },
    /** A turn that held a Board fix and ended without calling: the fix helped. */
    turnEnded(threadId: string, ok: boolean): void {
      const offered = offers.get(threadId);
      if (!offered) return;
      offers.delete(threadId);
      if (!ok) return;
      for (const offer of offered) deps.board.helped(offer.postIds, offer.botId);
    },
  };
}

export type BoardCalls = ReturnType<typeof createBoardCalls>;
