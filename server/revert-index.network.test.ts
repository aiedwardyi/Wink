import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRevertIndex } from "./revert-index.ts";
import { removeTempDir } from "./testing/cleanup.ts";

// libuv runs fs calls on 4 threads: a call on a dead share holds one for good, every other call queues behind them
const pool = vi.hoisted(() => {
  const state = { free: 4, waiting: [] as (() => void)[], dead: 0 };
  const take = () => state.free > 0 ? (state.free -= 1, Promise.resolve()) : new Promise<void>((go) => state.waiting.push(go));
  const give = () => { const next = state.waiting.shift(); if (next) next(); else state.free += 1; };
  return { state, take, give };
});

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const threaded = (real: (...args: never[]) => Promise<unknown>) => async (...args: never[]) => {
    await pool.take();
    if (String(args[0]).includes("dead-host")) {
      pool.state.dead += 1;
      return new Promise(() => {});
    }
    try { return await real(...args); } finally { pool.give(); }
  };
  const reads = { stat: threaded(fs.stat), readFile: threaded(fs.readFile), readdir: threaded(fs.readdir) };
  return { ...fs, ...reads, default: { ...fs, ...reads } };
});

const NOW = Date.parse("2026-11-24T04:00:00Z");
const share = (host: number) => process.platform === "win32" ? String.raw`\\dead-host${host}\share\x` : `//dead-host${host}/share/x`;

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });

describe("revert index with bot folders on dead shares", () => {
  it("keeps a local read and a launch in a new local folder fast", async () => {
    const dir = mkdtempSync(join(tmpdir(), "revert-net-"));
    roots.push(dir);
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    const { readFile } = await import("node:fs/promises");
    const index = createRevertIndex({ git: async () => "", now: () => NOW });
    for (let host = 0; host < 5; host += 1) {
      void index.refresh(share(host));
      void index.hit(share(host), "card");
    }
    const start = performance.now();
    const local = Promise.all([readFile(join(dir, ".git", "HEAD"), "utf8"), index.hit(dir, "card")]).then(() => performance.now() - start);
    const waited = await Promise.race([local, new Promise<number>((done) => setTimeout(() => done(Infinity), 500))]);
    expect(waited).toBeLessThan(50);
    expect(pool.state.dead).toBe(0);
  });
});
