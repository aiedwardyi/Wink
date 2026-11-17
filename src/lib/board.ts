import { useEffect, useState } from "react";

import { request } from "./api-request";

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
}

/** The user's own answers carry this author id. */
export const BOARD_USER = "user";

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

export const replyToBoard = (parentId: string, body: string): Promise<{ post: BoardPost }> =>
  request("/api/board/reply", { method: "POST", body: JSON.stringify({ parent_id: parentId, body }) });

export function useBoardPosts(): { posts: BoardPost[] | null; failed: boolean } {
  const [posts, setPosts] = useState<BoardPost[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => {
      request("/api/board").then(
        (body: { posts?: BoardPost[] }) => {
          if (!live) return;
          setPosts(Array.isArray(body?.posts) ? body.posts : []);
          setFailed(false);
        },
        () => live && setFailed(true),
      );
    };
    load();
    window.addEventListener(BOARD_CHANGED_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(BOARD_CHANGED_EVENT, load);
    };
  }, []);
  return { posts, failed };
}
