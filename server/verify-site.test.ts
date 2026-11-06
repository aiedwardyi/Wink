import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VerifyRunState } from "../electron/verify-protocol.mjs";
import type { VerifyCardData, VerifyResult } from "../shared/live-verify.ts";
import { autoVerdict } from "./auto-approve.ts";
import { CommsCallers } from "./comms-caller.ts";
import { DATA_DIR } from "./config.ts";
import { Store, type Message } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";
import { createVerifySite, verifyToolEnv, type VerifyBridge } from "./verify-site.ts";

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
  return fetch(`${base}/decision/${runId}`, { method: "POST", headers, body: JSON.stringify({ action, nonce }) })
    .then(async (res) => ({ status: res.status, body: (await res.json()) as any }));
}
const offered = () => until(() => card()?.status === "offered" && card());

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
  const verify = createVerifySite({
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
    const id = /^\/decision\/(.+)$/.exec(req.url ?? "")?.[1];
    if (id) return void verify.handleDecision(req, res, id, { relay: req.headers["x-relay"] === "1", phoneSession: req.headers["x-relay"] === "1" });
    void verify.handleTool(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
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
    ["a sibling prefix folder", () => join(tmp, "work2")],
    ["a .. escape", () => "site/../../outside"],
    ["a junction out of the root", () => "link"],
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

  it("answers desktop-required without a bridge, and busy while a run holds the slot", async () => {
    bridge = null;
    expect((await tool({ entry: "site" })).body).toMatchObject({ status: "blocked", errorCode: "desktop-required" });
    expect(card()).toBeUndefined();
    bridge = fakeBridge();
    const first = tool({ entry: "site" });
    await offered();
    const second = await tool({ entry: "site" });
    expect(second.body).toMatchObject({ status: "blocked", errorCode: "busy" });
    expect(second.body.text).toBe("Live Verify could not finish site: another Live Verify run is going; try again when it finishes.");
    await decide(card()!.runId, "skip", card()!.decisionNonce);
    await first;
  });
});

describe("verify_site Ask", () => {
  it("starts nothing before Watch, then starts with watch true", async () => {
    const pending = tool({ entry: "site" });
    const offer = await offered();
    expect(offer.mode).toBe("ask");
    expect(bridge!.starts).toEqual([]);
    bridge!.states = finalStates(result());
    expect((await decide(offer.runId, "watch", offer.decisionNonce)).body).toEqual({ status: "preparing" });
    const reply = await pending;
    expect(bridge!.starts).toHaveLength(1);
    expect(bridge!.starts[0]!.watch).toBe(true);
    expect(reply.body.status).toBe("completed");
  });

  it("Skip runs nothing", async () => {
    const pending = tool({ entry: "site" });
    const offer = await offered();
    await decide(offer.runId, "skip", offer.decisionNonce, { authorization: "Bearer app-token", "x-openmausbot-companion": "1" });
    expect((await pending).body).toMatchObject({ status: "skipped", text: "The user skipped Live Verify for site/index.html. Nothing ran." });
    expect(card()?.status).toBe("skipped");
    expect(bridge!.starts).toEqual([]);
  });

  it("goes stale when nobody answers", async () => {
    flags.limits.askWaitMs = 200;
    const reply = await tool({ entry: "site" });
    expect(reply.body).toMatchObject({ status: "stale", text: "No answer on the Live Verify card for site/index.html within 2 minutes. Nothing ran." });
    expect(card()?.status).toBe("stale");
    expect(bridge!.starts).toEqual([]);
  });

  it("holds the card and answers needs-approval at once when unattended", async () => {
    unattended = true;
    const reply = await tool({ entry: "site" });
    expect(reply.body).toMatchObject({
      status: "offered", errorCode: "needs-approval",
      text: "Live Verify for site/index.html needs the user's OK and they are away. A card is waiting in the chat; nothing ran.",
    });
    expect(card()).toMatchObject({ status: "offered", errorCode: "needs-approval", mode: "ask" });
    expect(verdict).toHaveBeenCalledWith(expect.objectContaining({ id: botId }), "verify_site", "Check the site site/index.html", { unattended: true });
    expect(bridge!.starts).toEqual([]);
  });

  it("runs a held offer on a later local Watch after the turn ended, card only", async () => {
    unattended = true;
    await tool({ entry: "site" });
    const held = card()!;
    turnRegistry.settle("turn-1");
    bridge!.states = finalStates(result());
    expect((await decide(held.runId, "watch", held.decisionNonce)).status).toBe(200);
    await until(() => card()?.status === "completed");
    expect(bridge!.starts[0]!.watch).toBe(true);
  });
});

describe("verify_site decisions", () => {
  it("refuses unknown runs, old nonces, phone Watch and scoped comms callers", async () => {
    const pending = tool({ entry: "site" });
    const offer = await offered();
    expect((await decide("unknown-run", "watch", offer.decisionNonce)).body).toEqual({ error: "not-here" });
    expect((await decide(offer.runId, "watch", "old-nonce")).status).toBe(404);
    expect((await decide(offer.runId, "watch", offer.decisionNonce, { "x-relay": "1" })).status).toBe(403);
    expect((await decide(offer.runId, "watch", offer.decisionNonce, { authorization: "Bearer app-token", "x-remote": "1" })).status).toBe(403);
    expect((await decide(offer.runId, "watch", offer.decisionNonce, { authorization: `Bearer ${token}` })).status).toBe(403);
    expect((await decide(offer.runId, "watch", offer.decisionNonce, {})).status).toBe(401);
    expect(bridge!.starts).toEqual([]);
    await decide(offer.runId, "skip", offer.decisionNonce, { "x-relay": "1" });
    expect((await pending).body.status).toBe("skipped");
  });

  it("refuses Watch after the site changed and starts nothing", async () => {
    const pending = tool({ entry: "site" });
    const offer = await offered();
    writeFileSync(join(work, "site", "a.css"), "h1{color:blue}");
    expect((await decide(offer.runId, "watch", offer.decisionNonce)).status).toBe(404);
    expect((await pending).body).toMatchObject({ status: "blocked", errorCode: "site-changed" });
    expect(bridge!.starts).toEqual([]);
  });

  it("refuses an expired held offer", async () => {
    unattended = true;
    flags.limits.heldMs = 50;
    await tool({ entry: "site" });
    const held = card()!;
    await new Promise((r) => setTimeout(r, 80));
    expect((await decide(held.runId, "watch", held.decisionNonce)).status).toBe(404);
    expect(bridge!.starts).toEqual([]);
  });

  it("starts once when Watch and Skip race", async () => {
    const pending = tool({ entry: "site" });
    const offer = await offered();
    bridge!.states = finalStates(result());
    const answers = await Promise.all([
      decide(offer.runId, "watch", offer.decisionNonce),
      decide(offer.runId, "watch", offer.decisionNonce),
      decide(offer.runId, "skip", offer.decisionNonce),
    ]);
    const won = answers.filter((a) => a.status === 200);
    expect(won).toHaveLength(1);
    await pending;
    expect(bridge!.starts).toHaveLength(won[0]!.body.status === "preparing" ? 1 : 0);
  });

  it("Watch on a running Auto run opens it; Skip changes nothing", async () => {
    store.patchBot(botId, { autoApprove: true });
    bridge!.states = [{ runId: "x", revision: 1, state: "running", counts: counts(2), result: null }];
    const pending = tool({ entry: "site" });
    const running = await until(() => card()?.status === "running" && card());
    expect((await decide(running.runId, "skip", running.decisionNonce)).body).toEqual({ status: "running" });
    expect((await decide(running.runId, "watch", running.decisionNonce)).status).toBe(200);
    expect(bridge!.watches).toBe(1);
    turnRegistry.settle("turn-1");
    expect((await pending).body).toMatchObject({ status: "blocked", errorCode: "cancelled" });
  });
});

describe("verify_site Auto", () => {
  it("calls autoVerdict with verify_site, logs the chip and starts unwatched", async () => {
    store.patchBot(botId, { autoApprove: true });
    bridge!.states = finalStates(result());
    const reply = await tool({ entry: "site" });
    expect(verdict).toHaveBeenCalledWith(expect.objectContaining({ id: botId }), "verify_site", "Check the site site/index.html", { unattended: false });
    const chip = store.activePath(threadId).find((m) => m.tool?.approval);
    expect(chip?.tool).toEqual({ name: "auto-approved verify_site: Check the site site/index.html", ok: true, approval: true });
    expect(decisions).toEqual([expect.objectContaining({ tool: "verify_site", decision: "auto-approved", source: "auto-mode" })]);
    expect(bridge!.starts[0]!.watch).toBe(false);
    expect(reply.body.status).toBe("completed");
  });

  it("moves the card preparing, running, completed with counts, broadcasting counts only in memory", async () => {
    store.patchBot(botId, { autoApprove: true });
    const seen: string[] = [];
    store.onChange((change) => { if (change.type === "message" || change.type === "message.patch") if (change.message.verify) seen.push(change.message.verify.status); });
    bridge!.states = finalStates(result([{ checker: "CONTRAST", tile: "phone", rule: "contrast", where: "p.lede", measured: "3.1:1, needs 4.5:1" }]));
    const reply = await tool({ entry: "site" });
    expect([...new Set(seen)]).toEqual(["preparing", "running", "completed"]);
    expect(broadcasts.at(-1)?.verify?.counts?.completed).toBe(5);
    expect(card()).toMatchObject({ status: "completed", counts: counts(10, 1), issueTotal: 1 });
    expect(reply.body.text).toBe([
      "Live Verify: site/index.html - 10 checks, 9 passed, 1 issues, 0 blocked, 0 not run (22 s).",
      "Issues (1 of 1):",
      "1. CONTRAST phone · p.lede · 3.1:1, needs 4.5:1",
      "Fix them in the site files, then call verify_site again for a fresh full run.",
    ].join("\n"));
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
});

describe("verify_site cancellation", () => {
  beforeEach(() => store.patchBot(botId, { autoApprove: true }));

  it("a dropped request cancels once", async () => {
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
    expect((await pending).body).toMatchObject({ status: "blocked", errorCode: "cancelled", text: "Live Verify could not finish site/index.html: the run was cancelled." });
    expect(bridge!.cancels).toBe(1);
  });

  it("the run deadline cancels once with timeout and partial counts", async () => {
    flags.limits.runMs = -9_800;
    bridge!.states = [{ runId: "x", revision: 1, state: "running", counts: counts(3), result: null }];
    const reply = await tool({ entry: "site" });
    expect(reply.body).toMatchObject({ status: "blocked", errorCode: "timeout" });
    expect(reply.body.text).toBe("Live Verify could not finish site/index.html: the run passed its time limit.\nPartial: 3 checks, 3 passed, 0 issues, 0 blocked, 7 not run.");
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
    expect((await tool({ entry: "site" })).body.text).toBe("Live Verify: site/index.html - 10 checks, 10 passed, 0 issues, 0 blocked, 0 not run (22 s).\nNo issues found.");
  });

  it("trims issue lines to the reply cap", async () => {
    const issues = Array.from({ length: 40 }, () => ({ checker: "FIT" as const, tile: "desktop" as const, rule: "cut text", where: "w".repeat(120), measured: "m".repeat(160) }));
    bridge!.states = finalStates(result(issues, { issueTotal: 55 }));
    const text: string = (await tool({ entry: "site" })).body.text;
    expect(text.length).toBeLessThanOrEqual(8_000);
    expect(text).toMatch(/^Issues \((\d+) of 55\):$/m);
    expect(Number(/Issues \((\d+) of/.exec(text)![1])).toBeLessThan(40);
    expect(text.endsWith("Fix them in the site files, then call verify_site again for a fresh full run.")).toBe(true);
  });

  it("reports a blocked run with its reason and partial counts", async () => {
    bridge!.states = [{ runId: "x", revision: 1, state: "blocked", counts: counts(4), result: result([], { counts: counts(4), errorCode: "page-failed" }), errorCode: "page-failed" }];
    expect((await tool({ entry: "site" })).body).toMatchObject({
      status: "blocked", errorCode: "page-failed",
      text: "Live Verify could not finish site/index.html: a page crashed or never loaded.\nPartial: 4 checks, 4 passed, 0 issues, 0 blocked, 6 not run.",
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
    expect(verifyToolEnv(true, "win32")).toEqual({});
    flags.on = true;
    expect(verifyToolEnv(true, "win32")).toEqual({ OMB_LIVE_VERIFY: "1" });
    expect(verifyToolEnv(false, "win32")).toEqual({});
    expect(verifyToolEnv(true, "darwin")).toEqual({});
  });
});
