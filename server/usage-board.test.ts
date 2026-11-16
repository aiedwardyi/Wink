import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UsageBoard, UsageBoardFrame } from "../src/lib/usage-board.ts";
import type { RateLimitsReport } from "./rate-limits-store.ts";
import { createUsageBoard } from "./usage-board.ts";
import { createUsageHistory } from "./usage-history.ts";
import { codexRateLimitWindows } from "./drivers/rate-limits.ts";

type Deps = Parameters<typeof createUsageBoard>[0];
type Row = ReturnType<Deps["accounts"]["list"]>[number];
type Runs = Awaited<ReturnType<Deps["runs"]>>;
const origin = Date.UTC(2026, 10, 4, 12);
const added = "acct_00000000-0000-4000-8000-000000000002";
const second = "acct_00000000-0000-4000-8000-000000000003";
let root: string;
let now: number;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function report(used = 20, at = now): RateLimitsReport {
  return { observedAt: new Date(at).toISOString(), windows: [
    { id: "five_hour", usedPercent: used, resetsAt: at + 60_000, windowMinutes: 300 },
    { id: "seven_day", usedPercent: 40, resetsAt: at + 7 * 86_400_000, windowMinutes: 10080 },
  ] };
}

function setup() {
  let rows: Row[] = [
    { id: "claude", of: "claude", driverKind: "claudeAgent", generation: 0, existing: true, state: "ready", status: { state: "available", authenticated: true } },
    { id: added, of: "claude", driverKind: "claudeAgent", generation: 1, existing: false, state: "ready" },
  ];
  let main = "claude";
  const drains: Record<string, Deps["accounts"]["drains"][string]> = {};
  const names = new Map<string, NonNullable<ReturnType<Deps["names"]["get"]>>>([
    ["claude", { id: "claude", engine: "claude", number: 1, nickname: null, name: "Claude 1" }],
    [added, { id: added, engine: "claude", number: 2, nickname: "Studio", name: "Studio" }],
  ]);
  const rateLimits = new Map<string, RateLimitsReport>();
  const schedule = vi.fn();
  const history = createUsageHistory(root, { now: () => now, schedule });
  const runs = vi.fn<Deps["runs"]>(async () => ({ known: true, runs: [] }));
  const bots: ReturnType<Deps["bots"]>[number][] = [
    { id: "atlas", name: "Atlas", base: "claude" }, { id: "mira", name: "Mira", base: "claude" },
  ];
  const deps: Deps = { accounts: { list: () => rows, defaultFor: () => main === "claude" ? undefined : main, drains },
    names: { get: (id) => names.get(id) ?? null }, rateLimits, history, runs, bots: () => bots, now: () => now };
  const board = createUsageBoard(deps);
  const accept = (id: string, value: RateLimitsReport) => { rateLimits.set(id, value); board.recordReport(id, value); };
  return { board, deps, names, rateLimits, history, runs, bots, drains, schedule, accept,
    rows: () => rows, setRows: (value: Row[]) => { rows = value; }, main: (id: string) => { main = id; } };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
it("publishes promo mark changes even when sign-in and generation stay the same", async () => {
  const f = setup();
  f.setRows([{ id: "codex", of: "codex", driverKind: "codex", generation: 0, existing: true, state: "ready" }]);
  let marked = false;
  f.deps.codexPromo = () => marked;
  const before = await f.board.read();
  marked = true;
  const after = await f.board.read(before.cursor);
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(after.engines[0]!.accounts[0]!.codexPromo).toBe(true);
  marked = false;
  const cleared = await f.board.read(after.cursor);
  expect(cleared.revision).toBeGreaterThan(after.revision);
  expect(cleared.engines[0]!.accounts[0]!.codexPromo).toBeUndefined();
});

const account = (board: UsageBoard, id = "claude") => board.engines.flatMap((engine) => engine.accounts).find((row) => row.id === id)!;

beforeEach(() => {
  const scratch = join(tmpdir(), "wink-BOARD-API");
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "board-"));
  now = origin;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("usage board", () => {
  it("drops an old identity's queued history before it drains", async () => {
    const s = setup();
    s.rows()[0].status = { state: "available", authenticated: true, account: "old@example.test" };
    s.accept("claude", report(100));
    s.rows()[0].status = { state: "available", authenticated: true, account: "new@example.test" };
    s.board.sync();
    await settle();
    expect(account(await s.board.read())).toMatchObject({ windows: [], history: { fine: [], coarse: [] } });
  });

  it.each(["claudeAgent", "codex", "grok", "muse", "gemini"])("drops %s windows and history on an identity swap", async (driverKind) => {
    const s = setup();
    s.setRows([{ ...s.rows()[0], driverKind, status: { state: "available", authenticated: true, account: "old@example.test" } }]);
    s.accept("claude", report(100));
    await settle();
    const before = await s.board.read();
    expect(account(before).windows[0].usedPercent).toBe(100);
    expect(account(before).history.fine).not.toEqual([]);
    s.setRows([{ ...s.rows()[0], status: { state: "available", authenticated: true, account: "new@example.test" } }]);
    const after = await s.board.read(before.cursor);
    expect(account(after).windows).toEqual([]);
    expect(account(after).history).toEqual({ fine: [], coarse: [] });
    expect(after.full).toBe(true);
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it.each([undefined, 1440])("records Codex aliases with primary duration %s", async (windowDurationMins) => {
    const s = setup();
    s.setRows([{ id: "codex", of: "codex", driverKind: "codex", generation: 0, existing: false, state: "ready" }]);
    s.accept("codex", { observedAt: new Date(now).toISOString(), windows: codexRateLimitWindows({
      primary: { usedPercent: 24, resetsAt: (now + 60_000) / 1000, windowDurationMins },
      secondary: { usedPercent: 40, resetsAt: (now + 7 * 86_400_000) / 1000 },
    }) });
    await settle();
    const row = account(await s.board.read(), "codex");
    expect(row.windows.map((window) => window.kind)).toEqual([windowDurationMins === undefined ? "session" : "other", "week"]);
    const point = [origin / 60_000, windowDurationMins === undefined ? 24 : null, 40];
    expect(row.history).toEqual({ fine: [point], coarse: [point] });
    expect(s.history.snapshot().accounts.codex).toMatchObject({ fine: [point], coarse: [point] });
  });

  it("rejects reserved instance ids consistently with account storage", async () => {
    const s = setup();
    s.setRows([{ ...s.rows()[0], id: "Constructor", of: "Constructor" }]);
    expect((await s.board.read()).engines).toEqual([]);
  });

  it("returns one row per account with every contract field", async () => {
    const s = setup();
    s.rateLimits.set("claude", report());
    const extra = ["codex", "grok", "gemini", "muse"] as const;
    s.setRows([...s.rows(), ...extra.map((engine) => ({ id: engine, of: engine, driverKind: engine, generation: 0, existing: true, state: "ready" as const }))]);
    const value = await s.board.read();
    expect(Object.keys(value).sort()).toEqual(["at", "cursor", "engines", "full", "revision", "runs", "version"]);
    expect(value).toMatchObject({ version: 1, full: true, runs: "known", at: origin, revision: expect.any(Number), cursor: expect.any(String) });
    expect(value.engines.map((engine) => engine.engine)).toEqual(["claude", ...extra]);
    expect(value.engines.flatMap((engine) => engine.accounts)).toHaveLength(6);
    for (const row of value.engines.flatMap((engine) => engine.accounts)) {
      expect(Object.keys(row).sort()).toEqual(["bots", "coverage", "history", "id", "main", "name", "nickname", "number", "observedAt", "signIn", "windows", "workers"]);
      expect(row).toMatchObject({ number: expect.any(Number), name: expect.any(String), coverage: "unknown", history: { fine: [], coarse: [] }, workers: [] });
    }
    expect(account(value)).toMatchObject({ id: "claude", number: 1, nickname: null, name: "Claude 1", main: true, signIn: "ready", observedAt: origin,
      bots: [{ botId: "atlas", bot: "Atlas", busy: false }, { botId: "mira", bot: "Mira", busy: false }],
      windows: [{ id: "five_hour", kind: "session", usedPercent: 20, resetsAt: origin + 60_000, windowMinutes: 300 },
        { id: "seven_day", kind: "week", usedPercent: 40, resetsAt: origin + 7 * 86_400_000, windowMinutes: 10080 }] });
    expect(account(value, added)).toMatchObject({ number: 2, name: "Studio", nickname: "Studio", main: false, signIn: "ready", observedAt: null, bots: [] });
    for (const engine of extra.slice(1)) expect(account(value, engine)).toMatchObject({ number: 1, name: engine[0].toUpperCase() + engine.slice(1), nickname: null });
    expect(s.runs).toHaveBeenCalledExactlyOnceWith(300);
    expect(value.engines.every((engine) => !("stayOn" in engine))).toBe(true);
  });

  it("keeps same-minute Main events and current-bucket replacements", async () => {
    const s = setup();
    s.accept("claude", report(10));
    await settle();
    const first = await s.board.read();
    now += 10_000;
    s.main(added);
    s.board.recordMain({ base: "claude", engine: "claude", from: { id: "claude", generation: 0 }, to: { id: added, generation: 1 }, seq: 1 });
    s.main("claude");
    s.board.recordMain({ base: "claude", engine: "claude", from: { id: added, generation: 1 }, to: { id: "claude", generation: 0 }, seq: 2 });
    s.accept("claude", report(24.456));
    await settle();
    const delta = await s.board.read(first.cursor);
    expect(delta.full).toBe(false);
    expect(account(delta).history).toEqual({ fine: [[origin / 60_000, 24.5, 40]], coarse: [[origin / 60_000, 24.5, 40]] });
    expect(delta.engines[0].events).toEqual([
      { kind: "main", seq: 1, at: now, from: "claude", to: added }, { kind: "main", seq: 2, at: now, from: added, to: "claude" },
    ]);
    const unchanged = await s.board.read(delta.cursor);
    expect(unchanged.full).toBe(false);
    expect(account(unchanged).history).toEqual({ fine: [], coarse: [] });
    expect(unchanged.engines[0].events).toEqual([]);
    expect(account(unchanged).windows[0].usedPercent).toBe(24.456);
  });

  it("never labels an older frozen snapshot with a newer revision", async () => {
    const s = setup();
    const host = deferred<Runs>();
    s.runs.mockReturnValueOnce(host.promise);
    s.rateLimits.set("claude", report(10));
    const pending = s.board.read();
    await Promise.resolve();
    s.main(added);
    s.names.set(added, { ...s.names.get(added)!, name: "Desk", nickname: "Desk" });
    s.rateLimits.set("claude", report(80));
    s.board.turnStarted({ turnId: "room-turn", botId: "atlas", accountId: "claude", generation: 0 });
    const committed = s.board.touch();
    host.resolve({ known: true, runs: [] });
    const value = await pending;
    expect(value.revision).toBe(committed);
    expect(value.engines[0].mainId).toBe(added);
    expect(account(value, added)).toMatchObject({ main: true, name: "Desk", nickname: "Desk" });
    expect(account(value)).toMatchObject({ main: false, windows: [{ usedPercent: 80 }, { usedPercent: 40 }], bots: [{ botId: "atlas", busy: true }] });
    expect(account(value, added).bots).toEqual([{ botId: "mira", bot: "Mira", busy: false }]);
    expect(s.runs).toHaveBeenCalledOnce();
  });

  it("freezes mutable reports, names and bots before the host await", async () => {
    const s = setup();
    const host = deferred<Runs>();
    s.runs.mockReturnValueOnce(host.promise);
    s.rateLimits.set("claude", report(10));
    const pending = s.board.read();
    await Promise.resolve();
    s.names.get(added)!.name = "Changed";
    s.bots[0].name = "Changed";
    s.rateLimits.get("claude")!.windows[0].usedPercent = 90;
    host.resolve({ known: true, runs: [] });
    const value = await pending;
    expect(account(value, added).name).toBe("Studio");
    expect(account(value).bots[0].bot).toBe("Atlas");
    expect(account(value).windows[0].usedPercent).toBe(10);
    expect(value.revision).toBeLessThan(s.board.touch());
  });

  it("orders two replies completed out of order by revision", async () => {
    const s = setup();
    const host = deferred<Runs>();
    s.runs.mockReturnValueOnce(host.promise);
    const older = s.board.read();
    await Promise.resolve();
    s.main(added);
    s.board.touch();
    const newer = await s.board.read();
    s.main("claude");
    s.board.touch();
    host.resolve({ known: false, reason: "error" });
    const later = await older;
    expect(later.revision).toBeGreaterThan(newer.revision);
    expect(newer.engines[0].mainId).toBe(added);
    expect(later.engines[0].mainId).toBe("claude");
    const delivered = [later, newer];
    const shown = delivered.reduce<UsageBoard | undefined>((shown, next) => !shown || next.revision > shown.revision ? next : shown, undefined);
    expect(shown).toBe(later);
  });

  it("records runtime spawn and manual quota reports exactly once", async () => {
    const s = setup();
    const record = vi.spyOn(s.history, "record");
    const sources = { runtime: s.accept, spawn: s.accept, manual: s.accept };
    for (const [index, accept] of Object.values(sources).entries()) {
      const value = report(30 + index, origin + index * 10_000);
      accept("claude", value);
      s.board.recordReport("claude", value);
    }
    expect(record).not.toHaveBeenCalled();
    await settle();
    expect(record.mock.calls).toEqual([0, 1, 2].map((i) => ["claude", 0, origin + i * 10_000, 30 + i, 40]));
    expect(s.schedule).toHaveBeenCalledOnce();
    await s.board.read();
    await s.board.read();
    s.rateLimits.delete("claude");
    s.board.touch();
    await settle();
    expect(record).toHaveBeenCalledTimes(3);
  });

  it("keeps known busy bots when worker state is unknown", async () => {
    const s = setup();
    s.runs.mockResolvedValue({ known: false, reason: "timeout" });
    s.board.turnStarted({ turnId: "room", botId: "atlas", accountId: added, generation: 1 });
    const value = await s.board.read();
    expect(value.runs).toBe("unknown");
    expect(value.engines[0].accounts.every((row) => row.workers === null)).toBe(true);
    expect(account(value, added).bots).toEqual([{ botId: "atlas", bot: "Atlas", busy: true }]);
    expect(account(value).bots).toEqual([{ botId: "mira", bot: "Mira", busy: false }]);
  });

  it("ignores an old turn settlement after another turn starts", async () => {
    const s = setup();
    s.board.turnStarted({ turnId: "old", botId: "atlas", accountId: added, generation: 1 });
    s.board.turnStarted({ turnId: "continuation", botId: "atlas", accountId: added, generation: 1 });
    s.board.turnSettled("old");
    expect(account(await s.board.read(), added).bots).toEqual([{ botId: "atlas", bot: "Atlas", busy: true }]);
    s.board.turnSettled("old");
    expect(account(await s.board.read(), added).bots[0].busy).toBe(true);
    s.board.turnSettled("continuation");
    const idle = await s.board.read();
    expect(account(idle, added).bots).toEqual([]);
    expect(account(idle).bots).toContainEqual({ botId: "atlas", bot: "Atlas", busy: false });
  });

  it("keeps simultaneous room and continuation turns on their captured accounts", async () => {
    const s = setup();
    s.board.turnStarted({ turnId: "room", botId: "atlas", accountId: "claude", generation: 0 });
    s.board.turnStarted({ turnId: "continuation", botId: "atlas", accountId: added, generation: 1 });
    s.main(added);
    s.board.touch();
    const value = await s.board.read();
    expect(account(value).bots).toEqual([{ botId: "atlas", bot: "Atlas", busy: true }]);
    expect(account(value, added).bots).toEqual([{ botId: "atlas", bot: "Atlas", busy: true }, { botId: "mira", bot: "Mira", busy: false }]);
    s.board.turnSettled("room");
    expect(account(await s.board.read()).bots).toEqual([]);
  });

  it("keeps account identities out of the board", async () => {
    const s = setup();
    const local = "syntheticidentitycanary913";
    const domain = "privacycanary.invalid";
    const identity = `${local}@${domain}`;
    s.rows()[0].identity = identity;
    s.rows()[0].status = { state: "available", authenticated: true, account: identity, accountIdentity: identity };
    s.names.set("claude", { ...s.names.get("claude")!, name: identity, nickname: local });
    s.bots[0].id = local;
    s.bots[0].name = domain;
    s.board.turnStarted({ turnId: "canary-turn", botId: local, accountId: "claude", generation: 0 });
    s.rateLimits.set("claude", Object.assign(report(), { error: identity, email: identity }));
    s.rateLimits.get("claude")!.windows.push({ id: identity, usedPercent: 12, resetsAt: null });
    s.history.event("claude", { at: now, kind: "auto", label: local, from: "claude", to: added });
    s.runs.mockResolvedValue({ known: true, runs: [{ accountId: "claude", accountGeneration: 0, engine: "claude", botId: local, paneId: "pane-1", label: identity, state: "busy" }] });
    const value = await s.board.read();
    const serialized = JSON.stringify(value);
    for (const canary of [identity, local, domain]) expect(serialized).not.toContain(canary);
    expect(account(value)).toMatchObject({ name: "Claude 1", nickname: null, workers: [{ bot: "Bot", label: "" }] });
    s.runs.mockRejectedValue(new Error(identity));
    expect(JSON.stringify(await s.board.handle("/api/usage/board"))).not.toContain(local);
  });

  it("answers full after an account is removed or signs in as someone else", async () => {
    const s = setup();
    s.accept(added, report());
    await settle();
    const first = await s.board.read();
    s.setRows(s.rows().filter((row) => row.id !== added));
    s.board.touch();
    const removed = await s.board.read(first.cursor);
    expect(removed.full).toBe(true);
    expect(account(removed, added)).toBeUndefined();
    expect(s.history.snapshot().accounts[added]).toBeUndefined();
    s.rows()[0].generation = 1;
    s.accept("claude", report());
    await settle();
    const before = await s.board.read(removed.cursor);
    expect(before.full).toBe(true);
    s.board.turnStarted({ turnId: "prior-sign-in", botId: "atlas", accountId: "claude", generation: 1 });
    s.rows()[0].generation = 2;
    s.board.touch();
    const changed = await s.board.read(before.cursor);
    expect(changed.full).toBe(true);
    expect(account(changed).history).toEqual({ fine: [], coarse: [] });
    expect(account(changed).bots.every((bot) => !bot.busy)).toBe(true);
  });

  it("answers full for added accounts, unknown cursors and another boot", async () => {
    const s = setup();
    const first = await s.board.read();
    s.setRows([...s.rows(), { id: second, of: "claude", driverKind: "claudeAgent", generation: 1, existing: false, state: "pending" }]);
    s.board.touch();
    expect((await s.board.read(first.cursor)).full).toBe(true);
    expect((await s.board.read("not-a-cursor")).full).toBe(true);
    expect((await createUsageBoard(s.deps).read(first.cursor)).full).toBe(true);
  });

  it("invalidates cursors when the account set changes and changes back", async () => {
    const s = setup();
    const first = await s.board.read();
    const rows = s.rows();
    s.setRows(rows.filter((row) => row.id !== added));
    s.board.touch();
    s.setRows(rows);
    s.board.touch();
    expect((await s.board.read(first.cursor)).full).toBe(true);
  });

  it("marks coverage unknown without complete-window evidence", async () => {
    const s = setup();
    s.rateLimits.set("claude", { observedAt: new Date(now).toISOString(), windows: [{ id: "seven_day", usedPercent: 50, resetsAt: null }] });
    const row = account(await s.board.read());
    expect(row.coverage).toBe("unknown");
    expect(row.windows).toEqual([{ id: "seven_day", kind: "week", usedPercent: 50, resetsAt: null, windowMinutes: null }]);
    expect(account(await s.board.read(), added)).toMatchObject({ coverage: "unknown", windows: [], observedAt: null });
  });

  it("answers within 300 ms when the host hangs", async () => {
    vi.useFakeTimers();
    const s = setup();
    s.runs.mockImplementation(() => new Promise(() => {}));
    const pending = s.board.read();
    let finished = false;
    void pending.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(299);
    expect(finished).toBe(false);
    s.main(added);
    s.board.touch();
    await vi.advanceTimersByTimeAsync(1);
    const value = await pending;
    expect(value.runs).toBe("unknown");
    expect(value.engines[0].mainId).toBe(added);
    expect(account(value, added).workers).toBeNull();
    expect(s.runs).toHaveBeenCalledOnce();
  });

  it("keeps sending frames while changes land every second", async () => {
    vi.useFakeTimers();
    const s = setup();
    const frames: Array<{ at: number; revision: number }> = [];
    const unsubscribe = s.board.onFrame((frame) => { frames.push({ at: Date.now(), revision: frame.revision }); });
    let committed = 0;
    for (let i = 0; i < 10; i++) {
      committed = s.board.touch();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(frames.length).toBeGreaterThanOrEqual(4);
    await vi.advanceTimersByTimeAsync(2_000);
    for (let i = 1; i < frames.length; i++) expect(frames[i].at - frames[i - 1].at).toBeGreaterThanOrEqual(2_000);
    expect(frames.at(-1)?.revision).toBe(committed);
    unsubscribe();
  });

  it("sends at most one frame per 2 s", async () => {
    vi.useFakeTimers();
    const s = setup();
    const frames: UsageBoardFrame[] = [];
    const unsubscribe = s.board.onFrame((frame) => { frames.push(frame); });
    s.board.touch();
    await vi.advanceTimersByTimeAsync(1_000);
    const committed = s.board.touch();
    await vi.advanceTimersByTimeAsync(999);
    expect(frames).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(frames).toEqual([{ kind: "usage.board", revision: committed }]);
    s.board.turnStarted({ turnId: "reply", botId: "atlas", accountId: added, generation: 1 });
    s.board.turnSettled("reply");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frames).toHaveLength(2);
    expect(frames[1].revision).toBeGreaterThan(committed);
    s.board.touch();
    unsubscribe();
    s.board.touch();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(frames).toHaveLength(2);
  });

  it("projects captured workers once per pane and rejects stale generations", async () => {
    const s = setup();
    const run = { botId: "atlas", paneId: "pane-1", label: "ATLAS-1", engine: "claude" as const, accountId: added, accountGeneration: 1, state: "busy" as const };
    s.runs.mockResolvedValue({ known: true, runs: [run, run, { ...run, paneId: "pane-old", accountGeneration: 0 }, { ...run, paneId: "pane-idle", state: "idle" }] });
    const value = await s.board.read();
    expect(account(value).workers).toEqual([]);
    expect(account(value, added).workers).toEqual([
      { botId: "atlas", bot: "Atlas", paneId: "pane-1", label: "ATLAS-1", state: "busy" },
      { botId: "atlas", bot: "Atlas", paneId: "pane-idle", label: "ATLAS-1", state: "idle" },
    ]);
    expect(account(value).bots.every((bot) => !bot.busy)).toBe(true);
  });

  it.each(["no-host", "old-host", "error", "timeout"] as const)("represents %s without an empty worker list", async (reason) => {
    const s = setup();
    s.runs.mockResolvedValue({ known: false, reason });
    const value = await s.board.read();
    expect(value.runs).toBe(reason === "old-host" ? "old-host" : "unknown");
    expect(value.engines[0].accounts.every((row) => row.workers === null)).toBe(true);
  });

  it("maps sign-in states and never marks a draining Main ready", async () => {
    const s = setup();
    s.main(added);
    s.drains[added] = { destinationId: "claude", phase: "draining" };
    expect(account(await s.board.read(), added)).toMatchObject({ main: true, signIn: "draining" });
    delete s.drains[added];
    s.rows()[1].state = "pending";
    expect(account(await s.board.read(), added).signIn).toBe("signing-in");
    s.rows()[1].state = "stopped";
    expect(account(await s.board.read(), added).signIn).toBe("signed-out");
    s.rows()[1].state = "ready";
    s.rows()[1].blocked = true;
    expect(account(await s.board.read(), added).signIn).toBe("signed-out");
    s.rows()[0].status = undefined;
    expect(account(await s.board.read()).signIn).toBe("unknown");
    s.rows()[0].status = { state: "available", authenticated: false };
    expect(account(await s.board.read()).signIn).toBe("signed-out");
    s.drains.claude = { destinationId: added, phase: "draining" };
    expect(account(await s.board.read()).signIn).toBe("draining");
  });

  it("commits monotonic revisions even when time stays still or moves backwards", async () => {
    const s = setup();
    const first = await s.board.read();
    const one = s.board.touch();
    const two = s.board.touch();
    now -= 10_000;
    const three = s.board.touch();
    expect(one).toBe(first.revision + 1);
    expect(two).toBe(one + 1);
    expect(three).toBe(two + 1);
    now = origin + 1_000_000;
    expect(s.board.touch()).toBe(now);
  });

  it("serves the cursor route and rejects unrelated paths without echoing input", async () => {
    const s = setup();
    const response = await s.board.handle(new URL("http://localhost/api/usage/board"));
    expect(response.status).toBe(200);
    if (!("revision" in response.body)) throw new Error("Expected a board");
    const value = response.body;
    expect((await s.board.handle(`/api/usage/board?cursor=${encodeURIComponent(value.cursor)}`)).body).toMatchObject({ full: false });
    expect(await s.board.handle("/api/usage/other?secret=private")).toEqual({ status: 404, body: { error: "Not found" } });
    expect(await s.board.handle("http://[")).toEqual({ status: 400, body: { error: "Invalid URL" } });
  });

  it("records one Main event per committed hook sequence", async () => {
    const s = setup();
    const change = { base: "claude", engine: "claude" as const, from: { id: "claude", generation: 0 }, to: { id: added, generation: 1 }, seq: 1 };
    s.board.recordMain(change);
    s.board.recordMain(change);
    expect((await s.board.read()).engines[0].events).toEqual([{ seq: 1, at: origin, kind: "main", from: "claude", to: added }]);
  });

  it("keeps a committed Main event when the destination generation just changed", async () => {
    const s = setup();
    s.accept(added, report());
    await settle();
    s.rows()[1].generation = 2;
    s.main(added);
    s.board.recordMain({ base: "claude", engine: "claude", from: { id: "claude", generation: 0 }, to: { id: added, generation: 2 }, seq: 1 });
    expect((await s.board.read()).engines[0].events).toEqual([{ seq: 1, at: origin, kind: "main", from: "claude", to: added }]);
  });

  it("keeps accepted late observations in their original buckets", async () => {
    const s = setup();
    s.accept("claude", report(40, origin + 10 * 60_000));
    s.accept("claude", report(20, origin));
    await settle();
    expect(account(await s.board.read()).history.fine).toEqual([[origin / 60_000, 20, 40], [origin / 60_000 + 10, 40, 40]]);
    expect(s.history.snapshot().events.claude ?? []).toEqual([]);
  });

  it("drops queued observations after removal or a generation change", async () => {
    const s = setup();
    const record = vi.spyOn(s.history, "record");
    s.accept(added, report());
    s.rows()[1].generation++;
    s.board.touch();
    await settle();
    expect(record).not.toHaveBeenCalled();
    s.accept(added, report(50, now + 1));
    s.setRows(s.rows().filter((row) => row.id !== added));
    s.board.touch();
    await settle();
    expect(record).not.toHaveBeenCalled();
  });

  it("bounds the recorder queue without losing accepted observations", async () => {
    const s = setup();
    const record = vi.spyOn(s.history, "record");
    for (let i = 0; i < 800; i++) s.accept("claude", report(i / 10, origin + i));
    expect(record).toHaveBeenCalledTimes(768);
    await settle();
    expect(record).toHaveBeenCalledTimes(800);
    expect(account(await s.board.read()).history.fine).toEqual([[origin / 60_000, 79.9, 40]]);
    expect(s.schedule).toHaveBeenCalledOnce();
  });

  it("ignores measurement noise when recording reset events", async () => {
    const s = setup();
    s.accept("claude", report(24.5, origin));
    s.accept("claude", report(24.4, origin + 1));
    s.accept("claude", report(100, origin + 2));
    s.accept("claude", report(99.9, origin + 3));
    await settle();
    expect((await s.board.read()).engines[0].events).toEqual([
      { seq: 1, at: origin + 2, kind: "limit", accountId: "claude", window: "five_hour" },
    ]);
  });

  it("compares new reports with persisted reports after a restart", async () => {
    const s = setup();
    s.accept("claude", report(100, origin));
    await settle();
    const restarted = createUsageBoard(s.deps);
    restarted.recordReport("claude", report(100, origin + 1));
    await settle();
    expect((await restarted.read()).engines[0].events.map((event) => event.kind)).toEqual(["limit"]);
    const reset = createUsageBoard(s.deps);
    reset.recordReport("claude", report(5, origin + 60_000));
    await settle();
    expect((await reset.read()).engines[0].events.map((event) => event.kind)).toEqual(["limit", "reset"]);
  });

  it("records a below-limit reset when the observed window rolls over", async () => {
    const s = setup();
    s.accept("claude", report(40, origin));
    s.accept("claude", report(5, origin + 60_000));
    await settle();
    expect((await s.board.read()).engines[0].events).toEqual([
      { seq: 1, at: origin + 60_000, kind: "reset", accountId: "claude", window: "five_hour" },
    ]);
  });

  it("records limit and reset events once using observation time", async () => {
    const s = setup();
    s.accept("claude", report(90, origin));
    s.accept("claude", report(100, origin + 1));
    s.accept("claude", report(100, origin + 1));
    s.accept("claude", report(105, origin + 2));
    s.accept("claude", report(5, origin + 3));
    await settle();
    expect((await s.board.read()).engines[0].events).toEqual([
      { seq: 1, at: origin + 1, kind: "limit", accountId: "claude", window: "five_hour" },
      { seq: 2, at: origin + 3, kind: "reset", accountId: "claude", window: "five_hour" },
    ]);
  });
});
