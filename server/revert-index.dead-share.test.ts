import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRevertIndex } from "./revert-index.ts";
import { removeTempDir } from "./testing/cleanup.ts";

// a folder on an unreachable share: a sync read stalls the thread, an async one never answers or fails late
const state = vi.hoisted(() => ({ calls: 0, dead: 0, mode: "hang" as "hang" | "fail", isDead: (path: unknown) => String(path).includes("192.0.2.1") }));
const unreachable = () => Object.assign(new Error("ETIMEDOUT: share unreachable"), { code: "ETIMEDOUT" });

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const stall = (real: (...args: never[]) => unknown) => (...args: never[]) => {
    state.calls += 1;
    if (!state.isDead(args[0])) return real(...args);
    state.dead += 1;
    for (const end = Date.now() + 200; Date.now() < end;);
    throw unreachable();
  };
  const reads = { statSync: stall(fs.statSync), readFileSync: stall(fs.readFileSync), existsSync: stall(fs.existsSync), readdirSync: stall(fs.readdirSync) };
  return { ...fs, ...reads, default: { ...fs, ...reads } };
});
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const late = (real: (...args: never[]) => Promise<unknown>) => (...args: never[]) => {
    state.calls += 1;
    if (!state.isDead(args[0])) return real(...args);
    state.dead += 1;
    return state.mode === "hang" ? new Promise(() => {}) : Promise.reject(unreachable());
  };
  const reads = { stat: late(fs.stat), readFile: late(fs.readFile), readdir: late(fs.readdir) };
  return { ...fs, ...reads, default: { ...fs, ...reads } };
});

const DEAD = process.platform === "win32" ? String.raw`\\192.0.2.1\share\x` : "//192.0.2.1/share/x";
// a slow folder that is not a network string: network folders are never probed
const SLOW = process.platform === "win32" ? String.raw`C:\192.0.2.1\share\x` : "/192.0.2.1/share/x";
const NOW = Date.parse("2026-11-24T04:00:00Z");
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const commit = (sha: string, when: string, subject: string, body: string, files: string[]) => `\x1e${sha.padEnd(40, "0")}\x1f${at(when)}\x1f${subject}\x1f${body}\x1f\n\n${files.join("\n")}\n`;
const LOG = commit("6cf938e74", "2026-11-14T10:56:00Z", "revert: Live Verify load wait fails healthy animated pages (#1595)", "Reverts #1587.", ["electron/verify-cast.mjs"])
  + commit("7500e57b0", "2026-11-14T10:01:00Z", "fix: Live Verify checks a slow page once it has loaded (#1587)", "", ["electron/verify-cast.mjs"]);
const CARD = "## Purpose\nSharpen electron/verify-cast.mjs:20 frames.\n";

const timerWait = () => new Promise<number>((done) => {
  const start = performance.now();
  setTimeout(() => done(performance.now() - start), 0);
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeTempDir(root); });

describe("revert index on a folder whose fs never answers", () => {
  it("leaves the server free at a refresh and at a launch", async () => {
    state.mode = "hang";
    const index = createRevertIndex({ git: async () => LOG, now: () => NOW });
    const waited = timerWait();
    void index.refresh(DEAD);
    void index.hit(DEAD, CARD);
    expect(await waited).toBeLessThan(50);
  });

  it("keeps one home probe in flight per folder", async () => {
    state.mode = "hang";
    const index = createRevertIndex({ git: async () => LOG, now: () => NOW });
    const before = state.dead;
    for (let turn = 0; turn < 3; turn += 1) {
      void index.refresh(SLOW);
      void index.hit(SLOW, CARD);
    }
    await timerWait();
    expect(state.dead - before).toBe(1);
  });

  it("probes a folder that failed again only after the interval", async () => {
    state.mode = "fail";
    let now = NOW;
    const index = createRevertIndex({ git: async () => LOG, now: () => now });
    const before = state.dead;
    await index.refresh(SLOW);
    const probed = state.dead;
    expect(probed).toBeGreaterThan(before);
    await index.refresh(SLOW);
    expect(await index.hit(SLOW, CARD)).toBeUndefined();
    expect(state.dead).toBe(probed);
    now += 10 * 60_000;
    await index.refresh(SLOW);
    expect(state.dead).toBeGreaterThan(probed);
  });

  it("answers a launch in a folder it has seen with no fs call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "revert-seen-"));
    roots.push(dir);
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    const index = createRevertIndex({ git: async () => LOG, now: () => NOW });
    await index.refresh(dir);
    const before = state.calls;
    expect((await index.hit(dir, CARD))?.revert.pr).toBe(1595);
    expect(state.calls).toBe(before);
  });
});
