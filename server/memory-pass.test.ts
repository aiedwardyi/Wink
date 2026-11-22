import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acceptFacts,
  appendNotes,
  createMemoryPass,
  eligibleRow,
  noteGenerator,
  notePrompt,
  noteSummary,
  parseFacts,
  pendingRows,
  secretLike,
  userTyping,
  type MemoryPass,
  type NoteGenerator,
} from "./memory-pass.ts";
import * as atomic from "./atomic.ts";
import { memoryNotesEnabled } from "./config.ts";
import type { ProviderInstance } from "./contracts.ts";
import { AntigravityDriver } from "./drivers/antigravity.ts";
import { createCliText } from "./drivers/cli-text.ts";
import { CodexDriver } from "./drivers/codex.ts";
import { MEMORY_SAVE_TOOL } from "./memory-save.ts";
import { replyTurns } from "./pick-sources.ts";
import { loadProfileSyncSettings, saveProfileSyncSettings } from "./profile-sync.ts";
import type { RateLimitsMap, RateLimitsReport } from "./rate-limits-store.ts";
import type { Message, StoreChange } from "./store.ts";
import { summaryInstance } from "./summary-instance.ts";
import { MEMORY_SEED, memoryFileRaw, readMemoryTopic, workspaceDir, writeMemoryFile } from "./workspace.ts";
import { createTempDirs } from "./testing/cleanup.ts";
import { removeTestData } from "./testing/test-home.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

const MINUTE = 60_000;
const NOW = new Date(2026, 9, 15, 12).getTime();

const row = (patch: Partial<Message> = {}): Message => ({ id: "m", at: 1, role: "user", kind: "text", text: "hi", ...patch });

function fakeStore() {
  const threads = new Map<string, Message[]>();
  const listeners = new Set<(change: StoreChange) => void>();
  let seq = 0;
  const emit = (change: StoreChange) => {
    for (const listener of listeners) listener(change);
  };
  return {
    onChange(listener: (change: StoreChange) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    messagesFor: (threadId: string) => threads.get(threadId) ?? [],
    // SAFETY: the pass only tests a room for presence.
    groupByThread: (threadId: string) => (threadId.startsWith("room") ? ({ id: "g" } as never) : undefined),
    // SAFETY: the pass only reads the bot id.
    botByThread: (threadId: string) => (threadId.startsWith("room") ? null : ({ id: `bot-${threadId}` } as never)),
    appendMessage(threadId: string, message: Omit<Message, "id" | "at">, imported?: true) {
      const full: Message = { id: `m${++seq}`, at: Date.now(), ...message };
      threads.set(threadId, [...(threads.get(threadId) ?? []), full]);
      emit(imported ? { type: "message", threadId, message: full, imported } : { type: "message", threadId, message: full });
      return full;
    },
    rows: (threadId: string) => threads.get(threadId) ?? [],
    emit,
  };
}

const facts = (...items: Array<[string, string]>) => JSON.stringify(items.map(([fact, quote]) => ({ fact, quote })));

describe("memory pass", () => {
  let store: ReturnType<typeof fakeStore>;
  let dataDir: string;
  let busy: Set<string>;
  let generate: ReturnType<typeof vi.fn<NoteGenerator>>;
  let generator: NoteGenerator | null;
  let on: boolean;
  let botSwitch: Map<string, boolean>;
  let pass: MemoryPass;
  const passes: MemoryPass[] = [];

  const start = () => {
    const enabled = (botId: string) => memoryNotesEnabled({ features: { memoryNotes: on } }, { memoryNotes: botSwitch.get(botId) });
    const created = createMemoryPass({ store, dataDir, generate: () => generator, enabled, busy: (botId) => busy.has(botId) });
    passes.push(created);
    return created;
  };
  const say = (threadId: string, text: string, patch: Partial<Message> = {}) =>
    store.appendMessage(threadId, { role: "user", kind: "text", text, ...patch });
  const settle = async (threadId: string, wait = 0) => {
    pass.onSettled(`bot-${threadId}`, threadId);
    if (wait) await vi.advanceTimersByTimeAsync(wait);
    await pass.idle();
  };
  const chips = (threadId: string) => store.rows(threadId).filter((m) => m.tool?.name === MEMORY_SAVE_TOOL);
  const stored = () => JSON.parse(readFileSync(join(dataDir, "memory-pass.json"), "utf8"));
  const switchTo = (next: boolean) => {
    on = next;
    pass.onConfigChanged();
  };
  const switchBot = (botId: string, next: boolean) => {
    botSwitch.set(botId, next);
    store.emit({ type: "bot", botId });
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(console, "info").mockImplementation(() => {});
    store = fakeStore();
    dataDir = temps.make(join(tmpdir(), "memory-pass-"));
    busy = new Set();
    generate = vi.fn<NoteGenerator>(async () => "[]");
    generator = generate;
    on = true;
    botSwitch = new Map();
    writeMemoryFile("bot-t1", "");
    removeTestData(join(workspaceDir("bot-t1"), "memory"));
    pass = start();
  });

  afterEach(() => {
    for (const created of passes.splice(0)) created.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs once the thread has been idle 3 minutes after a turn", async () => {
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE - 1);
    expect(generate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pass.idle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toContain("i'm 38");
  });

  it("saves a recorded Claude reply through the bot's bound account", async () => {
    const recorded = JSON.parse(readFileSync(new URL("../test/fixtures/recorded/claude/memory-notes.json", import.meta.url), "utf8"));
    const defaultGenerateText = vi.fn(async () => "[]");
    const generateText = vi.fn(async () => recorded.reply.text);
    generator = noteGenerator([
      { instanceId: "claude-default", driverKind: "claudeAgent", enabled: true, generateText: defaultGenerateText },
      { instanceId: "claude-bound", driverKind: "claudeAgent", enabled: true, generateText },
    ], { instanceId: "claude-bound", available: true });
    const first = say("t1", "I prefer concise replies.");
    const second = say("t1", "I use pnpm for my projects.");
    await settle("t1", 3 * MINUTE);
    expect(defaultGenerateText).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledExactlyOnceWith(notePrompt("", [{ id: first.id, text: first.text! }, { id: second.id, text: second.text! }]), {
      signal: expect.any(AbortSignal), timeoutMs: 120_000, ephemeral: true, lean: true,
    });
    expect(memoryFileRaw("bot-t1")).toBe(
      `${MEMORY_SEED}- Prefers concise replies (noted 2026-10-15)\n- Uses pnpm for projects (noted 2026-10-15)\n`,
    );
    expect(chips("t1")).toHaveLength(1);
    expect(chips("t1")[0]!.tool).toEqual({ name: MEMORY_SAVE_TOOL, ok: true, spoken: "Prefers concise replies, Uses pnpm for projects", memoryBotId: "bot-t1" });
    expect(stored()).toEqual({ threads: {} });
  });

  it("saves a recorded Claude pick to the timeline and its fact to MEMORY.md", async () => {
    const recorded = JSON.parse(readFileSync(new URL("../test/fixtures/recorded/claude/memory-decisions.json", import.meta.url), "utf8"));
    const generateText = vi.fn(async () => recorded.reply.text);
    generator = noteGenerator([{ instanceId: "claude-default", driverKind: "claudeAgent", enabled: true, generateText }]);
    const question = store.appendMessage("t1", { role: "bot", kind: "text", text: "Which look should the model picker have? 1. Always dark 2. Follow the app theme 3. Always light. Pick one and I'll build it." });
    const answer = say("t1", "the second one");
    say("t1", "I use pnpm for my projects.");
    await settle("t1", 3 * MINUTE);
    expect(generateText).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`<source message_id="${answer.id}" question_id="${question.id}" />\n<context>${question.text}</context>\nthe second one`), expect.anything());
    expect(memoryFileRaw("bot-t1")).toBe(`${MEMORY_SEED}- Uses pnpm for projects (noted 2026-10-15)\n`);
    expect(readMemoryTopic("bot-t1", "decisions.md")).toContain(
      '## 2026-10-15 12:00 | model picker look | current\n- Picked: 2 - Follow the app theme\n- Over: 1 - Always dark; 3 - Always light\n- Said: "the second one"\n',
    );
    expect(chips("t1")[0]!.tool).toEqual({ name: MEMORY_SAVE_TOOL, ok: true, spoken: "model picker look: 2 - Follow the app theme, Uses pnpm for projects", memoryBotId: "bot-t1" });
  });

  it("attributes a helper batch once when its write waits for a busy turn", async () => {
    const timing = process.env.ORBIT_TURN_TIMING;
    const outputDir = process.env.OMB_DATA_DIR;
    process.env.ORBIT_TURN_TIMING = "1";
    process.env.OMB_DATA_DIR = dataDir;
    try {
      generate.mockImplementation(async (_prompt, _signal, onUsage) => {
        onUsage?.({ input: 20, output: 2 }, "request-1");
        busy.add("bot-t1");
        return facts(["Prefers pnpm", "I prefer pnpm"]);
      });
      generator = Object.assign(generate, { engine: "codex" });
      say("t1", "I prefer pnpm", { sendId: "source-send" });
      await settle("t1", 3 * MINUTE);
      busy.clear();
      await settle("t1");
      expect(generate).toHaveBeenCalledTimes(1);
      const traces = readFileSync(join(dataDir, "turn-traces.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({ engine: "codex", botId: "bot-t1", threadId: "t1", sourceSendIds: ["source-send"], requests: [{ id: "request-1", usage: { input: 20, output: 2 }, nested: false }] });
      expect(chips("t1")).toHaveLength(1);
    } finally {
      if (timing === undefined) delete process.env.ORBIT_TURN_TIMING;
      else process.env.ORBIT_TURN_TIMING = timing;
      if (outputDir === undefined) delete process.env.OMB_DATA_DIR;
      else process.env.OMB_DATA_DIR = outputDir;
    }
  });

  it("runs right at the turn end after 8 new user messages", async () => {
    for (let i = 0; i < 8; i += 1) say("t1", `line ${i}`);
    await settle("t1");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("leaves a malformed batch pending across restart and saves it on a healthy pass", async () => {
    generate.mockResolvedValueOnce('[{"fact":1}]');
    const ids = Array.from({ length: 8 }, () => say("t1", "I prefer pnpm").id);
    await settle("t1");
    pass.dispose();
    expect(stored()).toEqual({ threads: { t1: ids } });
    expect(memoryFileRaw("bot-t1")).toBe("");
    expect(readMemoryTopic("bot-t1", "decisions.md")).toBeNull();
    expect(chips("t1")).toHaveLength(0);
    pass = start();
    generate.mockResolvedValueOnce(facts(["Prefers pnpm", "I prefer pnpm"]));
    await settle("t1");
    expect(memoryFileRaw("bot-t1")).toBe(`${MEMORY_SEED}- Prefers pnpm (noted 2026-10-15)\n`);
    expect(stored()).toEqual({ threads: {} });
  });

  it("makes five settlements cost one attempt on a limited account", async () => {
    const limits: RateLimitsMap = new Map();
    const own = { instanceId: "acct-live", enabled: true, driverKind: "codex", generateText: vi.fn(async () => {
      throw new Error("HTTP 429");
    }) };
    pass.dispose();
    pass = createMemoryPass({ store, dataDir, enabled: () => true, busy: () => false,
      generate: () => noteGenerator([], undefined, own, { limits, save: () => {} }) });
    passes.push(pass);
    const ids = Array.from({ length: 8 }, () => say("t1", "I prefer pnpm").id);
    for (let i = 0; i < 5; i++) await settle("t1");
    pass.dispose();
    expect(own.generateText).toHaveBeenCalledTimes(1);
    expect(store.rows("t1").map(({ id }) => id)).toEqual(ids);
    expect(stored()).toEqual({ threads: { t1: ids } });
  });

  it("makes five settlements cost one attempt on a signed-out account until a fresh probe", async () => {
    const signedOut = new Set<string>();
    const own = { instanceId: "acct-live", enabled: true, driverKind: "antigravityAgent", generateText: vi.fn(async () => {
      throw new Error("UNAUTHENTICATED (code 401): Sign in again.");
    }) };
    pass.dispose();
    pass = createMemoryPass({ store, dataDir, enabled: () => true, busy: () => false,
      generate: () => noteGenerator([], undefined, own, { limits: new Map(), save: () => {}, signedOut }) });
    passes.push(pass);
    const ids = Array.from({ length: 8 }, () => say("t1", "I prefer pnpm").id);
    for (let i = 0; i < 5; i++) await settle("t1");
    expect(own.generateText).toHaveBeenCalledTimes(1);
    signedOut.clear();
    await settle("t1");
    pass.dispose();
    expect(own.generateText).toHaveBeenCalledTimes(2);
    expect(store.rows("t1").map(({ id }) => id)).toEqual(ids);
    expect(stored()).toEqual({ threads: { t1: ids } });
  });

  it("keeps a moved, renamed or restored batch and saves it on the new home", async () => {
    const id = say("t1", "I use pnpm").id;
    pass.dispose();
    writeFileSync(join(dataDir, "memory-pass.json"), JSON.stringify({ host: "old-home", threads: { t1: [id] } }));
    generate.mockResolvedValueOnce(facts(["Uses pnpm", "I use pnpm"]));
    pass = createMemoryPass({ store, dataDir, host: "new-home", generate: () => generator, enabled: () => true, busy: () => false });
    passes.push(pass);
    expect(stored()).toEqual({ host: "new-home", threads: { t1: [id] }, foreign: { t1: [id] } });
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(memoryFileRaw("bot-t1")).toContain("Uses pnpm");
    expect(stored()).toEqual({ host: "new-home", threads: {} });
  });

  it("runs a synced copy's restored batch only on the PC that saved it", async () => {
    for (let i = 0; i < 8; i++) say("t1", "I use pnpm");
    pass.dispose();
    const startOn = (host: string, path: string) => {
      const copy = createMemoryPass({ store, dataDir: path, host, generate: () => generator, enabled: () => true, busy: () => false });
      passes.push(copy);
      return copy;
    };
    pass = startOn("pc-a", dataDir);
    say("t1", "I prefer tabs");
    const mirrorDir = temps.make(join(tmpdir(), "memory-pass-mirror-"));
    writeFileSync(join(mirrorDir, "memory-pass.json"), readFileSync(join(dataDir, "memory-pass.json")));
    saveProfileSyncSettings(mirrorDir, { ...loadProfileSyncSettings(mirrorDir), folder: mirrorDir, syncChats: true, botMap: { "bot-t1": "synced-bot" } });
    const mirror = startOn("pc-b", mirrorDir);
    mirror.onSettled("bot-t1", "t1");
    await mirror.idle();
    expect(generate).not.toHaveBeenCalled();
    await settle("t1");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toContain("I use pnpm");
    expect(generate.mock.calls[0]![0]).toContain("I prefer tabs");
    expect(stored()).toEqual({ host: "pc-a", threads: {} });
  });

  it("leaves a restored batch to its source when the sync mapping lands after startup", async () => {
    for (let i = 0; i < 8; i++) say("t1", "I use pnpm");
    pass.dispose();
    const startOn = (host: string, path: string) => {
      const copy = createMemoryPass({ store, dataDir: path, host, generate: () => generator, enabled: () => true, busy: () => false });
      passes.push(copy);
      return copy;
    };
    pass = startOn("pc-a", dataDir);
    const mirrorDir = temps.make(join(tmpdir(), "memory-pass-mirror-"));
    writeFileSync(join(mirrorDir, "memory-pass.json"), readFileSync(join(dataDir, "memory-pass.json")));
    const sync = { ...loadProfileSyncSettings(mirrorDir), folder: mirrorDir, syncChats: true, botMap: {} };
    saveProfileSyncSettings(mirrorDir, sync);
    startOn("pc-b", mirrorDir).dispose();
    const mirror = startOn("pc-b", mirrorDir);
    saveProfileSyncSettings(mirrorDir, { ...sync, botMap: { "bot-t1": "synced-bot" } });
    mirror.onSettled("bot-t1", "t1");
    await mirror.idle();
    expect(generate).not.toHaveBeenCalled();
    await settle("t1");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["mapping, then one local send", ["map", "say"]],
    ["one local send, then mapping", ["say", "map"]],
    ["two local sends, then mapping", ["say", "say", "map"]],
    ["mapping, a claimed turn, then the next settlement", ["map", "say", "claim"]],
  ])("submits a restored copy's own rows once: %s", async (_name, steps) => {
    for (let i = 0; i < 8; i++) say("t1", "I prefer short replies");
    pass.dispose();
    pass = createMemoryPass({ store, dataDir, host: "pc-a", generate: () => generator, enabled: () => true, busy: () => false });
    passes.push(pass);
    const mirrorDir = temps.make(join(tmpdir(), "memory-pass-mirror-"));
    writeFileSync(join(mirrorDir, "memory-pass.json"), readFileSync(join(dataDir, "memory-pass.json")));
    const sync = { ...loadProfileSyncSettings(mirrorDir), folder: mirrorDir, syncChats: true, botMap: {} };
    saveProfileSyncSettings(mirrorDir, sync);
    // B's own store: A's rows arrived by sync, B's typing never reaches A
    const storeB = fakeStore();
    for (let i = 0; i < 8; i++) storeB.appendMessage("t1", { role: "user", kind: "text", text: "I prefer short replies" });
    const claimed = new Set<string>();
    const mirror = createMemoryPass({ store: storeB, dataDir: mirrorDir, host: "pc-b", generate: () => generator, enabled: () => true, busy: (botId) => claimed.has(botId) });
    passes.push(mirror);
    const mine: string[] = [];
    for (const step of steps) {
      if (step === "map") saveProfileSyncSettings(mirrorDir, { ...sync, botMap: { "bot-t1": "synced-bot" } });
      if (step === "say") mine.push(storeB.appendMessage("t1", { role: "user", kind: "text", text: `I use pnpm ${mine.length}` }).id);
      if (step === "claim") {
        claimed.add("bot-t1");
        mirror.onSettled("bot-t1", "t1", true);
        await mirror.idle();
        expect(generate).not.toHaveBeenCalled();
        claimed.delete("bot-t1");
      }
    }
    mirror.onSettled("bot-t1", "t1", true);
    await mirror.idle();
    expect(generate).toHaveBeenCalledTimes(1);
    const prompt = generate.mock.calls[0]![0];
    for (const [i] of mine.entries()) expect(prompt).toContain(`I use pnpm ${i}`);
    expect(prompt).not.toContain("I prefer short replies");
    await settle("t1");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![0]).toContain("I prefer short replies");
    expect(generate.mock.calls[1]![0]).not.toContain("I use pnpm");
  });

  it("keeps a restored copy's local row out of the rows it leaves to the source", () => {
    const theirs = Array.from({ length: 2 }, () => say("t1", "I prefer short replies").id);
    pass.dispose();
    writeFileSync(join(dataDir, "memory-pass.json"), JSON.stringify({ host: "pc-a", threads: { t1: theirs } }));
    pass = createMemoryPass({ store, dataDir, host: "pc-b", generate: () => generator, enabled: () => true, busy: () => false });
    passes.push(pass);
    const mine = say("t1", "I use pnpm").id;
    pass.dispose();
    expect(stored()).toEqual({ host: "pc-b", threads: { t1: [...theirs, mine] }, foreign: { t1: theirs } });
  });

  it("never starts a helper for a turn claimed after the pass was scheduled", async () => {
    say("t1", "I use pnpm");
    pass.onSettled("bot-t1", "t1", true);
    busy.add("bot-t1");
    await pass.idle();
    expect(generate).not.toHaveBeenCalled();
    busy.delete("bot-t1");
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("starts a pass only after the settling call returns", async () => {
    say("t1", "I use pnpm");
    pass.onSettled("bot-t1", "t1", true);
    expect(generate).not.toHaveBeenCalled();
    await pass.idle();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("cancels an active extraction when the next turn starts and keeps its pending rows", async () => {
    let finish: (output: string) => void = () => {};
    generate.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve; }));
    say("t1", "I use pnpm");
    pass.onSettled("bot-t1", "t1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(generate).toHaveBeenCalledTimes(1);
    say("t1", "I prefer concise replies");
    pass.onTurn("bot-t1");
    expect(generate.mock.calls[0]![1].aborted).toBe(true);
    expect(chips("t1")).toHaveLength(0);
    pass.onSettled("bot-t1", "t1", true);
    finish(facts(["Uses pnpm", "I use pnpm"]));
    await pass.idle();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![0]).toContain("I use pnpm");
    expect(generate.mock.calls[1]![0]).toContain("I prefer concise replies");
    expect(stored()).toEqual({ threads: {} });
  });

  it("flushes at once before the engine compacts", async () => {
    say("t1", "i'm 38");
    pass.onSettled("bot-t1", "t1", true);
    await pass.idle();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("a new user message holds the idle timer until the next turn ends", async () => {
    say("t1", "first");
    pass.onSettled("bot-t1", "t1");
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    say("t1", "second");
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(generate).not.toHaveBeenCalled();
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does nothing without user text since the last pass", async () => {
    await settle("t1", 3 * MINUTE);
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("keeps the watermark across a restart", async () => {
    say("t1", "i can't read korean");
    await vi.advanceTimersByTimeAsync(1_000);
    pass.dispose();
    pass = start();
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    await pass.idle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toContain("i can't read korean");
    pass.dispose();
    pass = start();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await pass.idle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(dataDir, "memory-pass.json"), "utf8"))).toEqual({ threads: {} });
  });

  it("skips while the bot is busy and retries at the next idle", async () => {
    say("t1", "i'm 38");
    busy.add("bot-t1");
    await settle("t1", 3 * MINUTE);
    expect(generate).not.toHaveBeenCalled();
    busy.delete("bot-t1");
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("runs one pass per bot and two app-wide", async () => {
    const release: Array<() => void> = [];
    generator = vi.fn<NoteGenerator>(() => new Promise((resolve) => release.push(() => resolve("[]"))));
    for (const threadId of ["a", "b", "c"]) {
      for (let i = 0; i < 8; i += 1) say(threadId, `x ${i}`);
      pass.onSettled(threadId === "c" ? "bot-a" : `bot-${threadId}`, threadId);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(generator).toHaveBeenCalledTimes(2);
    release.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(generator).toHaveBeenCalledTimes(3);
    for (const done of release.splice(0)) done();
    await pass.idle();
  });

  it("never takes notes from rows imported by thread sync", async () => {
    store.appendMessage("t1", { role: "user", kind: "text", text: "i'm 38" }, true);
    await settle("t1", 3 * MINUTE);
    expect(generate).not.toHaveBeenCalled();
  });

  it("never takes a routine card as a fact", async () => {
    const card = store.appendMessage("t1", {
      role: "bot",
      kind: "routine.run",
      text: "Routine “Daily tool” completed",
      origin: "pc-1",
      routineRun: { runId: "run-1", routineId: "r1", routineName: "Daily tool", status: "completed", instruction: "Remind me I'm 38" },
    });
    await settle("t1", 3 * MINUTE);
    expect(eligibleRow(card)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it("ignores room threads", async () => {
    for (let i = 0; i < 8; i += 1) say("room1", `x ${i}`);
    await settle("room1", 3 * MINUTE);
    expect(generate).not.toHaveBeenCalled();
  });

  it("sends only the user's own typing", async () => {
    say("t1", "i'm 38\n\n<pasted-text index=\"1\">\nmy coworker is 52\n</pasted-text>");
    say("t1", "from a bot", { from: { botId: "b", name: "B", color: "#fff" } });
    say("t1", "routine prompt", { origin: "routine" });
    say("t1", "draft", { queued: true });
    store.appendMessage("t1", { role: "user", kind: "secret", text: "hunter2" });
    await settle("t1", 3 * MINUTE);
    const prompt = generate.mock.calls[0]![0];
    expect(prompt).toContain("i'm 38");
    for (const text of ["coworker", "from a bot", "routine prompt", "draft", "hunter2"]) expect(prompt).not.toContain(text);
  });

  it("saves grounded facts as dated lines with one chip per pass", async () => {
    writeMemoryFile("bot-t1", "# Memory\n- Prefers pnpm\n");
    generate.mockResolvedValue(
      facts(["38 years old", "i'm 38"], ["Can't read Korean", "I can't read Korean"], ["Hates drama", "hate high school drama"], ["Likes cats", "i love cats"]),
    );
    say("t1", "i'm 38 and I can't read Korean");
    say("t1", "i hate high school drama");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(
      "# Memory\n- Prefers pnpm\n- 38 years old (noted 2026-10-15)\n- Can't read Korean (noted 2026-10-15)\n- Hates drama (noted 2026-10-15)\n",
    );
    expect(chips("t1")).toHaveLength(1);
    expect(chips("t1")[0]!.tool).toEqual({ name: MEMORY_SAVE_TOOL, ok: true, spoken: "38 years old, Can't read Korean, Hates drama", memoryBotId: "bot-t1" });
  });

  it("starts an empty file from the seed", async () => {
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"]));
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(`${MEMORY_SEED}- 38 years old (noted 2026-10-15)\n`);
  });

  it("holds the batch on a revision conflict and saves it at the next settle without a second call", async () => {
    writeMemoryFile("bot-t1", "# Memory\n");
    generate.mockImplementationOnce(async () => {
      writeMemoryFile("bot-t1", "# Memory\n- edited meanwhile\n");
      return facts(["38 years old", "i'm 38"], ["Likes tea", "i like tea"]);
    });
    say("t1", "i'm 38");
    say("t1", "i like tea");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe("# Memory\n- edited meanwhile\n");
    expect(chips("t1")).toHaveLength(0);
    writeMemoryFile("bot-t1", "# Memory\n- edited meanwhile\n- Likes tea\n");
    await settle("t1");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(memoryFileRaw("bot-t1")).toBe("# Memory\n- edited meanwhile\n- Likes tea\n- 38 years old (noted 2026-10-15)\n");
    expect(chips("t1")).toHaveLength(1);
    expect(stored()).toEqual({ threads: {} });
  });

  it("skips an append that would pass the memory budget", async () => {
    const full = `# Memory\n${"- note\n".repeat(198)}`;
    writeMemoryFile("bot-t1", full);
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"], ["Can't read Korean", "can't read korean"]));
    say("t1", "i'm 38, can't read korean");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(full);
    expect(chips("t1")).toHaveLength(0);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("too-large"));
  });

  it("records notes a full file turned away until a later save lands", async () => {
    const full = `# Memory\n${"- note\n".repeat(198)}`;
    writeMemoryFile("bot-t1", full);
    generate.mockResolvedValueOnce(facts(["38 years old", "i'm 38"], ["Can't read Korean", "can't read korean"]));
    say("t1", "i'm 38, can't read korean");
    await settle("t1", 3 * MINUTE);
    generate.mockResolvedValueOnce(facts(["Likes tea", "i like tea"]));
    say("t1", "i like tea");
    await vi.advanceTimersByTimeAsync(MINUTE);
    await settle("t1", 3 * MINUTE);
    expect(pass.droppedNotes("bot-t1")).toEqual({ dropped: 3, since: NOW + 3 * MINUTE });
    expect(stored()).toEqual({ threads: {}, dropped: { "bot-t1": { dropped: 3, since: NOW + 3 * MINUTE } } });
    pass.dispose();
    pass = start();
    expect(pass.droppedNotes("bot-t1")).toEqual({ dropped: 3, since: NOW + 3 * MINUTE });

    writeMemoryFile("bot-t1", "# Memory\n");
    generate.mockResolvedValueOnce(facts(["Uses pnpm", "i use pnpm"]));
    say("t1", "i use pnpm");
    await settle("t1", 3 * MINUTE);
    expect(chips("t1")).toHaveLength(1);
    expect(pass.droppedNotes("bot-t1")).toBeUndefined();
    expect(stored()).toEqual({ threads: {} });
  });

  it("holds a batch that lands while the bot is busy and saves it at the next settle without a second call", async () => {
    generate.mockImplementationOnce(async () => {
      busy.add("bot-t1");
      say("t1", "i like tea");
      return facts(["38 years old", "i'm 38"]);
    });
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    expect(chips("t1")).toHaveLength(0);
    busy.delete("bot-t1");
    await settle("t1");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(memoryFileRaw("bot-t1")).toBe(`${MEMORY_SEED}- 38 years old (noted 2026-10-15)\n`);
    expect(chips("t1")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    await pass.idle();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![0]).toContain("i like tea");
    expect(generate.mock.calls[1]![0]).not.toContain("i'm 38");
  });

  it("revalidates a held batch against the latest notes", async () => {
    generate.mockImplementationOnce(async () => {
      busy.add("bot-t1");
      return facts(["38 years old", "i'm 38"]);
    });
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    writeMemoryFile("bot-t1", "# Memory\n- 38 years old\n");
    busy.delete("bot-t1");
    await settle("t1");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(memoryFileRaw("bot-t1")).toBe("# Memory\n- 38 years old\n");
    expect(chips("t1")).toHaveLength(0);
    expect(stored()).toEqual({ threads: {} });
  });

  it("drops a held batch when switched off", async () => {
    generate.mockImplementationOnce(async () => {
      busy.add("bot-t1");
      return facts(["38 years old", "i'm 38"]);
    });
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    busy.delete("bot-t1");
    switchTo(false);
    switchTo(true);
    say("t1", "i like tea");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe("");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![0]).not.toContain("i'm 38");
  });

  it("keeps a credential out of the prompt and the notes when the quote drops its label", async () => {
    generate.mockResolvedValue(facts(["Wi-Fi: qwer1234", "qwer1234"], ["Wi-Fi: hunter22", "hunter22"], ["38 years old", "i'm 38"]));
    say("t1", "우리집 와이파이 비번은 qwer1234야");
    say("t1", "i'm 38\n\nmy wifi password is hunter22");
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    const prompt = generate.mock.calls[0]![0];
    for (const text of ["qwer1234", "hunter22", "비번", "wifi"]) expect(prompt).not.toContain(text);
    expect(memoryFileRaw("bot-t1")).toBe(`${MEMORY_SEED}- 38 years old (noted 2026-10-15)\n`);
  });

  it("skips quietly when Claude is missing or signed out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    generate.mockRejectedValue(new Error("Not logged in - Please run /login"));
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    say("t1", "i can't read korean");
    await settle("t1", 3 * MINUTE);
    generator = null;
    await settle("t1", 3 * MINUTE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(store.rows("t1").every((m) => m.role === "user")).toBe(true);
  });

  it("records nothing and calls no model while switched off", async () => {
    switchTo(false);
    for (let i = 0; i < 8; i += 1) say("t1", `i'm 38 ${i}`);
    await settle("t1", 3 * MINUTE);
    expect(generate).not.toHaveBeenCalled();
    pass.dispose();
    expect(existsSync(join(dataDir, "memory-pass.json"))).toBe(false);
  });

  it("drops pending ids when switched off and never backfills them", async () => {
    say("t1", "i'm 38");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored().threads.t1).toHaveLength(1);
    switchTo(false);
    expect(stored()).toEqual({ threads: {} });
    switchTo(true);
    await settle("t1", 3 * MINUTE);
    expect(generate).not.toHaveBeenCalled();
    say("t1", "i can't read korean");
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toContain("i can't read korean");
    expect(generate.mock.calls[0]![0]).not.toContain("i'm 38");
  });

  it("discards a pass running when switched off", async () => {
    let finish: (output: string) => void = () => {};
    generate.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    for (let i = 0; i < 8; i += 1) say("t1", "i'm 38");
    pass.onSettled("bot-t1", "t1");
    await vi.advanceTimersByTimeAsync(0);
    expect(generate).toHaveBeenCalledTimes(1);
    switchTo(false);
    expect(generate.mock.calls[0]![1].aborted).toBe(true);
    switchTo(true);
    finish(facts(["38 years old", "i'm 38"]));
    await pass.idle();
    expect(memoryFileRaw("bot-t1")).toBe("");
    expect(chips("t1")).toHaveLength(0);
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("drops stored pending ids when it starts switched off", async () => {
    say("t1", "i'm 38");
    await vi.advanceTimersByTimeAsync(1_000);
    pass.dispose();
    on = false;
    pass = start();
    expect(stored()).toEqual({ threads: {} });
    on = true;
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await pass.idle();
    expect(generate).not.toHaveBeenCalled();
  });

  it("drops orphaned pending ids on restart", async () => {
    say("t1", "i'm 38");
    await vi.advanceTimersByTimeAsync(1_000);
    pass.dispose();
    vi.spyOn(store, "botByThread").mockReturnValue(null);
    pass = start();
    expect(stored()).toEqual({ threads: {} });
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    expect(generate).not.toHaveBeenCalled();
  });

  it("clears an orphaned thread's idle timer on a config sweep", async () => {
    say("t1", "i'm 38");
    pass.onSettled("bot-t1", "t1");
    await vi.advanceTimersByTimeAsync(1_000);
    vi.spyOn(store, "botByThread").mockReturnValue(null);
    pass.onConfigChanged();
    expect(stored()).toEqual({ threads: {} });
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    await pass.idle();
    expect(generate).not.toHaveBeenCalled();
  });

  it("aborts a deleted bot's running pass and drops its queued thread", async () => {
    let finish: (output: string) => void = () => {};
    generate.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const lookup = store.botByThread;
    const find = vi.spyOn(store, "botByThread").mockImplementation((threadId) => lookup(threadId === "t3" ? "t1" : threadId));
    for (let i = 0; i < 8; i += 1) say("t1", "i'm 38");
    pass.onSettled("bot-t1", "t1");
    for (let i = 0; i < 8; i += 1) say("t2", "i like tea");
    pass.onSettled("bot-t2", "t2");
    for (let i = 0; i < 8; i += 1) say("t3", "i like coffee");
    pass.onSettled("bot-t1", "t3");
    await vi.advanceTimersByTimeAsync(1_000);
    find.mockImplementation((threadId) => threadId === "t1" || threadId === "t3" ? null : lookup(threadId));
    store.emit({ type: "bot.deleted", botId: "bot-t1" });
    expect(generate.mock.calls[0]![1].aborted).toBe(true);
    expect(stored()).toEqual({ threads: {} });
    finish(facts(["38 years old", "i'm 38"]));
    await pass.idle();
    expect(memoryFileRaw("bot-t1")).toBe("");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("skips a bot switched off while another bot runs", async () => {
    switchBot("bot-t1", false);
    for (let i = 0; i < 8; i += 1) {
      say("t1", `i'm 38 ${i}`);
      say("t2", `i like tea ${i}`);
    }
    await settle("t1", 3 * MINUTE);
    await settle("t2", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toContain("i like tea");
    expect(stored().threads.t1).toBeUndefined();
  });

  it("follows the global switch for a bot without its own", async () => {
    pass.dispose();
    on = false;
    botSwitch.set("bot-t2", true);
    pass = start();
    say("t1", "i'm 38");
    say("t2", "i like tea");
    await settle("t1", 3 * MINUTE);
    await settle("t2", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toContain("i like tea");
  });

  it("lets the bot's own switch beat the global one", async () => {
    pass.dispose();
    on = false;
    botSwitch.set("bot-t1", true);
    pass = start();
    say("t1", "i'm 38");
    say("t2", "i like tea");
    await settle("t1", 3 * MINUTE);
    await settle("t2", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]![0]).toContain("i'm 38");
    pass.dispose();
    on = true;
    botSwitch.set("bot-t1", false);
    pass = start();
    say("t1", "i can't read korean");
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("drops only the switched-off bot's pending ids and running pass", async () => {
    let finish: (output: string) => void = () => {};
    generate.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    for (let i = 0; i < 8; i += 1) say("t1", "i'm 38");
    say("t2", "i like tea");
    pass.onSettled("bot-t1", "t1");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(Object.keys(stored().threads).sort()).toEqual(["t1", "t2"]);
    switchBot("bot-t1", false);
    expect(generate.mock.calls[0]![1].aborted).toBe(true);
    expect(Object.keys(stored().threads)).toEqual(["t2"]);
    switchBot("bot-t1", true);
    finish(facts(["38 years old", "i'm 38"]));
    await pass.idle();
    expect(memoryFileRaw("bot-t1")).toBe("");
    await settle("t1", 3 * MINUTE);
    await settle("t2", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]![0]).toContain("i like tea");
  });

  it("checks the switch and the generator before loading thread rows", async () => {
    const load = vi.spyOn(store, "messagesFor");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    say("t1", "i'm 38");
    generator = null;
    await settle("t1", 3 * MINUTE);
    expect(load).not.toHaveBeenCalled();
    generator = generate;
    switchTo(false);
    say("t1", "i can't read korean");
    await settle("t1", 3 * MINUTE);
    expect(load).not.toHaveBeenCalled();
  });

  it("lands a pick after the bot's options in the timeline with the user's words, with the bot's text as context only", async () => {
    store.appendMessage("t1", { role: "bot", kind: "text", text: `${"Some setup. ".repeat(60)}Should the picker follow the app theme, or stay dark always?` });
    say("t1", "the first one");
    say("t1", "I use pnpm for my projects.");
    generate.mockResolvedValue(JSON.stringify([
      { kind: "decision", fact: "Picker look follows the app theme", quote: "the first one" },
      { kind: "fact", fact: "Uses pnpm for projects", quote: "I use pnpm for my projects." },
    ]));
    await settle("t1", 3 * MINUTE);
    const prompt = generate.mock.calls[0]![0];
    expect(prompt).toContain("<context>");
    expect(prompt).toMatch(/<context>[^<]{1,400}follow the app theme, or stay dark always\?<\/context>\nthe first one\n\n<source [^>]+>/);
    expect(prompt).toContain("\nI use pnpm for my projects.\n</user_lines>");
    expect(prompt).not.toContain("Some setup. ".repeat(40));
    expect(memoryFileRaw("bot-t1")).toBe(`${MEMORY_SEED}- Uses pnpm for projects (noted 2026-10-15)\n`);
    expect(readMemoryTopic("bot-t1", "decisions.md")).toContain(
      '## 2026-10-15 12:00 | Picker look follows the app theme | current\n- Picked: Picker look follows the app theme\n- Said: "the first one"\n',
    );
    expect(chips("t1")).toHaveLength(1);
  });

  it("keeps a tweak said after an unbound pick in the same pass", async () => {
    store.appendMessage("t1", { role: "bot", kind: "text", text: "Should the picker follow the app theme, or stay dark always?" });
    say("t1", "the first one");
    say("t1", "and make the header smaller");
    generate.mockResolvedValue(JSON.stringify([
      { kind: "decision", fact: "Picker look follows the app theme", quote: "the first one", message_id: "not-a-message" },
      { kind: "tweak", key: "Picker look follows the app theme", fact: "Make the header smaller", quote: "and make the header smaller" },
    ]));
    await settle("t1", 3 * MINUTE);
    const timeline = readMemoryTopic("bot-t1", "decisions.md") ?? "";
    expect(timeline).toContain("- Binding: unbound");
    expect(timeline).toContain('"and make the header smaller"');
  });

  it("takes context from the bot's reply over a later options card, and from the card when no reply names the options", async () => {
    const card = (subtitle: string, options: string[]) => ({ title: "Your bot has a question", subtitle, options, askUser: true as const });
    store.appendMessage("t1", { role: "bot", kind: "text", text: "1. Always dark 2. Follow the app theme 3. Always light." });
    store.appendMessage("t1", { role: "bot", kind: "options", card: card("Pick 1, 2 or 3.", []) });
    say("t1", "the second one");
    await settle("t1", 3 * MINUTE);
    expect(generate.mock.calls[0]![0]).toContain("<context>1. Always dark 2. Follow the app theme 3. Always light.</context>\nthe second one");
    store.appendMessage("t1", { role: "bot", kind: "options", card: card("Which look?", ["Dark", "Light"]) });
    say("t1", "light");
    await settle("t1", 3 * MINUTE);
    expect(generate.mock.calls[1]![0]).toContain("<context>Which look? Dark Light</context>\nlight");
    store.appendMessage("t1", { role: "bot", kind: "text", text: "Please choose an option below." });
    store.appendMessage("t1", { role: "bot", kind: "options", card: card("Pick one.", ["Serif", "Sans"]) });
    say("t1", "the second one");
    await settle("t1", 3 * MINUTE);
    expect(generate.mock.calls[2]![0]).toContain("<context>Please choose an option below. Serif Sans</context>\nthe second one");
  });

  it("keeps context for a long user line", async () => {
    store.appendMessage("t1", { role: "bot", kind: "text", text: "Dark or light?" });
    say("t1", `dark please, ${"and some more words ".repeat(12)}`);
    await settle("t1", 3 * MINUTE);
    expect(generate.mock.calls[0]![0]).toContain("<context>Dark or light?</context>");
  });

  it("never takes a decision from the bot's text alone", async () => {
    store.appendMessage("t1", { role: "bot", kind: "text", text: "Pick one: A) ship on Fridays B) never ship on Fridays" });
    say("t1", "thanks, talk later");
    generate.mockResolvedValue(JSON.stringify([
      { kind: "decision", fact: "Never ships on Fridays", quote: "never ship on Fridays" },
      { kind: "decision", fact: "Deploys straight to production", quote: "thanks, talk later" },
    ]));
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe("");
  });

  it("moves a replaced decision line into the timeline before MEMORY.md drops it, once across a conflict", async () => {
    const old = "- Repo uses spaces (noted 2026-10-01)";
    const notes = `# Memory\n\n## Decisions (settled, do not ask again)\n${old}\n\n## Notes\n- Likes tea\n`;
    writeMemoryFile("bot-t1", notes);
    store.appendMessage("t1", { role: "bot", kind: "text", text: "Tabs or spaces for this repo?" });
    say("t1", "tabs");
    generate.mockImplementationOnce(async () => {
      writeMemoryFile("bot-t1", `${notes}- edited meanwhile\n`);
      return JSON.stringify([{ kind: "decision", key: "repo indent", fact: "Repo uses tabs", quote: "tabs", replaces: old }]);
    });
    await settle("t1", 3 * MINUTE);
    const side = join(workspaceDir("bot-t1"), "memory", "decisions.md");
    const moved = readFileSync(side, "utf8");
    expect(moved).toContain('## 2026-10-01 | repo indent | replaced by 2026-10-15 12:00\n- Picked: ~~Repo uses spaces~~\n\n## 2026-10-15 12:00 | repo indent | current\n- Picked: Repo uses tabs\n- Said: "tabs"\n');
    expect(memoryFileRaw("bot-t1")).toBe(`${notes}- edited meanwhile\n`);
    expect(chips("t1")).toHaveLength(0);
    await settle("t1");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(memoryFileRaw("bot-t1")).toBe("# Memory\n\n## Decisions (settled, do not ask again)\n\n## Notes\n- Likes tea\n- edited meanwhile\n");
    expect(readFileSync(side, "utf8")).toBe(moved);
    expect(chips("t1")).toHaveLength(1);
  });

  it("keeps a replaced decision line in MEMORY.md until its timeline write lands", async () => {
    const old = "- Repo uses spaces (noted 2026-10-01)";
    const notes = `# Memory\n\n## Decisions (settled, do not ask again)\n${old}\n\n## Notes\n- Likes tea\n`;
    writeMemoryFile("bot-t1", notes);
    const side = join(workspaceDir("bot-t1"), "memory", "decisions.md");
    const write = atomic.writeFileAtomic;
    const failWrite = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, ...args) => {
      if (path === side) throw new Error("timeline write failed");
      write(path, ...args);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    store.appendMessage("t1", { role: "bot", kind: "text", text: "Tabs or spaces for this repo?" });
    say("t1", "tabs");
    generate.mockResolvedValueOnce(JSON.stringify([{ kind: "decision", key: "repo indent", fact: "Repo uses tabs", quote: "tabs", replaces: old }]));
    await settle("t1", 3 * MINUTE);
    expect(failWrite).toHaveBeenCalledWith(side, expect.any(String), expect.anything());
    expect(memoryFileRaw("bot-t1")).toBe(notes);
    failWrite.mockRestore();
    await settle("t1");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(memoryFileRaw("bot-t1")).toBe("# Memory\n\n## Decisions (settled, do not ask again)\n\n## Notes\n- Likes tea\n");
    expect(readFileSync(side, "utf8")).toContain('## 2026-10-01 | repo indent | replaced by 2026-10-15 12:00\n- Picked: ~~Repo uses spaces~~\n\n## 2026-10-15 12:00 | repo indent | current\n- Picked: Repo uses tabs\n- Said: "tabs"\n');
    expect(chips("t1")).toHaveLength(1);
  });

  it("does not offer files only named in a bot reply as saved pictures", () => {
    store.appendMessage("t1", { role: "bot", kind: "text", text: "Mocks: /tmp/mock/C.png, ~/mock/B.png and C:\\mocks\\A.png. Which one?" });
    const { id } = say("t1", "c");
    const shown = replyTurns(store.messagesFor("t1"), [id], join(dataDir, "attachments")).get(id);
    expect(shown?.pictures).toEqual([]);
  });

  it("never lands the same pick twice", async () => {
    writeMemoryFile("bot-t1", "# Memory\n");
    const timeline = '# Decision timeline\n\n## 2026-10-01 09:00 | repo indent | current\n- Picked: Repo uses tabs\n- Said: "tabs"\n';
    mkdirSync(join(workspaceDir("bot-t1"), "memory"), { recursive: true });
    writeFileSync(join(workspaceDir("bot-t1"), "memory", "decisions.md"), timeline);
    store.appendMessage("t1", { role: "bot", kind: "text", text: "Tabs or spaces?" });
    say("t1", "tabs");
    generate.mockResolvedValue(JSON.stringify([{ kind: "decision", key: "Repo indent", fact: "Repo uses tabs", quote: "tabs" }]));
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe("# Memory\n");
    expect(readMemoryTopic("bot-t1", "decisions.md")).toBe(timeline);
    expect(chips("t1")).toHaveLength(0);
  });

  it("swaps an outdated note in place and appends the rest", async () => {
    writeMemoryFile("bot-t1", "# Memory\n- 38 years old (noted 2026-10-14)\n- Lives in Seoul\n- Prefers pnpm\n");
    generate.mockResolvedValue(JSON.stringify([
      { fact: "39 years old", quote: "I'm 39 now", replaces: "- 38 years old (noted 2026-10-14)" },
      { fact: "Lives in Busan", quote: "I moved to Busan last week", replaces: "- Lives in Seoul" },
    ]));
    say("t1", "I'm 39 now");
    say("t1", "I moved to Busan last week");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(
      "# Memory\n- 39 years old (noted 2026-10-15)\n- Lives in Seoul\n- Prefers pnpm\n- Lives in Busan (noted 2026-10-15)\n",
    );
    expect(chips("t1")).toHaveLength(1);
    expect(chips("t1")[0]!.tool?.spoken).toBe("39 years old, Lives in Busan");
  });
});

describe("memory pass filters", () => {
  it("accepts only typed user text rows", () => {
    expect(eligibleRow(row())).toBe(true);
    for (const patch of [
      { role: "bot" as const },
      { kind: "secret" as const },
      { from: { botId: "b", name: "B", color: "#fff" } },
      { origin: "webhook" },
      { comm: { groupId: "g", withBotId: "b", withName: "B", withColor: "#fff" } },
      { queued: true },
      { image: "a.png" },
      { hasImage: true },
    ]) expect(eligibleRow(row(patch))).toBe(false);
  });

  it("cuts pastes, attachments, code, quotes and long blocks", () => {
    const text = [
      "i'm 38",
      '<pasted-text index="1">\npasted body\n</pasted-text>',
      "<pasted_content>wrapped paste</pasted_content>",
      '<attached-file path="C:/a.pdf" name="a.pdf" size="3" />',
      "```\nconst code = 1;\n```",
      "> quoted reply",
      `he said "${"q".repeat(90)}" ok`,
      "x".repeat(401),
      "1\n2\n3\n4\n5\n6\n7",
    ].join("\n\n");
    expect(userTyping(text)).toBe("i'm 38\n\nhe said  ok");
  });

  it("masks secrets before text leaves Wink", () => {
    expect(userTyping("my key is sk-ant-abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijklmnop");
  });

  it("rejects facts without a verbatim quote", () => {
    const text = "i'm 38 and live in Seoul";
    expect(acceptFacts([{ fact: "38 years old", quote: "I'm 38" }], text, "")).toEqual([{ line: "38 years old" }]);
    expect(acceptFacts([{ fact: "Lives in Korea", quote: "lives in Korea" }], text, "")).toEqual([]);
    expect(acceptFacts([{ fact: "Is 39", quote: "" }], text, "")).toEqual([]);
    expect(acceptFacts([{ fact: "x", quote: "y".repeat(121) }], "y".repeat(121), "")).toEqual([]);
  });

  it("rejects secret-looking facts", () => {
    for (const fact of [
      "Wifi password is Tr0ub4dor",
      "PIN is 4471",
      "Uses token sk-ant-abc123def456",
      "GitHub ghp_abcdefghij1234567890",
      "Has eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl",
      "Code a8Fj29dkLq03mZp7XyT5vB2n",
    ]) expect(secretLike(fact)).toBe(true);
    expect(secretLike("Uses Muse Spark 1.3")).toBe(false);
    const text = "my wifi password is Tr0ub4dor";
    expect(acceptFacts([{ fact: "Has wifi at home", quote: "my wifi password is Tr0ub4dor" }], text, "")).toEqual([]);
  });

  it("rejects a quote whose own paragraph is sensitive", () => {
    for (const [said, value] of [["우리집 와이파이 비번은 qwer1234야", "qwer1234"], ["my wifi password is hunter22", "hunter22"]] as const) {
      expect(userTyping(said)).toBe("");
      expect(acceptFacts([{ fact: `Wi-Fi: ${value}`, quote: value }], said, "")).toEqual([]);
      expect(acceptFacts([{ fact: `Wi-Fi: ${value}`, quote: value }, { fact: "38", quote: "i'm 38" }], `i'm 38\n\n${said}`, "")).toEqual([{ line: "38" }]);
    }
    expect(acceptFacts([{ fact: "38 and likes tea", quote: "i'm 38 i like tea" }], "i'm 38\n\ni like tea", "")).toEqual([]);
  });

  it("dedupes against MEMORY.md and within the batch", () => {
    const text = "i can't read korean. i'm 38";
    const notes = "# Memory\n- Can't read Korean; translate for a parent\n";
    expect(acceptFacts([{ fact: "Unable to read Korean", quote: "i can't read korean" }], text, notes)).toEqual([]);
    expect(acceptFacts([{ fact: "38", quote: "i'm 38" }, { fact: "38", quote: "38" }], text, notes)).toEqual([{ line: "38" }]);
  });

  it("dedupes on whole words only", () => {
    const notes = "# Memory\n- Runs Wink 1.0.138 (noted 2026-10-01)\n- Lives at 3838 Main St\n";
    expect(acceptFacts([{ fact: "38", quote: "I'm 38" }], "I'm 38", notes)).toEqual([{ line: "38" }]);
    expect(acceptFacts([{ fact: "Main St", quote: "I'm on Main St" }], "I'm on Main St", notes)).toEqual([]);
    expect(acceptFacts([{ fact: "38 years old", quote: "I'm 38" }], "I'm 38", "- 38 years old\n")).toEqual([]);
  });

  it("keeps a valid replaces and skips dedupe against that line only", () => {
    const old = "- Turns 38 next week (noted 2026-10-01)";
    const fact = { fact: "38 years old", quote: "I'm 38", replaces: old };
    expect(acceptFacts([fact], "I'm 38", `# Memory\n${old}\n`)).toEqual([{ line: "38 years old", replaces: old }]);
    expect(acceptFacts([fact], "I'm 38", `# Memory\n${old}\n- Has 38 plants (noted 2026-10-02)\n`)).toEqual([]);
  });

  it.each([
    ["a hand-written line", "# Memory\n- Lives in Seoul\n", "- Lives in Seoul"],
    ["a missing line", "# Memory\n- Lives in Seoul\n", "- Lives in Daegu (noted 2026-10-01)"],
    ["a duplicated line", "# Memory\n- Lives in Daegu (noted 2026-10-01)\n- Lives in Daegu (noted 2026-10-01)\n", "- Lives in Daegu (noted 2026-10-01)"],
  ])("ignores replaces of %s and appends", (_case, notes, replaces) => {
    const accepted = acceptFacts([{ fact: "Lives in Busan", quote: "I moved to Busan", replaces }], "I moved to Busan", notes);
    expect(accepted).toEqual([{ line: "Lives in Busan" }]);
    expect(appendNotes(notes, accepted, NOW)).toBe(`${notes}- Lives in Busan (noted 2026-10-15)\n`);
  });

  it("ignores a line claimed by two facts", () => {
    const old = "- Lives in Daegu (noted 2026-10-01)";
    const notes = `# Memory\n${old}\n`;
    const accepted = acceptFacts(
      [
        { fact: "Lives in Busan", quote: "I moved to Busan", replaces: old },
        { fact: "Works in Ulsan", quote: "I work in Ulsan", replaces: old },
      ],
      "I moved to Busan and I work in Ulsan",
      notes,
    );
    expect(accepted).toEqual([{ line: "Lives in Busan" }, { line: "Works in Ulsan" }]);
    expect(appendNotes(notes, accepted, NOW)).toBe(`${notes}- Lives in Busan (noted 2026-10-15)\n- Works in Ulsan (noted 2026-10-15)\n`);
  });

  it("swaps one line and leaves every other byte alone", () => {
    const raw = "# Memory\r\n- Likes  tea \r\n- Is 38 (noted 2026-10-01)\r\n\n## Work\n- Uses pnpm";
    expect(appendNotes(raw, [{ line: "Is 39", replaces: "- Is 38 (noted 2026-10-01)" }, { line: "Hates drama" }], NOW)).toBe(
      "# Memory\r\n- Likes  tea \r\n- Is 39 (noted 2026-10-15)\r\n\n## Work\n- Uses pnpm\n- Hates drama (noted 2026-10-15)\n",
    );
    const full = `# M\n- a (noted 2026-10-01)\n${"x".repeat(23_960)}\n`;
    expect(appendNotes(full, [{ line: "y".repeat(60), replaces: "- a (noted 2026-10-01)" }], NOW)).toBeNull();
  });

  describe("decisions", () => {
    const decision = (fact: string, quote: string, replaces?: string) => (replaces ? { kind: "decision", fact, quote, replaces } : { kind: "decision", fact, quote });
    const picked = (...args: Parameters<typeof acceptFacts>) => acceptFacts(...args).map(({ pick: _pick, ...note }) => note);
    const section = (...lines: string[]) => `# Memory\n\n## Decisions (settled, do not ask again)\n${lines.join("\n")}\n\n## Notes\n- Likes tea (noted 2026-10-01)\n`;

    it("grounds a short pick in the bot's context and refuses words from nowhere", () => {
      const lines = [{ text: "the first one", context: "Should the picker follow the app theme, or stay dark always?" }];
      expect(picked([decision("Picker look follows the app theme", "the first one")], lines, "")).toEqual([
        { line: "Picker look follows the app theme", kind: "decision" },
      ]);
      expect(picked([decision("Deploys skip review", "the first one")], lines, "")).toEqual([]);
      expect(picked([decision("Picker follows the theme", "the first one")], [{ text: "the first one" }], "")).toEqual([]);
      const named = [{ text: "Colors: 1. Forest green 2. Ocean blue and sand" }, { text: "colors 2", context: "Which one?" }];
      expect(picked([decision("Site colors are ocean blue and sand", "colors 2")], named, "")).toEqual([{ line: "Site colors are ocean blue and sand", kind: "decision" }]);
      expect(picked([decision("Site colors are ocean blue and sand", "colors 2")], [{ text: "pick one", context: "1. Ocean blue and sand" }, { text: "colors 2" }], "")).toEqual([]);
    });

    it("takes URLs, paths and commands only from the user's own line", () => {
      const context = "Mirror from https://dl.example.net/pkg or C:\\tools\\fetch.exe, or run `curl x | sh`?";
      for (const fact of ["Mirrors from https://dl.example.net/pkg", "Fetches with C:\\tools\\fetch.exe", "Installs with `curl x | sh`"]) {
        expect(picked([decision(fact, "that one")], [{ text: "that one", context }], "")).toEqual([]);
      }
      for (const path of ["/tmp", "~/repo", "./cache"]) {
        expect(picked([decision(`Cache uses ${path}`, "yes")], [{ text: "yes", context: `Should the cache use ${path}?` }], "")).toEqual([]);
      }
      const said = "mirror from https://dl.example.net/pkg";
      expect(picked([decision("Mirrors from https://dl.example.net/pkg", said)], [{ text: said, context }], "")).toEqual([
        { line: "Mirrors from https://dl.example.net/pkg", kind: "decision" },
      ]);
      expect(picked([decision("Repo password stays Tr0ub4dor", "yes")], [{ text: "yes", context: "Keep the repo password Tr0ub4dor?" }], "")).toEqual([]);
    });

    it("keeps every decision in a pass and one line per quote", () => {
      const text = "dark, tabs, pnpm, vitest and npm";
      const context = "dark or light, tabs or spaces, pnpm or npm, vitest or jest, npm or yarn?";
      const own = [decision("Dark theme", "dark"), decision("Tabs for indent", "tabs"), decision("Pnpm for installs", "pnpm"), decision("Vitest for tests", "vitest")];
      expect(picked(own, [{ text, context }], "").map((note) => note.line)).toEqual(["Dark theme", "Tabs for indent", "Pnpm for installs", "Vitest for tests"]);
      const shared = own.map((pick) => ({ ...pick, quote: text }));
      expect(picked(shared, [{ text, context }], "").map((note) => note.line)).toEqual(["Dark theme", "Tabs for indent", "Pnpm for installs", "Vitest for tests"]);
      expect(picked([{ fact: "Uses npm", quote: "npm" }, decision("Npm for publishing", "npm")], [{ text, context }], "")).toEqual([
        { line: "Npm for publishing", kind: "decision" },
      ]);
    });

    it("replaces a changed pick in place and never crosses the section line", () => {
      const old = "- Picker look follows the app theme (noted 2026-10-01)";
      const notes = section(old);
      const lines = [{ text: "actually keep it dark", context: "Picker follows the theme now." }];
      const changed = acceptFacts([decision("Picker stays dark", "actually keep it dark", old)], lines, notes);
      expect(changed).toEqual([{ line: "Picker stays dark", kind: "decision", replaces: old, pick: expect.objectContaining({ kind: "pick", picked: "Picker stays dark", said: "actually keep it dark", legacy: { day: "2026-10-01", line: "Picker look follows the app theme" } }) }]);
      const back = [{ text: "tabs again", context: "Repo stays on spaces, or back to tabs?" }];
      const spaces = "- Repo uses spaces (noted 2026-10-02)";
      expect(picked([decision("Repo uses tabs", "tabs again", spaces)], back, section(spaces), "- Repo uses tabs (noted 2026-09-01)")).toEqual([
        { line: "Repo uses tabs", kind: "decision", replaces: spaces },
      ]);
      expect(appendNotes(notes, changed, NOW)).toBe("# Memory\n\n## Decisions (settled, do not ask again)\n\n## Notes\n- Likes tea (noted 2026-10-01)\n");
      expect(picked([{ fact: "Keeps it dark", quote: "actually keep it dark", replaces: old }], lines, notes)).toEqual([{ line: "Keeps it dark" }]);
      const fact = "- Likes tea (noted 2026-10-01)";
      expect(picked([decision("Tea over coffee", "tea", fact)], [{ text: "tea", context: "Tea or coffee?" }], notes)).toEqual([
        { line: "Tea over coffee", kind: "decision" },
      ]);
    });

    it("keeps picks out of MEMORY.md and takes only a replaced decision line out", () => {
      expect(appendNotes("# Memory\n- Likes tea\n", [{ line: "Dark theme", kind: "decision" }, { line: "38" }], NOW)).toBe("# Memory\n- Likes tea\n- 38 (noted 2026-10-15)\n");
      const old = "- A (noted 2026-10-01)";
      expect(appendNotes(section("- Hand-written pick", old), [{ line: "B", kind: "decision", replaces: old }, { line: "C", kind: "tweak" }, { line: "D" }], NOW)).toBe(
        `${section("- Hand-written pick")}- D (noted 2026-10-15)\n`,
      );
    });
  });

  it("names no example key the note-taker could copy as a pick's question", () => {
    expect(notePrompt("", [{ text: "x" }])).not.toMatch(/key[^\n.]*like "/);
    expect(notePrompt("", [{ text: "x" }])).toContain("key is the thing decided, never the option");
  });

  it("grows the note prompt by 1.3 KB at most", () => {
    expect(Buffer.byteLength(notePrompt("", [{ text: "x" }]), "utf8") - 992).toBeLessThanOrEqual(1_300);
  });

  it("finds pending rows from the newest end without reading older rows", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: `r${i}` }));
    for (let i = 0; i < 8; i += 1) {
      Object.defineProperty(rows, i, { get: () => { throw new Error(`read row ${i}`); } });
    }
    expect([...pendingRows(rows, ["r8", "r9"]).keys()]).toEqual(["r9", "r8"]);
    expect([...pendingRows(rows.slice(8), ["r9", "gone"]).keys()]).toEqual(["r9"]);
  });

  it("parses the model's JSON reply", () => {
    expect(parseFacts('```json\n[{"fact":"a","quote":"b"}]\n```')).toEqual([{ fact: "a", quote: "b" }]);
    expect(parseFacts("[]")).toEqual([]);
    expect(parseFacts("nothing")).toBeNull();
    expect(parseFacts('[{"fact":1}]')).toBeNull();
    expect(parseFacts('{"error":"incomplete response","details":[]')).toBeNull();
    expect(parseFacts('{"facts":[{"fact":"a","quote":"b"}]}')).toBeNull();
  });

  it("appends within the budget only", () => {
    expect(appendNotes("# M", [{ line: "a" }], NOW)).toBe("# M\n- a (noted 2026-10-15)\n");
    expect(appendNotes(`# M\n${"x".repeat(23_990)}\n`, [{ line: "a" }], NOW)).toBeNull();
  });

  it("keeps the chip summary short", () => {
    expect(noteSummary(["a", "b"])).toBe("a, b");
    expect(noteSummary(["x".repeat(200)])).toHaveLength(120);
  });
});

describe("note generator", () => {
  const instance = (driverKind: string, patch: { enabled?: boolean; text?: string | null } = {}) => ({
    driverKind,
    enabled: patch.enabled ?? true,
    generateText: patch.text === null ? undefined : vi.fn(async () => patch.text ?? driverKind),
  });

  it("calls the Claude instance lean, never another engine, without a session transcript", async () => {
    const codex = instance("codex");
    const claude = instance("claudeAgent");
    const signal = new AbortController().signal;
    await expect(noteGenerator([codex, claude])?.("prompt", signal)).resolves.toBe("claudeAgent");
    expect(claude.generateText).toHaveBeenCalledWith("prompt", { signal, timeoutMs: 120_000, ephemeral: true, lean: true });
    expect(codex.generateText).not.toHaveBeenCalled();
  });

  it("finds none when Claude is off, has no one-shot call, or is missing", () => {
    expect(noteGenerator([instance("claudeAgent", { enabled: false })])).toBeNull();
    expect(noteGenerator([instance("claudeAgent", { text: null })])).toBeNull();
    expect(noteGenerator([instance("codex")])).toBeNull();
    expect(noteGenerator([])).toBeNull();
  });

  it.each(["codex", "grokAgent", "antigravityAgent", "museAgent"])("runs %s on its resolved account even with Main Claude ready", async (engine) => {
    const own = instance(engine);
    const claude = { ...instance("claudeAgent"), instanceId: "claude-main" };
    const base = instance(engine, { text: "wrong account" });
    const signal = new AbortController().signal;
    const account = { instanceId: "claude-main", available: true };
    const generate = noteGenerator([base, claude], account, own);
    await expect(generate?.("prompt", signal)).resolves.toBe(engine);
    expect(own.generateText).toHaveBeenCalledExactlyOnceWith("prompt", { signal, timeoutMs: 120_000, ephemeral: true, lean: true });
    expect(claude.generateText).not.toHaveBeenCalled();
    expect(base.generateText).not.toHaveBeenCalled();
    expect(noteGenerator([base, claude], account, null)).toBeNull();
    expect(noteGenerator([], undefined, instance("codex", { enabled: false }))).toBeNull();
    expect(noteGenerator([], undefined, instance("codex", { text: null }))).toBeNull();
  });

  it("labels the background trace with the engine that runs the pass", async () => {
    const own = instance("grokAgent");
    expect(noteGenerator([], undefined, own)?.engine).toBe("grok");
  });

  it("passes an optional usage observer without changing the helper call", async () => {
    const claude = instance("claudeAgent");
    const signal = new AbortController().signal;
    const onUsage = vi.fn();
    await noteGenerator([claude])!("prompt", signal, onUsage);
    expect(claude.generateText).toHaveBeenCalledWith("prompt", { signal, timeoutMs: 120_000, ephemeral: true, lean: true, onUsage });
  });

  describe("account limits", () => {
    const HOUR = 3_600_000;
    const now = Date.parse("2026-11-22T00:00:00Z");
    const own = (error?: Error) => ({ instanceId: "grok", driverKind: "grokAgent", enabled: true, generateText: vi.fn(async () => {
      if (error) throw error;
      return "[]";
    }) });
    const usage = (report?: RateLimitsReport) => ({ limits: new Map<string, RateLimitsReport>(report ? [["grok", report]] : []), save: vi.fn() });
    beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
    afterEach(() => vi.restoreAllMocks());

    it("holds notes after a limit with no reset time only for the shortest window", async () => {
      const limits = usage();
      await expect(noteGenerator([], undefined, own(new Error("xAI HTTP 429: Too Many Requests")), limits)?.("notes", new AbortController().signal)).rejects.toThrow();
      expect(limits.limits.get("grok")?.noteLimit).toEqual({ resetsAt: now + 5 * HOUR });
      expect(noteGenerator([], undefined, own(), limits)).toBeNull();
      vi.spyOn(Date, "now").mockReturnValue(now + 5 * HOUR);
      expect(noteGenerator([], undefined, own(), limits)).not.toBeNull();
    });

    it("keeps a limit's own reset time, and stops reading a stored limit with none", async () => {
      const limits = usage();
      const error = Object.assign(new Error("429"), { data: { error: { type: "rate_limit_exceeded" }, resetsAt: (now + 30 * HOUR) / 1000 } });
      await expect(noteGenerator([], undefined, own(error), limits)?.("notes", new AbortController().signal)).rejects.toThrow();
      expect(limits.limits.get("grok")?.noteLimit).toEqual({ resetsAt: now + 30 * HOUR });
      vi.spyOn(Date, "now").mockReturnValue(now + 29 * HOUR);
      expect(noteGenerator([], undefined, own(), limits)).toBeNull();
      vi.spyOn(Date, "now").mockReturnValue(now + 30 * HOUR + 1);
      expect(noteGenerator([], undefined, own(), limits)).not.toBeNull();
      expect(noteGenerator([], undefined, own(), usage({ windows: [], observedAt: new Date(now).toISOString(), noteLimit: { resetsAt: null } }))).not.toBeNull();
    });

    it("pauses on a spent window unless another pool of it still has room", () => {
      const spent = { id: "seven_day", usedPercent: 100, resetsAt: now + 48 * HOUR };
      const report = (otherPoolLeft?: boolean) => usage({ windows: [{ ...spent, ...(otherPoolLeft && { otherPoolLeft }) }], observedAt: new Date(now).toISOString() });
      expect(noteGenerator([], undefined, own(), report())).toBeNull();
      expect(noteGenerator([], undefined, own(), report(true))).not.toBeNull();
    });
  });
});

describe("notes on the bot's own engine", () => {
  const FAKE_CODEX = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-codex-app-server.ts");
  let codex: ProviderInstance | undefined;

  afterEach(async () => {
    await codex?.dispose();
    delete process.env.FAKE_CODEX_MESSAGES;
    vi.restoreAllMocks();
  });

  it("keeps a real helper rejection on its account without submitting again", async () => {
    chmodSync(FAKE_CODEX, 0o755);
    const home = temps.make(join(tmpdir(), "memory-pass-codex-limit-"));
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-fake", context_window: 200_000 }] }));
    codex = await CodexDriver.create({ instanceId: "codex", displayName: "Codex", enabled: true,
      environment: { CODEX_HOME: home, FAKE_CODEX_MODE: "text-rate-limited" }, config: { cli: FAKE_CODEX, fullAuto: false } });
    const own = summaryInstance(codex, "gpt-fake");
    const limits: RateLimitsMap = new Map();
    const usage = { limits, save: vi.fn() };
    await expect(noteGenerator([], undefined, own, usage)?.("notes", new AbortController().signal)).rejects.toThrow("Account text rate limit");
    expect(noteGenerator([], undefined, own, usage)).toBeNull();
    expect(usage.save).toHaveBeenCalledTimes(1);
    expect(limits.get("codex")?.noteLimit?.resetsAt).toBeGreaterThan(Date.now());
  });

  it.each([
    ["an RPC error", undefined],
    ["an error event", { method: "error", params: { error: { message: "unexpected status 401 Unauthorized" }, willRetry: false } }],
    ["a failed turn", { method: "turn/completed", params: { turn: { status: "failed", error: { message: "unexpected status 401 Unauthorized" } } } }],
  ])("holds a Codex helper signed out by %s until a fresh account probe", async (_path, frame) => {
    chmodSync(FAKE_CODEX, 0o755);
    const home = temps.make(join(tmpdir(), "memory-pass-codex-signed-out-"));
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-fake", context_window: 200_000 }] }));
    const environment: Record<string, string> = frame ? { FAKE_CODEX_TOOL_FIXTURE: join(home, "frames.json") } : { FAKE_CODEX_MODE: "unauthorized" };
    if (frame) writeFileSync(join(home, "frames.json"), JSON.stringify([frame]));
    codex = await CodexDriver.create({ instanceId: "codex", displayName: "Codex", enabled: true,
      environment: { CODEX_HOME: home, ...environment }, config: { cli: FAKE_CODEX, fullAuto: false } });
    const own = summaryInstance(codex, "gpt-fake");
    const usage = { limits: new Map() as RateLimitsMap, save: vi.fn(), signedOut: new Set<string>() };
    await expect(noteGenerator([], undefined, own, usage)?.("notes", new AbortController().signal)).rejects.toThrow("401");
    expect(noteGenerator([], undefined, own, usage)).toBeNull();
    usage.signedOut.clear();
    expect(noteGenerator([], undefined, own, usage)).not.toBeNull();
    expect(usage.save).not.toHaveBeenCalled();
  });

  it("fills notes and the timeline for a Codex bot on a PC with no Claude", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const recorded = JSON.parse(readFileSync(new URL("../test/fixtures/recorded/claude/memory-decisions.json", import.meta.url), "utf8"));
    process.env.FAKE_CODEX_MESSAGES = JSON.stringify([{ text: recorded.reply.text, phase: "final_answer" }]);
    chmodSync(FAKE_CODEX, 0o755);
    const home = temps.make(join(tmpdir(), "memory-pass-codex-"));
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-fake", context_window: 200_000 }] }));
    codex = await CodexDriver.create({ instanceId: "codex", displayName: "Codex", enabled: true, environment: { CODEX_HOME: home }, config: { cli: FAKE_CODEX, fullAuto: false } });
    const own = summaryInstance(codex, "gpt-fake");
    const store = fakeStore();
    writeMemoryFile("bot-c1", "");
    removeTestData(join(workspaceDir("bot-c1"), "memory"));
    const pass = createMemoryPass({ store, dataDir: temps.make(join(tmpdir(), "memory-pass-")), generate: () => noteGenerator([codex!], undefined, own), enabled: () => true, busy: () => false });
    store.appendMessage("c1", { role: "bot", kind: "text", text: "Which look should the model picker have? 1. Always dark 2. Follow the app theme 3. Always light. Pick one and I'll build it." });
    store.appendMessage("c1", { role: "user", kind: "text", text: "the second one" });
    store.appendMessage("c1", { role: "user", kind: "text", text: "I use pnpm for my projects." });
    pass.onSettled("bot-c1", "c1", true);
    await pass.idle();
    pass.dispose();
    expect(memoryFileRaw("bot-c1")).toMatch(/^- Uses pnpm for projects \(noted \d{4}-\d{2}-\d{2}\)$/m);
    expect(readMemoryTopic("bot-c1", "decisions.md")).toContain("- Picked: 2 - Follow the app theme\n- Over: 1 - Always dark; 3 - Always light\n");
  });
});

describe("signed-out note helpers", () => {
  const FAKE_AGY = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-agy-cli.ts");
  const cliHelper = (name: string, stderr: string) => {
    const text = createCliText({ name, model: "text", timeoutMs: 30_000, parse: (stdout) => stdout,
      command: async () => ({ cli: process.execPath, args: ["-e", `process.stderr.write(${JSON.stringify(stderr)});process.exit(1)`], env: { ...process.env } }) });
    return { instanceId: name, driverKind: `${name.toLowerCase()}Agent`, enabled: true, generateText: text.generateText, dispose: async () => text.dispose() };
  };
  const geminiHelper = async (error: string) => {
    chmodSync(FAKE_AGY, 0o755);
    const home = temps.make(join(tmpdir(), "memory-pass-agy-signed-out-"));
    return AntigravityDriver.create({ instanceId: "Gemini", displayName: undefined, enabled: true,
      environment: { HOME: home, USERPROFILE: home, FAKE_AGY_RESULT_ERROR: error }, config: { cli: FAKE_AGY, fullAuto: false } });
  };

  // each engine's own words for a signed-out account; a wording missing here retries on every settlement
  it.each([
    ["Muse", "run ended with Failed: your API key from META_API_KEY was rejected — update or unset it"],
    ["Muse", "run ended with Failed: your saved API key was rejected — run `muse login` or add a new key"],
    ["Muse", "run ended with Failed: still unauthorized after a token refresh; run `muse login` again"],
    ["Muse", "missing meta credentials: run `muse login` or set META_API_KEY"],
    ["Grok", "Error: Not signed in. To authenticate without a browser, run:\n  grok login --device-code"],
    ["Grok", "Error: Session expired. Run `grok login` to re-authenticate."],
    ["Grok", "Error: Authentication failed. Run `grok login`, set XAI_API_KEY, or add api_key to ~/.grok/config.toml."],
    ["Grok", "HTTP 401 Unauthorized: session expired"],
    ["Gemini", "Unauthorized (code 401)"],
    ["Gemini", "UNAUTHENTICATED (code 401): Sign in again."],
  ])("makes five settlements cost one %s attempt: %s", async (engine, text) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const helper = engine === "Gemini" ? await geminiHelper(text) : cliHelper(engine, text);
    const generateText = vi.fn(helper.generateText!);
    const usage = { limits: new Map() as RateLimitsMap, save: vi.fn(), signedOut: new Set<string>() };
    const store = fakeStore();
    const pass = createMemoryPass({ store, dataDir: temps.make(join(tmpdir(), "memory-pass-")), enabled: () => true, busy: () => false,
      generate: () => noteGenerator([], undefined, { ...helper, generateText }, usage) });
    try {
      store.appendMessage("s1", { role: "user", kind: "text", text: "I use pnpm." });
      for (let i = 0; i < 5; i++) {
        pass.onSettled("bot-s1", "s1", true);
        await pass.idle();
      }
      expect(generateText).toHaveBeenCalledTimes(1);
      expect([...usage.signedOut]).toEqual([helper.instanceId]);
      expect(store.rows("s1").map(({ role }) => role)).toEqual(["user"]);
      // a fresh account probe clears the hold
      usage.signedOut.clear();
      expect(noteGenerator([], undefined, helper, usage)).not.toBeNull();
    } finally {
      pass.dispose();
      await helper.dispose();
      vi.restoreAllMocks();
    }
  });
});

describe("memory pass wiring", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(join(here, "index.ts"), "utf8");
  const bots = readFileSync(join(here, "bot-routes.ts"), "utf8");

  it("keeps the legacy Claude selector and uses the resolved own account for other bots", () => {
    expect(index).toContain("botAccounts.notes(bot, { limits: rateLimitsByInstance,");
    expect(index).toMatch(/createMemoryPass\(\{[\s\S]*?generate: noteHelper,[\s\S]*?botHasActiveTurn/);
    expect(index).toMatch(/createMemorySleep\(\{[\s\S]*?generate: noteHelper,/);
    expect(index).toMatch(/memoryPass\.onSettled\(bot\.id, event\.threadId, flushNotes\);\s*if \(!store\.groupByThread\(event\.threadId\)\)/);
    expect(index).toContain("memoryPass.dispose();");
  });

  it("lifts a signed-out helper only on a fresh account probe", () => {
    expect(index).toContain("registry.onProbed((instanceId) => signedOutHelpers.delete(instanceId));");
    expect(index).toContain("signedOut: signedOutHelpers");
  });

  it("stops a Gemini bot's note helpers as soon as a foreground send claims it", async () => {
    const source = index.replace(/\r\n/g, "\n");
    const start = source.indexOf("function tryClaimTurnStart(");
    const claims = new Map<string, string | undefined>();
    const kinds: Record<string, string> = { "bot-g1": "antigravityAgent", "bot-c1": "codex" };
    const generate = vi.fn((_prompt: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const store = fakeStore();
    const pass = createMemoryPass({ store, dataDir: temps.make(join(tmpdir(), "memory-pass-")), generate: () => generate, enabled: () => true, busy: (botId) => claims.has(botId) });
    const memorySleep = { onTurn: vi.fn() };
    const claim = new Function("scope", `with (scope) { ${ts.transpile(source.slice(start, source.indexOf("\n}\n", start) + 2), { target: ts.ScriptTarget.ES2022 })} return tryClaimTurnStart; }`)({
      turnStartClaims: claims, memoryPass: pass, memorySleep,
      store: { bot: (id: string) => ({ modelSelection: { instanceId: id } }) },
      registry: { get: (id: string) => ({ driverKind: kinds[id] }) },
    }) as (botId: string, threadId?: string) => boolean;
    for (const thread of ["g1", "c1"]) {
      writeMemoryFile(`bot-${thread}`, "");
      store.appendMessage(thread, { role: "user", kind: "text", text: "I use pnpm for my projects." });
      pass.onSettled(`bot-${thread}`, thread, true);
    }
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(claim("bot-g1", "g1")).toBe(true);
    expect(claim("bot-c1", "c1")).toBe(true);
    expect(generate.mock.calls.map(([, signal]) => signal.aborted)).toEqual([true, false]);
    expect(memorySleep.onTurn).toHaveBeenCalledExactlyOnceWith("bot-g1");
    pass.dispose();
  });

  it("runs the pass after a room turn, for the member that spoke", () => {
    expect(index).toMatch(/if \(speaker && group\?\.busyBotId === speaker\.botId\) \{\s*memoryPass\.onSettled\(speaker\.botId, event\.threadId\);\s*settledGroupSpeakers\.set/);
  });

  it("reads the Settings switch live and drops pending notes on a config change", () => {
    expect(index).toMatch(/createMemoryPass\(\{[\s\S]*?enabled: memoryJobEnabled,/);
    expect(index).toMatch(/saveConfig\(patch\);[\s\S]*?Object\.assign\(cfg, loadConfig\(\)\);\s*\}\s*if \(\(cfg\.profile[^\n]*\n\s*memoryPass\.onConfigChanged\(\);/);
    expect(index).toContain("memoryNotes: memoryNotesEnabled(cfg),");
  });

  it("saves and syncs the switch on the bot record", () => {
    expect(bots).toContain("patch.memoryNotes = body.memoryNotes;");
    expect(index).toContain("memoryNotes: bot.memoryNotes ?? null,");
    expect(index).toContain('if ("memoryNotes" in apply) patch.memoryNotes = typeof apply.memoryNotes === "boolean" ? apply.memoryNotes : undefined;');
    expect(index).toContain("ownOpSyncChanges(compatibleSyncChanges(synced, unsynced))");
  });

  it("takes notes only for engines that load MEMORY.md", () => {
    expect(index).toMatch(
      /const memoryJobEnabled = \(botId: string\) => \{\s*const bot = store\.bot\(botId\);\s*const instance = bot && registry\.get\(bot\.modelSelection\.instanceId\);\s*return Boolean\(instance && supportsWorkspaceFiles\(instance\.driverKind\)\) && memoryNotesEnabled\(cfg, bot\);/,
    );
  });

  it("loads only the pending rows, never a Map of the whole thread", () => {
    const source = readFileSync(join(here, "memory-pass.ts"), "utf8");
    expect(source.replace(/\r\n/g, "\n")).toContain("const messages = deps.store.messagesFor(sourceThread(threadId));\n    const rows = pendingRows(messages, ids);");
    expect(source).not.toMatch(/new Map\(deps\.store\.messagesFor/);
  });
});
