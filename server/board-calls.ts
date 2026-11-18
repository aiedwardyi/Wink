// Bot calls feed the Board: a call leaves a stuck post, the bot clearing that blocker solves it, and a later
// bot with the same blocker, or about to ask the user, gets the post instead. No model calls.
import { boardLine, boardPostId, errorSig, type Board, type BoardPost } from "./board.ts";
import type { TaskResumePacket } from "./task-state.ts";

type Blocker = TaskResumePacket["blockers"][number];
type Offer = { botId: string; key: string; postIds: string[] };

/** At most this many posts ride back to a held call (~200 tokens). */
export const BOARD_HITS = 2;
const HIT_CHARS = 240;
const MIN_SHARE = 0.6;

const calls = (blocker: Blocker) => blocker.kind === "login" || blocker.kind === "engine";
const keyOf = (blocker: Blocker) => `${blocker.kind}\n${blocker.note}`;
const callRef = (threadId: string) => `call:${threadId}:`;
// handoffs and tips are never solved, so they count as answers while open
const answers = (post: BoardPost) => (post.status === "solved" && Boolean(post.fix)) || post.kind === "handoff" || post.kind === "tip";

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
    minShare: MIN_SHARE,
    limit: Number.POSITIVE_INFINITY,
    withoutRoom: true,
  }).filter(answers).slice(0, BOARD_HITS);
  const episodeRef = (threadId: string, blocker: Blocker, episode: number) => `${callRef(threadId)}${episode}:${blocker.kind}:${blocker.note}`;
  /** The call's current episode: the first whose post is not solved yet. */
  const episodeOf = (threadId: string, blocker: Blocker) => {
    let episode = 0;
    while (deps.board.get(boardPostId(episodeRef(threadId, blocker, episode)))?.status === "solved") episode++;
    return episode;
  };

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
        // Held only with a fix the notice carries; past the budget the blocker calls.
        const posts = hits(threadId, blocker.note);
        const fresh = posts.filter((post) => !found.some((seen) => seen.id === post.id)).slice(0, BOARD_HITS - found.length);
        const shown = posts.filter((post) => fresh.includes(post) || found.some((seen) => seen.id === post.id));
        if (!shown.length) {
          kept.push(blocker);
          continue;
        }
        offered.push({ botId, key, postIds: shown.map((post) => post.id) });
        found.push(...fresh);
      }
      if (offered.length) offers.set(threadId, offered);
      else offers.delete(threadId);
      if (!found.length) return { blockers: kept, notice: "" };
      const lines = found.map((post) => boardLine(post, HIT_CHARS));
      return {
        blockers: kept,
        notice: `Not called yet: the Board has a fix for this blocker. Try it once. If it still fails, write the same blocker again to call.\n${lines.join("\n")}`,
      };
    },
    /**
     * Before an ask_user card posts: a question the Forum may answer is held once and the posts
     * go back to the bot. The same question asked again posts.
     */
    ask(botId: string, threadId: string, question: string): string {
      if (!deps.rings(threadId)) return "";
      const key = `ask\n${question}`;
      const offered = offers.get(threadId) ?? [];
      const tried = offered.findIndex((offer) => offer.botId === botId && offer.key === key);
      if (tried >= 0) {
        offered.splice(tried, 1);
        if (!offered.length) offers.delete(threadId);
        return "";
      }
      const posts = hits(threadId, question);
      if (!posts.length) return "";
      offers.set(threadId, [...offered, { botId, key, postIds: posts.map((post) => post.id) }]);
      return `Not asked yet: the Forum may answer this:\n${posts.map((post) => boardLine(post, HIT_CHARS)).join("\n")}\nIf it doesn't, ask again.`;
    },
    /** A call went out: the blocker becomes an open stuck post, a fresh one once the last call was solved. */
    called(botId: string, threadId: string, blocker: Blocker): BoardPost {
      return deps.board.post({
        author_bot_id: botId,
        kind: "stuck",
        title: blocker.note,
        body: blocker.note,
        error_sig: errorSig(blocker.note),
        project_id: deps.projectOf(threadId),
        source_ref: episodeRef(threadId, blocker, episodeOf(threadId, blocker)),
      });
    },
    /** The bot cleared a blocker it called on: the stuck post is solved, with the note it wrote then as the fix. The user's chat is never the fix. */
    cleared(threadId: string, before: readonly Blocker[], after: readonly Blocker[], note = ""): BoardPost[] {
      const left = new Set(after.map(keyOf));
      return before.filter((blocker) => calls(blocker) && !left.has(keyOf(blocker))).flatMap((blocker) => {
        const id = boardPostId(episodeRef(threadId, blocker, episodeOf(threadId, blocker)));
        return deps.board.get(id)?.kind === "stuck" ? [deps.board.solve(id, note)!] : [];
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
