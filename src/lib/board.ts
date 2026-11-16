import { useEffect, useState } from "react";

import { request } from "./api-request";

export type BoardKind = "stuck" | "fix" | "handoff";

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
