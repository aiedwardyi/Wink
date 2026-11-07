import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "../config.ts";
import { isFallbackSummary, prepareModelContext } from "../context-compaction.ts";
import * as procs from "../procs.ts";
import type { Message } from "../store.ts";
import { createSummaryBuild, inlineSummarizer } from "../summary-build.ts";
import { createSummaryRepair } from "../summary-repair.ts";
import { summaryInstance } from "../summary-instance.ts";
import { CodexDriver } from "./codex.ts";

vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>() }));

const recorded = JSON.parse(readFileSync(new URL("../../test/fixtures/recorded/codex/generate-text.json", import.meta.url), "utf8"));
const SUMMARY = "SUMMARY\nKeep the pending video research open. Verify the numerical memory budgets against the original slides before declaring the investigation complete.";
const history = (): Message[] => Array.from({ length: 70 }, (_, i) => [
  { id: `u${i}`, at: i, role: "user" as const, kind: "text" as const, text: `request ${i}` },
  { id: `b${i}`, at: i, role: "bot" as const, kind: "text" as const, text: `outcome ${i}` },
]).flat();

describe("Codex summaries", () => {
  let instance: ProviderInstance;
  let scratch: string;
  const calls: Array<{ method: string; params: any }> = [];
  const children: Array<ReturnType<typeof procs.spawnCli>> = [];
  let mode = "success";

  beforeEach(async () => {
    calls.length = 0;
    children.length = 0;
    mode = "success";
    const root = join(tmpdir(), "wink-codex-summary", "tests");
    mkdirSync(root, { recursive: true });
    scratch = mkdtempSync(join(root, "case-"));
    writeFileSync(join(scratch, "models_cache.json"), JSON.stringify({ models: ["gpt-6.1-sol", "gpt-6-astra"].map((slug) => ({ slug, tool_mode: "code_mode_only", context_window: 200_000 })) }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(procs, "killCliTree").mockImplementation((child) => {
      Object.assign(child, { exitCode: 0 });
      queueMicrotask(() => child.emit("close", 0));
    });
    vi.spyOn(procs, "spawnCli").mockImplementation(() => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout, stderr: new PassThrough(), exitCode: null, signalCode: null,
        stdin: new Writable({ write(chunk, _encoding, done) {
          const msg = JSON.parse(String(chunk));
          calls.push(msg);
          const send = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
          queueMicrotask(() => {
            if (msg.method === "initialize") send({ id: msg.id, result: {} });
            if (msg.method === "account/read") send({ id: msg.id, result: { account: { type: "chatgpt", email: "fixture@example.test" } } });
            if (msg.method === "config/read") send({ id: msg.id, result: { config: { mcp_servers: { custom: { command: "never-run" } } } } });
            if (msg.method === "model/list") send({ id: msg.id, result: { data: [{ id: "gpt-6.1-sol", isDefault: true }] } });
            if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "summary-thread" } } });
            if (msg.method === "turn/start") {
              send({ id: msg.id, result: { turn: { id: "summary-turn" } } });
              if (mode === "hang") return;
              if (mode === "rpc-error") return send({ method: "error", params: { error: { message: "summary failed" }, willRetry: false } });
              if (mode === "recorded") {
                for (const event of recorded.reply.events) send(event);
                return;
              }
              send({ method: "item/completed", params: { item: { type: "agentMessage", id: "summary", text: SUMMARY, phase: "final_answer" } } });
              if (mode === "usage") {
                for (const total of [{ inputTokens: 17_000, cachedInputTokens: 9_216, outputTokens: 500 }, { inputTokens: 17_879, cachedInputTokens: 9_216, outputTokens: 1_029, reasoningOutputTokens: 317 }]) {
                  send({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total } } });
                }
              }
              send({ method: "turn/completed", params: { turn: { status: "completed" } } });
            }
          });
          done();
        } }),
      }) as unknown as ReturnType<typeof procs.spawnCli>;
      children.push(child);
      return child;
    });
    instance = await CodexDriver.create({ instanceId: "summary-codex", displayName: "Codex", enabled: true, environment: { CODEX_HOME: scratch }, config: { cli: "codex", fullAuto: true } });
  });

  afterEach(async () => {
    await instance?.dispose();
    rmSync(scratch, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("R8 exposes one-shot text generation and its deadline", () => {
    expect(instance.generateText).toBeTypeOf("function");
    expect(instance.textTimeoutMs).toBeGreaterThan(0);
  });

  it("parses a recorded app-server text reply", async () => {
    mode = "recorded";
    await expect(instance.generateText!(recorded.stamp.prompt)).resolves.toBe("SUMMARY\nKeep the pending research open until the memory budgets are verified.");
    expect(children.at(-1)!.exitCode).toBe(0);
  });

  it("reports cumulative text usage without adding cache reads or reasoning twice", async () => {
    mode = "usage";
    const onUsage = vi.fn();
    await expect(instance.generateText!("cleanup", { onUsage })).resolves.toBe(SUMMARY);
    expect(onUsage).toHaveBeenLastCalledWith(18_908);
  });

  it("leaves absent text usage unreported", async () => {
    const onUsage = vi.fn();
    await expect(instance.generateText!("cleanup", { onUsage })).resolves.toBe(SUMMARY);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("R9 builds a summary for a Codex selection after settle", async () => {
    const messages = history();
    const appendCompaction = vi.fn((_threadId, value) => {
      const message: Message = { id: "built", at: 100, role: "bot", kind: "compaction", compaction: value };
      messages.push(message);
      return message;
    });
    const build = createSummaryBuild({
      store: { activePath: () => [...messages], activeLeaf: () => messages.at(-1)!.id, messagesFor: () => messages, appendCompaction },
      sendInputs: async () => ({ instance, contextWindow: 200_000, taskRecordText: "Verify the pending research" }),
      busy: () => false, userName: () => "User",
    });
    try {
      build.onSettled("bot", "thread");
      await build.idle();
      expect(appendCompaction).toHaveBeenCalledOnce();
      expect(appendCompaction.mock.calls[0]![1].summary).toContain("pending video research");
    } finally {
      build.dispose();
    }
  });

  it("R10 compacts with a model summary instead of the fallback", async () => {
    const prepared = await prepareModelContext({ messages: history(), contextWindow: 200_000, taskRecordText: "Verify the pending research", summarize: inlineSummarizer(instance, 0) });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("context preparation failed");
    expect(prepared.compaction).toBeDefined();
    expect(isFallbackSummary(prepared.compaction!.summary)).toBe(false);
    expect(prepared.compaction!.summary).toContain("pending video research");
  });

  it("uses the bot's selected model at low effort in an ephemeral restricted thread", async () => {
    const selected = summaryInstance(instance, "gpt-6-astra");
    const originalSpawn = vi.mocked(procs.spawnCli).getMockImplementation()!;
    const catalogs: unknown[] = [];
    vi.mocked(procs.spawnCli).mockImplementation((cli, args, opts) => {
      const option = args.find((arg) => arg.startsWith("model_catalog_json="));
      if (option) catalogs.push(JSON.parse(readFileSync(JSON.parse(option.slice("model_catalog_json=".length)), "utf8")));
      return originalSpawn(cli, args, opts);
    });
    await expect(selected.generateText!("summarize")).resolves.toBe(SUMMARY);
    expect(selected.textModel).toBe("gpt-6-astra");
    expect(calls.find((call) => call.method === "thread/start")?.params).toMatchObject({ model: "gpt-6-astra", modelProvider: "openai", ephemeral: true, sandbox: "read-only", approvalPolicy: "never", config: { "mcp_servers.custom.enabled": false } });
    expect(calls.find((call) => call.method === "turn/start")?.params).toMatchObject({ effort: "low", approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }, input: [{ type: "text", text: "summarize" }] });
    expect(catalogs).toEqual([{ models: [expect.objectContaining({ slug: "gpt-6-astra", tool_mode: "direct", shell_type: "disabled", apply_patch_tool_type: null, experimental_supported_tools: [], multi_agent_version: null, context_window: 200_000 })] }]);
    expect(children.at(-1)!.exitCode).toBe(0);
  });

  it("strips provider and workspace credentials from text helper children", async () => {
    await instance.dispose();
    const secrets = Object.fromEntries([...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV, "GH_TOKEN", "GITHUB_TOKEN", "ACME_API_KEY"].map((name) => [name, "must-not-reach-helper"]));
    instance = await CodexDriver.create({ instanceId: "summary-credentials", displayName: "Codex", enabled: true, environment: { ...secrets, CODEX_HOME: scratch }, config: { cli: "codex", fullAuto: true } });
    await instance.generateText!("summarize");
    const env = vi.mocked(procs.spawnCli).mock.calls.at(-1)![2].env!;
    for (const name of Object.keys(secrets)) expect(env[name]).toBeUndefined();
  });

  it.each([
    ["gpt-6.1-sol", "gpt-6-sol"],
    ["gpt-6.1-terra", "gpt-5.6-terra"],
  ])("uses compatible cached metadata for %s", async (model, legacy) => {
    const originalSpawn = vi.mocked(procs.spawnCli).getMockImplementation()!;
    const catalogs: any[] = [];
    vi.mocked(procs.spawnCli).mockImplementation((cli, args, opts) => {
      const option = args.find((arg) => arg.startsWith("model_catalog_json="));
      if (option) catalogs.push(JSON.parse(readFileSync(JSON.parse(option.slice("model_catalog_json=".length)), "utf8")));
      return originalSpawn(cli, args, opts);
    });
    const metadata = { slug: legacy, tool_mode: "code_mode_only", context_window: 200_000 };
    writeFileSync(join(scratch, "models_cache.json"), JSON.stringify({ models: [metadata] }));
    await expect(instance.generateText!("summarize", { model })).resolves.toBe(SUMMARY);
    expect(catalogs[0].models).toEqual([expect.objectContaining({ slug: model, context_window: 200_000, tool_mode: "direct", shell_type: "disabled" })]);
    expect(calls.find((call) => call.method === "thread/start")?.params.model).toBe(model);

    writeFileSync(join(scratch, "models_cache.json"), JSON.stringify({ models: [metadata, { ...metadata, slug: model, context_window: 400_000 }] }));
    await expect(instance.generateText!("summarize", { model })).resolves.toBe(SUMMARY);
    expect(catalogs[1].models[0]).toMatchObject({ slug: model, context_window: 400_000 });
  });

  it.each(["success", "rpc-error"])("preserves the %s outcome when catalog cleanup is locked", async (outcome) => {
    mode = outcome;
    vi.spyOn(fs, "rmSync").mockImplementationOnce(() => { throw new Error("EPERM: catalog locked"); });
    const result = instance.generateText!("summarize");
    if (outcome === "success") await expect(result).resolves.toBe(SUMMARY);
    else await expect(result).rejects.toThrow("Codex text generation failed");
    expect(children.at(-1)!.exitCode).toBe(0);
  });

  it.each(["missing", "invalid"])("keeps the deterministic fallback with a %s model cache", async (cache) => {
    const path = join(scratch, "models_cache.json");
    if (cache === "missing") rmSync(path);
    else writeFileSync(path, "{");
    const input = { messages: history(), contextWindow: 200_000, taskRecordText: "Continue research" };
    const baseline = await prepareModelContext(input);
    const prepared = await prepareModelContext({ ...input, summarize: inlineSummarizer(instance, 0) });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready" || baseline.status !== "ready") throw new Error("context preparation failed");
    expect(isFallbackSummary(prepared.compaction!.summary)).toBe(true);
    expect(prepared.compaction!.summary).toBe(baseline.compaction!.summary);
    expect(prepared.transcript).toEqual(baseline.transcript);
    expect(calls.some((call) => call.method === "thread/start")).toBe(false);
  });

  it("fails closed when the selected model metadata is unavailable", async () => {
    await expect(instance.generateText!("summarize", { model: "missing-model" })).rejects.toThrow("model catalog unavailable");
    expect(calls.some((call) => call.method === "thread/start")).toBe(false);
  });

  it.each(["hang", "rpc-error"])("falls back cleanly after %s", async (failure) => {
    mode = failure;
    const prepared = await prepareModelContext({ messages: history(), contextWindow: 200_000, taskRecordText: "Continue research", summarize: (prompt) => instance.generateText!(prompt, { timeoutMs: 50 }) });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("context preparation failed");
    expect(isFallbackSummary(prepared.compaction!.summary)).toBe(true);
    expect(children.at(-1)!.exitCode).toBe(0);
  });

  it("honors an abort signal and disposal", async () => {
    mode = "hang";
    const controller = new AbortController();
    const pending = instance.generateText!("summarize", { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow(/abort/i);
    await vi.waitFor(() => expect(calls.some((call) => call.method === "turn/start")).toBe(true));
    controller.abort();
    await rejected;
    const disposed = instance.generateText!("summarize");
    const stopped = expect(disposed).rejects.toThrow(/disposed/);
    await vi.waitFor(() => expect(children).toHaveLength(3));
    await instance.dispose();
    await stopped;
    expect(children.every((child) => child.exitCode === 0)).toBe(true);
  });

  it("repairs an existing Codex fallback through the shared repair queue", async () => {
    const messages = history();
    const initial = await prepareModelContext({ messages, contextWindow: 200_000, taskRecordText: "Continue research" });
    if (initial.status !== "ready" || !initial.compaction) throw new Error("missing fallback");
    messages.push({ id: "fallback", at: 100, role: "bot", kind: "compaction", compaction: initial.compaction });
    const appendCompaction = vi.fn((_threadId, value) => {
      const message: Message = { id: "repaired", at: 101, role: "bot", kind: "compaction", compaction: value };
      messages.push(message);
      return message;
    });
    const repair = createSummaryRepair({ store: { activePath: () => [...messages], messagesFor: () => messages, appendCompaction }, instanceFor: async () => summaryInstance(instance, "gpt-6-astra"), busy: () => false, taskRecordText: () => "Continue research", userName: () => "User" });
    try {
      repair.onSettled("bot", "thread");
      await repair.idle();
      expect(appendCompaction).toHaveBeenCalledOnce();
      expect(isFallbackSummary(appendCompaction.mock.calls[0]![1].summary)).toBe(false);
      expect(calls.find((call) => call.method === "thread/start")?.params.model).toBe("gpt-6-astra");
    } finally { repair.dispose(); }
  });

  it("leaves Claude summary calls and output unchanged", async () => {
    const generateText = vi.fn(async () => SUMMARY);
    const claude = { ...instance, driverKind: "claudeAgent" as const, textModel: "claude-haiku-5-5", generateText };
    const selected = summaryInstance(claude, "claude-opus-4-6");
    expect(selected).toBe(claude);
    const input = { messages: history(), contextWindow: 200_000, taskRecordText: "Continue research" };
    const before = await prepareModelContext({ ...input, summarize: inlineSummarizer(claude, 0) });
    const after = await prepareModelContext({ ...input, summarize: inlineSummarizer(selected, 0) });
    expect(after).toEqual(before);
    expect(generateText.mock.calls[1]).toEqual(generateText.mock.calls[0]);
    expect(generateText.mock.calls[0]).toHaveLength(1);
  });
});
