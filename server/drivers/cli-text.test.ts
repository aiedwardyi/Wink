import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { isFallbackSummary, prepareModelContext } from "../context-compaction.ts";
import * as procs from "../procs.ts";
import type { Message } from "../store.ts";
import { createSummaryBuild, inlineSummarizer } from "../summary-build.ts";
import { setWslGateForTests } from "../wsl-gate.ts";
import { createAcpDriver } from "./acp/core.ts";
import { grokSupport } from "./acp/grok.ts";
import { MSP_MUSE_MODELS, MspMuseAgentDriver } from "./msp/muse.ts";
import { createMspDriver } from "./msp/runtime.ts";

const grokRecorded = JSON.parse(readFileSync(new URL("../../test/fixtures/recorded/grok/generate-text.json", import.meta.url), "utf8"));
const museRecorded = JSON.parse(readFileSync(new URL("../../test/fixtures/recorded/muse/generate-text.json", import.meta.url), "utf8"));
const SUMMARY = "SUMMARY\nKeep the pending video research open. Verify the numerical memory budgets against the original slides before declaring the investigation complete.";
const history = (): Message[] => Array.from({ length: 70 }, (_, i) => [
  { id: `u${i}`, at: i, role: "user" as const, kind: "text" as const, text: `request ${i}` },
  { id: `b${i}`, at: i, role: "bot" as const, kind: "text" as const, text: `outcome ${i}` },
]).flat();

type Child = ReturnType<typeof procs.spawnCli>;
type Spawn = { cli: string; args: string[]; cwd: string; prompt: string; child: Child };

let home: string;
let mode: "summary" | "recorded" | "hang" | "fail";
const spawns: Spawn[] = [];

const engines = {
  grok: {
    create: () => createAcpDriver(grokSupport).create({ instanceId: "text-grok", displayName: "Grok", enabled: true, environment: { GROK_HOME: home }, config: { cli: "grok", fullAuto: false } }),
    recorded: grokRecorded,
    reply: (text: string, cwd: string) => JSON.stringify({ ...grokRecorded.reply.result, text, cwd }, null, 2),
  },
  muse: {
    create: () => MspMuseAgentDriver.create({ instanceId: "text-muse", displayName: "Muse", enabled: true, environment: { HOME: home, ORBIT_NO_WSL: "1" }, config: { cli: "muse", fullAuto: false } }),
    recorded: museRecorded,
    reply: (text: string) => {
      const lines: Array<{ payload: { text?: string } }> = structuredClone(museRecorded.reply.lines);
      lines.at(-1)!.payload.text = text;
      return lines.map((line) => JSON.stringify(line)).join("\n");
    },
  },
};
const grokSession = (cwd: string) => join(home, "sessions", encodeURIComponent(cwd));

describe.each(["grok", "muse"] as const)("%s summaries", (name) => {
  const engine = engines[name];
  let instance: ProviderInstance;

  beforeEach(async () => {
    spawns.length = 0;
    mode = "summary";
    const root = join(tmpdir(), "wink-cli-text", "tests");
    mkdirSync(root, { recursive: true });
    home = mkdtempSync(join(root, "case-"));
    setWslGateForTests({ env: { ORBIT_NO_WSL: "1" } });
    vi.spyOn(procs, "execCli").mockImplementation((_cli, _args, _opts, cb) => cb(null, "1.0.0"));
    vi.spyOn(procs, "killCliTree").mockImplementation((child) => {
      Object.assign(child, { exitCode: 1 });
      queueMicrotask(() => child.emit("close", 1));
    });
    vi.spyOn(procs, "spawnCli").mockImplementation((cli, args, opts) => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), exitCode: null, signalCode: null, pid: 1 }) as unknown as Child;
      const cwd = String(opts.cwd);
      spawns.push({ cli, args, cwd, prompt: readFileSync(args[args.indexOf("--prompt-file") + 1]!, "utf8"), child });
      if (name === "grok") mkdirSync(grokSession(cwd), { recursive: true });
      queueMicrotask(() => {
        if (mode === "hang") return;
        if (mode === "fail") {
          Object.assign(child, { exitCode: 1 });
          return child.emit("close", 1);
        }
        stdout.end(mode === "recorded" ? engine.reply("SUMMARY", cwd) : engine.reply(SUMMARY, cwd));
        Object.assign(child, { exitCode: 0 });
        stdout.on("end", () => child.emit("close", 0));
      });
      return child;
    });
    instance = await engine.create();
  });

  afterEach(async () => {
    await instance?.dispose();
    setWslGateForTests(null);
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("parses a recorded reply from a one-shot run that leaves nothing behind", async () => {
    mode = "recorded";
    await expect(instance.generateText!(engine.recorded.stamp.prompt)).resolves.toBe("SUMMARY");
    const [spawn] = spawns;
    expect(spawn!.cli).toBe(name);
    expect(spawn!.args.map((arg) => arg.endsWith("prompt.txt") ? "<prompt-file>" : arg)).toEqual(engine.recorded.stamp.args);
    expect(spawn!.prompt).toBe(engine.recorded.stamp.prompt);
    expect(instance.textModel).toBe(engine.recorded.stamp.model);
    expect(instance.textTimeoutMs).toBeGreaterThan(0);
    expect(existsSync(spawn!.cwd)).toBe(false);
    expect(existsSync(grokSession(spawn!.cwd))).toBe(false);
  });

  it("compacts with its own summary instead of the fallback", async () => {
    const messages = history();
    const appendCompaction = vi.fn((_threadId, value) => {
      const message: Message = { id: "built", at: 100, role: "bot", kind: "compaction", compaction: value };
      messages.push(message);
      return message;
    });
    const build = createSummaryBuild({
      store: { activePath: () => [...messages], activeLeaf: () => messages.at(-1)!.id, messagesFor: () => messages, appendCompaction, taskByThread: () => undefined },
      sendInputs: async () => ({ instance, contextWindow: 200_000, taskRecordText: "Verify the pending research" }),
      busy: () => false, userName: () => "User",
    });
    try {
      build.onSettled("bot", "thread");
      await build.idle();
      expect(appendCompaction).toHaveBeenCalledOnce();
      expect(isFallbackSummary(appendCompaction.mock.calls[0]![1].summary)).toBe(false);
      expect(appendCompaction.mock.calls[0]![1].summary).toContain("pending video research");
    } finally {
      build.dispose();
    }
    const prepared = await prepareModelContext({ messages: history(), contextWindow: 200_000, taskRecordText: "Verify the pending research", summarize: inlineSummarizer(instance, 0) });
    if (prepared.status !== "ready") throw new Error("context preparation failed");
    expect(isFallbackSummary(prepared.compaction!.summary)).toBe(false);
  });

  it.each(["hang", "fail"] as const)("falls back cleanly after %s", async (failure) => {
    mode = failure;
    await expect(instance.generateText!("summarize", { timeoutMs: 50 })).rejects.toThrow(failure === "hang" ? /timed out/ : /exited with code 1/);
    const prepared = await prepareModelContext({ messages: history(), contextWindow: 200_000, taskRecordText: "Continue research", summarize: (prompt) => instance.generateText!(prompt, { timeoutMs: 50 }) });
    if (prepared.status !== "ready") throw new Error("context preparation failed");
    expect(isFallbackSummary(prepared.compaction!.summary)).toBe(true);
    for (const spawn of spawns) {
      expect(spawn.child.exitCode).toBe(1);
      expect(existsSync(spawn.cwd)).toBe(false);
      expect(existsSync(grokSession(spawn.cwd))).toBe(false);
    }
  });

  it("honors an abort signal and disposal", async () => {
    mode = "hang";
    const controller = new AbortController();
    const pending = instance.generateText!("summarize", { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow(/abort/i);
    await vi.waitFor(() => expect(spawns).toHaveLength(1));
    controller.abort();
    await rejected;
    const disposed = instance.generateText!("summarize");
    const stopped = expect(disposed).rejects.toThrow(/disposed/);
    await vi.waitFor(() => expect(spawns).toHaveLength(2));
    await instance.dispose();
    await stopped;
    await expect(instance.generateText!("summarize")).rejects.toThrow(/disposed/);
    expect(spawns.every((spawn) => spawn.child.exitCode === 1 && !existsSync(spawn.cwd))).toBe(true);
  });
});

describe("MSP text wiring", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves the CLI before a text run and disposes the helper with the instance", async () => {
    let probe: Error | null = new Error("not found");
    vi.spyOn(procs, "execCli").mockImplementation((_cli, _args, _opts, cb) => cb(probe, probe ? "" : "1.0.0"));
    const dispose = vi.fn();
    let cli!: () => Promise<string>;
    const instance = await createMspDriver({
      driverKind: "museAgent", displayName: "Meta Muse", models: MSP_MUSE_MODELS, defaultCli: "muse", nativeSource: "muse.msp", loginNote: "",
      isAuthenticated: () => true,
      text: (ctx) => {
        cli = ctx.cli;
        return { generateText: async () => "", textModel: "muse-spark-1.3", textTimeoutMs: 1, dispose };
      },
    }).create({ instanceId: "wiring", displayName: undefined, enabled: true, environment: {}, config: { cli: "muse", fullAuto: false } });
    await expect(cli()).rejects.toThrow("Meta Muse CLI not found");
    probe = null;
    await expect(cli()).resolves.toBe("muse");
    expect(instance.textModel).toBe("muse-spark-1.3");
    await instance.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
