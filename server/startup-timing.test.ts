import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStartupTiming } from "./startup-timing.ts";
import { foldPeerQueuedSends } from "./peer-user-reply.ts";
import { isSendCancelled, queueMark, queueSteeredMessage, _queuedCount, _resetSteerQueue } from "./steer-queue.ts";
import { Store } from "./store.ts";

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
    const action = vi.fn();
    const probes = vi.fn(async () => {});
    startup.afterPaint("probes", async () => { await startup.waitFor("accounts"); await probes(); });
    for (let attempt = 0; attempt < 3; attempt++) {
      await startup.beforeRequest("POST", "/api/bots/b1/send")!.then(action);
      await expect(startup.waitFor("accounts")).resolves.toBeUndefined();
    }
    await startup.waitFor("probes");
    expect(action).toHaveBeenCalledTimes(3);
    expect(probes).toHaveBeenCalledOnce();
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

  it("logs shutdown before serving without recording skipped task durations", async () => {
    const write = vi.fn();
    const work = vi.fn(async () => {});
    const startup = createStartupTiming({ write });
    startup.afterPaint("accounts", work);
    startup.close();
    await startup.waitFor("accounts");
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0][0].slice(8))).toMatchObject({ closed: 1 });
    expect(JSON.parse(write.mock.calls[0][0].slice(8))).not.toHaveProperty("accounts");
    expect(work).not.toHaveBeenCalled();
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
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
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
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
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
    const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const source = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true);
    const statement = source.statements.filter((node) => (ts.isIfStatement(node) || ts.isExpressionStatement(node)) && /(?:enableWorkerAccounts|restoreStartupAccounts)\(/.test(node.getText(source))).map((node) => node.getText(source)).join("\n");
    expect(statement).toBeTruthy();
    let release!: () => void;
    const enableWorkerAccounts = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const restore = vi.fn(async () => {});
    const startupTiming = createStartupTiming({ write: () => {} });
    let ready = false;
    const boot = runInNewContext(`(async () => { ${statement}; ready(); })()`, {
      accounts: { snapshot: [{}], drains: {} }, terminalBridgeAccess: null, startupTiming,
      enableWorkerAccounts, console,
      accountRuntime: { restore }, restoreStartupAccounts: async () => { await enableWorkerAccounts(); await restore(); },
      ready: () => { ready = true; },
    }) as Promise<void>;
    try {
      await Promise.resolve();
      expect(ready).toBe(true);
      expect(enableWorkerAccounts).not.toHaveBeenCalled();
      startupTiming.paint();
      await Promise.resolve();
      expect(enableWorkerAccounts).toHaveBeenCalledOnce();
      expect(restore).not.toHaveBeenCalled();
    } finally {
      release?.();
      await boot;
      await startupTiming.waitFor("accounts");
    }
    expect(restore).toHaveBeenCalledOnce();
  });

  it("keeps worker launch behind account recovery", async () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const start = source.indexOf('if (method === "POST" && path === "/api/internal/worker-launch")');
    const route = source.slice(start, source.indexOf("// The show_image tool", start));
    let release!: () => void;
    const startupTiming = createStartupTiming({ write: () => {} });
    startupTiming.afterPaint("accounts", () => new Promise<void>((resolve) => { release = resolve; }));
    const workerLaunchResponse = vi.fn(async () => ({ status: 200, body: {} }));
    const pending = runInNewContext(`(async () => { ${route} })()`, {
      method: "POST", path: "/api/internal/worker-launch", startupTiming, workerLaunchResponse,
      terminalBridgeAccess: null, req: { headers: {} }, readBody: async () => ({}), workerLaunch: {}, res: {}, json() {},
    }) as Promise<void>;
    expect(workerLaunchResponse).not.toHaveBeenCalled();
    startupTiming.paint();
    await Promise.resolve();
    expect(workerLaunchResponse).not.toHaveBeenCalled();
    release();
    await pending;
    expect(workerLaunchResponse).toHaveBeenCalledOnce();
  });

  it.each(["none", "restored", "failed"])("answers instance discovery after accounts settle without waiting for refresh: %s", async (accounts) => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const start = source.indexOf('if (method === "GET" && path === "/api/instances")');
    const statement = source.slice(start, source.indexOf("// ── app config", start));
    let release!: () => void;
    let restore!: () => void;
    const startupTiming = createStartupTiming({ write: () => {} });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    if (accounts !== "none") startupTiming.afterPaint("accounts", async () => {
      await new Promise<void>((resolve) => { restore = resolve; });
      if (accounts === "failed") throw new Error("restore failed");
    });
    startupTiming.afterPaint("probes", () => new Promise<void>((resolve) => { release = resolve; }));
    const describeInstances = vi.fn(async () => []);
    const pending = runInNewContext(`(async () => { ${statement} })()`, {
      method: "GET", path: "/api/instances", startupTiming, url: new URL("http://localhost/api/instances"),
      describeInstances, resetPathCache() {}, withRateLimits: (value: unknown) => value,
      rememberAutomaticAvailability() {}, json() {}, res: {},
      botAccounts: { pickerInstances: (value: unknown) => value, accountInstances: (value: unknown) => value },
    }) as Promise<void>;
    try {
      await new Promise(setImmediate);
      if (accounts === "none") expect(describeInstances).toHaveBeenCalledExactlyOnceWith("cached");
      else expect(describeInstances).not.toHaveBeenCalled();
      startupTiming.paint();
      await Promise.resolve();
      if (accounts !== "none") {
        expect(describeInstances).not.toHaveBeenCalled();
        restore();
      }
      await new Promise(setImmediate);
      expect(describeInstances).toHaveBeenCalledExactlyOnceWith("cached");
      await pending;
    } finally {
      startupTiming.paint();
      await Promise.resolve();
      restore?.();
      release?.();
      await pending;
      log.mockRestore();
    }
    expect(describeInstances).toHaveBeenCalledOnce();
  });

  it.each([{}, { paneNoteWake: true }])("holds an internal turn claim until account restore completes: %j", async (opts) => {
    const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const source = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true);
    const turn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "startTurn")!;
    const start = text.indexOf("async function startClaimedTurn(");
    const body = text.slice(text.indexOf("{\n", start) + 2, text.indexOf("  const bot =", start));
    const startupTiming = createStartupTiming({ write: () => {} });
    let release!: () => void;
    startupTiming.afterPaint("accounts", () => new Promise<void>((resolve) => { release = resolve; }));
    const dispatch = vi.fn();
    const claims = new Set<string>();
    const startTurn = runInNewContext(`${ts.transpile(turn.getText(source), { target: ts.ScriptTarget.ES2022 })}
      async function startClaimedTurn(botId, text, opts) { ${body} dispatch(botId, text, opts); } startTurn`, {
      startupTiming, currentTurnEpoch: () => 0, queueMark, dispatch, store: { bot: () => ({ threadId: "t1" }) }, turnStartClaims: claims,
      tryClaimTurnStart: (id: string) => { if (claims.has(id)) return false; claims.add(id); return true; },
      takeStartingHold: () => () => {},
      busyRejection: (message: string) => new Error(message), queueMicrotask() {},
    }) as (botId: string, text: string, opts: object) => Promise<void>;
    const pending = startTurn("b1", "queued", opts);
    expect(dispatch).not.toHaveBeenCalled();
    await expect(startTurn("b1", "duplicate", opts)).rejects.toThrow("already working");
    startupTiming.paint();
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    release();
    await pending;
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("b1", "queued", opts);
    expect(claims.size).toBe(0);
  });

  it.each(["stop", "send"])("preserves the turn boundary during account recovery: %s", async (action) => {
    const text = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const source = ts.createSourceFile("index.ts", text, ts.ScriptTarget.Latest, true);
    const turn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "startClaimedTurn") as ts.FunctionDeclaration;
    const statements = turn.body!.statements;
    const botIndex = statements.findIndex((node) => node.getText(source).startsWith("const bot ="));
    const prefix = statements.slice(0, botIndex).map((node) => node.getText(source)).join("\n");
    const folded = statements.find((node) => node.getText(source).startsWith("const folded ="))!.getText(source);
    const stopped = statements.find((node) => ts.isIfStatement(node) && node.expression.getText(source) === "currentTurnEpoch(bot.id) !== epoch")!.getText(source);
    const store = new Store(() => ({ instanceId: "fake", model: "fake" }));
    const bot = store.createBot({}, { seedMessages: false });
    const threadId = bot.threadId;
    let epoch = 0;
    let release!: () => void;
    const startupTiming = createStartupTiming({ write: () => {} });
    startupTiming.afterPaint("accounts", () => new Promise<void>((resolve) => { release = resolve; }));
    const dispatch = vi.fn();
    _resetSteerQueue();
    const pending = runInNewContext(`(async () => { ${ts.transpile(`${prefix}\n${folded}\n${stopped}\ndispatch(folded);`, { target: ts.ScriptTarget.ES2022 })} })()`, {
      botId: bot.id, bot, threadId, opts: {}, store, startupTiming, queueMark, foldPeerQueuedSends, isSendCancelled,
      instance: { adapter: { capabilities: { queueing: false } } },
      currentTurnEpoch: () => epoch, logSummaryWait() {}, startedTurn() {}, userMessage: {}, dispatch,
    }) as Promise<void>;
    try {
      startupTiming.paint();
      await Promise.resolve();
      expect(dispatch).not.toHaveBeenCalled();
      if (action === "stop") epoch += 1;
      else queueSteeredMessage(bot.id, threadId, "during recovery");
      release();
      await pending;
      if (action === "stop") expect(dispatch).not.toHaveBeenCalled();
      else {
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(["during recovery"]);
        expect(store.messagesFor(threadId).map((message) => message.text)).toEqual(["during recovery"]);
        expect(_queuedCount(threadId)).toBe(0);
      }
    } finally {
      release?.();
      await pending;
      _resetSteerQueue();
    }
  });
});
