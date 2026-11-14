import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VerifyRunState } from "../electron/verify-protocol.mjs";
import { chunk } from "../electron/verify-replay.mjs";
import type { VerifyCardData, VerifyResult } from "../shared/live-verify.ts";
import { autoVerdict } from "./auto-approve.ts";
import { CommsCallers } from "./comms-caller.ts";
import { DATA_DIR } from "./config.ts";
import { paneNotesForTurn, prepareModelContext } from "./context-compaction.ts";
import { hasLocalUndeliveredPaneNote, isWakeNote } from "./pane-wake.ts";
import { Store, type Message } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";
import { createVerifySite, type VerifyBridge } from "./verify-site.ts";

const flags = vi.hoisted(() => ({ on: true, limits: {} as Record<string, number>, original: {} as Record<string, number> }));
vi.mock("../shared/live-verify.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/live-verify.ts")>();
  Object.assign(flags.limits, actual.VERIFY_LIMITS);
  Object.assign(flags.original, actual.VERIFY_LIMITS);
  return { ...actual, get LIVE_VERIFY_V0() { return flags.on; }, VERIFY_LIMITS: flags.limits };
});

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });
const scratch = join(tmpdir(), "wink-LV0-HOST-SRV");
const counts = (completed: number, failed = 0) => ({ planned: 10, completed, passed: completed - failed, failed, blocked: 0, notRun: 10 - completed });

let tmp: string;
let work: string;
let store: Store;
let callers: CommsCallers;
let server: Server;
let base: string;
let bridge: FakeBridge | null;
let unattended: boolean;
let verdict: ReturnType<typeof vi.fn<typeof autoVerdict>>;
let broadcasts: Message[];
let decisions: unknown[];
let botId: string;
let threadId: string;
let token: string;
let verify: ReturnType<typeof createVerifySite>;

type FakeBridge = VerifyBridge & { starts: Array<{ watch: boolean; root: string; entry: string; revision: string }>; cancels: number; watches: number; states: VerifyRunState[]; startReply: string };

function fakeBridge(): FakeBridge {
  const fake: FakeBridge = {
    starts: [], cancels: 0, watches: 0, states: [], startReply: "started",
    async start(run, watch) {
      fake.starts.push({ watch, root: run.root, entry: run.entry, revision: run.revision });
      return fake.startReply as "started";
    },
    poll(_run, _since, _waitMs, signal) {
      const next = fake.states.shift();
      if (next) return Promise.resolve(next);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
    async watch() {
      fake.watches++;
      return true;
    },
    async cancel() {
      fake.cancels++;
    },
  };
  return fake;
}

const result = (issues: VerifyResult["issues"] = [], extra: Partial<VerifyResult> = {}): VerifyResult => ({
  v: 1, runId: "x", site: "site/index.html", counts: counts(10, issues.length), issues, issueTotal: issues.length, durationMs: 22_400, ...extra,
});
const finalStates = (res: VerifyResult): VerifyRunState[] => [
  { runId: "x", revision: 1, state: "running", counts: counts(2), result: null },
  { runId: "x", revision: 2, state: "running", counts: counts(5), result: null },
  { runId: "x", revision: 3, state: "completed", counts: res.counts, result: res },
];

function card(): VerifyCardData | undefined {
  return store.activePath(threadId).findLast((message) => message.kind === "note" && message.verify)?.verify;
}
async function until<T>(read: () => T | undefined | false, ms = 3_000): Promise<T> {
  const ends = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > ends) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}
function tool(body: unknown, init: { auth?: string; signal?: AbortSignal } = {}) {
  return fetch(`${base}/tool`, { method: "POST", headers: { authorization: init.auth ?? `Bearer ${token}` }, body: JSON.stringify(body), signal: init.signal })
    .then(async (res) => ({ status: res.status, body: (await res.json()) as any }));
}
function decide(runId: string, action: string, nonce: string, headers: Record<string, string> = { authorization: "Bearer app-token" }) {
  return fetch(`${base}/decision/${runId}`, { method: "POST", headers, body: JSON.stringify({ action, nonce, owner: botId, threadId }) })
    .then(async (res) => ({ status: res.status, body: (await res.json()) as any }));
}

beforeEach(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  tmp = mkdtempSync(join(scratch, "site-"));
  work = join(tmp, "work");
  mkdirSync(join(work, "site"), { recursive: true });
  writeFileSync(join(work, "site", "index.html"), "<!doctype html><h1>Hi</h1>");
  writeFileSync(join(work, "site", "a.css"), "h1{color:red}");
  mkdirSync(join(tmp, "work2"));
  writeFileSync(join(tmp, "work2", "index.html"), "<p>sibling</p>");
  mkdirSync(join(tmp, "outside"));
  writeFileSync(join(tmp, "outside", "index.html"), "<p>out</p>");
  symlinkSync(join(tmp, "outside"), join(work, "link"), "junction");
  mkdirSync(join(work, "notes"));
  writeFileSync(join(work, "notes", "readme.txt"), "x");
  flags.on = true;
  store = new Store(selection);
  const bot = store.createBot({}, { seedMessages: false });
  botId = bot.id;
  threadId = bot.threadId;
  callers = new CommsCallers();
  token = callers.token(botId, threadId);
  turnRegistry.start("turn-1", { botId, threadId, owner: "user", depth: 0 });
  bridge = fakeBridge();
  unattended = false;
  broadcasts = [];
  decisions = [];
  verdict = vi.fn(autoVerdict);
  verify = createVerifySite({
    store,
    resolveCommsCaller: (header) => callers.resolve(header),
    botOutputRoots: () => [work],
    autoVerdict: verdict,
    isUnattended: () => unattended,
    bridge: () => bridge,
    broadcastPatch: (_thread, message) => broadcasts.push(message),
    logDecision: (row) => decisions.push(row),
    deviceId: () => "device-1",
    appToken: (header) => header === "Bearer app-token",
    remoteClient: (req) => req.headers["x-remote"] === "1",
    platform: "win32",
  });
  server = createServer((req, res) => {
    const stream = /^\/api\/verify\/runs\/([a-z0-9-]{8,64})\/(live|replay)$/.exec(req.url ?? "");
    if (stream) return void verify.handleStream(req, res, stream[1]!, stream[2] === "replay", { relay: req.headers["x-relay"] === "1", phoneSession: req.headers["x-phone"] === "1" });
    const id = /^\/decision\/(.+)$/.exec(req.url ?? "")?.[1];
    if (id) return void verify.handleDecision(req, res, id, { relay: req.headers["x-relay"] === "1", phoneSession: req.headers["x-relay"] === "1" });
    void verify.handleTool(req, res).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

it("streams only to thread readers, saves after the reply, and serves replay or 404", async () => {
  let finishRun!: () => void;
  const done = new Promise<void>(resolve => { finishRun = resolve; });
  bridge!.cast = async run => new ReadableStream({ start(controller) {
    controller.enqueue(chunk(0, { v: 1, runId: run.runId, site: run.site, page: run.entry, startedAt: Date.now(), tiles: { desktop: [1280, 720], phone: [392, 800] } }));
    controller.enqueue(chunk(1, { tile: "desktop", ms: 1, data: Buffer.from([255, 216, 255, 217]) }));
    controller.enqueue(chunk(2, { kind: "part", part: "loads", ms: 2 }));
    void done.then(() => { controller.enqueue(chunk(3, { status: "completed", ms: 4, issues: [], notChecked: [] })); controller.close(); });
  } });
  let polls = 0;
  bridge!.poll = async run => {
    if (!polls++) return { runId: run.runId, revision: 1, state: "running", counts: counts(1), result: null };
    await done; return { runId: run.runId, revision: 2, state: "completed", counts: counts(10), result: result([], { runId: run.runId }) };
  };
  const pending = tool({ entry: "site" });
  const live = await until(() => broadcasts.find(message => message.verify?.live));
  const runId = live.verify!.runId;
  const get = (suffix: string, headers: Record<string, string> = { authorization: "Bearer app-token" }) => fetch(`${base}/api/verify/runs/${runId}/${suffix}`, { headers });
  expect((await get("live", {})).status).toBe(401);
  expect((await get("live", { authorization: `Bearer ${token}` })).status).toBe(403);
  expect((await get("live", { "x-relay": "1", authorization: "Bearer app-token" })).status).toBe(401);
  const first = await get("live"), second = await get("live", { "x-relay": "1", "x-phone": "1" });
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(first.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await get("live")).status).toBe(429);
  finishRun();
  expect((await pending).body.status).toBe("completed");
  expect((await first.arrayBuffer()).byteLength).toBeGreaterThan(20);
  await second.arrayBuffer();
  await until(() => broadcasts.find(message => message.verify?.replay?.includes(runId)));
  expect(card()?.live).toBeUndefined(); expect(card()?.replay).toBeUndefined();
  const file = await get("replay"), fileBytes = Buffer.from(await file.arrayBuffer());
  expect(fileBytes.subarray(0, 4).toString()).toBe("LVR1");
  expect(Buffer.from(await (await get("live")).arrayBuffer())).toEqual(fileBytes);
  await unlink(join(DATA_DIR, "verify-replays", threadId, `${runId}.lvr`));
  expect((await get("replay")).status).toBe(404);
});

it("bounds waiting runs to two in FIFO order", async () => {
  const completions: Array<() => void> = [];
  bridge!.poll = async (run, _since, _wait, signal) => {
    await new Promise<void>((resolve, reject) => { completions.push(resolve); signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
    return { runId: run.runId, revision: 2, state: "completed", counts: counts(10), result: result([], { runId: run.runId }) };
  };
  for (const name of ["second", "third", "fourth"]) writeFileSync(join(work, "site", `${name}.html`), `<h1>${name}</h1>`);
  const first = tool({ entry: "site" }); await until(() => bridge!.starts.length === 1);
  const second = tool({ entry: "site/second.html" }); await until(() => card()?.status === "waiting" && card()?.site.includes("second"));
  const third = tool({ entry: "site/third.html" }); await until(() => card()?.status === "waiting" && card()?.site.includes("third"));
  expect((await tool({ entry: "site/fourth.html" })).body.errorCode).toBe("busy");
  completions.shift()!(); await first; await until(() => bridge!.starts.length === 2);
  expect(bridge!.starts[1]!.entry).toBe("second.html");
  completions.shift()!(); await second; await until(() => bridge!.starts.length === 3);
  expect(bridge!.starts[2]!.entry).toBe("third.html");
  completions.shift()!(); await third;
});

it("includes waiting inside the tool deadline", async () => {
  const aborter = new AbortController(), first = tool({ entry: "site" }, { signal: aborter.signal }).catch(() => null);
  await until(() => bridge!.starts.length === 1);
  flags.limits.runMs = 100;
  const started = Date.now(), second = await tool({ entry: "site" });
  expect(second.body.errorCode).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(bridge!.starts).toHaveLength(1);
  aborter.abort(); await first;
});

it("holds the next run until a cancelled cast retires", async () => {
  let retire!: () => void;
  bridge!.cast = async run => new ReadableStream({ start(controller) {
    controller.enqueue(chunk(0, { v: 1, runId: run.runId, site: run.site, page: run.entry }));
    retire = () => controller.close();
  } });
  bridge!.states = [{ runId: "x", revision: 1, state: "running", counts: counts(1), result: null }];
  const aborter = new AbortController(), first = tool({ entry: "site" }, { signal: aborter.signal }).catch(() => null);
  await until(() => broadcasts.some(message => message.verify?.live));
  const second = tool({ entry: "site" }); await until(() => card()?.status === "waiting");
  aborter.abort(); await first; await until(() => bridge!.cancels === 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(bridge!.starts).toHaveLength(1);
  bridge!.cast = undefined; bridge!.states = finalStates(result());
  retire();
  expect((await second).body.status).toBe("completed");
  expect(bridge!.starts).toHaveLength(2);
});

afterEach(async () => {
  vi.restoreAllMocks();
  turnRegistry.settle("turn-1");
  turnRegistry.settle("turn-2");
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  Object.assign(flags.limits, flags.original);
  rmSync(tmp, { recursive: true, force: true });
});

describe("verify_site caller", () => {
  it("takes the caller from the bearer and ignores body ids", async () => {
    const other = store.createBot({}, { seedMessages: false });
    store.patchBot(botId, { autoApprove: true });
    bridge!.states = finalStates(result());
    const reply = await tool({ entry: "site", fromBotId: other.id, fromThreadId: other.threadId });
    expect(reply.body.status).toBe("completed");
    expect(card()?.owner).toBe(botId);
    expect(store.activePath(other.threadId).some((m) => m.verify)).toBe(false);
  });

  it("refuses an unknown bearer, a call with no turn, and a peer turn", async () => {
    expect((await tool({ entry: "site" }, { auth: "Bearer nope" })).status).toBe(403);
    turnRegistry.settle("turn-1");
    expect((await tool({ entry: "site" })).status).toBe(409);
    turnRegistry.start("turn-2", { botId, threadId, owner: "peer", depth: 1 });
    expect((await tool({ entry: "site" })).status).toBe(403);
    expect(bridge!.starts).toEqual([]);
  });
});

describe("verify_site scope", () => {
  it.each([
    ["a UNC path", () => "\\\\server\\share\\site"],
    ["a stream path", () => "site/index.html:secret"],
  ])("refuses %s as outside-folders with no card", async (_label, entry) => {
    const reply = await tool({ entry: entry() });
    expect(reply.body).toMatchObject({ status: "blocked", errorCode: "outside-folders" });
    expect(reply.body.text).toContain("is not inside your working folder or workspace");
    expect(card()).toBeUndefined();
    expect(bridge!.starts).toEqual([]);
  });

  it.each([["a folder without index.html", "notes"], ["a missing path", "nothing"], ["a non-HTML file", "site/a.css"]])("refuses %s as not-a-site", async (_label, entry) => {
    expect((await tool({ entry })).body).toMatchObject({ status: "blocked", errorCode: "not-a-site" });
    expect(card()).toBeUndefined();
  });

  it("serves an .htm file from its parent folder", async () => {
    store.patchBot(botId, { autoApprove: true });
    writeFileSync(join(work, "site", "page.htm"), "<p>htm</p>");
    bridge!.states = finalStates(result());
    await tool({ entry: "site/page.htm" });
    expect(bridge!.starts[0]).toMatchObject({ entry: "page.htm", root: expect.stringMatching(/site$/), revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("accepts file URLs and refuses remote file hosts", async () => {
    bridge!.states = finalStates(result());
    expect((await tool({ entry: pathToFileURL(join(work, "site", "index.html")).href })).body.status).toBe("completed");
    expect(bridge!.starts[0]).toMatchObject({ entry: "index.html", root: await realpath(join(work, "site")) });
    for (const entry of ["file://other-pc/share/index.html", "file:///C:/index.html?secret", "file:///C:/index.html#fragment"]) {
      expect((await tool({ entry })).body).toMatchObject({ status: "blocked", errorCode: "outside-folders" });
    }
    expect(bridge!.starts).toHaveLength(1);
  });

  it.each(["path", "file", "relative", "junction"])("accepts a site outside workspace folders via %s", async kind => {
    bridge!.states = finalStates(result());
    const entry = kind === "file" ? pathToFileURL(join(tmp, "outside", "index.html")).href : kind === "relative" ? "../outside" : kind === "junction" ? "link" : join(tmp, "outside", "index.html");
    expect((await tool({ entry })).body.status).toBe("completed");
    expect(bridge!.starts[0]).toMatchObject({ root: await realpath(join(tmp, "outside")), entry: "index.html" });
    expect(card()?.status).toBe("completed");
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("accepts loopback dev servers on %s", async host => {
    const local = createServer((_req, res) => res.end("ready"));
    await new Promise<void>(resolve => local.listen(0, host === "[::1]" ? "::1" : "127.0.0.1", resolve));
    try {
      bridge!.states = finalStates(result());
      const entry = `http://${host}:${(local.address() as { port: number }).port}/dashboard?q=1`;
      expect((await tool({ entry })).body.status).toBe("completed");
      expect(bridge!.starts[0]).toMatchObject({ root: expect.stringContaining("/dashboard?q=1"), entry: "index.html" });
      expect(card()?.entry).toMatch(/^http:/);
    } finally { await new Promise<void>(resolve => local.close(() => resolve())); }
  });

  it("waits for a slow loopback listener", async () => {
    const local = createServer((_req, res) => res.end("ready"));
    await new Promise<void>(resolve => local.listen(0, "127.0.0.1", resolve));
    const port = (local.address() as { port: number }).port;
    await new Promise<void>(resolve => local.close(() => resolve()));
    const timer = setTimeout(() => local.listen(port, "127.0.0.1"), 650);
    try {
      bridge!.states = finalStates(result());
      expect((await tool({ entry: `http://127.0.0.1:${port}/` })).body.status).toBe("completed");
    } finally { clearTimeout(timer); if (local.listening) await new Promise<void>(resolve => local.close(() => resolve())); }
  });

  it("explains an unused loopback port within the startup budget", async () => {
    const local = createServer();
    await new Promise<void>(resolve => local.listen(0, "127.0.0.1", resolve));
    const port = (local.address() as { port: number }).port;
    await new Promise<void>(resolve => local.close(() => resolve()));
    const started = Date.now(), reply = await tool({ entry: `http://127.0.0.1:${port}/` });
    expect(reply.body).toMatchObject({ status: "blocked", errorCode: "page-failed" });
    expect(reply.body.text).toContain(`nothing is running on port ${port}`);
    expect(Date.now() - started).toBeLessThan(13_000);
    expect(bridge!.starts).toHaveLength(0);
  });

  it.each(["http://192.168.1.2:3000/", "http://example.com/", "http://localhost.example.com/", "http://user:pass@127.0.0.1/", "http://2130706433/", "http://127.1/", "http://[::ffff:127.0.0.1]/"])("refuses noncanonical or foreign URL %s", async entry => {
    expect((await tool({ entry })).body).toMatchObject({ status: "blocked", errorCode: "outside-folders" });
    expect(bridge!.starts).toHaveLength(0);
  });

  it("answers desktop-required without a bridge and queues another run", async () => {
    bridge = null;
    expect((await tool({ entry: "site" })).body).toMatchObject({ status: "blocked", errorCode: "desktop-required" });
    expect(card()).toBeUndefined();
    bridge = fakeBridge();
    const aborter = new AbortController();
    const first = tool({ entry: "site" }, { signal: aborter.signal }).catch(() => null);
    await until(() => bridge!.starts.length === 1);
    const second = tool({ entry: "site" });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(bridge!.starts).toHaveLength(1);
    bridge!.states = finalStates(result());
    aborter.abort();
    await first;
    expect((await second).body.status).toBe("completed");
    expect(bridge!.starts).toHaveLength(2);
  });
});

describe("verify_site hidden checks", () => {
  it.each(["preparing", "running"] as const)("reruns a stale %s card after restart", async status => {
    const previous = { v: 1, runId: "old-run-1234", owner: botId, site: "site/index.html", entry: join(work, "site", "index.html"), status, mode: "auto", decisionNonce: "old-nonce", offeredAt: Date.now() - 80_000 } satisfies VerifyCardData;
    store.appendMessage(threadId, { role: "bot", kind: "note", text: "Live Verify", verify: previous });
    bridge!.states = finalStates(result());
    expect((await decide(previous.runId, "rerun", previous.decisionNonce)).status).toBe(200);
    await until(() => card()?.status === "completed");
    expect(bridge!.starts).toHaveLength(1);
  });

  it("refuses a rerun while the original run is live even if its card is stale", async () => {
    bridge!.states = [{ runId: "x", revision: 1, state: "running", counts: counts(1), result: null }];
    const pending = tool({ entry: "site" });
    const previous = await until(() => card());
    const message = store.activePath(threadId).find(message => message.verify)!;
    store.patchMessage(threadId, message.id, { verify: { ...previous, startedAt: Date.now() - 80_000 } });
    expect((await decide(previous.runId, "rerun", previous.decisionNonce)).status).toBe(404);
    turnRegistry.settle("turn-1");
    expect((await pending).body.errorCode).toBe("cancelled");
  });

  it.each([false, true])("runs without an Ask offer, including unattended=%s", async away => {
    unattended = away;
    bridge!.states = finalStates(result());
    expect((await tool({ entry: "site" })).body.status).toBe("completed");
    expect(bridge!.starts[0]!.watch).toBe(false);
    expect(verdict).not.toHaveBeenCalled();
    expect(decisions).toEqual([]);
  });

  it("reruns hidden from the phone after the bot turn ends, updating the same card", async () => {
    bridge!.states = finalStates(result());
    await tool({ entry: "site" });
    const previous = card()!;
    turnRegistry.settle("turn-1");
    writeFileSync(join(work, "site", "index.html"), "<h1>Updated</h1>");
    bridge!.states = finalStates(result());
    const reply = await decide(previous.runId, "rerun", previous.decisionNonce, { authorization: "Bearer app-token", "x-openmausbot-companion": "1" });
    expect(reply.status).toBe(200);
    await until(() => card()?.status === "completed" && card()!.runId !== previous.runId);
    expect(bridge!.starts.map(row => row.watch)).toEqual([false, false]);
    expect(bridge!.starts[0]!.revision).not.toBe(bridge!.starts[1]!.revision);
    expect(store.activePath(threadId).filter(message => message.verify)).toHaveLength(1);
    expect((await decide(previous.runId, "rerun", previous.decisionNonce)).status).toBe(404);
  });

  it("refuses stale nonces, comms callers and show actions", async () => {
    bridge!.states = finalStates(result()); await tool({ entry: "site" });
    const previous = card()!;
    expect((await decide(previous.runId, "rerun", "stale")).status).toBe(404);
    expect((await decide(previous.runId, "rerun", previous.decisionNonce, { authorization: `Bearer ${token}` })).status).toBe(403);
    expect((await decide(previous.runId, "watch", previous.decisionNonce)).status).toBe(400);
    expect(bridge!.starts).toHaveLength(1);
  });
});

describe("verify_site Auto", () => {
  it("does not check or save a replay for a static site outside owned roots", async () => {
    bridge!.states = finalStates(result());
    await verify.startAuto({ botId, threadId, entry: join(tmp, "outside"), episode: "outside" });
    expect(bridge!.starts).toEqual([]);
    expect(card()).toBeUndefined();
    expect(existsSync(join(DATA_DIR, "verify-replays", threadId))).toBe(false);
  });

  it("runs after settlement, creates task cards and patches episode rechecks with fixed counts", async () => {
    turnRegistry.settle("turn-1");
    const input = { botId, threadId, entry: join(work, "site"), episode: "task-one" };
    bridge!.states = finalStates(result([{ tile: "desktop", checker: "LINKS", rule: "missing target", where: "a#missing", measured: "No target" }]));
    await verify.startAuto(input);
    expect(card()?.issueTotal).toBe(1);
    const first = store.activePath(threadId).findLast(message => message.verify)!;
    bridge!.states = finalStates(result());
    await verify.startAuto(input);
    expect(card()?.fixed).toBe(1);
    expect(store.activePath(threadId).filter(message => message.verify)).toHaveLength(1);
    expect(store.activePath(threadId).findLast(message => message.verify)!.id).toBe(first.id);
    bridge!.states = finalStates(result());
    await verify.startAuto({ ...input, episode: "task-two" });
    expect(store.activePath(threadId).filter(message => message.verify)).toHaveLength(2);
    expect(card()?.fixed).toBeUndefined();
  });

  it("shows no card, Check or replay for a run that checked nothing", async () => {
    const seen: string[] = [];
    store.onChange((change) => { if ((change.type === "message" || change.type === "message.patch") && change.message.verify) seen.push(change.message.verify.status); });
    bridge!.cast = async run => new ReadableStream({ start(controller) {
      controller.enqueue(chunk(0, { v: 1, runId: run.runId, site: run.site, page: run.entry, startedAt: Date.now(), tiles: { desktop: [1280, 720], phone: [392, 800] } }));
      controller.enqueue(chunk(1, { tile: "desktop", ms: 1, data: Buffer.from([255, 216, 255, 217]) }));
      controller.enqueue(chunk(3, { status: "blocked", ms: 20_000, issues: [], notChecked: [] }));
      controller.close();
    } });
    const none = { planned: 0, completed: 0, passed: 0, failed: 0, blocked: 0, notRun: 0 };
    bridge!.states = [
      { runId: "x", revision: 1, state: "running", counts: none, result: null },
      { runId: "x", revision: 2, state: "blocked", counts: none, result: result([], { counts: none, errorCode: "page-failed" }), errorCode: "page-failed" },
    ];
    expect(await verify.startAuto({ botId, threadId, entry: join(work, "site"), episode: "loading" })).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(seen).toEqual([]);
    expect(card()).toBeUndefined();
    expect(broadcasts.filter(message => message.verify)).toEqual([]);
    expect(existsSync(join(DATA_DIR, "verify-replays", threadId))).toBe(false);
    bridge!.states = finalStates(result());
    await verify.startAuto({ botId, threadId, entry: join(work, "site"), episode: "loaded" });
    expect(card()?.status).toBe("completed");
  });

  it("queues behind a tool run and replaces an older auto run for the same thread", async () => {
    const toolRun = tool({ entry: "site" });
    await until(() => bridge!.starts.length === 1);
    const input = { botId, threadId, entry: join(work, "site"), episode: "old-task" };
    const old = verify.startAuto(input);
    await new Promise<void>(done => setTimeout(done, 40));
    const latest = verify.startAuto({ ...input, episode: "new-task" });
    await old;
    expect(bridge!.starts).toHaveLength(1);
    bridge!.states = finalStates(result());
    bridge!.poll = async () => ({ runId: "x", revision: 3, state: "completed", counts: counts(10), result: result() });
    turnRegistry.settle("turn-1");
    await toolRun;
    await latest;
    expect(bridge!.starts).toHaveLength(2);
  });

  it("silently skips auto starts without a bridge or an admitted entry", async () => {
    await verify.startAuto({ botId, threadId, entry: join(work, "notes"), episode: "notes" });
    expect(card()).toBeUndefined();
    bridge = null;
    await verify.startAuto({ botId, threadId, entry: join(work, "site"), episode: "site" });
    expect(card()).toBeUndefined();
  });

  it("reruns an earlier task card after a newer task and keeps its episode count", async () => {
    turnRegistry.settle("turn-1");
    const issue = { tile: "desktop" as const, checker: "LINKS" as const, rule: "missing target", where: "a#missing", measured: "No target" };
    const input = { botId, threadId, entry: join(work, "site"), episode: "first" };
    bridge!.states = finalStates(result([issue]));
    await verify.startAuto(input);
    const first = card()!;
    bridge!.states = finalStates(result());
    await verify.startAuto({ ...input, episode: "second" });
    const second = card()!;
    bridge!.states = finalStates(result());
    expect((await decide(first.runId, "rerun", first.decisionNonce)).status).toBe(200);
    await until(() => store.activePath(threadId).some(message => message.verify?.fixed === 1));
    const cards = store.activePath(threadId).filter(message => message.verify);
    expect(cards).toHaveLength(2);
    expect(cards[1]!.verify!.runId).toBe(second.runId);
    expect(cards[0]!.verify!.fixed).toBe(1);
  });

  it("keeps each room owner's card", async () => {
    const other = store.createBot({}, { seedMessages: false });
    const room = store.createGroup("Team", [botId, other.id]);
    threadId = room.threadId;
    turnRegistry.settle("turn-1");
    turnRegistry.start("turn-1", { botId, threadId, owner: "user", depth: 0 });
    token = callers.token(botId, threadId);
    bridge!.states = finalStates(result());
    await tool({ entry: "site" });
    const first = card()!;
    turnRegistry.settle("turn-1");
    botId = other.id;
    turnRegistry.start("turn-2", { botId, threadId, owner: "user", depth: 0 });
    token = callers.token(botId, threadId);
    bridge!.states = finalStates(result());
    await tool({ entry: "site" });
    const cards = store.activePath(threadId).filter(message => message.verify);
    expect(cards).toHaveLength(2);
    expect(cards.find(message => message.verify?.owner === first.owner)?.verify?.runId).toBe(first.runId);
    expect(cards.find(message => message.verify?.owner === botId)?.from?.botId).toBe(botId);
  });

  it("keeps receipt summaries out of pane notes and startup wakes", async () => {
    bridge!.states = finalStates(result());
    await tool({ entry: "site" });
    const messages = store.activePath(threadId);
    const receipt = messages.find(message => message.verify)!;
    expect(isWakeNote(receipt)).toBe(false);
    expect(hasLocalUndeliveredPaneNote(messages, undefined, "device-1")).toBe(false);
    expect(paneNotesForTurn(messages, new Set(), undefined, false).notes).toEqual([]);
    const context = await prepareModelContext({ messages, contextWindow: 32_000, taskRecordText: "", summarize: vi.fn(async () => "") });
    expect(context.status).toBe("ready");
    if (context.status !== "ready") return;
    expect(context.transcript.some(message => message.text.includes(receipt.text!))).toBe(true);
    expect(JSON.stringify(context.transcript)).not.toContain("Pane note");
  });

  it.each(["running", "completed"])("frees the slot after a %s card persistence failure", async status => {
    const append = store.appendMessage.bind(store);
    const patch = store.patchMessage.bind(store);
    vi.spyOn(store, "appendMessage").mockImplementation((thread, input) => {
      if (input.verify?.status === status || input.verify?.status === "blocked") throw new Error("disk full");
      return append(thread, input);
    });
    vi.spyOn(store, "patchMessage").mockImplementation((thread, id, input) => {
      if (input.verify?.status === status || input.verify?.status === "blocked") throw new Error("disk full");
      return patch(thread, id, input);
    });
    bridge!.states = finalStates(result());
    expect((await tool({ entry: "site" })).body).toMatchObject({ status: "blocked", errorCode: "internal" });
    vi.mocked(store.appendMessage).mockRestore();
    vi.mocked(store.patchMessage).mockRestore();
    bridge!.states = finalStates(result());
    expect((await tool({ entry: "site" })).body.status).toBe("completed");
  });

  it("moves the card running, completed with counts from the first check, broadcasting counts only in memory", async () => {
    store.patchBot(botId, { autoApprove: true });
    const seen: string[] = [];
    store.onChange((change) => { if (change.type === "message" || change.type === "message.patch") if (change.message.verify) seen.push(change.message.verify.status); });
    bridge!.states = finalStates(result([{ checker: "CONTRAST", tile: "phone", rule: "contrast", where: "p.lede", measured: "3.1:1, needs 4.5:1" }]));
    const reply = await tool({ entry: "site" });
    expect([...new Set(seen)]).toEqual(["running", "completed"]);
    expect(broadcasts.at(-1)?.verify?.counts?.completed).toBe(5);
    expect(card()).toMatchObject({ status: "completed", counts: counts(10, 1), issueTotal: 0, issues: [], details: [expect.objectContaining({ rule: "contrast" })] });
    expect(reply.body.text).toContain("no problems found");
    expect(reply.body.text).not.toContain("3.1:1");
  });

  it("patches one card per owner and thread for the next run", async () => {
    store.patchBot(botId, { autoApprove: true });
    bridge!.states = finalStates(result());
    const first = (await tool({ entry: "site" })).body.runId;
    bridge!.states = finalStates(result());
    const second = (await tool({ entry: "site" })).body.runId;
    const cards = store.activePath(threadId).filter((m) => m.verify);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.verify?.runId).toBe(second);
    expect(second).not.toBe(first);
  });

  it("marks a same-turn recheck that passes after problems as fixed, once", async () => {
    store.patchBot(botId, { autoApprove: true });
    const dead = { checker: "LINKS", tile: "desktop", rule: "missing target", where: "a#x", measured: "#x has no target" } as const;
    bridge!.states = finalStates(result([dead, { ...dead, where: "a#y" }]));
    await tool({ entry: "site" });
    expect(card()).toMatchObject({ issueTotal: 2 });
    expect(card()?.fixed).toBeUndefined();
    bridge!.states = finalStates(result());
    await tool({ entry: "site" });
    expect(card()).toMatchObject({ issueTotal: 0, fixed: 2 });
    bridge!.states = finalStates(result());
    await tool({ entry: "site" });
    expect(card()?.fixed).toBeUndefined();
  });

  it("counts a clean check of another page in the turn as no fix", async () => {
    store.patchBot(botId, { autoApprove: true });
    writeFileSync(join(work, "site", "other.html"), "<h1>other</h1>");
    const dead = { checker: "LINKS", tile: "desktop", rule: "missing target", where: "a#x", measured: "#x has no target" } as const;
    bridge!.states = finalStates(result([dead, { ...dead, where: "a#y" }]));
    await tool({ entry: "site" });
    bridge!.states = finalStates(result());
    await tool({ entry: "site/other.html" });
    expect(card()).toMatchObject({ issueTotal: 0 });
    expect(card()?.fixed).toBeUndefined();
    bridge!.states = finalStates(result());
    await tool({ entry: "site" });
    expect(card()).toMatchObject({ issueTotal: 0, fixed: 2 });
  });
});

describe("verify_site cancellation", () => {
  beforeEach(() => store.patchBot(botId, { autoApprove: true }));

  it("a dropped request cancels once", async () => {
    bridge!.states = [{ runId: "x", revision: 1, state: "running", counts: counts(1), result: null }];
    const aborter = new AbortController();
    const pending = tool({ entry: "site" }, { signal: aborter.signal }).catch(() => null);
    await until(() => bridge!.starts.length === 1);
    aborter.abort();
    await pending;
    await until(() => card()?.status === "blocked");
    expect(card()?.errorCode).toBe("cancelled");
    expect(bridge!.cancels).toBe(1);
  });

  it("turn replacement cancels once", async () => {
    const pending = tool({ entry: "site" });
    await until(() => bridge!.starts.length === 1);
    turnRegistry.start("turn-2", { botId, threadId, owner: "user", depth: 0 });
    expect((await pending).body).toMatchObject({ status: "blocked", errorCode: "cancelled", text: "Not checked: the run was cancelled." });
    expect(bridge!.cancels).toBe(1);
  });

  it("the run deadline cancels once with timeout and partial counts", async () => {
    flags.limits.runMs = 200;
    bridge!.states = [{ runId: "x", revision: 1, state: "running", counts: counts(3), result: null }];
    const reply = await tool({ entry: "site" });
    expect(reply.body).toMatchObject({ status: "blocked", errorCode: "timeout" });
    expect(reply.body.text).toBe("Not checked: the run passed its time limit.");
    expect(bridge!.cancels).toBe(1);
  });

  it("a normally finished request body does not cancel", async () => {
    bridge!.states = finalStates(result());
    const reply = await tool({ entry: "site" });
    expect(reply.body.status).toBe("completed");
    expect(bridge!.cancels).toBe(0);
  });
});

describe("verify_site replies", () => {
  beforeEach(() => store.patchBot(botId, { autoApprove: true }));

  it("says no issues found", async () => {
    bridge!.states = finalStates(result());
    expect((await tool({ entry: "site" })).body.text).toBe("Desktop and phone: no problems found.");
  });

  it("trims issue lines to the reply cap", async () => {
    const issues = Array.from({ length: 40 }, () => ({ checker: "FIT" as const, tile: "phone" as const, rule: "sideways scroll", where: "w".repeat(120), measured: "m".repeat(160) }));
    bridge!.states = finalStates(result(issues, { issueTotal: 55 }));
    const text: string = (await tool({ entry: "site" })).body.text;
    expect(text.length).toBeLessThanOrEqual(1200);
    expect(text).toContain("Phone 392 px");
    expect(text).toContain("at most twice");
  });

  it("reports a blocked run with its reason and partial counts", async () => {
    bridge!.states = [{ runId: "x", revision: 1, state: "blocked", counts: counts(4), result: result([], { counts: counts(4), errorCode: "page-failed" }), errorCode: "page-failed" }];
    expect((await tool({ entry: "site" })).body).toMatchObject({
      status: "blocked", errorCode: "page-failed",
      text: "Not checked: a page crashed or never loaded.",
    });
  });

  it("maps a bridge busy start to busy", async () => {
    bridge!.startReply = "busy";
    expect((await tool({ entry: "site" })).body).toMatchObject({ status: "blocked", errorCode: "busy" });
  });
});

describe("verify_site kill switch", () => {
  it("404s both routes and sets no env when off", async () => {
    flags.on = false;
    expect((await tool({ entry: "site" })).status).toBe(404);
    expect((await decide("abcdefgh-1234", "skip", "n")).status).toBe(404);
    for (const kind of ["live", "replay"]) expect((await fetch(`${base}/api/verify/runs/abcdefgh-1234/${kind}`, { headers: { authorization: "Bearer app-token" } })).status).toBe(404);
    expect(existsSync(join(DATA_DIR, "verify-replays"))).toBe(false);
  });
});
