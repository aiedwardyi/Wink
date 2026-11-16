// A teammate's bot in a shared room searches its own Wink's Board; the owner's posts never reach it.
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
});
