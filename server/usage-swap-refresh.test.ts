import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createUsageBoard } from "./usage-board.ts";
import { createUsageHistory } from "./usage-history.ts";
import { createMuseCheck, createUsageRefresh } from "./usage-refresh.ts";
import { createUsageSwapRefresh } from "./usage-swap-refresh.ts";
import type { RateLimitsReport } from "./rate-limits-store.ts";
import type { JsonValue } from "./schema.ts";

type SwapDeps = Parameters<typeof createUsageSwapRefresh>[0];
type Row = ReturnType<Parameters<typeof createUsageBoard>[0]["accounts"]["list"]>[number];
const roots: string[] = [];
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("usage swap refresh", () => {
  it.each([
    ["claudeAgent", "claudeAgent"], ["codex", "codex"], ["grokAgent", "grok"],
    ["museAgent", "muse"], ["antigravityAgent", "gemini"],
  ] as const)("automatically reads %s after a snapshot identity swap, once", async (driver, boardDriver) => {
    const root = mkdtempSync(join(tmpdir(), "wink-USAGE-STALE-SWAP-"));
    roots.push(root);
    const now = Date.now();
    const reset = new Date(now + 7 * 86_400_000).toISOString();
    const read = vi.fn(async () => ({ windows: [{ id: "seven_day", usedPercent: 40, resetsAt: Date.parse(reset) }], observedAt: new Date(now).toISOString() }));
    const refresh = createUsageRefresh({ now: () => now, platform: "linux",
      request: async () => { await read(); return Response.json({ seven_day: { utilization: 40, resets_at: reset } }); },
      rpc: async () => { await read(); return { rateLimits: { secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Date.parse(reset) / 1000 } } }; },
      billing: async () => { await read(); return { config: { creditUsagePercent: 40, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: reset } } }; },
      muse: async () => { await read(); return { usage: { observedAtMs: now, tier: "pro",
        window: { usedPercent: 40, windowDurationMins: 300, resetsAtMs: now + 3_600_000 }, weekly: { usedPercent: 40, resetsAtMs: Date.parse(reset) } } }; },
      antigravity: async () => { await read(); return { weekly: { remaining_fraction: 0.6, reset_in_seconds: 3600 } }; },
    });
    const rateLimits = new Map<string, RateLimitsReport>();
    let rows: Row[] = [{ id: "engine", of: "engine", driverKind: boardDriver, generation: 0, existing: true,
      state: "ready", status: { state: "available", authenticated: true, account: "old@example.test" } }];
    const history = createUsageHistory(root, { schedule: vi.fn() });
    const registry = { get: () => ({ driverKind: driver }) };
    const configs: SwapDeps["configs"] = () => ({ engine: { driver, config: {}, environment: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-only" } } });
    const board = createUsageBoard({ accounts: { list: () => rows, defaultFor: () => undefined, drains: {} },
      names: { get: () => null }, rateLimits, history, runs: async () => ({ known: true, runs: [] }), bots: () => [],
      accountChanged: (id, ready) => { void swap(id, ready); },
    });
    const swap = createUsageSwapRefresh({ registry, configs, refresh, rateLimits, save: (id, report) => { if (report) board.recordReport(id, report); } });
    const old = { windows: [{ id: "seven_day", usedPercent: 100, resetsAt: Date.parse(reset) }], observedAt: new Date(now - 1000).toISOString() };
    rateLimits.set("engine", old);
    board.recordReport("engine", old);
    await settle();
    await board.read();
    rows = [{ ...rows[0], status: { state: "available", authenticated: true, account: "new@example.test" } }];
    board.sync();
    expect(rateLimits.has("engine")).toBe(false);
    expect(history.snapshot().accounts.engine).toBeUndefined();
    await settle();
    const after = (await board.read()).engines[0].accounts[0];
    expect(after.windows.map((window) => window.usedPercent)).toContain(40);
    expect(after.history.fine.every((point) => point[1] !== 100 && point[2] !== 100)).toBe(true);
    board.sync();
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects an old Grok read finishing after invalidation and bypasses its cooldown", async () => {
    let finish!: (value: JsonValue) => void;
    const billing = vi.fn(() => new Promise<JsonValue>((resolve) => { finish = resolve; }));
    const refresh = createUsageRefresh({ billing });
    const old = refresh("grokAgent", { instanceId: "grok" });
    const finishOld = finish;
    refresh.invalidate("grok");
    const current = refresh("grokAgent", { instanceId: "grok" });
    const payload = (used: number) => ({ config: { creditUsagePercent: used, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: new Date(Date.now() + 86_400_000).toISOString() } } });
    finish(payload(40));
    expect((await current).report?.windows[0].usedPercent).toBe(40);
    finishOld(payload(100));
    expect((await old).report).toBeUndefined();
    expect(billing).toHaveBeenCalledTimes(2);
  });

  it("drops Claude's shared credential cache when its identity changes", async () => {
    let used = 100;
    const request = vi.fn(async () => Response.json({ seven_day: { utilization: used, resets_at: null } }));
    const refresh = createUsageRefresh({ request, platform: "linux" });
    const options = { instanceId: "claude", environment: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-only" } };
    expect((await refresh("claudeAgent", options)).report?.windows[0].usedPercent).toBe(100);
    used = 40;
    refresh.invalidate("claude");
    expect((await refresh("claudeAgent", options)).report?.windows[0].usedPercent).toBe(40);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("drops the managed Claude probe cache on an identity swap", async () => {
    let used = 100;
    const claude = vi.fn(async () => [{ id: "seven_day", usedPercent: used, resetsAt: null }]);
    const refresh = createUsageRefresh({ claude });
    const options = { instanceId: "claude", account: { id: "claude", of: "claude", generation: 1, home: join(tmpdir(), "wink-USAGE-STALE-SWAP", "fixture") } };
    expect((await refresh("claudeAgent", options)).report?.windows[0].usedPercent).toBe(100);
    used = 40;
    refresh.invalidate("claude");
    expect((await refresh("claudeAgent", options)).report?.windows[0].usedPercent).toBe(40);
    expect(claude).toHaveBeenCalledTimes(2);
  });

  it("rejects a Muse check finishing after its identity changed", async () => {
    let finish!: (value: JsonValue) => void;
    const check = createMuseCheck({ muse: () => new Promise<JsonValue>((resolve) => { finish = resolve; }) });
    const pending = check({ instanceId: "muse" });
    check.invalidate("muse");
    const now = Date.now();
    finish({ usage: { observedAtMs: now, tier: "pro", window: { usedPercent: 100, windowDurationMins: 300, resetsAtMs: now + 3_600_000 },
      weekly: { usedPercent: 100, resetsAtMs: now + 7 * 86_400_000 } } });
    expect((await pending).report).toBeUndefined();
  });

  it("invalidates on sign-out without starting a usage read", async () => {
    const refresh = Object.assign(vi.fn(async () => ({ retryAt: 0 })), { invalidate: vi.fn(), busy: () => false });
    const save = vi.fn();
    const swap = createUsageSwapRefresh({ registry: { get: vi.fn() }, configs: () => ({}), refresh, rateLimits: new Map(), save });
    await swap("grok", false);
    expect(refresh.invalidate).toHaveBeenCalledWith("grok");
    expect(save).toHaveBeenCalledWith("grok");
    expect(refresh).not.toHaveBeenCalled();
  });
});
