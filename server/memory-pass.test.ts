import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { memoryNotice } from "./memory-health.ts";
import { createMemoryLookup } from "./memory-lookup.ts";
import { MEMORY_SAVE_TOOL } from "./memory-save.ts";
import { replyTurns } from "./pick-sources.ts";
import type { Message, StoreChange } from "./store.ts";
import { MEMORY_MAX_BYTES, MEMORY_SEED, memoryFileRaw, memorySystemPrompt, readMemoryTopic, workspaceDir, writeMemoryFile } from "./workspace.ts";
import { createTempDirs } from "./testing/cleanup.ts";

// oxlint-disable-next-line anti-slop/no-module-mocking -- a second writer has to land between the pass's read and its write.
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

const temps = createTempDirs();
afterAll(() => temps.remove());

const MINUTE = 60_000;
const NOW = new Date(2026, 9, 15, 12).getTime();
const readBytes = fs.readFileSync;

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
  const overflowPath = () => join(workspaceDir("bot-t1"), "memory", "auto-notes-overflow.md");
  const overflowBytes = () => {
    const path = overflowPath();
    return fs.statSync(path, { throwIfNoEntry: false })?.isFile() ? readBytes(path) : Buffer.alloc(0);
  };
  const idle = async (before: Buffer) => {
    await pass.idle();
    expect(overflowBytes().subarray(0, before.length).equals(before)).toBe(true);
  };
  const settle = async (threadId: string, wait = 0) => {
    const before = overflowBytes();
    pass.onSettled(`bot-${threadId}`, threadId);
    if (wait) await vi.advanceTimersByTimeAsync(wait);
    await idle(before);
  };
  const chips = (threadId: string) => store.rows(threadId).filter((m) => m.tool?.name === MEMORY_SAVE_TOOL);
  const stored = () => JSON.parse(readFileSync(join(dataDir, "memory-pass.json"), "utf8"));
  const overflow = () => (existsSync(overflowPath()) ? readFileSync(overflowPath(), "utf8") : null);
  const lockMemoryOnce = () => {
    const path = join(workspaceDir("bot-t1"), "MEMORY.md");
    const open = fs.openSync;
    let failed = false;
    // SAFETY: the wrapper passes every other call through and returns the real descriptor.
    vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof open>) => {
      if (!failed && args[0] === path) {
        failed = true;
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      }
      return open(...args);
    }) as typeof open);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  };
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
    rmSync(join(workspaceDir("bot-t1"), "memory"), { recursive: true, force: true });
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
      say("t1", "I prefer pnpm", { sendId: "source-send" });
      await settle("t1", 3 * MINUTE);
      busy.clear();
      await settle("t1");
      expect(generate).toHaveBeenCalledTimes(1);
      const traces = readFileSync(join(dataDir, "turn-traces.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({ botId: "bot-t1", threadId: "t1", sourceSendIds: ["source-send"], requests: [{ id: "request-1", usage: { input: 20, output: 2 }, nested: false }] });
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

  it("saves notes a MEMORY.md at its limit turns away to the overflow file", async () => {
    const full = `# Memory\n${"- note\n".repeat(198)}`;
    writeMemoryFile("bot-t1", full);
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"], ["Can't read Korean", "can't read korean"]));
    say("t1", "i'm 38, can't read korean");
    await settle("t1", 3 * MINUTE);
    const pointer = "- memory/auto-notes-overflow.md: Auto Notes saved while this file was full; read it when a fact seems missing (noted 2026-10-15)";
    expect(memoryFileRaw("bot-t1")).toBe(`${full}${pointer}`);
    expect(memorySystemPrompt("bot-t1")).toContain(`${pointer}`);
    expect(memorySystemPrompt("bot-t1")).not.toContain("cut off");
    expect(overflow()).toBe(`# Auto notes overflow\n\nAuto Notes saved here while MEMORY.md was full.\n\n- 38 years old (noted 2026-10-15)\n- Can't read Korean (noted 2026-10-15)\n`);
    expect(chips("t1").map((m) => m.tool?.spoken)).toEqual(["38 years old, Can't read Korean (MEMORY.md is full, saved in memory/auto-notes-overflow.md)"]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("too-large"));
  });

  it("adds one pointer line to the overflow file when it fits, and appends to the file after", async () => {
    const full = `# Memory\n${"- note\n".repeat(197)}`;
    writeMemoryFile("bot-t1", full);
    generate.mockResolvedValueOnce(facts(["38 years old", "i'm 38"], ["Can't read Korean", "can't read korean"]));
    say("t1", "i'm 38, can't read korean");
    await settle("t1", 3 * MINUTE);
    const pointed = `${full}- memory/auto-notes-overflow.md: Auto Notes saved while this file was full; read it when a fact seems missing (noted 2026-10-15)\n`;
    expect(memoryFileRaw("bot-t1")).toBe(pointed);

    generate.mockResolvedValueOnce(facts(["Likes tea", "i like tea"]));
    say("t1", "i like tea");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(pointed);
    expect(overflow()).toBe(`# Auto notes overflow\n\nAuto Notes saved here while MEMORY.md was full.\n\n- 38 years old (noted 2026-10-15)\n- Can't read Korean (noted 2026-10-15)\n- Likes tea (noted 2026-10-15)\n`);
    expect(chips("t1")).toHaveLength(2);
  });

  it("counts an overflowed note once when its pointer save conflicts and lands on retry", async () => {
    const full = `# Memory\n${"- note\n".repeat(197)}`;
    writeMemoryFile("bot-t1", full);
    generate.mockImplementationOnce(async () => {
      writeMemoryFile("bot-t1", `${full}- edited meanwhile\n`);
      return facts(["38 years old", "i'm 38"], ["Likes tea", "i like tea"]);
    });
    say("t1", "i'm 38, i like tea");
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`# Auto notes overflow\n\nAuto Notes saved here while MEMORY.md was full.\n\n- 38 years old (noted 2026-10-15)\n- Likes tea (noted 2026-10-15)\n`);
    expect(pass.droppedNotes("bot-t1")).toEqual({ dropped: 2, since: NOW + 3 * MINUTE });
    await settle("t1");
    expect(overflow()).toBe(`# Auto notes overflow\n\nAuto Notes saved here while MEMORY.md was full.\n\n- 38 years old (noted 2026-10-15)\n- Likes tea (noted 2026-10-15)\n`);
    expect(pass.droppedNotes("bot-t1")).toEqual({ dropped: 2, since: NOW + 3 * MINUTE });
  });

  it("never writes an overflow note twice when its retry finds a later note on its subject", async () => {
    const full = `# Memory\n${"- note\n".repeat(197)}`;
    writeMemoryFile("bot-t1", full);
    generate.mockImplementationOnce(async () => {
      writeMemoryFile("bot-t1", `${full}- edited meanwhile\n`);
      return facts(["Lives in Toronto", "i live in Toronto"], ["Likes tea", "i like tea"]);
    });
    say("t1", "i live in Toronto, i like tea");
    await settle("t1", 3 * MINUTE);
    fs.appendFileSync(overflowPath(), "- Lives in Vancouver (noted 2026-10-15)\n");
    await settle("t1");
    expect(overflow()?.split("\n").filter((row) => row.startsWith("- Lives in"))).toEqual(["- Lives in Toronto (noted 2026-10-15)", "- Lives in Vancouver (noted 2026-10-15)"]);
    expect(chips("t1")).toHaveLength(1);
  });

  it("writes a repeated note to the overflow file once, with one chip", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"]));
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(overflow()).toBe(`# Auto notes overflow\n\nAuto Notes saved here while MEMORY.md was full.\n\n- 38 years old (noted 2026-10-15)\n`);
    expect(pass.droppedNotes("bot-t1")?.dropped).toBe(1);
    expect(chips("t1")).toHaveLength(1);
  });

  it("holds the batch when the overflow file cannot be read, never rewriting it", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(overflowPath(), { recursive: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"]));
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    expect(chips("t1")).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("auto-notes-overflow.md write failed"));
    rmSync(overflowPath(), { recursive: true });
    writeFileSync(overflowPath(), "# Overflow\n- Uses pnpm\n");
    await settle("t1");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(overflow()).toBe("# Overflow\n- Uses pnpm\n- 38 years old (noted 2026-10-15)\n");
  });

  it("appends to an overflow file the bot already keeps", async () => {
    const full = `# Memory\n- memory/auto-notes-overflow.md: overflow notes\n${"- note\n".repeat(197)}`;
    writeMemoryFile("bot-t1", full);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    writeFileSync(overflowPath(), "# Overflow\n- Uses pnpm\n");
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"]));
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(full);
    expect(overflow()).toBe("# Overflow\n- Uses pnpm\n- 38 years old (noted 2026-10-15)\n");
  });

  it("keeps a note another writer adds to the overflow file while the pass saves its own", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    writeFileSync(overflowPath(), "# Existing notebook\n");
    const read = fs.readFileSync;
    // SAFETY: the wrapper passes every argument through and returns the real read.
    vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof read>) => {
      const out = read(...args);
      if (args[0] === overflowPath()) execFileSync(process.execPath, ["-e", "require('node:fs').appendFileSync(process.argv[1], '- Uses cobalt blue\\n')", overflowPath()], { windowsHide: true });
      return out;
    }) as typeof read);
    generate.mockResolvedValue(facts(["Likes tea", "i like tea"]));
    say("t1", "i like tea");
    await settle("t1", 3 * MINUTE);
    vi.mocked(fs.readFileSync).mockRestore();
    expect(overflow()).toBe("# Existing notebook\n- Uses cobalt blue\n- Likes tea (noted 2026-10-15)\n");
  });

  it("saves a fact that an overflow line names only inside a retraction", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    writeFileSync(overflowPath(), "# History\n- Retracted: ~~ - Likes tea (noted 2020-01-01) ~~\n- ~~Likes tea (noted 2020-01-02)~~\n");
    generate.mockResolvedValue(facts(["Likes tea", "i like tea"]));
    say("t1", "i like tea");
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe("# History\n- Retracted: ~~ - Likes tea (noted 2020-01-01) ~~\n- ~~Likes tea (noted 2020-01-02)~~\n- Likes tea (noted 2026-10-15)\n");
    expect(pass.droppedNotes("bot-t1")?.dropped).toBe(1);
  });

  it("keeps a line another writer adds to MEMORY.md after the revision check of its overflow pointer", async () => {
    const full = `# Memory\n${"- note\n".repeat(198)}`;
    writeMemoryFile("bot-t1", full);
    const path = join(workspaceDir("bot-t1"), "MEMORY.md");
    const open = fs.openSync;
    let landed = false;
    // SAFETY: the wrapper passes every argument through and returns the real descriptor.
    vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof open>) => {
      // lands after the revision check, just before the pointer reaches MEMORY.md
      if (!landed && args[0] === path) {
        execFileSync(process.execPath, ["-e", "require('node:fs').appendFileSync(process.argv[1], '- Cobalt preference\\n')", path], { windowsHide: true });
        landed = true;
      }
      return open(...args);
    }) as typeof open);
    generate.mockResolvedValue(facts(["Likes tea", "i like tea"]));
    say("t1", "i like tea");
    await settle("t1", 3 * MINUTE);
    vi.mocked(fs.openSync).mockRestore();
    expect(landed).toBe(true);
    expect(memoryFileRaw("bot-t1")).toBe(`${full}- Cobalt preference\n- memory/auto-notes-overflow.md: Auto Notes saved while this file was full; read it when a fact seems missing (noted 2026-10-15)`);
    expect(overflow()).toContain("- Likes tea (noted 2026-10-15)");
  });

  it("saves a fact that an overflow line names only inside a comment or code block", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const retired = "# Notebook\n<!-- Retired\n* Likes tea (noted 2020-01-01)\n-->\n```\n- Uses pnpm (noted 2020-01-02)\n```\n";
    writeFileSync(overflowPath(), retired);
    generate.mockResolvedValue(facts(["Likes tea", "i like tea"], ["Uses pnpm", "i use pnpm"]));
    say("t1", "i like tea, i use pnpm");
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`${retired}- Likes tea (noted 2026-10-15)\n- Uses pnpm (noted 2026-10-15)\n`);
    expect(pass.droppedNotes("bot-t1")?.dropped).toBe(2);
  });

  it("saves a fact that an overflow line names only in an indented code example", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const examples = "# Notebook\n\nExample:\n\n    - Likes tea (noted 2026-10-14) <!-- example only -->\n    - Uses pnpm (noted 2026-10-14)\n";
    writeFileSync(overflowPath(), examples);
    generate.mockResolvedValue(facts(["Likes tea", "i like tea"], ["Uses pnpm", "i use pnpm"]));
    say("t1", "i like tea, i use pnpm");
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`${examples}- Likes tea (noted 2026-10-15)\n- Uses pnpm (noted 2026-10-15)\n`);
    expect(chips("t1")).toHaveLength(1);
  });

  it.each(["pre", "details"])("appends a live note while preserving a hand-written %s example", async (tag) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const notes = `# Notebook\n\n<${tag}>\n- Likes tea (noted 2026-10-14)\n</${tag}>\n- Likes coffee\n`;
    writeFileSync(overflowPath(), notes);
    generate.mockResolvedValue(facts(["Likes tea", "i like tea"]));
    say("t1", "i like tea");
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`${notes}- Likes tea (noted 2026-10-15)\n`);
    expect(chips("t1")).toHaveLength(1);
  });

  it("still knows the notes after a literal comment opener in an overflow line", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const notes = "# Notebook\n- Opens comments with `<!--` in templates (noted 2026-10-14)\n- Writes <!-- by hand in notes (noted 2026-10-14)\n- Likes tea (noted 2026-10-14)\n- North office is in building 4 (noted 2026-10-14)\n";
    writeFileSync(overflowPath(), notes);
    generate.mockResolvedValue(facts(["Likes tea", "i like tea"]));
    for (let turn = 0; turn < 3; turn++) {
      say("t1", "i like tea");
      await settle("t1", 3 * MINUTE);
    }
    expect(generate).toHaveBeenCalledTimes(3);
    expect(overflow()).toBe(`${notes}- Likes tea (noted 2026-10-15)\n`);
    expect(chips("t1")).toHaveLength(1);
    expect(pass.droppedNotes("bot-t1")?.dropped).toBe(1);
  });

  it.each([
    ["an open comment", "<!-- draft\n- idea\n", "-->\n"],
    ["an open fence", "```\nexample output\n", "```\n"],
    ["a nested detail", "- Allergic to nuts (noted 2026-10-13)\n  - Carries an EpiPen in the blue bag\n- Owns a kayak\n", ""],
    ["two headings", "## Mina\n- Allergic to nuts (noted 2026-10-13)\n## Sam\n- Allergic to nuts (noted 2026-10-14)\n- Owns a kayak\n", ""],
  ])("leaves an overflow note in place with %s and adds the repeat after it", async (_kind, tail, close) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const notes = `# Notebook\n- Allergic to nuts (noted 2026-10-12)\n- Likes coffee\n${tail}`;
    writeFileSync(overflowPath(), notes);
    generate.mockResolvedValue(facts(["Allergic to nuts", "i am allergic to nuts"]));
    say("t1", "i am allergic to nuts");
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`${notes}${close}- Allergic to nuts (noted 2026-10-15)\n`);
    expect(chips("t1")).toHaveLength(1);
  });
  it("reads a line of inline code in an overflow file as text, not a fence", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const notes = "# Notebook\n- Likes tea (noted 2026-10-01)\n```js``` is how i write code\n- Owns a kayak (noted 2026-10-03)\n";
    writeFileSync(overflowPath(), notes);
    const turns: Array<[string, string]> = [["Owns a kayak", "i own a kayak"], ["Plays the cello", "i play the cello"]];
    for (const [fact, quote] of turns) {
      generate.mockResolvedValue(facts([fact, quote]));
      say("t1", quote);
      await settle("t1", 3 * MINUTE);
    }
    expect(overflow()).toBe(`${notes}- Plays the cello (noted 2026-10-15)\n`);
  });


  it("keeps an old overflow note reachable in a file past the lookup budget", async () => {
    writeMemoryFile("bot-t1", `# Memory\n- memory/auto-notes-overflow.md: prior pointer\n${"- note\n".repeat(197)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const fact = "COBALT WALRUS invoice goes to the north office";
    const notes = `# Notebook\n- ${fact} (noted 2026-10-01)\n- Likes coffee\n`.padEnd(2 * 1024 * 1024 + 4096, " ");
    writeFileSync(overflowPath(), notes);
    writeFileSync(join(dataDir, "lookup-bots.json"), JSON.stringify(["bot-t1"]));
    const lookup = createMemoryLookup({ dataDir, notesPath: () => undefined, clock: () => 0 });
    const recall = async (cursor: string) => {
      await lookup.refresh("bot-t1");
      return lookup.take("bot-t1", "t1", cursor, "cobalt walrus").join("");
    };
    expect(await recall("before")).toContain("north office");
    generate.mockResolvedValue(facts([fact, fact.toLowerCase()]));
    say("t1", fact.toLowerCase());
    await settle("t1", 3 * MINUTE);
    expect(await recall("after")).toContain("north office");
    expect(overflow()).toBe(`${notes}\n- ${fact} (noted 2026-10-15)\n`);
    expect(chips("t1")).toHaveLength(1);
  });

  it.each([
    ["another memory file", `# Memory\n${"- note\n".repeat(198)}`, "- Home city: Vancouver (noted 2026-10-10)\n"],
    ["a table row in another file", `# Memory\n${"- note\n".repeat(198)}`, "| Home city | Vancouver (noted 2026-10-10) |\n"],
    ["a plain line in another file", `# Memory\n${"- note\n".repeat(198)}`, "Home city: Vancouver (noted 2026-10-10)\n"],
    ["MEMORY.md past the cut", `# Memory\n${"- note\n".repeat(199)}- Home city: Vancouver (noted 2026-10-10)\n`, ""],
  ])("saves a value said again when %s holds a later one", async (_kind, memory, places) => {
    writeMemoryFile("bot-t1", memory);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    writeFileSync(overflowPath(), "# Notebook\n- Home city: Toronto (noted 2026-10-01)\n");
    if (places) writeFileSync(join(dirname(overflowPath()), "places.md"), `# Places\n${places}`);
    generate.mockResolvedValue(facts(["Home city: Toronto", "i moved back to Toronto"]));
    say("t1", "i moved back to Toronto");
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe("# Notebook\n- Home city: Toronto (noted 2026-10-01)\n- Home city: Toronto (noted 2026-10-15)\n");
    expect(chips("t1")).toHaveLength(1);
  });

  it("saves a value an overflow file had before a later correction as the latest", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const moves = "# Notebook\n- Home city: Toronto (noted 2026-10-01)\n- Lives in Toronto (noted 2026-10-01)\n- Home city: Vancouver (noted 2026-10-10)\n- Lives in Vancouver (noted 2026-10-10)\n- Likes tea (noted 2026-10-11)\n";
    writeFileSync(overflowPath(), moves);
    generate.mockResolvedValue(facts(["Home city: Toronto", "i moved back to Toronto"], ["Lives in Toronto", "back to Toronto"], ["Likes tea", "i like tea"]));
    say("t1", "i moved back to Toronto, i like tea");
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`${moves}- Home city: Toronto (noted 2026-10-15)\n- Lives in Toronto (noted 2026-10-15)\n- Likes tea (noted 2026-10-15)\n`);
  });

  it("saves a return to a multiword city after a one-word city as the latest", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    for (const city of ["New York", "Boston", "New York"]) {
      generate.mockResolvedValue(facts([`Lives in ${city}`, `i now live in ${city}`]));
      say("t1", `i now live in ${city}`);
      await settle("t1", 3 * MINUTE);
    }
    expect(overflow()?.split("\n").filter((row) => row.startsWith("- Lives in"))).toEqual([
      "- Lives in New York (noted 2026-10-15)",
      "- Lives in Boston (noted 2026-10-15)",
      "- Lives in New York (noted 2026-10-15)",
    ]);
  });

  it.each([
    ["Uses pnpm", "Uses npm"],
    ["Prefers dark mode", "Prefers light mode"],
    ["Favorite color blue", "Favorite color red"],
    ["Moved to Toronto", "Moved to Vancouver"],
    ["38 years old", "39 years old"],
    ["Drinks oat milk", "Drinks soy milk"],
    ["Lives in Toronto", "Moved to Vancouver"],
    ["Uses pnpm", "Switched to npm"],
    ["On macOS", "On Linux"],
    ["Has a cat", "Has a dog"],
    ["Vegetarian", "Eats meat again"],
    ["Uses dark mode", "Switched to light theme"],
    ["Single", "Married to Sam"],
    ["Timezone is PST", "Now in EST"],
  ])("saves a return to %s after %s as the latest, with a chip for each", async (a, b) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    for (const fact of [a, b, a]) {
      generate.mockResolvedValue(facts([fact, `ok so now ${fact.toLowerCase()}`]));
      say("t1", `ok so now ${fact.toLowerCase()}`);
      await settle("t1", 3 * MINUTE);
    }
    expect(overflow()?.split("\n").filter((row) => row.startsWith("- "))).toEqual([a, b, a].map((fact) => `- ${fact} (noted 2026-10-15)`));
    expect(chips("t1")).toHaveLength(3);
  });

  it.each([
    ["Uses pnpm", "Uses npm"],
    ["Lives in Toronto", "Lives in Vancouver"],
    ["Home city: Toronto", "Home city: Vancouver"],
  ])("saves a return to %s said in one batch after %s as the latest", async (a, b) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    generate.mockResolvedValue(facts([a, `ok so now ${a.toLowerCase()}`]));
    say("t1", `ok so now ${a.toLowerCase()}`);
    await settle("t1", 3 * MINUTE);
    generate.mockResolvedValue(facts([b, `ok so now ${b.toLowerCase()}`], [a, `no wait back to ${a.toLowerCase()}`]));
    say("t1", `ok so now ${b.toLowerCase()}`);
    say("t1", `no wait back to ${a.toLowerCase()}`);
    await settle("t1", 3 * MINUTE);
    expect(overflow()?.split("\n").filter((row) => row.startsWith("- "))).toEqual([a, b, a].map((fact) => `- ${fact} (noted 2026-10-15)`));
    expect(chips("t1")).toHaveLength(2);
  });

  it("saves a return after a hand-written row with no date as the latest", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    generate.mockResolvedValue(facts(["Uses pnpm", "i use pnpm"]));
    say("t1", "i use pnpm");
    await settle("t1", 3 * MINUTE);
    fs.appendFileSync(overflowPath(), "- Uses npm\n");
    say("t1", "no wait i use pnpm");
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe("# Auto notes overflow\n\nAuto Notes saved here while MEMORY.md was full.\n\n- Uses pnpm (noted 2026-10-15)\n- Uses npm\n- Uses pnpm (noted 2026-10-15)\n");
    expect(chips("t1")).toHaveLength(2);
  });
  it.each([
    ["Works at Acme", "i work at acme", "Works at Globex", "i work at globex", "i work at acme again"],
    ["Drives a Honda", "i drive a honda", "Drives a Tesla", "i drive a tesla", "i drive a honda again"],
    ["Uses Chrome", "i use chrome", "Uses Firefox", "i use firefox", "i use chrome again"],
    ["Lives in seoul", "i live in seoul", "Lives in busan", "i live in busan", "i live in seoul again"],
    ["Lives in Toronto, Canada", "i live in toronto, canada", "Lives in Vancouver, Canada", "i live in vancouver, canada", "back in toronto, canada"],
    ["서울에 산다", "서울에 산다", "부산에 산다", "부산에 산다", "다시 서울에 산다"],
    ["Favorite editor is Vim", "my favorite editor is vim", "Favorite editor is Emacs", "my favorite editor is emacs", "my favorite editor is vim after all"],
    ["Phone is an iPhone", "my phone is an iphone", "Phone is a Pixel", "my phone is a pixel", "my phone is an iphone again"],
    ["Is vegetarian", "i am vegetarian", "Eats meat", "i eat meat", "i am vegetarian again"],
    ["Uses Python 3.11", "i use python 3.11", "Uses Python 3.12", "i use python 3.12", "i use python 3.11 again"],
    ["Wakes up at 6am", "i wake up at 6am", "Wakes up at 9am", "i wake up at 9am", "i wake up at 6am again"],
    ["Uses pnpm for work projects", "i use pnpm for work projects", "Uses npm for work projects", "i use npm for work projects", "i use pnpm for work projects again"],
    ["Manager is Dana", "my manager is dana", "Manager is Lee", "my manager is lee", "my manager is dana again"],
    ["Prefers tabs", "i prefer tabs", "Prefers spaces", "i prefer spaces", "i prefer tabs after all"],
    ["Based in Toronto", "i am based in toronto", "Based in Vancouver", "i am based in vancouver", "i am based in toronto again"],
    ["Is 38", "i am 38", "Is 39", "i am 39", "sorry i am 38"],
    ["Subscribed to the Pro plan", "i am on the pro plan", "Subscribed to the Max plan", "i am on the max plan", "i am on the pro plan again"],
    ["Team standup is at 9", "standup is at 9", "Team standup is at 10", "standup is at 10", "standup is at 9 again"],
    ["Has a cat", "i have a cat", "Has a dog", "i have a dog", "sorry i meant i have a cat"],
    ["Drinks oat milk", "i drink oat milk", "Drinks soy milk", "i drink soy milk", "i drink oat milk these days"],
  ])("saves a return to %s (%s) after %s as the latest, in any wording", async (a, said, b, saidB, again) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    const turns: Array<[string, string]> = [[a, said], [b, saidB], [a, again]];
    for (const [fact, quote] of turns) {
      generate.mockResolvedValue(facts([fact, quote]));
      say("t1", quote);
      await settle("t1", 3 * MINUTE);
    }
    expect(overflow()?.split("\n").filter((row) => row.startsWith("- "))).toEqual([a, b, a].map((fact) => `- ${fact} (noted 2026-10-15)`));
    expect(chips("t1")).toHaveLength(3);
  });

  it("keeps what was said last as the newest overflow row in any script, through a held batch and a restart, recalls the newest-dated copy in any file order, and a plain repeat changes nothing", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    // seeded, so a failing run replays
    let seed = 1991;
    const pick = (n: number) => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % n;
    };
    const scripts = ["abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789", ".,;:!?'\"()&%#@/=_"];
    const glyph = (script: number) => {
      const letters = scripts[script];
      return letters ? letters[pick(letters.length)]! : String.fromCodePoint(0xac00 + pick(11_172));
    };
    const word = () => {
      const script = pick(4);
      return Array.from({ length: 2 + pick(5) }, () => glyph(script)).join("");
    };
    const said: string[] = [];
    const value = (): string => {
      const text = said.length && !pick(4) ? said[pick(said.length)]! : Array.from({ length: 2 + pick(3) }, word).join(" ");
      if (acceptFacts([{ fact: text, quote: text }], text, memoryFileRaw("bot-t1")).length !== 1) return value();
      if (!said.includes(text)) said.push(text);
      return text;
    };
    // the model says back what each message said, and may word a held one another way when asked again
    const reworded = new Map<string, string>();
    generate.mockImplementation(async (prompt) => facts(...[...prompt.matchAll(/message_id="([^"]+)"/g)].map(([, id]): [string, string] => {
      const text = store.rows("t1").find((message) => message.id === id)!.text!;
      return [reworded.get(id!) ?? text, text];
    })));
    const tell = async (...lines: string[]) => {
      for (const line of lines) say("t1", line);
      await settle("t1", 3 * MINUTE);
    };
    const newest = () => overflow()?.trimEnd().split("\n").at(-1)?.replace(/ \(noted \d{4}-\d{2}-\d{2}\)$/, "");
    const rows = () => (overflow() ?? "").split("\n").filter((row) => row.startsWith("- ")).map((row) => row.slice(2).replace(/ \(noted \d{4}-\d{2}-\d{2}\)$/, ""));
    writeFileSync(join(dataDir, "lookup-bots.json"), JSON.stringify(["bot-log"]));
    const lookup = createMemoryLookup({ dataDir, notesPath: () => undefined, clock: () => 0 });
    const log = join(workspaceDir("bot-log"), "memory", "log.md");
    mkdirSync(dirname(log), { recursive: true });
    for (let run = 0; run < 100; run++) {
      const a = value();
      let b = value();
      while (b === a) b = value();
      if (overflow() !== null && !pick(8)) fs.appendFileSync(overflowPath(), ["<!-- draft\n", "```\n", "<details>\n"][pick(3)]!);
      await tell(a);
      if (pick(3)) {
        await tell(b);
        await tell(a);
      } else {
        await tell(b, a);
      }
      expect(newest(), `run ${run}: ${a} then ${b} then ${a}`).toBe(`- ${a}`);
      const text = overflow();
      const saved = chips("t1").length;
      const count = pass.droppedNotes("bot-t1");
      const calls = generate.mock.calls.length;
      await tell(a);
      expect(generate).toHaveBeenCalledTimes(calls + 1);
      expect(overflow(), `run ${run}: ${a} again`).toBe(text);
      expect(chips("t1")).toHaveLength(saved);
      expect(pass.droppedNotes("bot-t1")).toEqual(count);
      // held after its overflow step, then the other PC's older copy of the file or another writer's row, and the same chat again, with a restart anywhere
      const c = pick(2) ? a : value();
      writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
      const prior = overflow()!;
      const newestWhenSaid = rows().at(-1);
      lockMemoryOnce();
      await tell(c);
      const heldDay = / \(noted (\d{4}-\d{2}-\d{2})\)$/.exec(overflow()!.trimEnd().split("\n").at(-1)!)?.[1];
      vi.mocked(fs.openSync).mockRestore();
      const asked = generate.mock.calls.length;
      const restartAt = pick(5);
      const restart = (at: number) => {
        if (restartAt !== at) return;
        pass.dispose();
        pass = start();
      };
      restart(1);
      if (pick(2)) reworded.set(store.rows("t1").findLast((message) => message.role === "user")!.id, [`${c}.`, `User ${c}`, `${c} too`][pick(3)]!);
      let other = value();
      while (other === c) other = value();
      const swap = pick(3);
      if (swap) writeFileSync(overflowPath(), `${prior}${swap === 2 ? `- ${other} (noted 2026-10-15)\n` : ""}`);
      else if (pick(2)) fs.appendFileSync(overflowPath(), `- ${other} (noted 2026-10-15)\n`);
      restart(2);
      const later = [undefined, c, value()][pick(3)];
      if (later !== undefined) say("t1", later);
      restart(3);
      // a row the older copy dropped is written again, unless it was the newest row already when said or a row in its words from that day is still there
      const twin = swap && prior.split("\n").includes(`- ${c} (noted ${heldDay})`);
      const before = swap && newestWhenSaid !== c && !twin ? [...rows(), c] : rows();
      await settle("t1", 3 * MINUTE);
      restart(4);
      await settle("t1", 3 * MINUTE);
      const want = later === undefined || later === before.at(-1) ? before : [...before, later];
      expect(rows(), `run ${run}: ${c} held, then ${["no swap", "older copy", `older copy and ${other}`][swap]} and ${later}, restart ${restartAt}`).toEqual(want);
      expect(newest()).toBe(`- ${want.at(-1)}`);
      expect(rows()).toContain(c);
      expect(generate).toHaveBeenCalledTimes(asked + (later === undefined ? 0 : 1));
      expect(stored().held).toBeUndefined();
      // a hand-kept log keeps copies of a note in any order
      const key = Array.from({ length: 2 }, () => Array.from({ length: 6 }, () => glyph(0)).join("")).join(" ");
      const dates = Array.from({ length: 2 + pick(3) }, () => `2026-0${1 + pick(9)}-${10 + pick(19)}`);
      const copies = [...dates.map((date) => `- ${key} ${a} (noted ${date})`), ...said.slice(-3).map((note) => `- ${note}`)];
      for (let at = copies.length - 1; at > 0; at--) {
        const swap = pick(at + 1);
        [copies[at], copies[swap]] = [copies[swap]!, copies[at]!];
      }
      writeFileSync(log, `# Log\n${copies.join("\n")}\n`);
      await lookup.refresh("bot-log");
      const answer = lookup.take("bot-log", "t1", run, key).join("\n");
      const latest = dates.reduce((top, date) => (date > top ? date : top));
      expect([...new Set(dates)].filter((date) => answer.includes(`(noted ${date})`)), `run ${run}: ${copies.join(" | ")}`).toEqual([latest]);
    }
  }, 120_000);


  it.each([
    ["Likes tea", "Likes coffee"],
    ["Works at Acme", "Works at night"],
    ["Lives in Toronto", "Lives in a condo"],
  ])("adds one dated row for %s said again after %s, and recall keeps the overflow topic", async (a, b) => {
    writeMemoryFile("bot-t1", `# Memory\n- memory/auto-notes-overflow.md: prior pointer\n${"- note\n".repeat(197)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const fillers = Array.from({ length: 120 }, (_, i) => `- filler kettle${i} harbor${i} lantern${i}\n`).join("");
    // eight bytes under the lookup budget, so the new dated row takes the file past it
    const notes = `# Notebook\n\n- ${a} (noted 2026-10-01)\n- ${b} (noted 2026-10-02)\n- COBALT WALRUS: invoice goes to the north office\n${fillers}`
      .padEnd(2 * 1024 * 1024 - Buffer.byteLength(memoryFileRaw("bot-t1")) - 8, " ");
    writeFileSync(overflowPath(), notes);
    writeFileSync(join(dataDir, "lookup-bots.json"), JSON.stringify(["bot-t1"]));
    const lookup = createMemoryLookup({ dataDir, notesPath: () => undefined, clock: () => 0 });
    const recalled = async (cursor: string) => {
      await lookup.refresh("bot-t1");
      return lookup.take("bot-t1", "t1", cursor, "cobalt walrus").join("").includes("north office");
    };
    expect(await recalled("before")).toBe(true);
    generate.mockResolvedValue(facts([a, `ok so now ${a.toLowerCase()}`]));
    say("t1", `ok so now ${a.toLowerCase()}`);
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`${notes}\n- ${a} (noted 2026-10-15)\n`);
    expect(chips("t1")).toHaveLength(1);
    expect(pass.droppedNotes("bot-t1")?.dropped).toBe(1);
    expect(await recalled("after")).toBe(true);
  });
  it.each([0, 20, 45, 60, 120])("recalls a note the user returned to in an overflow file with %i other rows", async (count) => {
    writeMemoryFile("bot-t1", `# Memory\n- memory/auto-notes-overflow.md: prior pointer\n${"- note\n".repeat(197)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const fillers = Array.from({ length: count }, (_, i) => `- Filler fact about topic${i} and subject${i} (noted 2026-09-01)\n`).join("");
    writeFileSync(overflowPath(), `# Notebook\n${fillers}- Likes tea (noted 2026-10-01)\n- Uses pnpm (noted 2026-10-01)\n- Uses npm (noted 2026-10-02)\n- Owns a kayak (noted 2026-10-03)\n`);
    writeFileSync(join(dataDir, "lookup-bots.json"), JSON.stringify(["bot-t1"]));
    const lookup = createMemoryLookup({ dataDir, notesPath: () => undefined, clock: () => 0 });
    const recall = async (cursor: string) => {
      await lookup.refresh("bot-t1");
      return lookup.take("bot-t1", "t1", cursor, "uses pnpm").join("");
    };
    expect(await recall("before")).toContain("Uses pnpm");
    generate.mockResolvedValue(facts(["Uses pnpm", "ok so now i use pnpm"]));
    say("t1", "ok so now i use pnpm");
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toMatch(/- Uses pnpm \(noted 2026-10-15\)\n$/);
    expect(await recall("after")).toContain("Uses pnpm");
  });

  it("recalls the value the user flipped back to ten times", async () => {
    writeMemoryFile("bot-t1", `# Memory\n- memory/auto-notes-overflow.md: prior pointer\n${"- note\n".repeat(197)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const fillers = Array.from({ length: 60 }, (_, i) => `- Filler fact about topic${i} and subject${i} (noted 2026-09-01)\n`).join("");
    writeFileSync(overflowPath(), `# Notebook\n${fillers}- Uses macOS (noted 2026-10-01)\n`);
    writeFileSync(join(dataDir, "lookup-bots.json"), JSON.stringify(["bot-t1"]));
    const lookup = createMemoryLookup({ dataDir, notesPath: () => undefined, clock: () => 0 });
    const recall = async (cursor: string) => {
      await lookup.refresh("bot-t1");
      return lookup.take("bot-t1", "t1", cursor, "uses macos").join("");
    };
    expect(await recall("before")).toContain("Uses macOS");
    for (let flip = 0; flip < 20; flip++) {
      const system = flip % 2 ? "macOS" : "Windows";
      generate.mockResolvedValue(facts([`Uses ${system}`, `ok so now i use ${system.toLowerCase()}`]));
      say("t1", `ok so now i use ${system.toLowerCase()}`);
      await settle("t1", 3 * MINUTE);
    }
    expect(overflow()?.split("\n").filter((row) => /^- Uses (?:macOS|Windows) /.test(row))).toHaveLength(21);
    expect(await recall("after")).toContain("Uses macOS");
  });


  it.each([
    ["Has a cat", "Has a dog", "i have a cat"],
    ["Drinks oat milk", "Drinks soy milk", "i drink oat milk"],
    ["Uses pnpm", "Uses pip", "i use pnpm"],
    ["Uses pnpm", "Switched to pnpm", "i use pnpm"],
  ])("adds a repeat of %s after %s as the newest row", async (a, b, quote) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const notes = `# Notebook\n- ${a} (noted 2026-10-01)\n- ${b} (noted 2026-10-02)\n`;
    writeFileSync(overflowPath(), notes);
    generate.mockResolvedValue(facts([a, quote]));
    say("t1", quote);
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`${notes}- ${a} (noted 2026-10-15)\n`);
    expect(chips("t1")).toHaveLength(1);
  });

  it("keeps the count of notes an older version lost when a new note overflows", async () => {
    pass.dispose();
    writeFileSync(join(dataDir, "memory-pass.json"), JSON.stringify({ threads: {}, dropped: { "bot-t1": { dropped: 2, since: NOW - 2 * 86_400_000 } } }));
    pass = start();
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    generate.mockResolvedValue(facts(["Likes tea", "i like tea"]));
    say("t1", "i like tea");
    await settle("t1", 3 * MINUTE);
    const notice = memoryNotice({ longLines: 0, orphans: [] }, pass.droppedNotes("bot-t1"));
    expect(notice).toContain("2 auto notes since 10-13 were not saved because the file is full");
    expect(notice).toContain("1 auto note since 10-15 went to memory/auto-notes-overflow.md because MEMORY.md is full");
    pass.dispose();
    expect(stored()).toEqual({ threads: {}, dropped: { "bot-t1": { dropped: 2, since: NOW - 2 * 86_400_000 } }, overflow: { "bot-t1": { dropped: 1, since: NOW + 3 * MINUTE } } });
    pass = start();
    expect(memoryNotice({ longLines: 0, orphans: [] }, pass.droppedNotes("bot-t1"))).toBe(notice);
  });

  it("retries the batch, without a second extraction, when its pointer append fails after the overflow write", async () => {
    const full = `# Memory\n${"- note\n".repeat(198)}`;
    writeMemoryFile("bot-t1", full);
    const path = join(workspaceDir("bot-t1"), "MEMORY.md");
    const open = fs.openSync;
    let failed = false;
    // SAFETY: the wrapper passes every other call through and returns the real descriptor.
    vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof open>) => {
      if (!failed && args[0] === path) {
        failed = true;
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      }
      return open(...args);
    }) as typeof open);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    generate.mockResolvedValue(facts(["Likes tea", "i like tea"]));
    say("t1", "i like tea");
    await settle("t1", 3 * MINUTE);
    expect(failed).toBe(true);
    expect(chips("t1")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    await pass.idle();
    vi.mocked(fs.openSync).mockRestore();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(memoryFileRaw("bot-t1")).toBe(`${full}- memory/auto-notes-overflow.md: Auto Notes saved while this file was full; read it when a fact seems missing (noted 2026-10-15)`);
    expect(overflow()).toBe(`# Auto notes overflow\n\nAuto Notes saved here while MEMORY.md was full.\n\n- Likes tea (noted 2026-10-15)\n`);
    expect(chips("t1")).toHaveLength(1);
  });

  it("writes a held note again when another writer removed it before the retry", async () => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Likes tea", "i like tea"]));
    say("t1", "i like tea");
    await settle("t1", 3 * MINUTE);
    expect(chips("t1")).toHaveLength(0);
    writeFileSync(overflowPath(), "# Auto notes overflow\n\n- Owns a kayak (noted 2026-10-01)\n");
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    await pass.idle();
    expect(overflow()).toBe("# Auto notes overflow\n\n- Owns a kayak (noted 2026-10-01)\n- Likes tea (noted 2026-10-15)\n");
    expect(chips("t1")).toHaveLength(1);
  });

  it.each([
    ["Uses pnpm", "Uses npm"],
    ["Lives in Toronto", "Lives in Vancouver"],
  ])("keeps the change last when a restart replays a held batch of %s then %s", async (a, b) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    lockMemoryOnce();
    generate.mockResolvedValue(facts([a, `i used to say ${a.toLowerCase()}`], [b, `ok so now ${b.toLowerCase()}`]));
    say("t1", `i used to say ${a.toLowerCase()}`);
    say("t1", `ok so now ${b.toLowerCase()}`);
    await settle("t1", 3 * MINUTE);
    pass.dispose();
    pass = start();
    await settle("t1", 3 * MINUTE);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(overflow()?.split("\n").filter((row) => row.startsWith("- "))).toEqual([a, b].map((fact) => `- ${fact} (noted 2026-10-15)`));
  });

  it.each(["Works at Acme", "Works at Acme Corp", "Employed at Acme", "works at Acme", "Works at Acme.", "User works at Acme", "nothing"])("lands a held note after a restart as it was saved, where asking again would give %s", async (again) => {
    const full = `# Memory\n${"- note\n".repeat(198)}`;
    writeMemoryFile("bot-t1", full);
    lockMemoryOnce();
    generate.mockResolvedValueOnce(facts(["Works at Acme", "my job is at acme"]));
    say("t1", "my job is at acme");
    await settle("t1", 3 * MINUTE);
    fs.appendFileSync(overflowPath(), "- Works at Globex (noted 2026-10-15)\n");
    generate.mockResolvedValue(again === "nothing" ? "[]" : facts([again, "my job is at acme"]));
    pass.dispose();
    pass = start();
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe("# Auto notes overflow\n\nAuto Notes saved here while MEMORY.md was full.\n\n- Works at Acme (noted 2026-10-15)\n- Works at Globex (noted 2026-10-15)\n");
    expect(memoryFileRaw("bot-t1")).toBe(`${full}- memory/auto-notes-overflow.md: Auto Notes saved while this file was full; read it when a fact seems missing (noted 2026-10-15)`);
    expect(chips("t1").map((m) => m.tool?.spoken)).toEqual(["Works at Acme (MEMORY.md is full, saved in memory/auto-notes-overflow.md)"]);
    expect(stored()).toEqual({ threads: {}, overflow: { "bot-t1": { dropped: 1, since: NOW + 3 * MINUTE } } });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each(["retry", "restart"])("writes a held return again when an older copy of the file replaces it before the %s", async (how) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const older = "# Auto notes overflow\n\n- Works at Acme (noted 2026-10-01)\n- Works at Globex (noted 2026-10-14)\n";
    writeFileSync(overflowPath(), older);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Works at Acme", "my job is at acme again"]));
    say("t1", "my job is at acme again");
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`${older}- Works at Acme (noted 2026-10-15)\n`);
    // the other PC's copy, without this PC's row, wins a sync
    writeFileSync(overflowPath(), `${older}- Likes tea (noted 2026-10-15)\n`);
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`${older}- Likes tea (noted 2026-10-15)\n- Works at Acme (noted 2026-10-15)\n`);
    expect(chips("t1")).toHaveLength(1);
    expect(pass.droppedNotes("bot-t1")?.dropped).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  const above = "# Auto notes overflow\n\n- Works at Acme (noted 2026-10-01)\n- Likes tea (noted 2026-10-01)\n- Has a cat (noted 2026-10-02)\n";
  const aboveEdits: Array<[string, (text: string) => string]> = [
    ["deletes a row", (text) => text.replace("- Likes tea (noted 2026-10-01)\n", "")],
    ["deletes the older row in the same words", (text) => text.replace("- Works at Acme (noted 2026-10-01)\n", "")],
    ["adds a row", (text) => text.replace("- Likes tea", "- Plays chess (noted 2026-09-30)\n- Likes tea")],
    ["swaps two rows", (text) => text.replace("- Likes tea (noted 2026-10-01)\n- Has a cat (noted 2026-10-02)\n", "- Has a cat (noted 2026-10-02)\n- Likes tea (noted 2026-10-01)\n")],
    ["puts a row in a comment", (text) => text.replace("- Likes tea (noted 2026-10-01)\n", "<!-- - Likes tea (noted 2026-10-01) -->\n")],
  ];
  it.each(aboveEdits.flatMap(([kind, edit]) => [[kind, "retry", edit], [kind, "restart", edit]] as const))("never writes a held note again when a hand edit %s above it, then a %s", async (_kind, how, edit) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    writeFileSync(overflowPath(), above);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Works at Acme", "my job is at acme again"]));
    say("t1", "my job is at acme again");
    await settle("t1", 3 * MINUTE);
    fs.appendFileSync(overflowPath(), "- Works at Globex (noted 2026-10-15)\n");
    const edited = edit(overflow()!);
    writeFileSync(overflowPath(), edited);
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(edited);
    expect(chips("t1")).toHaveLength(1);
    expect(pass.droppedNotes("bot-t1")?.dropped).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  const chipEdits: Array<[string, (text: string) => string]> = [
    ["a row above is deleted", (text) => text.replace("- Likes tea (noted 2026-10-01)\n", "")],
    ["a shorter older copy replaces the file", () => "# Auto notes overflow\n\n- Works at Acme (noted 2026-10-01)\n"],
  ];
  it.each(chipEdits.flatMap(([kind, edit]) => [[kind, "retry", edit], [kind, "restart", edit]] as const))("shows the saved chip for a held note still the newest row after %s, then a %s", async (_kind, how, edit) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    writeFileSync(overflowPath(), above);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Works at Acme", "my job is at acme again"]));
    say("t1", "my job is at acme again");
    await settle("t1", 3 * MINUTE);
    const edited = edit(overflow()!);
    writeFileSync(overflowPath(), edited);
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(edited);
    expect(chips("t1").map((m) => m.tool?.spoken)).toEqual(["Works at Acme (MEMORY.md is full, saved in memory/auto-notes-overflow.md)"]);
    expect(pass.droppedNotes("bot-t1")?.dropped).toBe(1);
    expect(stored().held).toBeUndefined();
  });

  it.each(["retry", "restart"])("keeps a held batch's later line last when only its earlier line is removed before the %s", async (how) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Uses pnpm", "i used to say i use pnpm"], ["Uses npm", "ok so now i use npm"]));
    say("t1", "i used to say i use pnpm");
    say("t1", "ok so now i use npm");
    await settle("t1", 3 * MINUTE);
    writeFileSync(overflowPath(), overflow()!.replace("- Uses pnpm (noted 2026-10-15)\n", ""));
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    expect(overflow()?.split("\n").filter((row) => row.startsWith("- "))).toEqual(["Uses npm", "Uses pnpm", "Uses npm"].map((fact) => `- ${fact} (noted 2026-10-15)`));
    expect(chips("t1")).toHaveLength(1);
    expect(pass.droppedNotes("bot-t1")?.dropped).toBe(2);
  });

  const mine = "- Works at Acme (noted 2026-10-15)\n";
  const ownEdits: Array<[string, (text: string) => string]> = [
    ["takes its date off", (text) => text.replace(mine, "- Works at Acme\n")],
    ["moves its date a day on", (text) => text.replace(mine, "- Works at Acme (noted 2026-10-16)\n")],
    ["moves its date a day back", (text) => text.replace(mine, "- Works at Acme (noted 2026-10-14)\n")],
    ["takes every date off", (text) => text.replace(/ \(noted [0-9-]+\)/g, "")],
  ];
  it.each(ownEdits.flatMap(([kind, edit]) => [[kind, "retry", edit], [kind, "restart", edit]] as const))("never writes a held note again when a hand edit %s its row, then a %s", async (_kind, how, edit) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    writeFileSync(overflowPath(), above);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Works at Acme", "my job is at acme again"]));
    say("t1", "my job is at acme again");
    await settle("t1", 3 * MINUTE);
    fs.appendFileSync(overflowPath(), "- Works at Globex (noted 2026-10-15)\n");
    const edited = edit(overflow()!);
    writeFileSync(overflowPath(), edited);
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(edited);
    expect(chips("t1")).toHaveLength(1);
  });

  const twinEdits: Array<[string, (text: string) => string]> = [
    ["removes", (text) => text.replace(mine, "")],
    ["comments out", (text) => text.replace(mine, "<!-- old: Works at Acme -->\n")],
    ["retypes", (text) => text.replace(mine, "- Worked at Acme before (noted 2026-10-15)\n")],
    ["moves the date of", (text) => text.replace(mine, "- Works at Acme (noted 2026-10-14)\n")],
  ];
  it.each(twinEdits.flatMap(([kind, edit]) => [[kind, "retry", edit], [kind, "restart", edit]] as const))("never writes a held note again when a hand edit %s an earlier copy from the same day, then a %s", async (_kind, how, edit) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    writeFileSync(overflowPath(), `${above}${mine}- Works at Globex (noted 2026-10-15)\n`);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Works at Acme", "my job is at acme again"]));
    say("t1", "my job is at acme again");
    await settle("t1", 3 * MINUTE);
    fs.appendFileSync(overflowPath(), "- Works at Initech (noted 2026-10-15)\n");
    const edited = edit(overflow()!);
    writeFileSync(overflowPath(), edited);
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(edited);
    expect(chips("t1")).toHaveLength(1);
  });

  it.each(["retry", "restart"])("writes a held note again when the file is swapped for an older copy in its words with a newer value after, then a %s", async (how) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    writeFileSync(overflowPath(), above);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Works at Acme", "my job is at acme again"]));
    say("t1", "my job is at acme again");
    await settle("t1", 3 * MINUTE);
    writeFileSync(overflowPath(), `${above}- Works at Acme (noted 2026-10-14)\n- Works at Globex (noted 2026-10-14)\n`);
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    expect(overflow()?.split("\n").filter((row) => row.startsWith("- ")).at(-1)).toBe(mine.trim());
    expect(chips("t1")).toHaveLength(1);
  });

  it.each([
    ["the same note", "# Memory\n- note\n- Works at Acme (noted 2026-10-15)\n"],
    ["the note in other words", "# Memory\n- note\n- User's job is at Acme\n"],
    ["the same note, then a newer value", "# Memory\n- note\n- Works at Acme (noted 2026-10-15)\n- Works at Globex (noted 2026-10-15)\n"],
  ])("checks a held note against MEMORY.md after a restart once room is made with %s in it", async (_kind, room) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Works at Acme", "my job is at acme"]));
    say("t1", "my job is at acme");
    await settle("t1", 3 * MINUTE);
    expect(stored().held).toBeDefined();
    writeMemoryFile("bot-t1", room);
    pass.dispose();
    pass = start();
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(room);
    expect(stored().held).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(chips("t1")).toHaveLength(1);
    expect(pass.droppedNotes("bot-t1")).toBeUndefined();
  });

  it.each(["retry", "restart"])("lands a held correction on the quote it was accepted on, never one turned away, after a %s", async (how) => {
    const old = "- Builds oak kayaks (noted 2026-10-01)";
    writeMemoryFile("bot-t1", `# Memory\n- Plans cedar shelves\n${old}\n${"- note\n".repeat(196)}`);
    const path = join(workspaceDir("bot-t1"), "MEMORY.md");
    const write = atomic.writeFileAtomic;
    let failed = false;
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation((target, ...args) => {
      if (!failed && target === path) {
        failed = true;
        throw Object.assign(new Error("locked"), { code: "EBUSY" });
      }
      write(target, ...args);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    generate.mockResolvedValue(JSON.stringify([
      { fact: "Builds cedar kayaks", quote: "cedar" },
      { fact: "Builds cedar kayaks", quote: "I build cedar kayaks", replaces: old },
      { fact: "Collects flutes", quote: "I collect flutes" },
    ]));
    say("t1", "I build cedar kayaks");
    say("t1", "I collect flutes");
    await settle("t1", 3 * MINUTE);
    expect(stored().held).toBeDefined();
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toContain("- Builds cedar kayaks (noted 2026-10-15)\n");
    expect(memoryFileRaw("bot-t1")).not.toContain(old);
    expect(stored().held).toBeUndefined();
  });

  it.each(["retry", "restart"])("keeps a later value of its label in recall when a hand edit dates a held row back above an older row, then a next-day %s", async (how) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const top = "# Auto notes overflow\n\n- Likes tea (noted 2026-10-01)\n- Has a cat (noted 2026-10-02)\n";
    writeFileSync(overflowPath(), `${top}- Plays chess (noted 2026-10-03)\n`);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Research station: Cobalt Acme", "my research station is cobalt acme"]));
    say("t1", "my research station is cobalt acme");
    await settle("t1", 3 * MINUTE);
    const edited = `${top}- Research station: Cobalt Acme (noted 2026-10-01)\n- Plays chess (noted 2026-10-03)\n- Research station: Indigo Globex (noted 2026-10-15)\n`;
    writeFileSync(overflowPath(), edited);
    vi.setSystemTime(NOW + 24 * 60 * MINUTE);
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`${edited}- Research station: Cobalt Acme (noted 2026-10-15)\n`);
    writeFileSync(join(dataDir, "lookup-bots.json"), JSON.stringify(["bot-t1"]));
    const lookup = createMemoryLookup({ dataDir, notesPath: () => undefined, clock: () => 0 });
    await lookup.refresh("bot-t1");
    expect(lookup.take("bot-t1", "t1", "after", "indigo globex").join("")).toContain("Indigo Globex");
  });

  const restores: Array<[string, string, string]> = [
    ["dates it above two later rows", "- Has a cat (noted 2026-10-02)\n", "- Research station: Cobalt Acme (noted 2026-10-01)\n- Plays chess (noted 2026-10-03)\n- Research station: Indigo Globex (noted 2026-10-15)\n"],
    ["keeps only an older copy", "- Research station: Cobalt Acme (noted 2026-10-14)\n- Research station: Indigo Globex (noted 2026-10-15)\n", "- Research station: Cobalt Acme (noted 2026-10-14)\n- Research station: Indigo Globex (noted 2026-10-15)\n"],
    ["moves an older copy to the end", "- Has a cat (noted 2026-10-02)\n", "- Research station: Indigo Globex (noted 2026-10-15)\n- Plays chess (noted 2026-10-03)\n- Research station: Cobalt Acme (noted 2026-10-01)\n"],
    ["has an older copy above and at the end", "- Has a cat (noted 2026-10-02)\n", "- Research station: Cobalt Acme (noted 2026-10-01)\n- Research station: Indigo Globex (noted 2026-10-15)\n- Plays chess (noted 2026-10-03)\n- Research station: Cobalt Acme (noted 2026-10-01)\n"],
    ["names a later day in an older row", "- Has a cat (noted 2026-10-02)\n", "- Has a cat (noted 2026-10-02)\n- Research station: Indigo Globex until 2026-10-16 (noted 2026-10-14)\n"],
  ];
  it.each(restores.flatMap(([kind, before, restored]) => [[kind, "retry", before, restored], [kind, "restart", before, restored]] as const))("keeps a held return in recall and in its chip when a restored older file %s, then a %s", async (_kind, how, before, restored) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const top = "# Auto notes overflow\n\n- Likes tea (noted 2026-10-01)\n";
    writeFileSync(overflowPath(), top + before);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Research station: Cobalt Acme", "I returned to the cobalt acme research station"]));
    say("t1", "I returned to the cobalt acme research station");
    await settle("t1", 3 * MINUTE);
    writeFileSync(overflowPath(), top + restored);
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    writeFileSync(join(dataDir, "lookup-bots.json"), JSON.stringify(["bot-t1"]));
    const lookup = createMemoryLookup({ dataDir, notesPath: () => undefined, clock: () => 0 });
    await lookup.refresh("bot-t1");
    expect(chips("t1").map((chip) => chip.tool?.spoken).join()).toContain("Cobalt Acme");
    expect(lookup.take("bot-t1", "t1", "after", "cobalt acme").join("")).toContain("Cobalt Acme");
  });

  it.each(["retry", "restart"])("keeps another chat's newer value of its label in recall when a hand edit moves a held row below it, then a next-day %s", async (how) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const top = "# Auto notes overflow\n\n- Likes tea (noted 2026-10-01)\n- Has a cat (noted 2026-10-02)\n";
    writeFileSync(overflowPath(), `${top}- Plays chess (noted 2026-10-03)\n`);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Research station: Cobalt Acme", "my research station is cobalt acme"]));
    say("t1", "my research station is cobalt acme");
    await settle("t1", 3 * MINUTE);
    generate.mockResolvedValue(facts(["Research station: Indigo Globex", "my research station is indigo globex"]));
    say("t2", "my research station is indigo globex");
    pass.onSettled("bot-t1", "t2", true);
    await pass.idle();
    writeFileSync(overflowPath(), `${top}- Research station: Indigo Globex (noted 2026-10-15)\n- Research station: Cobalt Acme (noted 2026-10-02)\n- Plays chess (noted 2026-10-03)\n`);
    vi.setSystemTime(NOW + 24 * 60 * MINUTE);
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    writeFileSync(join(dataDir, "lookup-bots.json"), JSON.stringify(["bot-t1"]));
    const lookup = createMemoryLookup({ dataDir, notesPath: () => undefined, clock: () => 0 });
    await lookup.refresh("bot-t1");
    expect(lookup.take("bot-t1", "t1", "after", "indigo globex").join("")).toContain("Indigo Globex");
  });

  it.each(["retry", "restart"])("keeps another chat's newer value of its label in recall when a removed held row that names a later day is written back, then a next-day %s", async (how) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    mkdirSync(dirname(overflowPath()), { recursive: true });
    const top = "# Auto notes overflow\n\n- Likes tea (noted 2026-10-01)\n";
    writeFileSync(overflowPath(), top);
    lockMemoryOnce();
    generate.mockResolvedValue(facts(["Field assignment: Cobalt Acme through 2027-01-31", "my field assignment is cobalt acme through 2027-01-31"]));
    say("t1", "my field assignment is cobalt acme through 2027-01-31");
    await settle("t1", 3 * MINUTE);
    writeFileSync(overflowPath(), top);
    vi.setSystemTime(NOW + 24 * 60 * MINUTE);
    generate.mockResolvedValue(facts(["Field assignment: Indigo Globex", "my new field assignment is indigo globex"]));
    say("t2", "my new field assignment is indigo globex");
    pass.onSettled("bot-t1", "t2", true);
    await pass.idle();
    if (how === "restart") {
      pass.dispose();
      pass = start();
    }
    await settle("t1", 3 * MINUTE);
    expect(overflow()).toBe(`${top}- Field assignment: Indigo Globex (noted 2026-10-16)\n- Field assignment: Cobalt Acme through 2027-01-31 (noted 2026-10-15)\n`);
    writeFileSync(join(dataDir, "lookup-bots.json"), JSON.stringify(["bot-t1"]));
    const lookup = createMemoryLookup({ dataDir, notesPath: () => undefined, clock: () => 0 });
    await lookup.refresh("bot-t1");
    expect(lookup.take("bot-t1", "t1", "after", "indigo globex").join("")).toContain("Indigo Globex");
  });

  it.each(["rename-save", "open append handle"])("keeps another writer's overflow rows during %s", async (kind) => {
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    const path = overflowPath();
    mkdirSync(dirname(path), { recursive: true });
    const notes = "# Notebook\n- Uses pnpm (noted 2026-10-01)\n- Uses npm (noted 2026-10-02)\n";
    const hand = "- Owns a kayak\n";
    writeFileSync(path, notes);
    const open = fs.openSync;
    let edited = false;
    let fd: number | undefined;
    const edit = (target: fs.PathLike) => {
      if (target !== path || edited) return;
      edited = true;
      if (kind === "rename-save") {
        writeFileSync(`${path}.editor`, notes + hand);
        fs.renameSync(`${path}.editor`, path);
      } else {
        fd = open(path, "a");
        fs.writeSync(fd, hand);
      }
    };
    const atomicWrite = atomic.writeFileAtomic;
    vi.spyOn(atomic, "writeFileAtomic").mockImplementation((target, ...args) => {
      edit(target);
      atomicWrite(target, ...args);
    });
    // SAFETY: the wrapper passes each open through and returns the real descriptor.
    vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof open>) => {
      if (args[1] === "a+") edit(args[0]);
      return open(...args);
    }) as typeof open);
    generate.mockResolvedValue(facts(["Uses pnpm", "i use pnpm"]));
    say("t1", "i use pnpm");
    try {
      const before = overflowBytes();
      pass.onSettled("bot-t1", "t1");
      await vi.advanceTimersByTimeAsync(3 * MINUTE);
      await pass.idle();
      if (fd !== undefined) fs.writeSync(fd, "- Daughter is Mina\n");
      const second = kind === "open append handle" ? "- Daughter is Mina\n" : "";
      expect(edited).toBe(true);
      expect(overflow()).toBe(`${notes}${hand}- Uses pnpm (noted 2026-10-15)\n${second}`);
      await idle(before);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    expect(chips("t1")).toHaveLength(1);
  });

  describe("a correction in a MEMORY.md at its limit, while another writer edits it", () => {
    const old = "- Home city: Toronto (noted 2026-10-01)";
    const full = `# Memory\n${old}\n${"- note\n".repeat(197)}`;
    // lands after the revision check, just before the corrected file is written; `then` lands just after it
    const editDuringSwap = (script: string, then?: string) => {
      const path = join(workspaceDir("bot-t1"), "MEMORY.md");
      const write = atomic.writeFileAtomic;
      const edit = { landed: false };
      vi.spyOn(atomic, "writeFileAtomic").mockImplementation((target, ...args) => {
        const first = !edit.landed && target === path;
        if (first) {
          execFileSync(process.execPath, ["-e", script, path], { windowsHide: true });
          edit.landed = true;
        }
        write(target, ...args);
        if (first && then) execFileSync(process.execPath, ["-e", then, path], { windowsHide: true });
      });
      return edit;
    };
    const correct = async () => {
      generate.mockResolvedValue(JSON.stringify([{ fact: "Home city: Vancouver", quote: "i now live in Vancouver", replaces: old }, { fact: "Uses pnpm", quote: "i use pnpm" }]));
      say("t1", "i now live in Vancouver, i use pnpm");
      await settle("t1", 3 * MINUTE);
    };

    it("keeps a line the other writer appended", async () => {
      writeMemoryFile("bot-t1", full);
      const edit = editDuringSwap("require('node:fs').appendFileSync(process.argv[1], '- Cobalt preference\\n')");
      await correct();
      await vi.advanceTimersByTimeAsync(3 * MINUTE);
      await pass.idle();
      vi.mocked(atomic.writeFileAtomic).mockRestore();
      expect(edit.landed).toBe(true);
      const after = memoryFileRaw("bot-t1");
      expect(after).toContain("\n- Cobalt preference\n");
      expect(after).toContain("- Home city: Vancouver (noted 2026-10-15)");
      expect(after).not.toContain("Toronto");
      expect(overflow()).toContain("- Uses pnpm (noted 2026-10-15)");
      expect(chips("t1")).toHaveLength(1);
    });

    it.skipIf(process.platform !== "win32")("keeps a line the other writer changed in place", async () => {
      writeMemoryFile("bot-t1", full);
      const edit = editDuringSwap("const fs = require('node:fs'); const p = process.argv[1]; fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('- note\\n', '- edited by hand\\n'))");
      await correct();
      await vi.advanceTimersByTimeAsync(3 * MINUTE);
      await pass.idle();
      vi.mocked(atomic.writeFileAtomic).mockRestore();
      expect(edit.landed).toBe(true);
      const after = memoryFileRaw("bot-t1");
      expect(after).toContain("\n- edited by hand\n");
      expect(after).toContain("- Home city: Vancouver (noted 2026-10-15)");
      expect(after).not.toContain("Toronto");
      expect(overflow()).toContain("- Uses pnpm (noted 2026-10-15)");
      expect(generate).toHaveBeenCalledTimes(1);
      expect(chips("t1")).toHaveLength(1);
    });

    it("keeps a line another writer appends once the corrected file has landed, and parks the line changed in place", async () => {
      writeMemoryFile("bot-t1", full);
      const edit = editDuringSwap(
        "const fs = require('node:fs'); const p = process.argv[1]; fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('- note\\n', '- Cobalt hand edit\\n'))",
        "require('node:fs').appendFileSync(process.argv[1], '\\n- Indigo after install\\n')",
      );
      await correct();
      await vi.advanceTimersByTimeAsync(3 * MINUTE);
      await pass.idle();
      vi.mocked(atomic.writeFileAtomic).mockRestore();
      expect(edit.landed).toBe(true);
      const after = memoryFileRaw("bot-t1");
      expect(after).toContain("\n- Indigo after install\n");
      expect(after).toContain("- Home city: Vancouver (noted 2026-10-15)");
      const memory = dirname(overflowPath());
      const parked = fs.readdirSync(memory).filter((name) => name.startsWith("MEMORY.conflict-")).map((name) => readFileSync(join(memory, name), "utf8"));
      expect(parked).toHaveLength(1);
      expect(parked[0]).toContain("\n- Cobalt hand edit\n");
      expect(overflow()).toContain("- Uses pnpm (noted 2026-10-15)");
      expect(generate).toHaveBeenCalledTimes(1);
      expect(chips("t1")).toHaveLength(1);
    });
  });

  it("swaps a correction into a MEMORY.md at its limit and sends the rest to the overflow file", async () => {
    const old = "- Home city: Toronto (noted 2026-10-01)";
    writeMemoryFile("bot-t1", `# Memory\n${old}\n${"- note\n".repeat(197)}`);
    generate.mockResolvedValue(JSON.stringify([{ fact: "Home city: Vancouver", quote: "i now live in Vancouver", replaces: old }, { fact: "Uses pnpm", quote: "i use pnpm" }]));
    say("t1", "i now live in Vancouver, i use pnpm");
    await settle("t1", 3 * MINUTE);
    expect(memorySystemPrompt("bot-t1")).toContain("- Home city: Vancouver (noted 2026-10-15)");
    expect(memorySystemPrompt("bot-t1")).not.toContain("Toronto");
    expect(overflow()).toContain("- Uses pnpm (noted 2026-10-15)");
    expect(overflow()).not.toContain("Vancouver");
  });

  it("swaps a correction into a MEMORY.md that already ends on its overflow pointer", async () => {
    const old = "- Home city: Toronto (noted 2026-10-01)";
    const pointer = "- memory/auto-notes-overflow.md: Auto Notes saved while this file was full; read it when a fact seems missing (noted 2026-10-14)";
    writeMemoryFile("bot-t1", `# Memory\n${old}\n${"- note\n".repeat(197)}${pointer}`);
    generate.mockResolvedValue(JSON.stringify([{ fact: "Home city: Vancouver", quote: "i now live in Vancouver", replaces: old }]));
    say("t1", "i now live in Vancouver");
    await settle("t1", 3 * MINUTE);
    expect(memorySystemPrompt("bot-t1")).toContain("- Home city: Vancouver (noted 2026-10-15)");
    expect(memorySystemPrompt("bot-t1")).not.toContain("Toronto");
    expect(overflow()).toBeNull();
  });

  it("takes a corrected line out of a MEMORY.md too full in bytes to swap it", async () => {
    const old = "- Home city: Toronto (noted 2026-10-01)";
    const head = `# Memory\n${old}\n`;
    const filler = "x".repeat(98);
    const rows = Math.floor((MEMORY_MAX_BYTES - head.length) / 101);
    const rest = MEMORY_MAX_BYTES - 1 - head.length - rows * 101;
    writeMemoryFile("bot-t1", `${head}${`- ${filler}\n`.repeat(rows)}${"y".repeat(rest - 1)}\n`);
    generate.mockResolvedValue(JSON.stringify([{ fact: "Home city: Vancouver", quote: "i now live in Vancouver", replaces: old }]));
    say("t1", "i now live in Vancouver");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).not.toContain("Toronto");
    expect(overflow()).toContain("- Home city: Vancouver (noted 2026-10-15)");
  });

  it("keeps a corrected line until its new value is on disk", async () => {
    const old = "- Home city: Toronto (noted 2026-10-01)";
    const head = `# Memory\n${old}\n`;
    const rows = Math.floor((MEMORY_MAX_BYTES - head.length) / 101);
    const rest = MEMORY_MAX_BYTES - 1 - head.length - rows * 101;
    const full = `${head}${`- ${"x".repeat(98)}\n`.repeat(rows)}${"y".repeat(rest - 1)}\n`;
    writeMemoryFile("bot-t1", full);
    mkdirSync(overflowPath(), { recursive: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    generate.mockResolvedValue(JSON.stringify([{ fact: "Home city: Vancouver", quote: "i now live in Vancouver", replaces: old }]));
    say("t1", "i now live in Vancouver");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(full);
    rmSync(overflowPath(), { recursive: true });
    await settle("t1");
    expect(memoryFileRaw("bot-t1")).not.toContain("Toronto");
    expect(overflow()).toContain("- Home city: Vancouver (noted 2026-10-15)");
  });

  it("writes no pointer past the bytes the prompt reads", async () => {
    const full = `# Memory\n${`- ${"x".repeat(118)}\n`.repeat(199)}`;
    writeMemoryFile("bot-t1", full);
    generate.mockResolvedValue(facts(["Likes tea", "i like tea"]));
    say("t1", "i like tea");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(full);
    expect(overflow()).toContain("- Likes tea (noted 2026-10-15)");
  });

  it("never reports notes an older version turned away as saved in the overflow file", () => {
    pass.dispose();
    writeFileSync(join(dataDir, "memory-pass.json"), JSON.stringify({ threads: {}, dropped: { "bot-t1": { dropped: 2, since: NOW } } }));
    pass = start();
    const notice = memoryNotice({ longLines: 0, orphans: [] }, pass.droppedNotes("bot-t1"));
    expect(notice).toContain("2 auto notes since 10-15 were not saved because the file is full");
    expect(notice).not.toContain("auto-notes-overflow.md");
  });

  it("saves every fact of a reply with more than 20", async () => {
    const items = Array.from({ length: 21 }, (_, i): [string, string] => [`Project color ${i}`, `color ${i}`]);
    generate.mockResolvedValue(facts(...items));
    say("t1", items.map(([, quote]) => quote).join("\n\n"));
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toContain("- Project color 20 (noted 2026-10-15)");
    expect(memoryFileRaw("bot-t1")).toContain("- Project color 0 (noted 2026-10-15)");
  });

  it("leaves the overflow file alone when the note fits an empty MEMORY.md", async () => {
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"]));
    say("t1", "i'm 38");
    await settle("t1", 3 * MINUTE);
    expect(memoryFileRaw("bot-t1")).toBe(`${MEMORY_SEED}- 38 years old (noted 2026-10-15)\n`);
    expect(existsSync(overflowPath())).toBe(false);
  });

  it("saves a room member's turned-away note to its own overflow file", async () => {
    Object.assign(store, {
      // SAFETY: the pass reads only the member ids and the bot id.
      groupByThread: (threadId: string) => (threadId.startsWith("room") ? ({ id: "g", memberIds: ["bot-t1"] } as never) : undefined),
      // SAFETY: the pass reads only the bot id.
      bot: (botId: string) => ({ id: botId }) as never,
    });
    writeMemoryFile("bot-t1", `# Memory\n${"- note\n".repeat(198)}`);
    generate.mockResolvedValue(facts(["38 years old", "i'm 38"]));
    say("room1", "i'm 38");
    pass.onSettled("bot-t1", "room1");
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    await pass.idle();
    expect(overflow()).toBe(`# Auto notes overflow\n\nAuto Notes saved here while MEMORY.md was full.\n\n- 38 years old (noted 2026-10-15)\n`);
    expect(chips("room1")).toHaveLength(1);
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
    expect(stored()).toEqual({ threads: {}, overflow: { "bot-t1": { dropped: 3, since: NOW + 3 * MINUTE } } });
    pass.dispose();
    pass = start();
    expect(pass.droppedNotes("bot-t1")).toEqual({ dropped: 3, since: NOW + 3 * MINUTE });

    writeMemoryFile("bot-t1", "# Memory\n");
    generate.mockResolvedValueOnce(facts(["Uses pnpm", "i use pnpm"]));
    say("t1", "i use pnpm");
    await settle("t1", 3 * MINUTE);
    expect(chips("t1")).toHaveLength(3);
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
    expect(parseFacts("nothing")).toEqual([]);
    expect(parseFacts('[{"fact":1}]')).toEqual([]);
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

  it("passes an optional usage observer without changing the helper call", async () => {
    const claude = instance("claudeAgent");
    const signal = new AbortController().signal;
    const onUsage = vi.fn();
    await noteGenerator([claude])!("prompt", signal, onUsage);
    expect(claude.generateText).toHaveBeenCalledWith("prompt", { signal, timeoutMs: 120_000, ephemeral: true, lean: true, onUsage });
  });
});

describe("memory pass wiring", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const index = readFileSync(join(here, "index.ts"), "utf8");
  const bots = readFileSync(join(here, "bot-routes.ts"), "utf8");

  it("runs every bot's pass on Claude, after 1:1 turns, without a session transcript", () => {
    expect(index).toMatch(/createMemoryPass\(\{[\s\S]*?generate: \(\) => noteGenerator\(registry\.instances\(\), botAccounts\.noteAccount\(\)\),[\s\S]*?botHasActiveTurn/);
    expect(index).toMatch(/memoryPass\.onSettled\(bot\.id, event\.threadId, flushNotes\);\s*if \(!store\.groupByThread\(event\.threadId\)\)/);
    expect(index).toContain("memoryPass.dispose();");
  });

  it("runs the pass after a room turn, for the member that spoke", () => {
    expect(index).toMatch(/if \(speaker && group\?\.busyBotId === speaker\.botId\) \{\s*memoryPass\.onSettled\(speaker\.botId, event\.threadId\);\s*settledGroupSpeakers\.set/);
  });

  it("reads the Settings switch live and drops pending notes on a config change", () => {
    expect(index).toMatch(/createMemoryPass\(\{[\s\S]*?enabled: \(botId\) => \{[\s\S]*?memoryNotesEnabled\(cfg, bot\);[\s\S]*?\}\);/);
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
      /enabled: \(botId\) => \{\s*const bot = store\.bot\(botId\);\s*const instance = bot && registry\.get\(bot\.modelSelection\.instanceId\);\s*return Boolean\(instance && supportsWorkspaceFiles\(instance\.driverKind\)\) && memoryNotesEnabled\(cfg, bot\);/,
    );
  });

  it("loads only the pending rows, never a Map of the whole thread", () => {
    const source = readFileSync(join(here, "memory-pass.ts"), "utf8");
    expect(source.replace(/\r\n/g, "\n")).toContain("const messages = deps.store.messagesFor(sourceThread(threadId));\n    const rows = pendingRows(messages, ids);");
    expect(source).not.toMatch(/new Map\(deps\.store\.messagesFor/);
  });
  it("picks overflow rows without reading their wording", () => {
    const path = join(here, "memory-pass.ts");
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const all = <T extends ts.Node>(root: ts.Node, test: (node: ts.Node) => node is T) => {
      const found: T[] = [];
      const walk = (node: ts.Node) => {
        if (test(node)) found.push(node);
        node.forEachChild(walk);
      };
      walk(root);
      return found;
    };
    const statementOf = (node: ts.Node): ts.Node => (node.parent && node.parent !== source ? statementOf(node.parent) : node);
    const names = (statement: ts.Node) =>
      ts.isFunctionDeclaration(statement) && statement.name ? [statement.name.text]
        : ts.isVariableStatement(statement) ? statement.declarationList.declarations.flatMap(({ name }) => (ts.isIdentifier(name) ? [name.text] : []))
          : [];
    const owner = (node: ts.Node) => names(statementOf(node))[0] ?? "";
    const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    // a pattern's own text, escapes and character classes left out
    const literal = (pattern: ts.Node) => {
      const text = pattern.getText(source);
      return text.slice(1, text.lastIndexOf("/")).replace(/\[(?:\\.|[^\]\\])*\]/g, " ").replace(/\\./g, " ");
    };
    const tables = [...all(source, ts.isArrayLiteralExpression), ...all(source, ts.isObjectLiteralExpression)]
      .filter((node) => all(node, ts.isRegularExpressionLiteral).filter((pattern) => /\p{L}{2,} \p{L}{2,}/u.test(literal(pattern))).length >= 2)
      .map((node) => `memory-pass.ts:${line(node)} ${owner(node)}: a table of sentence patterns`);
    const appends = all(source, ts.isCallExpression).filter((call) => call.expression.getText(source) === "appendLines");
    const holds = (outer: ts.Node, inner: ts.Node) => outer.getStart(source) <= inner.getStart(source) && inner.getEnd() <= outer.getEnd();
    const writers = all(source, ts.isIdentifier).filter((name) => name.text === "OVERFLOW_FILE").map((name) => {
      let node: ts.Node = name;
      while (node.parent && !appends.some((call) => holds(node, call))) node = node.parent;
      return node;
    });
    const writer = writers.sort((a, b) => a.getWidth(source) - b.getWidth(source))[0];
    if (!writer) throw new Error("no overflow write found in memory-pass.ts");
    const declared = new Map(source.statements.flatMap((statement) => names(statement).map((name): [string, ts.Node] => [name, statement])));
    const reached = new Set<ts.Node>([writer]);
    for (const node of reached) for (const name of all(node, ts.isIdentifier)) reached.add(declared.get(name.text) ?? writer);
    // Markdown structure, not what a note says
    const markup = new Set(["liveRows", "NOTED"]);
    const wording = [...reached].flatMap((node) => all(node, ts.isRegularExpressionLiteral))
      .filter((pattern) => !markup.has(owner(pattern)) && /\p{L}{2,}/u.test(literal(pattern)))
      .map((pattern) => `memory-pass.ts:${line(pattern)} ${owner(pattern)}: ${pattern.getText(source)}`);
    expect([...tables, ...wording], "Overflow returns are language-free: a line lands unless it is already the file's newest row. Delete the wording list instead of growing it.").toEqual([]);
  });
});
