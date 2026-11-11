import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, ensureDirs } from "./config.ts";
import type { ProviderInstance, SideEvent, SideHandle, SideInput } from "./contracts.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { forkClaude } from "./drivers/claude-fork.ts";
import { EventBus } from "./harness/bus.ts";
import { createMemoryPass } from "./memory-pass.ts";
import { quickAsk, sideIdle, sweepSide } from "./side-chat.ts";
import { observeLive } from "./side-live-state.ts";
import { Store, type Message } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-claude-cli.ts");
const LEDGER = join(DATA_DIR, "side-chat", "live.json");
const ledger = () => (existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : []);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

let scratch: string;
beforeEach(() => {
  ensureDirs();
  rmSync(LEDGER, { force: true });
  scratch = mkdtempSync(join(tmpdir(), "omb-side-chat-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await sideIdle();
  await removeTempDir(scratch);
});

function stubFork() {
  const listeners = new Set<(event: SideEvent) => void>();
  const closes: number[] = [];
  const inputs: SideInput[] = [];
  const tempDir = mkdtempSync(join(scratch, "fork-"));
  const handle: SideHandle = {
    live: { pid: 999_999, procStart: Date.now(), cwd: scratch, tempDir },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async (graceMs = 0) => {
      closes.push(graceMs);
    },
  };
  const emit = (event: SideEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const fork = (input: SideInput) => {
    inputs.push(input);
    return handle;
  };
  return { handle, emit, closes, inputs, tempDir, fork };
}

const instanceWith = (extra: Partial<ProviderInstance>) => ({ instanceId: "i", driverKind: "stub", ...extra }) as unknown as ProviderInstance;

describe("quickAsk on a fork", () => {
  it("returns the buffered answer and closes the fork after it", async () => {
    const stub = stubFork();
    const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t1", { text: "what port?" });
    stub.emit({ type: "text", delta: "Port " });
    stub.emit({ type: "text", delta: "8080." });
    stub.emit({ type: "done", ok: true, text: "Port 8080.", usage: { input: 900, output: 4, cachedInput: 880 } });
    const result = await pending;
    expect(result).toMatchObject({ route: "answer", text: "Port 8080.", usage: { input: 900, output: 4, cachedInput: 880 } });
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(stub.closes).toHaveLength(1);
    expect(stub.closes[0]).toBeGreaterThan(0);
  });

  it("sends the preamble, then the notes block, then the text", async () => {
    const stub = stubFork();
    const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t1", { text: "where's the plan?", notes: "[Quick answers given beside your work.]\nQ: a\nA: b" });
    stub.emit({ type: "done", ok: true, text: "HANDOFF" });
    await pending;
    expect(stub.inputs).toHaveLength(1);
    expect(stub.inputs[0]!.threadId).toBe("t1");
    const [preamble, notes, text] = stub.inputs[0]!.text.split("\n\n");
    expect(preamble).toMatch(/^\[Quick helper\. .*reply with exactly HANDOFF and nothing else\. .*\]$/);
    expect(preamble).toContain("naming only the files the question needs");
    expect(preamble).toContain("A file being written now: don't state what it says, answer the rest.");
    expect(notes).toBe("[Quick answers given beside your work.]\nQ: a\nA: b");
    expect(text).toBe("where's the plan?");
  });

  it("hands the main's live state to the fork", async () => {
    const stub = stubFork();
    const at = new Date().toISOString();
    observeLive({ eventId: "l1", provider: "claude", threadId: "t-open", createdAt: at, type: "turn.started" });
    observeLive({ eventId: "l2", provider: "claude", threadId: "t-open", createdAt: at, type: "item.started", itemType: "tool", itemId: "a1", title: "mcp__agents__ask_bot", summary: "mina" });
    const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t-open", { text: "are we done?" });
    stub.emit({ type: "done", ok: true, text: "HANDOFF" });
    await pending;
    expect(stub.inputs[0]!.live).toMatch(/ask_bot mina \(started \d+ s ago\)/);
    const idle = stubFork();
    const quiet = quickAsk({ instance: instanceWith({ fork: idle.fork }), messages: [] }, "t-quiet", { text: "q?" });
    idle.emit({ type: "done", ok: true, text: "HANDOFF" });
    await quiet;
    expect(idle.inputs[0]!.live).toBeUndefined();
  });

  it("hands off an answer quoting a changed file it did not read this ask", async () => {
    const at = new Date().toISOString();
    observeLive({ eventId: "g1", provider: "claude", threadId: "t-guard", createdAt: at, type: "turn.started" });
    observeLive({ eventId: "g2", provider: "claude", threadId: "t-guard", createdAt: at, type: "item.started", itemType: "tool", itemId: "e1", title: "Edit", summary: "config.json +1 -1" });
    observeLive({ eventId: "g3", provider: "claude", threadId: "t-guard", createdAt: at, type: "item.completed", itemType: "tool", itemId: "e1", ok: true, writes: ["work\\config.json"] });
    observeLive({ eventId: "g4", provider: "claude", threadId: "t-guard", createdAt: at, type: "item.started", itemType: "tool", itemId: "e2", title: "Write", summary: "notes.md +3" });
    const ask = (reads: string[], answer: string) => {
      const stub = stubFork();
      const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t-guard", { text: "what port?" });
      for (const path of reads) stub.emit({ type: "tool", name: "Read", path });
      stub.emit({ type: "done", ok: true, text: answer });
      return pending;
    };
    expect(await ask([], "config.json says 4100.")).toMatchObject({ route: "handoff" });
    expect(await ask([], "notes.md says Friday.")).toMatchObject({ route: "handoff" });
    expect(await ask(["D:/work/config.json"], "config.json says 4180.")).toMatchObject({ route: "answer" });
    expect(await ask([], "It runs on Node 20.")).toMatchObject({ route: "answer" });
  });

  it("counts a Grep or Glob hit and an attached file as read", async () => {
    const at = new Date().toISOString();
    const small = join(scratch, "notes.md");
    writeFileSync(small, "Release: Tue Nov 24");
    observeLive({ eventId: "h1", provider: "claude", threadId: "t-hit", createdAt: at, type: "turn.started" });
    observeLive({ eventId: "h2", provider: "claude", threadId: "t-hit", createdAt: at, type: "item.started", itemType: "tool", itemId: "e1", title: "Edit", summary: "config.json +1 -1" });
    observeLive({ eventId: "h3", provider: "claude", threadId: "t-hit", createdAt: at, type: "item.completed", itemType: "tool", itemId: "e1", ok: true, writes: ["work/config.json"] });
    observeLive({ eventId: "h4", provider: "claude", threadId: "t-hit", createdAt: at, type: "item.started", itemType: "tool", itemId: "e2", title: "Edit", summary: "notes.md +1 -1" });
    observeLive({ eventId: "h5", provider: "claude", threadId: "t-hit", createdAt: at, type: "item.completed", itemType: "tool", itemId: "e2", ok: true, writes: [small] });
    const ask = (found: string[], answer: string) => {
      const stub = stubFork();
      const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t-hit", { text: "what port?" });
      stub.emit({ type: "tool", name: "Grep" });
      if (found.length) stub.emit({ type: "found", paths: found });
      stub.emit({ type: "done", ok: true, text: answer });
      return pending;
    };
    expect(await ask(["src/server.js"], "config.json says 4180.")).toMatchObject({ route: "handoff" });
    expect(await ask(["src/server.js", "config.json"], "config.json says 4180.")).toMatchObject({ route: "answer" });
    expect(await ask([], "notes.md says Tue Nov 24.")).toMatchObject({ route: "answer" });
  });

  it("hands off an answer over 450 characters", async () => {
    const say = async (answer: string) => {
      const stub = stubFork();
      const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t1", { text: "progress?" });
      stub.emit({ type: "done", ok: true, text: answer });
      return pending;
    };
    expect(await say("- a\n- b\n- c\n- d\n- e\n- f")).toMatchObject({ route: "answer" });
    expect(await say(`  ${"x".repeat(450)}\n`)).toMatchObject({ route: "answer" });
    expect(await say("x".repeat(451))).toMatchObject({ route: "handoff" });
  });

  it("pins the fork input shape a Codex fork reads", async () => {
    const stub = stubFork();
    const at = new Date().toISOString();
    observeLive({ eventId: "s1", provider: "claude", threadId: "t-shape", createdAt: at, type: "turn.started" });
    observeLive({ eventId: "s2", provider: "claude", threadId: "t-shape", createdAt: at, type: "item.started", itemType: "tool", itemId: "b1", title: "Bash", summary: "npm test" });
    const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t-shape", { text: "q?" });
    stub.emit({ type: "done", ok: true, text: "HANDOFF" });
    await pending;
    const input = stub.inputs[0]!;
    expect(Object.keys(input).sort()).toEqual(["live", "text", "threadId"]);
    expect(input.live).toMatch(/^\[Main task right now, as of \d\d:\d\d:\d\d, from Wink:\n[\s\S]*\]$/);
    expect(input.text).not.toContain("Main task right now");
  });

  it("hands off when the output starts with HANDOFF, killing the fork at once", async () => {
    const stub = stubFork();
    const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t1", { text: "dark mode?" });
    stub.emit({ type: "text", delta: "HAND" });
    stub.emit({ type: "text", delta: "OFF" });
    expect(await pending).toMatchObject({ route: "handoff" });
    expect(stub.closes).toEqual([0]);
  });

  it("answers through read tools but hands off on the first other tool", async () => {
    const stub = stubFork();
    const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t1", { text: "save it" });
    stub.emit({ type: "tool", name: "Read" });
    stub.emit({ type: "tool", name: "Grep" });
    expect(stub.closes).toEqual([]);
    stub.emit({ type: "tool", name: "Write" });
    expect(await pending).toMatchObject({ route: "handoff" });
    expect(stub.closes).toEqual([0]);
  });

  it("hands off at the 12 s cap", async () => {
    vi.useFakeTimers();
    const stub = stubFork();
    let settled = false;
    const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t1", { text: "slow?" }).then((result) => {
      settled = true;
      return result;
    });
    stub.emit({ type: "text", delta: "thinking about it" });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ route: "handoff" });
    expect(stub.closes).toEqual([0]);
  });

  it("gives a fork that reads or writes a fresh 12 s, up to 25 s", async () => {
    vi.useFakeTimers();
    const stub = stubFork();
    const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t1", { text: "what's in config?" });
    await vi.advanceTimersByTimeAsync(10_000);
    stub.emit({ type: "tool", name: "Read", path: "config.json" });
    await vi.advanceTimersByTimeAsync(10_000);
    stub.emit({ type: "text", delta: "Port " });
    await vi.advanceTimersByTimeAsync(3_000);
    stub.emit({ type: "done", ok: true, text: "Port 4180." });
    expect(await pending).toMatchObject({ route: "answer", text: "Port 4180." });
  });

  it("hands off at 25 s even while the fork keeps going", async () => {
    vi.useFakeTimers();
    const stub = stubFork();
    let settled = false;
    const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t1", { text: "slow?" }).then((result) => {
      settled = true;
      return result;
    });
    for (let at = 0; at < 24_000; at += 8_000) {
      stub.emit({ type: "tool", name: "Grep" });
      await vi.advanceTimersByTimeAsync(8_000);
    }
    expect(settled).toBe(false);
    stub.emit({ type: "text", delta: "almost" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ route: "handoff" });
    expect(stub.closes).toEqual([0]);
  });

  it("hands off when the fork fails or exits early", async () => {
    const stub = stubFork();
    const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t1", { text: "hm?" });
    stub.emit({ type: "done", ok: false, text: "" });
    expect(await pending).toMatchObject({ route: "handoff" });
  });

  it("keeps the fork in the ledger only while it lives", async () => {
    const stub = stubFork();
    const pending = quickAsk({ instance: instanceWith({ fork: stub.fork }), messages: [] }, "t1", { text: "port?" });
    expect(ledger()).toEqual([expect.objectContaining({ pid: 999_999, tempDir: stub.tempDir })]);
    stub.emit({ type: "session", id: "fork-1" });
    expect(ledger()).toEqual([expect.objectContaining({ forkSessionId: "fork-1" })]);
    stub.emit({ type: "done", ok: true, text: "8080" });
    await pending;
    await sideIdle();
    expect(ledger()).toEqual([]);
    expect(existsSync(stub.tempDir)).toBe(false);
  });
});

describe("quickAsk without a fork", () => {
  const message = (i: number, text: string): Message => ({ id: `m${i}`, role: i % 2 ? "bot" : "user", kind: "text", text, at: 1_000 + i });

  it("asks generateText, ephemeral and lean, over a capped transcript", async () => {
    const generateText = vi.fn(async () => "The plan is in docs/plan.md.");
    const messages = Array.from({ length: 200 }, (_, i) => message(i, `${i === 199 ? "NEWEST" : `line ${i}`} ${"x".repeat(2_000)}`));
    const result = await quickAsk({ instance: instanceWith({ generateText }), messages }, "t1", { text: "where's the plan?", notes: "NOTES" });
    expect(result).toMatchObject({ route: "answer", text: "The plan is in docs/plan.md." });
    expect(generateText).toHaveBeenCalledTimes(1);
    const [prompt, opts] = generateText.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts).toMatchObject({ ephemeral: true, lean: true, timeoutMs: 12_000 });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(prompt).toContain("NEWEST");
    expect(prompt).not.toContain("line 1 ");
    expect(prompt).toMatch(/\[Quick helper\.[\s\S]*NOTES\n\nwhere's the plan\?$/);
    expect(Math.ceil(Buffer.byteLength(prompt) / 3)).toBeLessThan(18_000);
  });

  it("hands off on HANDOFF, an error, or no text helper", async () => {
    const say = (text: string) => quickAsk({ instance: instanceWith({ generateText: async () => text }), messages: [] }, "t1", { text: "q?" });
    expect(await say("HANDOFF")).toMatchObject({ route: "handoff" });
    expect(await quickAsk({ instance: instanceWith({ generateText: async () => { throw new Error("signed out"); } }), messages: [] }, "t1", { text: "q?" })).toMatchObject({ route: "handoff" });
    expect(await quickAsk({ instance: instanceWith({}), messages: [] }, "t1", { text: "q?" })).toMatchObject({ route: "handoff" });
  });

  it("hands off when an engine's fork returns null, without a text call", async () => {
    const generateText = vi.fn(async () => "Port 8787.");
    const result = await quickAsk({ instance: instanceWith({ driverKind: "claudeAgent", fork: () => null, generateText }), messages: [] }, "t1", { text: "what port?" });
    expect(result).toMatchObject({ route: "handoff" });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("hands off an over-long answer or one quoting a changed file it was not given", async () => {
    const at = new Date().toISOString();
    observeLive({ eventId: "x1", provider: "claude", threadId: "t-text-guard", createdAt: at, type: "turn.started" });
    observeLive({ eventId: "x2", provider: "claude", threadId: "t-text-guard", createdAt: at, type: "item.started", itemType: "tool", itemId: "e1", title: "Edit", summary: "config.json +1 -1" });
    observeLive({ eventId: "x3", provider: "claude", threadId: "t-text-guard", createdAt: at, type: "item.completed", itemType: "tool", itemId: "e1", ok: true, writes: ["work/config.json"] });
    const say = (text: string) => quickAsk({ instance: instanceWith({ generateText: async () => text }), messages: [] }, "t-text-guard", { text: "q?" });
    expect(await say("x".repeat(451))).toMatchObject({ route: "handoff" });
    expect(await say("config.json says 4100.")).toMatchObject({ route: "handoff" });
    expect(await say("It runs on Node 20.")).toMatchObject({ route: "answer" });
  });

  it("puts the main's live state in the prompt", async () => {
    const generateText = vi.fn(async (_prompt: string) => "HANDOFF");
    observeLive({ eventId: "f1", provider: "claude", threadId: "t-text", createdAt: new Date().toISOString(), type: "item.started", itemType: "tool", itemId: "b1", title: "Bash", summary: "npm test" });
    await quickAsk({ instance: instanceWith({ generateText }), messages: [] }, "t-text", { text: "q?" });
    expect(generateText.mock.calls[0]![0]).toContain("Bash npm test (started");
  });
});

describe("sweepSide", () => {
  it("cleans dead forks and keeps live ones", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const config = join(scratch, "cfg");
    const logs = join(scratch, "logs");
    mkdirSync(join(config, "sessions"), { recursive: true });
    mkdirSync(join(logs, "mcp-logs-ogb"), { recursive: true });
    const deadTemp = mkdtempSync(join(scratch, "dead-"));
    const liveTemp = mkdtempSync(join(scratch, "live-"));
    writeFileSync(join(config, "sessions", `${dead}.json`), JSON.stringify({ pid: dead, sessionId: "fork-dead" }));
    writeFileSync(join(config, "sessions", `${dead}.abc.key`), "k");
    writeFileSync(join(config, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid }));
    writeFileSync(join(logs, "mcp-logs-ogb", "a.jsonl"), JSON.stringify({ sessionId: "fork-dead" }) + "\n");
    writeFileSync(join(logs, "mcp-logs-ogb", "b.jsonl"), JSON.stringify({ sessionId: "main" }) + "\n");
    mkdirSync(dirname(LEDGER), { recursive: true });
    writeFileSync(LEDGER, JSON.stringify([
      { pid: dead, procStart: Date.now() - 60_000, forkSessionId: "fork-dead", configDir: config, mcpLogDir: logs, cwd: scratch, tempDir: deadTemp },
      { pid: process.pid, procStart: Date.now(), cwd: scratch, tempDir: liveTemp },
    ]));
    sweepSide();
    expect(existsSync(deadTemp)).toBe(false);
    expect(existsSync(join(config, "sessions", `${dead}.json`))).toBe(false);
    expect(existsSync(join(config, "sessions", `${dead}.abc.key`))).toBe(false);
    expect(existsSync(join(config, "sessions", `${process.pid}.json`))).toBe(true);
    expect(existsSync(join(logs, "mcp-logs-ogb", "a.jsonl"))).toBe(false);
    expect(existsSync(join(logs, "mcp-logs-ogb", "b.jsonl"))).toBe(true);
    expect(existsSync(liveTemp)).toBe(true);
    expect(ledger()).toEqual([expect.objectContaining({ pid: process.pid })]);
  });
});

describe("Claude fork (fake CLI)", () => {
  let instance: ProviderInstance;
  let work: string;
  const envKeys = ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_FORK_MODE", "FAKE_CLAUDE_FORK_FIXTURE", "FAKE_CLAUDE_DUMP", "FAKE_CLAUDE_PROMPT_LOG"];

  beforeEach(async () => {
    chmodSync(FAKE_CLI, 0o755);
    work = join(scratch, "work");
    mkdirSync(work);
    instance = await ClaudeDriver.create({ instanceId: "claude-side", displayName: "Claude", environment: {}, enabled: true, config: { cli: FAKE_CLI, permissionMode: "acceptEdits" } as never });
  });
  afterEach(async () => {
    await instance.adapter.stopAll();
    await sideIdle();
    for (const key of envKeys) delete process.env[key];
  });

  const fixture = (text: string) => {
    const path = join(scratch, "fork-reply.json");
    writeFileSync(path, JSON.stringify([
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } },
      { type: "assistant", message: { content: [{ type: "text", text }] } },
      { type: "result", is_error: false, result: text, usage: { input_tokens: 3, cache_read_input_tokens: 900, output_tokens: 4 } },
    ]));
    return path;
  };
  const mainTurn = (threadId: string) =>
    new Promise<void>((resolve, reject) => {
      const off = instance.adapter.onEvent((event) => {
        if (event.threadId !== threadId) return;
        if (event.type === "session.started" || event.type === "turn.completed") {
          off();
          resolve();
        }
      });
      instance.adapter.sendTurn({ threadId, text: "main work", approval: "auto", system: "You are Ada.", cwd: work }).catch(reject);
    });
  const prompts = () => readFileSync(process.env.FAKE_CLAUDE_PROMPT_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { pid: number; argv: string[]; text: string });

  it("forks with the main's args plus --resume, --fork-session, --no-session-persistence and the hook", async () => {
    process.env.FAKE_CLAUDE_PROMPT_LOG = join(scratch, "prompts.jsonl");
    process.env.FAKE_CLAUDE_DUMP = join(scratch, "dump.json");
    process.env.FAKE_CLAUDE_FORK_FIXTURE = fixture("Port 8080.");
    await mainTurn("t-args");
    await vi.waitFor(() => expect(existsSync(process.env.FAKE_CLAUDE_DUMP!)).toBe(true));
    const mainDump = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_DUMP!, "utf8"));
    const result = await quickAsk({ instance, messages: [] }, "t-args", { text: "what port?" });
    expect(result).toMatchObject({ route: "answer", text: "Port 8080.", usage: { input: 903, output: 4, cachedInput: 900 } });
    await sideIdle();
    const [main, fork] = prompts();
    expect(fork!.pid).not.toBe(main!.pid);
    expect(fork!.text).toMatch(/^\[Quick helper\.[\s\S]*\n\nwhat port\?$/);
    const forkDump = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_DUMP!, "utf8"));
    expect(forkDump.pid).toBe(fork!.pid);

    const cursor = main!.argv[main!.argv.indexOf("--session-id") + 1]!;
    const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1]!;
    const same = (argv: string[]) => argv.map((arg, i) => (["--mcp-config", "--append-system-prompt-file", "--settings"].includes(argv[i - 1] ?? "") ? "<value>" : arg));
    const mainArgs = main!.argv.filter((arg, i) => arg !== "--session-id" && main!.argv[i - 1] !== "--session-id");
    expect(same(fork!.argv)).toEqual([...same(mainArgs), "--resume", cursor, "--fork-session", "--no-session-persistence"]);

    const mainSettings = JSON.parse(valueOf(main!.argv, "--settings"));
    const forkSettings = JSON.parse(valueOf(fork!.argv, "--settings"));
    expect(forkSettings).toMatchObject(mainSettings);
    expect(forkSettings.hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: expect.stringContaining("side-hook.cjs") }] }]);
    expect(forkDump.systemPrompt).toBe(mainDump.systemPrompt);
    expect(Object.keys(forkDump.mcpConfig.mcpServers)).toEqual(Object.keys(mainDump.mcpConfig.mcpServers));
    expect(forkDump.mcpConfig.mcpServers.ogb.args[1]).not.toBe(mainDump.mcpConfig.mcpServers.ogb.args[1]);
    expect(valueOf(fork!.argv, "--mcp-config")).not.toBe(valueOf(main!.argv, "--mcp-config"));
    expect(alive(fork!.pid)).toBe(false);
    expect(existsSync(dirname(valueOf(fork!.argv, "--mcp-config")))).toBe(false);
    expect(ledger()).toEqual([]);
  });

  it("answers beside a live main turn without touching it", async () => {
    process.env.FAKE_CLAUDE_MODE = "hang";
    process.env.FAKE_CLAUDE_FORK_FIXTURE = fixture("Almost done.");
    const steer = vi.spyOn(instance.adapter, "steer");
    const appendMessage = vi.spyOn(Store.prototype, "appendMessage");
    const setActivity = vi.spyOn(Store.prototype, "setActivity");
    const publish = vi.spyOn(EventBus.prototype, "publish");
    const store = new Store(() => ({ instanceId: "claude-side", model: "claude-sonnet-5-5" }));
    const changes = vi.fn();
    store.onChange(changes);
    const generate = vi.fn();
    const pass = createMemoryPass({ store, generate: () => generate, enabled: () => true, busy: () => false, dataDir: DATA_DIR });
    await mainTurn("t-live");
    const events: string[] = [];
    const off = instance.adapter.onEvent((event) => events.push(event.type));

    const result = await quickAsk({ instance, messages: [] }, "t-live", { text: "are we almost done yet" });
    await sideIdle();
    off();
    pass.onSettled("bot-1", "t-live", true);
    await pass.idle();
    pass.dispose();

    expect(result).toMatchObject({ route: "answer", text: "Almost done." });
    expect(instance.adapter.hasSession("t-live")).toBe(true);
    expect(steer).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(appendMessage).not.toHaveBeenCalled();
    expect(setActivity).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("kills the fork on a scripted Write and hands off", async () => {
    process.env.FAKE_CLAUDE_FORK_MODE = "edit";
    process.env.FAKE_CLAUDE_PROMPT_LOG = join(scratch, "prompts.jsonl");
    await mainTurn("t-write");
    const result = await quickAsk({ instance, messages: [] }, "t-write", { text: "save it" });
    expect(result).toMatchObject({ route: "handoff" });
    await sideIdle();
    const fork = prompts().find((line) => line.argv.includes("--fork-session"))!;
    expect(alive(fork.pid)).toBe(false);
    expect(existsSync(join(work, "made.txt"))).toBe(false);
    expect(ledger()).toEqual([]);
  });

  it("reports the files a Grep or Glob result lists", async () => {
    const path = join(scratch, "fork-grep.json");
    const grep = (id: string, input: Record<string, string>, content: string) => [
      { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Grep", input }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } },
    ];
    writeFileSync(path, JSON.stringify([
      ...grep("g1", { pattern: "port" }, 'config.json:2:  "port": 4180\nsrc\\server.js:2:const { port } = require("../config.json");'),
      ...grep("g2", { pattern: "Nov", path: "notes.md" }, "4:- Release target: Tuesday Nov 24."),
      ...grep("g3", { pattern: "zzz", path: "plan.md" }, "No matches found"),
      { type: "result", is_error: false, result: "4180", usage: { input_tokens: 3, output_tokens: 1 } },
    ]));
    process.env.FAKE_CLAUDE_FORK_FIXTURE = path;
    await mainTurn("t-grep");
    const handle = instance.fork!({ threadId: "t-grep", text: "what port?" })!;
    const found: string[][] = [];
    await new Promise<void>((resolve) => {
      handle.onEvent((event) => {
        if (event.type === "found") found.push(event.paths);
        if (event.type === "done") resolve();
      });
    });
    await handle.close(5_000);
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual(expect.arrayContaining(["config.json", "src\\server.js"]));
    expect(found[1]).toEqual(expect.arrayContaining(["notes.md"]));
  });

  it("the hook denies the fake's scripted Write and Bash", async () => {
    process.env.FAKE_CLAUDE_FORK_MODE = "edit";
    await mainTurn("t-hook");
    const handle = instance.fork!({ threadId: "t-hook", text: "save it" })!;
    const done = await new Promise<Extract<SideEvent, { type: "done" }>>((resolve) => {
      handle.onEvent((event) => {
        if (event.type === "done") resolve(event);
      });
    });
    await handle.close(5_000);
    expect(done.ok).toBe(true);
    expect(existsSync(join(work, "made.txt"))).toBe(false);
    expect(existsSync(join(work, "ran.txt"))).toBe(false);
    expect(alive(handle.live.pid)).toBe(false);
  });

  it("sends the live block ahead of the ask", async () => {
    process.env.FAKE_CLAUDE_PROMPT_LOG = join(scratch, "prompts.jsonl");
    process.env.FAKE_CLAUDE_FORK_FIXTURE = fixture("Still waiting on Mina.");
    await mainTurn("t-block");
    const handle = instance.fork!({ threadId: "t-block", text: "q", live: "[LIVE]" })!;
    await new Promise<void>((resolve) => handle.onEvent((event) => event.type === "done" && resolve()));
    await handle.close(5_000);
    expect(prompts().find((line) => line.argv.includes("--fork-session"))!.text).toBe("[LIVE]\n\nq");
  });

  const forkOf = (settings: object, policy: Parameters<typeof forkClaude>[0]["policy"] = {}) => {
    process.env.FAKE_CLAUDE_PROMPT_LOG = join(scratch, "prompts.jsonl");
    process.env.FAKE_CLAUDE_FORK_FIXTURE = fixture("Port 8080.");
    return forkClaude({ cli: FAKE_CLI, args: ["-p", "--settings", JSON.stringify(settings)], mcpServers: {}, cwd: work, env: { ...process.env }, policy, cursor: "s-main" }, { threadId: "t", text: "q" });
  };
  const settled = async (handle: SideHandle) => {
    await new Promise<void>((resolve) => handle.onEvent((event) => event.type === "done" && resolve()));
    await handle.close(5_000);
    const argv = prompts().find((line) => line.argv.includes("--fork-session"))!.argv;
    return JSON.parse(argv[argv.indexOf("--settings") + 1]!);
  };

  it("keeps only the side hook in the fork's settings", async () => {
    const other = [{ hooks: [{ type: "command", command: "notify" }] }];
    const settings = await settled(forkOf({ permissions: { ask: ["Bash"] }, hooks: { SessionStart: other, PreToolUse: other, Stop: other } }));
    expect(settings.permissions).toEqual({ ask: ["Bash"] });
    expect(settings.hooks).toEqual({ PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: expect.stringContaining("side-hook.cjs") }] }] });
  });

  it("runs the fork at low effort only when the main is at xhigh or max", async () => {
    process.env.FAKE_CLAUDE_PROMPT_LOG = join(scratch, "prompts.jsonl");
    process.env.FAKE_CLAUDE_FORK_FIXTURE = fixture("Port 8080.");
    const effortOf = async (args: string[]) => {
      const handle = forkClaude({ cli: FAKE_CLI, args: ["-p", ...args], mcpServers: {}, cwd: work, env: { ...process.env }, policy: {}, cursor: "s-main" }, { threadId: "t", text: "q" });
      await new Promise<void>((resolve) => handle.onEvent((event) => event.type === "done" && resolve()));
      await handle.close(5_000);
      const argv = prompts().filter((line) => line.argv.includes("--fork-session")).at(-1)!.argv;
      return argv.includes("--effort") ? argv[argv.indexOf("--effort") + 1] : null;
    };
    expect(await effortOf(["--effort", "max"])).toBe("low");
    expect(await effortOf(["--effort", "xhigh"])).toBe("low");
    expect(await effortOf(["--effort", "high"])).toBe("high");
    expect(await effortOf(["--effort", "medium"])).toBe("medium");
    expect(await effortOf([])).toBeNull();
  });

  it("forks an account bot's thread", async () => {
    const account = { id: "acct_7d6e234b-8046-4a5a-9354-2cf05f27d775", of: "claude", home: join(scratch, "account"), generation: 1 };
    const settings = await settled(forkOf({ permissions: { ask: ["Bash"] } }, { account, accountDriver: "claudeAgent" }));
    expect(Object.keys(settings.hooks)).toEqual(["PreToolUse"]);
  });

  it("returns no fork once the main session closed", async () => {
    process.env.FAKE_CLAUDE_PROMPT_LOG = join(scratch, "prompts.jsonl");
    await mainTurn("t-closed");
    await vi.waitFor(() => expect(existsSync(process.env.FAKE_CLAUDE_PROMPT_LOG!)).toBe(true));
    const [main] = prompts();
    await instance.adapter.stopAll();
    await vi.waitFor(() => expect(alive(main!.pid)).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(instance.fork!({ threadId: "t-closed", text: "q" })).toBeNull();
  });

  it("returns no fork before the thread ever spawned", () => {
    expect(instance.fork!({ threadId: "never", text: "q" })).toBeNull();
  });
});

