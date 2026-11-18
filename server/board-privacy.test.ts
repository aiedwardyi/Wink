// A teammate's bot in a shared room searches its own Wink's Board; the owner's posts never reach it.
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { BOARD_USER, createBoard, ROOM_REF } from "./board.ts";
import { createBoardRoutes } from "./board-routes.ts";
import { createTempDirs } from "./testing/cleanup.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

/** One Wink: its own data folder, its own bots, and a caller token per running turn. */
function wink(pc: string, bots: Record<string, string>) {
  const board = createBoard({ dir: join(temps.make(join(tmpdir(), `orbit-${pc}-`)), "board"), pcId: () => pc });
  const routes = createBoardRoutes({
    board,
    caller: (header) => {
      const token = String(header ?? "").replace(/^Bearer /, "");
      return bots[token] ? { botId: bots[token]!, threadId: `room-${pc}` } : undefined;
    },
    known: (botId) => Object.values(bots).includes(botId),
    projectOf: () => "",
    roomTurn: () => null,
  });
  return { board, routes };
}

async function search(routes: ReturnType<typeof createBoardRoutes>, token: string, query: string) {
  let status = 0;
  let body = "";
  const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { authorization: `Bearer ${token}` };
  const pending = routes.search(req, res);
  req.emit("data", JSON.stringify({ query }));
  req.emit("end");
  await pending;
  return { status, ...(JSON.parse(body) as { count?: number; text?: string; error?: string }) };
}

function list(routes: ReturnType<typeof createBoardRoutes>) {
  let body = "";
  routes.list({ writeHead() {}, end(text: string) { body = text; } } as unknown as ServerResponse);
  return (JSON.parse(body) as { posts: Array<{ id: string; parent_id: string | null; fix: string; body: string }> }).posts;
}

describe("board privacy", () => {
  it("a teammate's bot in a shared room gets 0 of the owner's posts", async () => {
    const owner = wink("owner-pc", { "tok-astra": "astra" });
    const teammate = wink("teammate-pc", { "tok-nova": "nova" });
    owner.board.post({ author_bot_id: "astra", kind: "stuck", title: "Codex usage limit on the eval box", body: "Codex usage limit", source_ref: "call:t1:engine:limit" });
    owner.board.solve(owner.board.list()[0]!.id, "Use the owner's Claude account, password in the vault.");
    expect((await search(owner.routes, "tok-astra", "codex usage limit")).count).toBe(1);

    // the teammate's bot runs on the teammate's PC, against that Wink's Board
    const own = await search(teammate.routes, "tok-nova", "codex usage limit");
    expect(own).toMatchObject({ status: 200, count: 0 });
    expect(own.text).not.toContain("vault");
    // and the owner's Wink answers no caller it did not start
    const asked = await search(owner.routes, "tok-nova", "codex usage limit");
    expect(asked).toMatchObject({ status: 403 });
    expect(JSON.stringify(asked)).not.toContain("vault");
  });

  it("chat answers saved before stay on disk but out of the list, the post, its replies and search, rooms too", async () => {
    const { board, routes } = wink("home", { "tok-astra": "astra" });
    const CHAT = "coool it worked, now push the branch to staging";
    const ROOM_CHAT = "teammates please use the staging seat for rehearsal";
    const stuck = board.post({ author_bot_id: "astra", kind: "stuck", title: "Stuck on the staging deploy", body: "Stuck on the staging deploy", source_ref: "call:ta:0:engine:deploy" });
    const roomStuck = board.post({ author_bot_id: "astra", kind: "stuck", title: "Stuck on the rehearsal seat", body: "Stuck on the rehearsal seat", source_ref: `${ROOM_REF}tr:seat` });
    // what answering a call wrote before: the user's chat as a fix, copied into the stuck post too
    const answers = [[stuck, CHAT, "m1"], [roomStuck, ROOM_CHAT, "m2"]] as const;
    const copied = answers.map(([parent, text, id]) => board.post({ author_bot_id: BOARD_USER, parent_id: parent.id, kind: "fix", title: parent.title, body: text, fix: text, source_ref: `answer:${id}:${parent.id}` }));
    const reply = board.post({ author_bot_id: BOARD_USER, parent_id: stuck.id, kind: "tip", title: stuck.title, body: "Thanks Astra, that read well.", source_ref: "reply:r1" });
    const botFix = board.post({ author_bot_id: "astra", parent_id: roomStuck.id, kind: "tip", title: roomStuck.title, body: "Seat rotation notes.", source_ref: "tool:tr:notes" });

    for (const shown of [board, createBoard({ dir: board.dir, pcId: () => "home" })]) {
      expect(shown.list().map((post) => post.id).sort()).toEqual([stuck.id, roomStuck.id, reply.id, botFix.id].sort());
      expect(shown.get(stuck.id)).toMatchObject({ status: "solved", fix: "" });
      expect(shown.get(roomStuck.id)).toMatchObject({ status: "solved", fix: "" });
      for (const post of copied) expect(shown.get(post.id)).toBeUndefined();
      for (const text of [CHAT, ROOM_CHAT]) {
        expect(JSON.stringify(shown.list())).not.toContain(text);
        const hits = shown.search({ query: text });
        expect(hits.map((post) => post.id)).not.toContain(copied[0]!.id);
        expect(hits.map((post) => post.id)).not.toContain(copied[1]!.id);
        expect(JSON.stringify(hits)).not.toContain(text);
      }
    }
    const posts = list(routes);
    expect(posts.filter((post) => post.parent_id === stuck.id).map((post) => post.id)).toEqual([reply.id]);
    expect(posts.filter((post) => post.parent_id === roomStuck.id).map((post) => post.id)).toEqual([botFix.id]);
    expect(JSON.stringify(posts)).not.toContain(CHAT);
    for (const text of [CHAT, ROOM_CHAT]) expect((await search(routes, "tok-astra", text)).text).not.toContain(text);
    for (const post of copied) expect(existsSync(join(board.dir, `${post.id}.json`))).toBe(true);
  });
});
