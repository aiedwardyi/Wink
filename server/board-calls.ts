// Bot calls feed the Board: an engine call leaves a stuck post, the bot clearing that blocker with a note solves it, and a later
// bot with the same blocker, or about to ask the user a plain fact, gets the fix instead. No model calls.
import { createHash } from "node:crypto";

import { BOARD_REF_MAX, boardLine, boardPostId, errorSig, type Board, type BoardPost } from "./board.ts";
import { mayHoldAsk, solvedFix } from "./forum-hold.ts";
import type { TaskResumePacket } from "./task-state.ts";

type Blocker = TaskResumePacket["blockers"][number];
type Offer = { botId: string; key: string; postIds: string[] };
export type ForumHold = { kind: "ask" | "call"; botId: string; threadId: string; postIds: string[] };
/** One line per hold in the data folder, read by scripts/forum-replay.ts. */
export const FORUM_HOLDS_FILE = "forum-holds.ndjson";

/** At most this many posts ride back to a held call (~200 tokens). */
export const BOARD_HITS = 2;
const HIT_CHARS = 240;
const MIN_SHARE = 0.6;
const ASK_MIN_HITS = 3;

/** Only an engine blocker is one another bot could clear; a login is the user's alone, so it never reaches the Forum. */
const forumKind = (blocker: Blocker) => blocker.kind === "engine";
/** A login post from before the rule is still open on the Board; clearing its login closes it. */
const closable = (blocker: Blocker) => forumKind(blocker) || blocker.kind === "login";
const keyOf = (blocker: Blocker) => `${blocker.kind}\n${blocker.note}`;
const callRef = (threadId: string) => `call:${threadId}:`;

export interface BoardCallDeps {
  board: Board;
  /** The thread's project, as a folder name; "" when it has none. */
  projectOf(threadId: string): string;
  /** True on a turn other people share (a group, a hosted or joined room): nothing private is offered, posted or captured there. */
  room(threadId: string): boolean;
  /** Each hold, for the replay: ids only, never the question or blocker. */
  held?(hold: ForumHold): void;
}

export function createBoardCalls(deps: BoardCallDeps) {
  const offers = new Map<string, Offer[]>();
  /** Per thread and bot, kept past turn end: whether the last eligible ask was held, and every post shown. */
  const asked = new Map<string, { held: boolean; postIds: Set<string> }>();

  const search = (threadId: string, query: string, ask = false) => deps.board.search({
    query,
    errorSig: errorSig(query),
    projectId: deps.projectOf(threadId),
    minShare: MIN_SHARE,
    ...(ask ? { sigRanksOnly: true, minHits: ASK_MIN_HITS } : {}),
    limit: Number.POSITIVE_INFINITY,
    withoutRoom: true,
  }).filter(solvedFix);
  /** The episode's post refs: the full-note ref older calls posted under, then the digest of the whole blocker a new post takes. */
  const episodeRefs = (threadId: string, blocker: Blocker, episode: number) => {
    const legacy = `${callRef(threadId)}${episode}:${blocker.kind}:${blocker.note}`;
    const digest = `${callRef(threadId)}${episode}:${blocker.kind}:${createHash("sha256").update(keyOf(blocker)).digest("hex").slice(0, 24)}`;
    // a longer legacy ref was cut before hashing, so another note may share its post
    return legacy.length <= BOARD_REF_MAX ? [legacy, digest] : [digest];
  };
  /** The call's current ref: the live post of the first episode neither deleted nor solved, else a new post. */
  const currentRef = (threadId: string, blocker: Blocker) => deps.board.next((episode) => episodeRefs(threadId, blocker, episode), (post) => post.status === "solved");

  return {
    /**
     * Before a write can ring: a new engine blocker with a solved fix is held once and the fix
     * goes back to the bot. The same blocker written again calls as usual; a login always calls.
     */
    hold(botId: string, threadId: string, before: readonly Blocker[], after: readonly Blocker[]): { blockers: Blocker[]; notice: string } {
      if (deps.room(threadId)) return { blockers: [...after], notice: "" };
      const had = new Set(before.map(keyOf));
      const offered = offers.get(threadId) ?? [];
      const kept: Blocker[] = [];
      const found: BoardPost[] = [];
      for (const blocker of after) {
        const key = keyOf(blocker);
        if (blocker.kind !== "engine" || had.has(key)) {
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
        const posts = search(threadId, blocker.note).slice(0, BOARD_HITS);
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
      deps.held?.({ kind: "call", botId, threadId, postIds: found.map((post) => post.id) });
      const lines = found.map((post) => boardLine(post, HIT_CHARS));
      return {
        blockers: kept,
        notice: `Not called yet: the Board has a fix for this blocker. Try it once. If it still fails, write the same blocker again to call.\n${lines.join("\n")}`,
      };
    },
    /**
     * Before an ask_user card the bot marked as a fact posts: a solved fix in the same project that covers it goes back
     * to the bot first, each post once. The next ask, in any words or turn, is not held. A held ask earns no Helped.
     */
    ask(botId: string, threadId: string, question: string, choices: readonly string[] = []): string {
      if (deps.room(threadId) || !mayHoldAsk(question, choices)) return "";
      const key = `${threadId}\n${botId}`;
      const seen = asked.get(key) ?? { held: false, postIds: new Set<string>() };
      if (seen.held) {
        seen.held = false;
        return "";
      }
      const project = deps.projectOf(threadId);
      const posts = project ? search(threadId, question, true).filter((post) => post.project_id === project).slice(0, BOARD_HITS) : [];
      if (!posts.length || posts.some((post) => seen.postIds.has(post.id))) return "";
      seen.held = true;
      for (const post of posts) seen.postIds.add(post.id);
      asked.set(key, seen);
      deps.held?.({ kind: "ask", botId, threadId, postIds: posts.map((post) => post.id) });
      return `Not asked yet: the Forum may answer this:\n${posts.map((post) => boardLine(post, HIT_CHARS)).join("\n")}\nIf it answers you, close this question with ask_user close:true. If not, it posts when your turn ends.`;
    },
    /** A call went out: an engine blocker becomes an open stuck post, a fresh one once the last call was solved. */
    called(botId: string, threadId: string, blocker: Blocker): BoardPost | undefined {
      if (deps.room(threadId) || !forumKind(blocker)) return undefined;
      return deps.board.post({
        author_bot_id: botId,
        kind: "stuck",
        title: blocker.note,
        body: blocker.note,
        error_sig: errorSig(blocker.note),
        project_id: deps.projectOf(threadId),
        source_ref: currentRef(threadId, blocker),
      });
    },
    /** The bot cleared the one blocker it called on, with a note: that note is the fix. The user's chat is never the fix. */
    cleared(threadId: string, before: readonly Blocker[], after: readonly Blocker[], note = ""): BoardPost[] {
      if (deps.room(threadId) || !note.trim()) return [];
      const left = new Set(after.map(keyOf));
      const open = before.filter((blocker) => closable(blocker) && !left.has(keyOf(blocker))).flatMap((blocker) => {
        const post = deps.board.get(boardPostId(currentRef(threadId, blocker)));
        return post?.kind === "stuck" && post.status === "open" ? [post] : [];
      });
      // one note cannot say which of several calls it fixed
      return open.length === 1 ? [deps.board.solve(open[0]!.id, note)!] : [];
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
