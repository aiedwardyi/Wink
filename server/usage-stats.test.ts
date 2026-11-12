import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EVENT_NAMES, statsBatchSchema, statsEventSchema, type StatsBatch } from "../shared/usage-stats.ts";
import { saveAnalyticsConsent } from "./analytics-consent.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { createUsageStats, type StatsInput, type StatsState, type TurnFacts, type UsageStatsOptions } from "./usage-stats.ts";

const URL = "https://relay.example.test/v1/stats";
const STATE: StatsState = {
  engines: [{ kind: "claudeAgent", accounts: 2, signedIn: true, cli: "claude 2.1.30 (Claude Code)" }, { kind: "homebrew", accounts: 0, signedIn: false }],
  counts: { bots: 5, rooms: 1, joinedRooms: 0, archived: 9, routines: 0, skills: 20, mcp: 2, phones: 1, pcs: 12 },
  on: { tailscale: true, relay: false, push: false, sync: true, syncChats: false, team: false, chief: true },
  keys: ["composio", "xai"],
};
// One of each event, as the app hands them over.
const SAMPLES: StatsInput[] = [
  { e: "launch", cold: true, mainMs: 900, serverMs: 400, windowMs: 300, checksMs: 2100, prevClean: true, prevMin: 42 },
  { e: "open", c: "phone", label: "notification", fcpMs: 300, mountMs: 350, helloMs: 500, chatMs: 620, cached: true },
  { e: "onboard", step: "engine", ms: 4000, engine: "codex" },
  { e: "first_reply", msStart: 90_000, msFinish: 12_000, engine: "claudeAgent", model: "claude-opus-5-5", tries: 1 },
  { e: "turn", c: "desktop", surface: "chat", engine: "claudeAgent", model: "claude-opus-5-5", effort: "high", ok: true, stop: "done", tools: 3, tokIn: 1200, tokOut: 300, costUsd: 0.12, len: 2 },
  { e: "turn_error", engine: "codex", model: "gpt-6-astra", kind: "retry", code: "rate_limited" },
  { e: "send", c: "desktop", input: "typed", bubbleMs: 12, firstMs: 900 },
  { e: "switch", what: "model", via: "picker", ms: 40, from: "claude-opus-5-5", to: "claude-sonnet-5-5" },
  { e: "screen", c: "browser", name: "settings-general", n: 2 },
  { e: "setting", c: "desktop", key: "skin", from: "default", to: "nord", via: "settings" },
  { e: "feature", c: "desktop", name: "attach.add", n: 1, kind: "image" },
  { e: "worker", phase: "end", engine: "claudeAgent", model: "claude-sonnet-5-5", effort: "medium", parallel: 3, outcome: "done", min: 7 },
  { e: "crash", process: "renderer", kind: "renderer-gone", exit: -1073741819, up: 2 },
  { e: "error", c: "desktop", site: "rendererError", code: "UNKNOWN_ERROR", stack: "0123456789ab", n: 1 },
  { e: "stall", c: "phone", where: "ui", ms: 2600 },
  { e: "update", phase: "installed", from: "1.0.255", to: "1.0.256", ms: 60_000 },
];
// What must never leave: a path, an email, a name, an address, a code, a typed sentence.
const POISON = ["C:\\Users\\dana\\secret plan.docx", "/home/dana/notes.md", "dana@example.com", "Dana Kim", "192.168.1.20", "fd7a:115c:a1e0::1", "ROOM-7Q2K", "please fix my resume", "sk-live-abcdef0123456789"];

let root: string;
let made: ReturnType<typeof createUsageStats>[] = [];
let posts: { url: string; batch: StatsBatch; headers: Record<string, string>; signal: AbortSignal }[];
let answers: Array<Response | Promise<Response>>;

const sent = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  // SAFETY: the uploader always posts a gzipped Buffer.
  const batch = JSON.parse(gunzipSync(init!.body as Buffer).toString("utf8"));
  // SAFETY: the uploader always sets a plain header object and a signal.
  posts.push({ url: String(url), batch, headers: init!.headers as Record<string, string>, signal: init!.signal as AbortSignal });
  return answers.shift() ?? new Response(JSON.stringify({ ok: true, rejected: 0 }));
});

function stats(patch: Partial<UsageStatsOptions> = {}) {
  const made_ = createUsageStats({
    dataDir: root, url: URL, app: "1.0.256", state: () => STATE, turn: () => null, busy: () => false, fetch: sent, ...patch,
  });
  made.push(made_);
  return made_;
}
const file = (name: string) => join(root, name);
const queued = () => (existsSync(file("stats-queue.ndjson")) ? readFileSync(file("stats-queue.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const consent = (enabled: boolean) => saveAnalyticsConsent(root, enabled);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omb-usage-stats-")));
  posts = [];
  answers = [];
  sent.mockClear();
});

afterEach(() => {
  for (const one of made.splice(0)) one.setEnabled(false);
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe("off", () => {
  it("captures, writes and sends nothing without a stats URL", async () => {
    consent(true);
    const off = stats({ url: "" });
    off.start();
    for (const event of SAMPLES) off.capture(event);
    expect(off.ingest({ events: [SAMPLES[6]] })).toBe(false);
    await off.flush();
    await off.upload();
    expect(off.capturing()).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(["stats-queue.ndjson", "stats-id", "stats-active"].filter((name) => existsSync(file(name)))).toEqual([]);
  });

  it.each(["http://relay.example.test/v1/stats", "ftp://relay.example.test", "relay.example.test"])("refuses %s as a stats URL", async (url) => {
    consent(true);
    const off = stats({ url });
    off.start();
    off.capture(SAMPLES[0]!);
    await off.flush();
    expect(off.capturing()).toBe(false);
    expect(queued()).toEqual([]);
  });

  it.each([["no saved choice", undefined], ["a saved no", false]])("captures, writes and sends nothing with %s", async (_name, saved) => {
    if (saved !== undefined) consent(saved);
    const off = stats();
    for (const event of SAMPLES) off.capture(event);
    off.start();
    await off.flush();
    await off.upload();
    expect(off.capturing()).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(["stats-queue.ndjson", "stats-id", "stats-active"].filter((name) => existsSync(file(name)))).toEqual([]);
  });

  it("deletes the queue, the install id and the marker, and stops the upload in flight", async () => {
    consent(true);
    const on = stats();
    on.start();
    for (const event of SAMPLES) on.capture(event);
    await on.flush();
    await on.upload();
    expect(posts).toHaveLength(1);
    expect(existsSync(file("stats-id"))).toBe(true);
    on.capture(SAMPLES[8]!);
    await on.flush();
    expect(queued()).toHaveLength(1);
    let release: (value: Response) => void = () => {};
    answers.push(new Promise((resolve) => { release = resolve; }));
    const uploading = on.upload();
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    on.capture(SAMPLES[6]!);
    on.setEnabled(false);
    expect(posts[1]!.signal.aborted).toBe(true);
    expect(["stats-queue.ndjson", "stats-id", "stats-active"].filter((name) => existsSync(file(name)))).toEqual([]);
    release(new Response("{}", { status: 503 }));
    await uploading;
    on.capture(SAMPLES[6]!);
    expect(on.ingest({ events: [SAMPLES[6]] })).toBe(false);
    await on.flush();
    await on.upload();
    expect(posts).toHaveLength(2);
    expect(on.capturing()).toBe(false);
    expect(["stats-queue.ndjson", "stats-id", "stats-active"].filter((name) => existsSync(file(name)))).toEqual([]);
  });

  it("starts again with a new install id when turned back on", async () => {
    consent(true);
    const on = stats();
    on.start();
    on.capture(SAMPLES[8]!);
    await on.flush();
    await on.upload();
    on.setEnabled(false);
    on.setEnabled(true);
    on.capture(SAMPLES[8]!);
    await on.flush();
    await on.upload();
    expect(posts).toHaveLength(2);
    expect(posts[1]!.batch.id).not.toBe(posts[0]!.batch.id);
  });
});

describe("on", () => {
  it("queues every event the schema knows and sends one gzipped batch", async () => {
    consent(true);
    const on = stats({ internal: true, display: { scale: 150, screens: 2 } });
    for (const event of SAMPLES) on.capture(event);
    on.start();
    await on.flush();
    expect(queued().map((event) => event.e)).toEqual(SAMPLES.map((event) => event.e));
    for (const event of queued()) expect(statsEventSchema.safeParse(event).success).toBe(true);
    expect(queued()[0]).toMatchObject({ prevMin: 15 });
    expect(queued().find((event) => event.e === "worker")).toMatchObject({ min: 5 });
    expect(queued().find((event) => event.e === "stall")).toMatchObject({ ms: 2000 });
    await on.upload();
    expect(posts).toHaveLength(1);
    const { url, batch, headers } = posts[0]!;
    expect(url).toBe(URL);
    expect(headers).toEqual({ "content-type": "application/json", "content-encoding": "gzip" });
    expect(statsBatchSchema.safeParse(batch).success).toBe(true);
    expect(batch).toMatchObject({ v: 1, app: "1.0.256", channel: "stable", internal: true, lang: "en", dropped: 0 });
    expect(batch.id).toBe(readFileSync(file("stats-id"), "utf8"));
    expect(batch.events.map((event) => event.e)).toEqual(["state", ...SAMPLES.map((event) => event.e)]);
    expect(new Set(batch.events.map((event) => event.e)).size).toBe(EVENT_NAMES.length);
    expect(batch.events[0]).toMatchObject({
      pc: { scale: 150, screens: 2 },
      engines: [{ kind: "claudeAgent", accounts: 2, signedIn: true, cli: "2.1.30" }, { kind: "other", accounts: 0, signedIn: false }],
      counts: { bots: 4, rooms: 1, joinedRooms: 0, archived: 8, routines: 0, skills: 16, mcp: 2, phones: 1, pcs: 9 },
      on: STATE.on, keys: STATE.keys,
    });
    expect(queued()).toEqual([]);
  });

  it("sends the state once a UTC day, across restarts", async () => {
    consent(true);
    const first = stats();
    first.start();
    first.capture(SAMPLES[8]!);
    await first.flush();
    await first.upload();
    first.capture(SAMPLES[8]!);
    await first.flush();
    await first.upload();
    first.stop();
    const second = stats();
    second.start();
    second.capture(SAMPLES[8]!);
    await second.flush();
    await second.upload();
    expect(posts.map((post) => post.batch.events.map((event) => event.e))).toEqual([["state", "screen"], ["screen"], ["screen"]]);
    expect(new Set(posts.map((post) => post.batch.id)).size).toBe(1);
    expect(new Set(posts.map((post) => post.batch.batch)).size).toBe(3);
  });

  it("sends nothing when the queue is empty", async () => {
    consent(true);
    const on = stats();
    on.start();
    await on.upload();
    expect(sent).not.toHaveBeenCalled();
    expect(existsSync(file("stats-id"))).toBe(false);
  });

  it("replaces ids outside the lists and drops what the schema refuses", async () => {
    consent(true);
    const on = stats();
    on.start();
    on.capture({ e: "turn", c: "desktop", surface: "chat", engine: "my-fork", model: "llama-local-dana", effort: "turbo", ok: true, stop: "done" });
    on.capture({ e: "switch", what: "model", via: "picker", from: "dana-finetune", to: "claude-opus-5-5" });
    on.capture({ e: "switch", what: "chat", via: "sidebar", from: "Dana's bot", to: "Work room", ms: 30 });
    on.capture({ e: "setting", c: "desktop", key: "skin", from: "my-theme", to: "nord", via: "settings" });
    on.capture({ e: "turn_error", engine: "codex", kind: "runtime", code: "Error: ENOENT C:\\Users\\dana" });
    on.capture({ e: "setting", c: "desktop", key: "language", from: "en", to: "fr", via: "settings" });
    // SAFETY: a caller bug, typed away to prove the queue still refuses it.
    on.capture({ e: "screen", c: "desktop", name: "Dana's room", n: 1 } as never);
    await on.flush();
    expect(queued().map(({ h: _h, ...event }) => event)).toEqual([
      { e: "turn", c: "desktop", surface: "chat", engine: "other", model: "custom", effort: "auto", ok: true, stop: "done" },
      { e: "switch", what: "model", via: "picker", from: "custom", to: "claude-opus-5-5" },
      { e: "switch", what: "chat", via: "sidebar", ms: 30 },
      { e: "setting", c: "desktop", key: "skin", from: "other", to: "nord", via: "settings" },
      { e: "turn_error", engine: "codex", kind: "runtime", code: "other" },
    ]);
  });

  it("never lets typed text, paths, emails, names or addresses reach the queue or the wire", async () => {
    consent(true);
    const on = stats();
    on.start();
    for (const sample of SAMPLES) {
      for (const [key, value] of Object.entries(sample)) {
        for (const poison of POISON) {
          if (typeof value === "string" && key !== "e") {
            on.capture({ ...sample, [key]: poison } as never);
            on.ingest({ events: [{ ...sample, [key]: poison }] });
          }
          on.ingest({ events: [{ ...sample, [poison]: 1 }, { ...sample, note: poison }, { ...sample, h: poison }] });
        }
      }
      await on.flush();
    }
    on.ingest({ events: [], ui: { skin: POISON[3], shape: "soft", name: POISON[2] }, lang: "en" });
    on.ingest({ events: [], ui: { skin: "nord", bot: POISON[3] } });
    on.ingest({ events: [], lang: POISON[3] });
    on.ingest({ events: [{ e: "state", pc: { cores: 8, ramGb: 16, scale: 100, screens: 1 }, engines: [], counts: STATE.counts, on: STATE.on, keys: [POISON[2]] }] });
    on.capture(SAMPLES[8]!);
    await on.flush();
    const disk = readFileSync(file("stats-queue.ndjson"), "utf8");
    for (let turn = 0; turn < 20 && queued().length; turn++) await on.upload();
    expect(queued()).toEqual([]);
    const wire = posts.map((post) => JSON.stringify(post.batch)).join("\n");
    expect(posts.length).toBeGreaterThan(0);
    for (const poison of [...POISON, "dana", "Dana", "secret", "resume"]) {
      expect(disk).not.toContain(poison);
      expect(disk).not.toContain(JSON.stringify(poison).slice(1, -1));
      expect(wire).not.toContain(poison);
      expect(wire).not.toContain(JSON.stringify(poison).slice(1, -1));
    }
    for (const post of posts) expect(statsBatchSchema.safeParse(post.batch).success).toBe(true);
    expect(posts[0]!.batch.events[0]).not.toHaveProperty("ui");
  });

  it("keeps the newest megabyte, dropping screen counts first, and says how many it lost", async () => {
    consent(true);
    const on = stats();
    on.start();
    for (let round = 0; round < 9; round++) {
      for (let index = 0; index < 1500; index++) {
        on.capture(SAMPLES[8]!);
        if (index < 300) on.capture(SAMPLES[4]!);
      }
      await on.flush();
    }
    expect(statSync(file("stats-queue.ndjson")).size).toBeLessThanOrEqual(1024 * 1024);
    const kept = queued();
    expect(kept.filter((event) => event.e === "turn")).toHaveLength(2700);
    expect(kept.filter((event) => event.e === "screen").length).toBeLessThan(13_500);
    await on.upload();
    expect(posts[0]!.batch.dropped).toBe(16_200 - kept.length);
    expect(posts[0]!.batch.events).toHaveLength(2000);
    for (let index = 0; index < 2500; index++) on.capture(SAMPLES[8]!);
    await on.flush();
    await on.upload();
    expect(posts[1]!.batch.dropped).toBe(500);
  });

  it("drops events older than 14 days", async () => {
    consent(true);
    const on = stats();
    on.start();
    const hour = Math.floor(Date.now() / 3_600_000);
    const row = (h: number) => JSON.stringify({ e: "screen", h, c: "desktop", name: "chat", n: 1 });
    writeFileSync(file("stats-queue.ndjson"), `${row(hour - 14 * 24 - 1)}\nnot json\n${row(hour - 14 * 24)}\n${row(hour)}\n`);
    await on.upload();
    expect(posts[0]!.batch.events.filter((event) => event.e === "screen").map((event) => event.h)).toEqual([hour - 14 * 24, hour]);
    expect(queued()).toEqual([]);
  });

  it("checks every queued row again before it leaves, so a row edited on disk never does", async () => {
    consent(true);
    const on = stats();
    on.start();
    const hour = Math.floor(Date.now() / 3_600_000);
    const row = (more: object) => JSON.stringify({ e: "screen", h: hour, c: "desktop", name: "chat", n: 1, ...more });
    writeFileSync(file("stats-queue.ndjson"), `${row({ note: POISON[0] })}
${row({ name: POISON[3] })}
${row({ n: 2 })}
`);
    await on.upload();
    expect(posts[0]!.batch.events.filter((event) => event.e === "screen")).toEqual([{ e: "screen", h: hour, c: "desktop", name: "chat", n: 2 }]);
    expect(queued()).toEqual([]);
  });

  it.each([400, 404, 413])("drops a batch the relay refuses with %i", async (status) => {
    consent(true);
    const on = stats();
    on.start();
    on.capture(SAMPLES[8]!);
    await on.flush();
    answers.push(new Response("{}", { status }));
    await on.upload();
    expect(queued()).toEqual([]);
    on.capture(SAMPLES[8]!);
    await on.flush();
    await on.upload();
    expect(posts[1]!.batch.events[0]!.e).toBe("state");
  });

  it.each([408, 429, 500, 503, 507])("keeps a batch after %i and sends it again under the same id", async (status) => {
    consent(true);
    const on = stats();
    on.start();
    on.capture(SAMPLES[8]!);
    await on.flush();
    answers.push(new Response("{}", { status }));
    await on.upload();
    expect(queued()).toHaveLength(1);
    on.capture(SAMPLES[6]!);
    await on.flush();
    await on.upload();
    expect(posts[1]!.batch.batch).toBe(posts[0]!.batch.batch);
    expect(posts[1]!.batch.events).toEqual(posts[0]!.batch.events);
    expect(queued().map((event) => event.e)).toEqual(["send"]);
  });

  it("keeps a batch when the relay cannot be reached", async () => {
    consent(true);
    const on = stats();
    on.start();
    on.capture(SAMPLES[8]!);
    await on.flush();
    const offline = Promise.reject<Response>(new Error("offline"));
    offline.catch(() => {});
    answers.push(offline);
    await on.upload();
    expect(queued()).toHaveLength(1);
  });
});

describe("timing", () => {
  it("waits 5 minutes, then for a running turn, then backs off and honors Retry-After", async () => {
    vi.useFakeTimers();
    consent(true);
    let busy = true;
    const on = stats({ busy: () => busy });
    on.start();
    on.capture(SAMPLES[8]!);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1000);
    await on.flush();
    expect(sent).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await on.flush();
    expect(sent).not.toHaveBeenCalled();
    busy = false;
    answers.push(new Response("{}", { status: 503 }), new Response("{}", { status: 429, headers: { "retry-after": "600" } }));
    await vi.advanceTimersByTimeAsync(10_000);
    await on.flush();
    expect(posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_000);
    await on.flush();
    expect(posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await on.flush();
    expect(posts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(599_000);
    await on.flush();
    expect(posts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await on.flush();
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((post) => post.batch.batch)).size).toBe(1);
    await vi.advanceTimersByTimeAsync(25 * 60_000 - 1000);
    await on.flush();
    expect(posts).toHaveLength(3);
    on.capture(SAMPLES[8]!);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await on.flush();
    expect(posts).toHaveLength(4);
  });

  it("gives up waiting for a turn after 2 minutes", async () => {
    vi.useFakeTimers();
    consent(true);
    const on = stats({ busy: () => true });
    on.start();
    on.capture(SAMPLES[8]!);
    await vi.advanceTimersByTimeAsync(7 * 60_000 - 1000);
    await on.flush();
    expect(sent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await on.flush();
    expect(posts).toHaveLength(1);
  });
});

describe("sessions", () => {
  it("reports a launch after a clean quit and a crash after an unclean one", async () => {
    consent(true);
    const first = stats();
    first.start();
    first.launched({ mainFork: 800, mainWindow: 300, serverReady: 450, checksReady: 2000 });
    await first.flush();
    expect(queued().map(({ h: _h, ...event }) => event)).toEqual([{ e: "launch", cold: true, mainMs: 800, serverMs: 450, windowMs: 300, checksMs: 2000 }]);
    first.capture(SAMPLES[8]!);
    first.stop();
    expect(queued().map((event) => event.e)).toEqual(["launch", "screen"]);
    expect(JSON.parse(readFileSync(file("stats-active"), "utf8"))).toMatchObject({ start: expect.any(Number), end: expect.any(Number) });
    const second = stats();
    second.launched({ mainFork: 700, mainWindow: 280, serverReady: 400, checksReady: 1500 });
    second.start();
    await second.flush();
    expect(queued().at(-1)).toMatchObject({ e: "launch", cold: false, prevClean: true, prevMin: 0 });
    // The process dies here: no stop().
    made.splice(made.indexOf(second), 1);
    const third = stats();
    third.start();
    third.launched({ mainFork: 700, mainWindow: 280, serverReady: 400, checksReady: 1500 });
    await third.flush();
    expect(queued().slice(-2).map(({ h: _h, ...event }) => event)).toEqual([
      { e: "crash", process: "server", kind: "unclean-exit", up: 0 },
      { e: "launch", cold: false, mainMs: 700, serverMs: 400, windowMs: 280, checksMs: 1500, prevClean: false, prevMin: 0 },
    ]);
  });

  it("reports no launch for a server the desktop app did not start", async () => {
    consent(true);
    const on = stats();
    on.start();
    on.launched({ serverReady: 400, checksReady: 1500 });
    await on.flush();
    expect(queued()).toEqual([]);
  });
});

describe("turns", () => {
  const base = { eventId: "e", provider: "claudeAgent" as const, threadId: "t1", turnId: "u1", createdAt: "" };
  const facts: TurnFacts = { surface: "chat", model: "claude-opus-5-5", effort: "high", startedAt: 0, chars: 240, images: 1, files: 0, resumed: true, reused: true, spawnMs: 12, readyMs: 30 };

  it("folds a turn's events into one row with no text in it", async () => {
    consent(true);
    const on = stats({ turn: (event) => ({ ...facts, startedAt: Date.now() - 5000, ...(event.threadId === "t2" ? { c: "system" as const, surface: "routine" as const } : {}) }) });
    on.start();
    on.sent("t1", "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Mobile/15E148", false);
    const events: RuntimeEvent[] = [
      { ...base, type: "turn.started" },
      { ...base, type: "content.delta", streamKind: "reasoning_text", delta: "thinking about Dana" },
      { ...base, type: "content.delta", streamKind: "assistant_text", delta: "Hi Dana" },
      { ...base, type: "item.completed", itemType: "tool", ok: true, summary: "read C:\\Users\\dana\\cv.docx" },
      { ...base, type: "item.completed", itemType: "tool", ok: false },
      { ...base, type: "request.opened", requestType: "permission", tool: "Bash", summary: "rm -rf /home/dana" },
      { ...base, type: "request.resolved", behavior: "deny", source: "user" },
      { ...base, type: "request.opened", requestType: "permission", tool: "Read", summary: "x" },
      { ...base, type: "request.resolved", behavior: "allow", source: "auto" },
      { ...base, type: "turn.retrying", attempt: 1, delayMs: 1000, reason: "overloaded" },
      { ...base, type: "runtime.error", message: "401 dana@example.com is signed out", signedOut: true },
      { ...base, type: "turn.completed", ok: false, cost: 0.126, usage: { input: 5000, output: 700, cachedInput: 4000 }, prompt: { first: 1000, last: 50_000 }, contextWindow: 200_000 },
      { ...base, threadId: "t2", type: "turn.completed", ok: true },
    ];
    for (const event of events) on.runtime(event);
    await on.flush();
    const rows = queued().map(({ h: _h, ...event }) => event);
    expect(rows).toEqual([
      { e: "turn_error", engine: "claudeAgent", model: "claude-opus-5-5", kind: "retry", code: "overloaded" },
      { e: "turn_error", engine: "claudeAgent", model: "claude-opus-5-5", kind: "signed-out", code: "auth" },
      {
        e: "turn", c: "phone", surface: "chat", engine: "claudeAgent", model: "claude-opus-5-5", effort: "high", ok: false, stop: "signed-out", retries: 1,
        spawnMs: 12, readyMs: 30, ttftMs: expect.any(Number), doneMs: expect.any(Number), reused: true, tools: 2, toolFails: 1, asks: 2, asksAuto: 1, denied: 1,
        tokIn: 5000, tokOut: 700, tokCached: 4000, costUsd: 0.13, ctxPct: 25, images: 1, files: 0, len: 2, resumed: true,
      },
      { e: "turn", c: "system", surface: "routine", engine: "claudeAgent", model: "claude-opus-5-5", effort: "high", ok: true, stop: "done", spawnMs: 12, readyMs: 30, doneMs: expect.any(Number), reused: true, images: 1, files: 0, len: 2, resumed: true },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/dana|Dana/);
  });

  it.each([
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140 Electron/38.2.0 Safari/537.36", true, "desktop"],
    ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140 Safari/537.36", true, "browser"],
    ["Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36", false, "phone"],
    ["Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15", false, "browser"],
  ])("names the screen that sent the turn (%s)", async (agent, local, c) => {
    consent(true);
    const on = stats({ turn: () => facts });
    on.start();
    on.sent("t1", agent, local);
    on.runtime({ ...base, type: "turn.completed", ok: true });
    await on.flush();
    expect(queued()[0]).toMatchObject({ e: "turn", c });
  });

  it("names the screen behind a room turn from the room's send, not the member's thread", async () => {
    consent(true);
    const on = stats({ turn: () => ({ ...facts, surface: "room", from: "group:g1" }) });
    on.start();
    on.sent("t1", "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140 Electron/38.2.0 Safari/537.36", true);
    on.sent("group:g1", "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36", false);
    on.sent(undefined, "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15", false);
    on.runtime({ ...base, type: "turn.completed", ok: true });
    await on.flush();
    expect(queued()[0]).toMatchObject({ e: "turn", c: "phone", surface: "room" });
  });
});

describe("workers", () => {
  it("reports a start and an end by engine, model and status word, never the pane, the path or the report", async () => {
    consent(true);
    const on = stats();
    on.start();
    on.workerStarted("pane-1", { executable: "C:\\Users\\dana\\AppData\\Roaming\\npm\\claude.cmd", args: ["--model", POISON[3]] });
    on.workerStarted("pane-2", { session: { engine: "codex", model: "gpt-6-astra", effort: "high" } });
    on.workerStarted(undefined, { executable: "claude" });
    on.workerStarted("pane-3", {});
    on.workerStarted("pane-4", { executable: "/home/dana/bin/my-agent" });
    on.workerReported("pane-2", `DONE STATS "${POISON[7]}"`);
    on.workerReported("pane-1", "still working on Dana's resume");
    on.workerReported("pane-1", "BLOCKED need a key");
    on.workerReported("pane-4", "FAIL");
    on.workerReported("pane-9", "DONE");
    await on.flush();
    const rows = queued().map(({ h: _h, ...event }) => event);
    expect(rows).toEqual([
      { e: "worker", phase: "start", engine: "claudeAgent", model: "custom", effort: "auto", parallel: 1 },
      { e: "worker", phase: "start", engine: "codex", model: "gpt-6-astra", effort: "high", parallel: 2 },
      { e: "worker", phase: "start", engine: "other", model: "custom", effort: "auto", parallel: 3 },
      { e: "worker", phase: "end", engine: "codex", model: "gpt-6-astra", effort: "high", parallel: 3, outcome: "done", min: 0 },
      { e: "worker", phase: "end", engine: "claudeAgent", model: "custom", effort: "auto", parallel: 2, outcome: "stuck", min: 0 },
      { e: "worker", phase: "end", engine: "other", model: "custom", effort: "auto", parallel: 1, outcome: "failed", min: 0 },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/dana|Dana|pane/);
  });
});

describe("screens", () => {
  it("takes a screen's batch, keeps an engine kind as a list id and drops any other free text", async () => {
    consent(true);
    const on = stats();
    on.start();
    expect(on.ingest({ events: [
      { e: "feature", c: "phone", name: "engine.signin", kind: "claudeAgent" },
      { e: "feature", c: "phone", name: "engine.signin", kind: "dana-fork" },
      { e: "feature", c: "phone", name: "attach.add", kind: POISON[0] },
      { e: "feature", c: "phone", name: "palette.run", kind: "command" },
      { e: "onboard", step: "signin", ms: 4000, engine: "my-engine" },
      { e: "error", c: "browser", site: "rendererError", code: "UNKNOWN_ERROR", message: POISON[7] },
    ], lang: "ko" })).toBe(true);
    expect(on.ingest({ events: "all of them" })).toBe(false);
    expect(on.ingest({ events: Array(501).fill({ e: "feature", c: "phone", name: "export" }) })).toBe(false);
    await on.flush();
    expect(queued().map(({ h: _h, ...event }) => event)).toEqual([
      { e: "feature", c: "phone", name: "engine.signin", kind: "claudeAgent" },
      { e: "feature", c: "phone", name: "engine.signin", kind: "other" },
      { e: "onboard", step: "signin", ms: 4000, engine: "other" },
    ]);
  });

  it("refuses a screen's batch while stats are off", async () => {
    consent(false);
    const off = stats();
    off.start();
    expect(off.ingest({ events: [{ e: "feature", c: "phone", name: "export" }] })).toBe(false);
    await off.flush();
    expect(queued()).toEqual([]);
  });
});
