// board_search and board_post for bots, and the Forum's read for the app.
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { BOARD_KINDS, BOARD_USER, boardLine, ownReply, REPLY_REF, ROOM_REF, type Board } from "./board.ts";
import { json, readBody } from "./http-helpers.ts";

export const BOARD_ROUTES = { search: "/api/internal/board-search", post: "/api/internal/board-post", list: "/api/board", reply: "/api/board/reply", remove: "/api/board/delete" } as const;

const searchSchema = z.object({ query: z.string().trim().min(1).max(200), project_id: z.string().trim().max(160).optional() }).strict();
const postSchema = z.object({
  kind: z.enum(BOARD_KINDS),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
  parent_id: z.string().trim().min(1).max(64).optional(),
  helped: z.boolean().optional(),
}).strict();
const replySchema = z.object({ parent_id: z.string().trim().min(1).max(64), body: z.string().trim().min(1).max(4000) }).strict();
const removeSchema = z.object({ id: z.string().trim().min(1).max(64) }).strict();

export interface BoardRouteDeps {
  board: Board;
  caller(header: string | string[] | undefined): { botId: string; threadId: string } | undefined;
  known(botId: string): boolean;
  projectOf(threadId: string): string;
  /** "read-only" while someone without "Can make bots work" asked for the caller's turn; "room" on any other team room turn. */
  roomTurn(from: { botId: string; threadId: string }): "read-only" | "room" | null;
}

export function createBoardRoutes(deps: BoardRouteDeps) {
  const source = (req: IncomingMessage) => {
    const from = deps.caller(req.headers.authorization);
    return from && deps.known(from.botId) ? from : undefined;
  };
  return {
    async search(req: IncomingMessage, res: ServerResponse) {
      const from = source(req);
      if (!from) return json(res, 403, { error: "unknown sender" });
      const body = searchSchema.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "board_search needs a query" });
      const room = deps.roomTurn(from);
      const posts = deps.board.search({ query: body.data.query, projectId: body.data.project_id || deps.projectOf(from.threadId), ...(room ? { roomThread: from.threadId } : {}) });
      return json(res, 200, { count: posts.length, text: posts.length ? posts.map((post) => boardLine(post)).join("\n\n") : "No Board posts match." });
    },
    async post(req: IncomingMessage, res: ServerResponse) {
      const from = source(req);
      if (!from) return json(res, 403, { error: "unknown sender" });
      const room = deps.roomTurn(from);
      if (room === "read-only") return json(res, 403, { error: "board_post is unavailable: the host has to turn on \"Can make bots work\" for whoever asked" });
      const body = postSchema.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "board_post needs kind (stuck, fix, tip or handoff), title and body" });
      const { kind, title, body: text, parent_id, helped } = body.data;
      const parent = parent_id ? deps.board.get(parent_id) : undefined;
      if (parent_id && !parent) return json(res, 404, { error: `no Board post ${parent_id}` });
      const event = createHash("sha256").update(JSON.stringify([kind, title, text, parent_id ?? ""])).digest("hex").slice(0, 16);
      const post = deps.board.post({
        author_bot_id: from.botId,
        kind,
        title,
        body: text,
        parent_id: parent?.id ?? null,
        project_id: parent?.project_id ?? deps.projectOf(from.threadId),
        error_sig: parent?.error_sig,
        fix: kind === "fix" ? text : undefined,
        source_ref: `${room ? ROOM_REF : "tool:"}${from.threadId}:${event}`,
      });
      if (helped && parent && parent.author_bot_id !== from.botId) deps.board.helped([parent.id], from.botId);
      return json(res, 200, { id: post.id, text: `Posted to the Board as ${post.id}.` });
    },
    list(res: ServerResponse) {
      return json(res, 200, { posts: deps.board.list() });
    },
    /** The user's reply in the Forum: an ordinary post under the one it answers, never a fix that solves it. */
    async reply(req: IncomingMessage, res: ServerResponse) {
      const body = replySchema.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "a reply needs parent_id and body" });
      const parent = deps.board.get(body.data.parent_id);
      if (!parent) return json(res, 404, { error: `no Board post ${body.data.parent_id}` });
      const post = deps.board.post({
        author_bot_id: BOARD_USER,
        kind: "tip",
        title: parent.title,
        body: body.data.body,
        parent_id: parent.id,
        project_id: parent.project_id,
        source_ref: `${REPLY_REF}${randomUUID()}`,
      });
      return json(res, 200, { post });
    },
    /** The user deletes only what they typed in the Forum's reply box. */
    async remove(req: IncomingMessage, res: ServerResponse) {
      const body = removeSchema.safeParse(await readBody(req));
      if (!body.success) return json(res, 400, { error: "a delete needs id" });
      const post = deps.board.get(body.data.id);
      if (!post) return json(res, 404, { error: `no Board post ${body.data.id}` });
      if (!ownReply(post)) return json(res, 403, { error: "only your own replies can be deleted" });
      deps.board.remove(post.id);
      return json(res, 200, { id: post.id });
    },
  };
}
