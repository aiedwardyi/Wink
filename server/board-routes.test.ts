import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createBoard } from "./board.ts";
import { createBoardRoutes } from "./board-routes.ts";
import { createTempDirs } from "./testing/cleanup.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

describe("board_post", () => {
  it("a fix solves its parent with one change broadcast", async () => {
    let changes = 0;
    const board = createBoard({ dir: join(temps.make(join(tmpdir(), "orbit-board-routes-")), "board"), pcId: () => "home", changed: () => changes++ });
    const routes = createBoardRoutes({ board, caller: () => ({ botId: "astra", threadId: "ta" }), known: () => true, projectOf: () => "wink" });
    const stuck = board.post({ author_bot_id: "astra", kind: "stuck", title: "Codex usage limit", body: "Codex usage limit", source_ref: "call:ta:0:engine:limit" });
    changes = 0;
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end() {} } as unknown as ServerResponse;
    const req = new EventEmitter() as IncomingMessage;
    req.headers = { authorization: "Bearer tok" };
    const pending = routes.post(req, res);
    req.emit("data", JSON.stringify({ kind: "fix", title: "Codex usage limit", body: "Use Claude.", parent_id: stuck.id }));
    req.emit("end");
    await pending;
    expect(status).toBe(200);
    expect(changes).toBe(1);
    expect(board.get(stuck.id)).toMatchObject({ status: "solved", fix: "Use Claude." });
  });
});
