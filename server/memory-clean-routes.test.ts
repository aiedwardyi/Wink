import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import type { MemoryCleanSummary, MemoryCleanUndoResult } from "./memory-clean.ts";

const load = () => import("./memory-clean-routes.ts");

function response() {
  let status = 0;
  let body: unknown;
  const res = {
    writeHead(code: number) { status = code; },
    end(text: string) { body = JSON.parse(text); },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

async function setup(summary: MemoryCleanSummary = { run: null }, result: MemoryCleanUndoResult = { ok: false, error: "no-run" }) {
  const clean = { summary: vi.fn(() => summary), undo: vi.fn(async () => result) };
  const routes = (await load()).createMemoryCleanRoutes({ bot: (id: string) => id === "b", clean });
  return { routes, clean };
}

describe("memory cleanup routes", () => {
  it("returns run null and 404 for an unknown bot", async () => {
    const { routes } = await setup();
    const res = response();
    routes.get(res.res, "b"); expect(res.status()).toBe(200); expect(res.body()).toEqual({ run: null });
    routes.get(res.res, "missing"); expect(res.status()).toBe(404); expect(res.body()).toEqual({ error: "no such bot" });
  });

  it("returns an undoable run unchanged", async () => {
    const summary: MemoryCleanSummary = { run: { runId: "mc-20261104-12345678", at: 1, files: ["MEMORY.md"], beforeBytes: 20000, afterBytes: 16000, merged: 2, replaced: 0, moved: 3, undoneAt: null, undoable: true } };
    const { routes } = await setup(summary);
    const res = response(); routes.get(res.res, "b"); expect(res.body()).toEqual(summary);
  });

  it.each(["no-run", "busy", "not-newest", "undone"] as const)("maps %s to its status", async (error) => {
    const { routes, clean } = await setup({ run: null }, { ok: false, error });
    const res = response(); const req = new EventEmitter();
    const done = routes.undo(req as IncomingMessage, res.res, "b");
    req.emit("data", JSON.stringify({ runId: "mc-20261104-12345678" })); req.emit("end"); await done;
    expect(clean.undo).toHaveBeenCalledWith("b", "mc-20261104-12345678");
    expect(res.status()).toBe(error === "no-run" ? 404 : 409);
    expect(res.body()).toEqual({ ok: false, error });
  });

  it("returns success with revision and rejects malformed input", async () => {
    const result = { ok: true as const, revision: "abc", restored: 2, skipped: 1 };
    const { routes } = await setup({ run: null }, result);
    const res = response(); const req = new EventEmitter();
    const done = routes.undo(req as IncomingMessage, res.res, "b");
    req.emit("data", '{"runId":"mc-20261104-12345678"}'); req.emit("end"); await done;
    expect(res.status()).toBe(200); expect(res.body()).toEqual(result);
    const bad = new EventEmitter(); const rejected = routes.undo(bad as IncomingMessage, res.res, "b");
    bad.emit("data", "{}"); bad.emit("end"); await rejected; expect(res.status()).toBe(400);
  });
});
