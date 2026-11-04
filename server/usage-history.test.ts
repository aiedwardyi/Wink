import * as fs from "node:fs";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { drivePathRule } from "./drive-mirror.ts";
import { createUsageHistory } from "./usage-history.ts";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));

let root: string;
let now: number;
let scheduled: Array<{ callback: () => void; delayMs: number }>;
const minute = 60_000;
const origin = Date.UTC(2026, 10, 4);
const options = () => ({ now: () => now, schedule: (callback: () => void, delayMs: number) => { scheduled.push({ callback, delayMs }); } });
const file = () => join(root, "usage-history.json");
const read = () => JSON.parse(fs.readFileSync(file(), "utf8"));

beforeEach(() => {
  const scratch = join(tmpdir(), "wink-BOARD-TYPES");
  fs.mkdirSync(scratch, { recursive: true });
  root = fs.mkdtempSync(join(scratch, "history-"));
  now = origin;
  scheduled = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("usage history", () => {
  it.each(["claude.fixture", "a".repeat(128)])("persists valid instance id %s through a restart", async (accountId) => {
    const history = createUsageHistory(root, options());
    history.record(accountId, 1, origin, 20, 30);
    const event = history.event(accountId, { kind: "main", at: origin, from: "claude", to: accountId });
    expect(history.snapshot().accounts[accountId]?.fine).toEqual([[origin / minute, 20, 30]]);
    expect(event).toMatchObject({ kind: "main", to: accountId });
    await history.flush();
    expect(createUsageHistory(root, options()).snapshot()).toMatchObject({
      accounts: { [accountId]: { generation: 1, fine: [[origin / minute, 20, 30]] } },
      events: { [accountId]: [{ kind: "main", at: origin, from: "claude", to: accountId }] },
    });
  });

  it("keeps 288 five-minute and 168 hourly points per account", () => {
    const history = createUsageHistory(root, options());
    for (let i = 0; i < 9 * 24 * 12; i++) history.record("claude", 0, origin + i * 5 * minute, 12.345, 45.678);
    const account = history.snapshot().accounts.claude;
    expect(account.fine).toHaveLength(288);
    expect(account.coarse).toHaveLength(168);
    expect(account.fine.at(-1)).toEqual([origin / minute + (9 * 24 * 12 - 1) * 5, 12.3, 45.7]);
    expect(account.coarse.at(-1)?.[0]).toBe(Math.floor(account.fine.at(-1)![0] / 60) * 60);
    history.record("claude", 0, origin + 20 * 24 * 60 * minute, null, 70);
    expect(history.snapshot().accounts.claude.fine).toHaveLength(1);
    expect(history.snapshot().accounts.claude.coarse).toHaveLength(1);
  });

  it("bounds maximum-size events and recovers from a failed atomic write", async () => {
    const history = createUsageHistory(root, options());
    for (let i = 0; i < 100; i++) history.event("claude", {
      kind: "moved", at: origin + i, from: "a".repeat(96), to: "b".repeat(96), accountId: "c".repeat(96),
      window: "w".repeat(64), paneId: "p".repeat(96), label: "🍌".repeat(24),
    });
    expect(history.snapshot().events.claude).toHaveLength(64);
    expect(history.snapshot().events.claude[0].seq).toBe(37);
    expect(history.event("claude", { kind: "main", at: origin, label: "x".repeat(25) })).toBeUndefined();
    await history.flush();
    const committed = fs.readFileSync(file(), "utf8");
    history.record("claude", 0, origin, 20, 30);
    now += 30_000;
    vi.spyOn(files, "rename").mockRejectedValueOnce(new Error("locked"));
    await expect(history.flush()).resolves.toBeUndefined();
    expect(fs.readFileSync(file(), "utf8")).toBe(committed);
    expect(fs.readdirSync(root)).toEqual(["usage-history.json"]);
    now += 30_000;
    await history.flush();
    expect(read().accounts.claude.fine).toEqual([[origin / minute, 20, 30]]);
  });

  it("stays under 256 KB with 18 full accounts and 24-character labels", async () => {
    const history = createUsageHistory(root, options());
    const ids = Array.from({ length: 18 }, (_, i) => `acct_00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    for (const accountId of ids) {
      for (let i = 0; i < 168; i++) history.record(accountId, 1, origin + i * 60 * minute, 99.9, 88.8);
      for (let i = 0; i < 288; i++) history.record(accountId, 1, origin + (167 * 60 + i * 5) * minute, 99.9, 88.8);
    }
    for (const base of ["claude", "codex"]) {
      for (let i = 0; i < 64; i++) history.event(base, {
        kind: "auto", at: origin + i, from: ids[0], to: ids[1], accountId: ids[2],
        paneId: "p".repeat(96), window: "w".repeat(64), label: "🍌".repeat(24),
      });
    }
    const snapshot = history.snapshot();
    expect(Object.values(snapshot.accounts).every((account) => account.fine.length === 288)).toBe(true);
    expect(Object.values(snapshot.accounts).every((account) => account.coarse.length === 168)).toBe(true);
    expect(snapshot.events.claude).toHaveLength(64);
    expect(snapshot.events.codex).toHaveLength(64);
    await history.flush();
    const size = fs.statSync(file()).size;
    expect(size).toBeLessThanOrEqual(256 * 1024);
    for (const base of ["grok", "gemini", "muse"]) {
      for (let i = 0; i < 64; i++) history.event(base, {
        kind: "moved", at: origin + 100 + i, from: "a".repeat(96), to: "b".repeat(96), accountId: "c".repeat(96),
        paneId: "p".repeat(96), window: "w".repeat(64), label: "🍌".repeat(24),
      });
    }
    const pressured = history.snapshot();
    expect(Object.values(pressured.accounts).every((account) => account.fine.length === 288 && account.coarse.length === 0)).toBe(true);
    expect(Object.values(pressured.events).flat().length).toBeLessThan(320);
    expect(pressured.events.muse.at(-1)?.seq).toBe(320);
    history.record(ids[0], 1, origin + (167 * 60 + 287 * 5) * minute, 1, 2);
    expect(history.snapshot()).toEqual(pressured);
    now += 30_000;
    await history.flush();
    expect(fs.statSync(file()).size).toBeLessThanOrEqual(256 * 1024);
  });

  it("purges history from a removed account and a prior sign-in generation", async () => {
    const history = createUsageHistory(root, options());
    history.record("acct-one", 1, origin, 90, 80);
    history.record("acct-two", 1, origin, 10, 20);
    for (const base of ["claude", "codex"]) {
      history.event(base, { kind: "main", at: origin, from: "acct-one", to: "acct-two" });
      history.event(base, { kind: "reset", at: origin, accountId: "acct-one" });
      history.event(base, { kind: "main", at: origin, from: "acct-two", to: "acct-one" });
      history.event(base, { kind: "limit", at: origin, accountId: "acct-two" });
    }
    history.record("acct-one", 2, origin, 1, 2);
    history.record("acct-one", 1, origin + minute, 99, 99);
    expect(history.snapshot().accounts["acct-one"]).toEqual({ generation: 2, fine: [[origin / minute, 1, 2]], coarse: [[origin / minute, 1, 2]] });
    expect(Object.values(history.snapshot().events).every((events) => events.length === 1 && events[0].accountId === "acct-two")).toBe(true);
    history.purge("acct-one");
    expect(history.snapshot().accounts["acct-one"]).toBeUndefined();
    history.purge("acct-two");
    await history.flush();
    expect(read()).toMatchObject({ accounts: {}, events: { claude: [], codex: [] }, seq: 8 });
  });

  it("evicts coarse points, then events, then the oldest fine points under pressure", async () => {
    const accounts = Object.fromEntries(Array.from({ length: 40 }, (_, i) => {
      const end = origin / minute + i * 24 * 60;
      return [`acct-${i}`, {
        generation: 1,
        fine: Array.from({ length: 288 }, (_, n) => [end - (287 - n) * 5, 1_000_000, 1_000_000]),
        coarse: Array.from({ length: 168 }, (_, n) => [end - (167 - n) * 60, 1_000_000, 1_000_000]),
      }];
    }));
    const events = { claude: Array.from({ length: 64 }, (_, i) => ({ seq: i + 1, at: origin + i, kind: "main", to: "acct-39" })) };
    fs.writeFileSync(file(), JSON.stringify({ version: 1, accounts, events, seq: 64 }));
    const history = createUsageHistory(root, options());
    const snapshot = history.snapshot();
    expect(Object.values(snapshot.accounts).every((account) => account.coarse.length === 0)).toBe(true);
    expect(snapshot.events.claude).toEqual([]);
    expect(snapshot.accounts["acct-0"].fine).toEqual([]);
    expect(snapshot.accounts["acct-39"].fine).toHaveLength(288);
    await history.flush();
    expect(fs.statSync(file()).size).toBeLessThanOrEqual(256 * 1024);
    expect(fs.existsSync(`${file()}.bad`)).toBe(false);
  });

  it("round-trips through a restart and sets aside a corrupt or unknown-version file", async () => {
    const history = createUsageHistory(root, options());
    history.record("claude", 0, origin, 12.3, null);
    history.event("claude", { kind: "reset", at: origin, accountId: "claude", window: "five_hour" });
    await history.flush();
    const restarted = createUsageHistory(root, options());
    expect(restarted.snapshot()).toEqual({ ...history.snapshot(), counter: 0 });
    expect(restarted.since()).toEqual(restarted.snapshot());
    expect(restarted.event("claude", { kind: "main", at: origin, to: "claude" })?.seq).toBe(2);
    for (const bad of ["{broken", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, accounts: {}, events: {}, seq: "wrong" })]) {
      fs.writeFileSync(file(), bad);
      expect(createUsageHistory(root, options()).snapshot()).toMatchObject({ accounts: {}, events: {}, seq: 0 });
      expect(fs.readFileSync(`${file()}.bad`, "utf8")).toBe(bad);
      expect(fs.existsSync(file())).toBe(false);
    }
  });

  it("keeps usage-history.json and its temp and bad files off Drive", async () => {
    const history = createUsageHistory(root, options());
    const ids = { profileDeviceId: "test-device", writerId: "test-writer", memoryDeviceId: "a".repeat(12) };
    const rename = files.rename;
    const paths = ["usage-history.json", "usage-history.json.bad"];
    vi.spyOn(files, "rename").mockImplementation(async (from, to) => {
      paths.push(String(from).slice(root.length + 1));
      await rename(from, to);
    });
    history.record("claude", 0, origin, 0, 1);
    await history.flush();
    expect(paths).toHaveLength(3);
    for (const path of paths) expect(drivePathRule(path, ids)).toBe("unknown");
  });

  it("returns only buckets and events changed since a counter", () => {
    const history = createUsageHistory(root, options());
    history.record("claude", 0, origin, 10, 20);
    history.record("codex", 0, origin, null, 30);
    history.event("claude", { kind: "main", at: origin, to: "claude" });
    const cursor = history.snapshot().counter;
    history.record("claude", 0, origin + minute, 11, 21);
    history.event("claude", { kind: "reset", at: origin + 1, accountId: "claude" });
    const delta = history.since(cursor);
    expect(delta.accounts).toEqual({ claude: { generation: 0, fine: [[origin / minute, 11, 21]], coarse: [[origin / minute, 11, 21]] } });
    expect(delta.events.claude.map((event) => event.seq)).toEqual([2]);
    expect(history.since(delta.counter)).toMatchObject({ accounts: {}, events: {} });
    expect(history.since(-1)).toEqual(history.snapshot());
    delta.accounts.claude.fine[0][1] = 999;
    expect(history.snapshot().accounts.claude.fine[0][1]).toBe(11);
  });

  it("never records a repeated observation twice", async () => {
    const history = createUsageHistory(root, options());
    history.record("claude", 0, origin, 10, 20);
    const snapshot = history.snapshot();
    history.record("claude", 0, origin, 80, 90);
    expect(history.snapshot()).toEqual(snapshot);
    history.record("claude", 0, origin + 6 * minute, 30, 40);
    const latest = history.snapshot();
    history.record("claude", 0, origin, 50, 60);
    expect(history.snapshot()).toEqual(latest);
    await history.flush();
    const restarted = createUsageHistory(root, options());
    restarted.record("claude", 0, origin + 6 * minute, 30, 40);
    expect(restarted.snapshot().counter).toBe(0);
  });

  it("uses report time and lets the latest observation in each bucket win", () => {
    const history = createUsageHistory(root, options());
    history.record("claude", 0, origin + 9 * minute, 20, 30);
    history.record("claude", 0, origin + minute, 5, 6);
    history.record("claude", 0, origin + 8 * minute, 80, 90);
    expect(history.snapshot().accounts.claude).toEqual({
      generation: 0, fine: [[origin / minute, 5, 6], [origin / minute + 5, 20, 30]], coarse: [[origin / minute, 20, 30]],
    });
  });

  it("writes off the request at most once per 30 seconds", async () => {
    const history = createUsageHistory(root, options());
    history.record("claude", 0, origin, 1, 2);
    expect(fs.existsSync(file())).toBe(false);
    expect(scheduled).toHaveLength(1);
    const first = scheduled.shift()!;
    expect(first.delayMs).toBe(0);
    first.callback();
    await history.flush();
    history.record("claude", 0, origin + minute, 3, 4);
    await history.flush();
    expect(read().accounts.claude.fine[0][1]).toBe(1);
    expect(scheduled[0].delayMs).toBe(30_000);
    now += 30_000;
    scheduled.shift()!.callback();
    await history.flush();
    expect(read().accounts.claude.fine[0][1]).toBe(3);
    expect(read()).not.toHaveProperty("counter");
  });

  it("rejects an oversized file before reading it and leaves other files alone", () => {
    fs.writeFileSync(file(), " ".repeat(1024 * 1024 + 1));
    fs.writeFileSync(join(root, "keep.json"), "keep");
    const open = vi.spyOn(fs, "openSync");
    expect(createUsageHistory(root, options()).snapshot().accounts).toEqual({});
    expect(open).not.toHaveBeenCalled();
    expect(fs.statSync(`${file()}.bad`).size).toBe(1024 * 1024 + 1);
    expect(fs.readFileSync(join(root, "keep.json"), "utf8")).toBe("keep");
  });

  it("keeps synthetic identity fields out of history and diagnostics", async () => {
    const local = ["canary", "private", "local"].join("_");
    const domain = ["canary", "private", "invalid"].join(".");
    const identity = `${local}@${domain}`;
    const log = vi.spyOn(console, "warn");
    const history = createUsageHistory(root, options());
    history.record("claude", 0, origin, 10, 20);
    const input = { kind: "main" as const, at: origin, to: "claude", email: identity, identity, domain, local };
    history.event("claude", input);
    history.event("claude", { ...input, label: identity });
    await history.flush();
    const text = [fs.readFileSync(file(), "utf8"), JSON.stringify(history.snapshot()), JSON.stringify(log.mock.calls)].join(" ");
    for (const token of [identity, local, domain]) expect(text).not.toContain(token);
    expect(history.snapshot().events.claude).toHaveLength(1);
  });
});
