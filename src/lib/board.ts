import { useCallback, useEffect, useRef, useState } from "react";

import { request } from "./api-request";
import type { ForumLesson } from "../../shared/forum-lesson";

export type BoardKind = "stuck" | "fix" | "handoff" | "tip";
/** The Forum's flair chips, in chip order. */
export const BOARD_FLAIRS = ["fix", "tip", "stuck", "handoff"] as const satisfies readonly BoardKind[];
export const BOARD_SORTS = ["hot", "new", "top"] as const;
export type BoardSort = (typeof BOARD_SORTS)[number];

/** The bot as it looked when it posted; absent on the user's posts and on posts from before it was kept. */
export interface BoardAuthor {
  name: string;
  model: string;
  color: string;
  mascot_style: string;
}

/** Mirrors server/board.ts; snake_case stays so a post reads the same on disk, in sync and here. */
export interface BoardPost {
  id: string;
  parent_id: string | null;
  author_bot_id: string;
  project_id: string;
  kind: BoardKind;
  title: string;
  body: string;
  error_sig: string;
  status: "open" | "solved";
  fix: string;
  source_ref: string;
  helped_bot_ids: string[];
  created_at: number;
  updated_at: number;
  pc_id: string;
  author?: BoardAuthor;
  lesson?: ForumLesson;
}

/** The user's Forum replies carry this author id. */
export const BOARD_USER = "user";
/** Mirrors ownReply in server/board.ts: only replies typed in the Forum's box can be deleted. */
export const isOwnReply = (post: BoardPost) => post.author_bot_id === BOARD_USER && post.source_ref.startsWith("reply:");

/** The sidebar selection for the Forum. It never matches a bot, group or room id. */
export const FORUM_SELECTION = "forum:board";
export const isForumSelection = (selectedId: string) => selectedId === FORUM_SELECTION;
/** Server frames say the Board changed; the open Forum reloads. */
export const BOARD_CHANGED_EVENT = "orbit:board";

/** Top-level posts newest first, each with every post under it, replies to replies included, oldest first. */
export function boardThreads(posts: readonly BoardPost[]): Array<{ post: BoardPost; replies: BoardPost[] }> {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const rootOf = (post: BoardPost) => {
    const seen = new Set<string>();
    let at = post;
    for (let up = at.parent_id ? byId.get(at.parent_id) : undefined; up && !seen.has(up.id); up = up.parent_id ? byId.get(up.parent_id) : undefined) {
      seen.add(at.id);
      at = up;
    }
    return at;
  };
  const roots = posts.filter((post) => rootOf(post) === post).sort((a, b) => b.created_at - a.created_at);
  return roots.map((post) => ({
    post,
    replies: posts.filter((reply) => reply !== post && rootOf(reply) === post).sort((a, b) => a.created_at - b.created_at),
  }));
}

export interface BoardReply {
  post: BoardPost;
  replies: BoardReply[];
}

/** A thread's replies as a tree; a reply whose parent is missing hangs off the post. */
export function boardReplyTree(post: BoardPost, replies: readonly BoardPost[]): BoardReply[] {
  const ids = new Set(replies.map((reply) => reply.id));
  const under = (id: string): BoardReply[] => replies
    .filter((reply) => (reply.parent_id && ids.has(reply.parent_id) ? reply.parent_id : post.id) === id)
    .map((reply) => ({ post: reply, replies: under(reply.id) }));
  return under(post.id);
}

const HOUR = 3_600_000;

/** Reddit's three sorts: Hot weighs helped and replies against age, New is newest, Top is most helped. */
export function sortBoardThreads<T extends { post: BoardPost; replies: readonly BoardPost[] }>(threads: readonly T[], sort: BoardSort, now: number): T[] {
  const helped = (thread: T) => thread.post.helped_bot_ids.length;
  const hot = (thread: T) => (helped(thread) + thread.replies.length + 1) / (Math.max(0, now - thread.post.created_at) / HOUR + 2) ** 1.5;
  const score = sort === "hot" ? hot : sort === "top" ? helped : () => 0;
  return [...threads].sort((a, b) => score(b) - score(a) || b.post.created_at - a.post.created_at);
}

/** clientId stays the same for a retry of the same reply, so a reply saved before its answer was lost is not posted twice. */
export const replyToBoard = (parentId: string, body: string, clientId: string): Promise<{ post: BoardPost }> =>
  request("/api/board/reply", { method: "POST", body: JSON.stringify({ parent_id: parentId, body, client_id: clientId }) });

export const deleteFromBoard = (id: string): Promise<{ id: string }> =>
  request("/api/board/delete", { method: "POST", body: JSON.stringify({ id }) });

/** What the Forum showed, kept while it is closed: a chat visit returns to the same posts, sort, filter and open post. */
export interface ForumKept {
  posts: BoardPost[] | null;
  sort: BoardSort;
  flair: BoardKind | null;
  openId: string | null;
}
export const forumKept: ForumKept = { posts: null, sort: "hot", flair: null, openId: null };

export interface BoardPostsView {
  posts: BoardPost[] | null;
  failed: boolean;
  saved: (post: BoardPost) => void;
  removed: (post: BoardPost) => void;
  retry: () => void;
}

export function useBoardPosts(): BoardPostsView {
  const [posts, setPosts] = useState(() => forumKept.posts);
  const [failed, setFailed] = useState(false);
  // only the newest load lands: an older one finishing late would drop posts the newer one has
  const asked = useRef(0);
  // a reply saved here stays until a load carries it, since that load may have been asked before the save
  const mine = useRef(new Map<string, BoardPost>());
  // a deleted reply stays gone, even from a load asked before the delete or with the live link down
  const gone = useRef(new Map<string, string | null>());
  // replies under a deleted post move up to its parent, as the server moves them
  const lift = useCallback((post: BoardPost) => {
    let parent = post.parent_id;
    while (parent && gone.current.has(parent)) parent = gone.current.get(parent)!;
    return parent === post.parent_id ? post : { ...post, parent_id: parent };
  }, []);
  const reload = useRef(() => {});
  useEffect(() => {
    let live = true;
    const load = () => {
      const seq = ++asked.current;
      request("/api/board").then(
        (body: { posts?: BoardPost[] }) => {
          if (!live || seq !== asked.current) return;
          const list = (Array.isArray(body?.posts) ? body.posts : []).filter((post) => !gone.current.has(post.id));
          for (const post of list) mine.current.delete(post.id);
          setPosts((forumKept.posts = [...list, ...mine.current.values()].map(lift)));
          setFailed(false);
        },
        () => live && seq === asked.current && setFailed(true),
      );
    };
    reload.current = load;
    load();
    window.addEventListener(BOARD_CHANGED_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(BOARD_CHANGED_EVENT, load);
    };
  }, [lift]);
  const saved = useCallback((post: BoardPost) => {
    mine.current.set(post.id, post);
    setPosts((now) => (forumKept.posts = [...(now ?? []).filter((held) => held.id !== post.id), post]));
  }, []);
  const removed = useCallback((post: BoardPost) => {
    gone.current.set(post.id, post.parent_id);
    mine.current.delete(post.id);
    setPosts((now) => (forumKept.posts = (now ?? []).filter((held) => held.id !== post.id).map(lift)));
  }, [lift]);
  const retry = useCallback(() => reload.current(), []);
  return { posts, failed, saved, removed, retry };
}
