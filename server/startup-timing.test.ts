import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStartupTiming } from "./startup-timing.ts";

afterEach(() => vi.useRealTimers());

describe("startup timing", () => {
  it("holds background work until paint and logs once after it settles", async () => {
    let now = 0;
    let finish!: () => void;
    const write = vi.fn();
    const work = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const startup = createStartupTiming({ now: () => now, write });
    startup.afterPaint("accounts", work);
    startup.serving();
    await Promise.resolve();
    expect(work).not.toHaveBeenCalled();
    now = 500;
    startup.paint({ firstResponse: 20, chatPaint: 400 });
    await Promise.resolve();
    expect(work).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    now = 800;
    finish();
    await startup.waitFor("accounts");
    startup.paint({ chatPaint: 900 });
    expect(write).toHaveBeenCalledOnce();
    const record = JSON.parse(write.mock.calls[0][0].slice("startup ".length));
    expect(record).toMatchObject({ accounts: 300, firstResponse: 20, chatPaint: 400, checksReady: 800, errors: 0 });
    expect(Object.values(record).every((value) => typeof value === "number")).toBe(true);
  });

  it("releases hidden or empty chats after the fallback", async () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const work = vi.fn(async () => {});
    const startup = createStartupTiming({ write });
    startup.afterPaint("accounts", work);
    startup.serving();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0][0].slice(8))).toMatchObject({ paintTimeout: 1 });
  });

  it("keeps failed recovery observable and releases its waiters", async () => {
    const write = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const startup = createStartupTiming({ write });
    startup.afterPaint("accounts", async () => { throw new Error("failed"); });
    startup.serving();
    startup.paint();
    await expect(startup.waitFor("accounts")).rejects.toThrow("failed");
    expect(JSON.parse(write.mock.calls[0][0].slice(8))).toMatchObject({ errors: 1 });
    log.mockRestore();
  });

  it("holds immediate actions while snapshots and the paint signal stay available", async () => {
    let release!: () => void;
    const recovery = new Promise<void>((resolve) => { release = resolve; });
    const startup = createStartupTiming({ write: () => {} });
    startup.afterPaint("accounts", () => recovery);
    expect(startup.beforeRequest("GET", "/api/bots")).toBeUndefined();
    expect(startup.beforeRequest("POST", "/api/diag/cold-open")).toBeUndefined();
    expect(startup.beforeRequest("PUT", "/api/internal/google-account")).toBeUndefined();
    expect(startup.beforeRequest("PUT", "/api/internal/terminal-bridge")).toBeUndefined();
    const action = vi.fn();
    const pending = startup.beforeRequest("POST", "/api/bots/b1/send")!.then(action);
    startup.paint();
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
    release();
    await pending;
    expect(action).toHaveBeenCalledOnce();
  });

  it("does not start deferred probes when the window closes before paint", async () => {
    const work = vi.fn(async () => {});
    const write = vi.fn();
    const startup = createStartupTiming({ write });
    startup.afterPaint("probes", work);
    startup.serving();
    startup.close();
    await startup.waitFor("probes");
    expect(work).not.toHaveBeenCalled();
    expect(JSON.parse(write.mock.calls[0][0].slice(8))).toMatchObject({ closed: 1 });
  });

  it("logs pending work once when shutdown interrupts a slow probe", async () => {
    const write = vi.fn();
    let release!: () => void;
    const startup = createStartupTiming({ write });
    startup.afterPaint("probes", () => new Promise<void>((resolve) => { release = resolve; }));
    startup.serving();
    startup.paint();
    await Promise.resolve();
    startup.close();
    expect(write).toHaveBeenCalledOnce();
    const record = JSON.parse(write.mock.calls[0][0].slice(8));
    expect(record).toMatchObject({ closed: 1, pending: 1, closedAt: expect.any(Number) });
    expect(record).not.toHaveProperty("checksReady");
    release();
    await startup.waitFor("probes");
    expect(write).toHaveBeenCalledOnce();
  });

  it("keeps the HTTP boot path independent of account probe completion", async () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const statement = source.split("\n").find((line) => line.startsWith("if (accounts.snapshot.length") && line.includes("accountRuntime.restore"));
    expect(statement).toBeTruthy();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const restore = vi.fn(() => blocked);
    const startupTiming = createStartupTiming({ write: () => {} });
    let ready = false;
    const boot = runInNewContext(`(async () => { ${statement} })()`, {
      accounts: { snapshot: [{}], drains: {} }, accountRuntime: { restore }, startupTiming,
      terminalBridgeAccess: null, restoreStartupAccounts: async (_access: unknown, restore: () => Promise<void>) => restore(),
    }) as Promise<void>;
    void boot.then(() => { ready = true; });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(ready).toBe(true);
      expect(restore).not.toHaveBeenCalled();
      startupTiming.paint();
      await Promise.resolve();
      expect(restore).toHaveBeenCalledOnce();
    } finally {
      release();
      await boot;
      await startupTiming.waitFor("accounts");
    }
  });

  it("waits for paint instead of racing it with the boot probe timer", async () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.search(/(?:startupTiming.afterPaint\("probes"|void serverServing.then\(\(\) => setTimeout)/);
    const statement = source.slice(start, source.indexOf("hostShutdown =", start));
    const schedule = vi.fn(() => ({ unref() {} }));
    const startupTiming = createStartupTiming({ write: () => {} });
    const describeInstances = vi.fn(async () => []);
    runInNewContext(statement, {
      startupTiming, serverServing: Promise.resolve(), setTimeout: schedule, describeInstances,
      registry: { describeCached: async () => [] }, rememberAutomaticAvailability() {},
      broadcast() {}, botAccounts: { pickerInstances: (value: unknown) => value, accountInstances: (value: unknown) => value },
      withRateLimits: (value: unknown) => value, defaultSelection: async () => ({}), bootSelection: {}, console,
    });
    await Promise.resolve();
    expect(schedule).not.toHaveBeenCalled();
    expect(describeInstances).not.toHaveBeenCalled();
    startupTiming.paint();
    await startupTiming.waitFor("probes");
    expect(describeInstances).toHaveBeenCalledOnce();
  });

  it("does not await the native worker bridge before installing HTTP handlers", async () => {
    const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const source = text.slice(0, text.indexOf("function agentsIntegration"));
    const start = source.indexOf("if (accounts.snapshot.length) await enableWorkerAccounts");
    const statement = start < 0 ? "" : source.slice(start);
    let release!: () => void;
    const enableWorkerAccounts = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    let ready = false;
    const boot = runInNewContext(`(async () => { ${statement}; ready(); })()`, {
      accounts: { snapshot: [{}] }, terminalBridgeAccess: null, enableWorkerAccounts, console,
      ready: () => { ready = true; },
    }) as Promise<void>;
    try {
      await Promise.resolve();
      expect(ready).toBe(true);
      expect(enableWorkerAccounts).not.toHaveBeenCalled();
    } finally {
      release?.();
      await boot;
    }
  });

  it("keeps worker launch behind account recovery", async () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const route = source.slice(source.indexOf('path === "/api/internal/worker-launch"'));
    const wait = route.indexOf('await startupTiming.waitFor("accounts")');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(route.indexOf("await workerLaunchResponse"));
  });

  it("keeps renderer instance discovery behind the startup probes", async () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.indexOf('if (method === "GET" && path === "/api/instances")');
    const statement = source.slice(start, source.indexOf("// ── app config", start));
    let release!: () => void;
    const startupTiming = createStartupTiming({ write: () => {} });
    startupTiming.afterPaint("probes", () => new Promise<void>((resolve) => { release = resolve; }));
    const describeInstances = vi.fn(async () => []);
    const pending = runInNewContext(`(async () => { ${statement} })()`, {
      method: "GET", path: "/api/instances", startupTiming, url: new URL("http://localhost/api/instances"),
      describeInstances, resetPathCache() {}, withRateLimits: (value: unknown) => value,
      rememberAutomaticAvailability() {}, json() {}, res: {},
      botAccounts: { pickerInstances: (value: unknown) => value, accountInstances: (value: unknown) => value },
    }) as Promise<void>;
    try {
      await Promise.resolve();
      expect(describeInstances).not.toHaveBeenCalled();
      startupTiming.paint();
      await Promise.resolve();
    } finally {
      release?.();
      await pending;
    }
    expect(describeInstances).toHaveBeenCalledOnce();
  });
});
