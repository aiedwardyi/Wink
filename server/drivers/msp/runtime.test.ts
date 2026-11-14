// MSP driver contract tests, run against the scripted fake MSP host in
// server/testing/fake-msp-cli.ts: session/start carries the model, text
// folds into canonical events, interrupts and crashes settle cleanly.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { PrepareTurn, ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { toWslPath } from "../../env-path.ts";
import * as procs from "../../procs.ts";
import { createTempDirs, removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { fakeMuseInstall, museUpdate } from "../../testing/fake-muse-install.ts";
import { createWarmPool, type WarmPool } from "../warm-pool.ts";
import { MspMuseAgentDriver } from "./muse.ts";
import { createMspDriver, mspMcpServers, translateMspServerForWsl } from "./runtime.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-msp-cli.ts");

describe("MSP turns (fake host)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (mode?: string, fullAuto = false) => {
    if (mode) process.env.FAKE_MSP_MODE = mode;
    process.env.META_API_KEY = "meta-key";
    instance = await MspMuseAgentDriver.create({
      instanceId: "msp-test",
      displayName: "MSP Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto },
    });
    recorder = recordEvents(instance.adapter);
  };

  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  // WSL interop hands argv to the Windows exe verbatim, so a translated arg
  // reaches node.exe as `C:\mnt\c\...` and the server dies on spawn.
  it("translates a server command for WSL and leaves args and env alone", () => {
    const server = {
      transport: "stdio" as const,
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Orbit\\server\\drivers\\terminal-proxy.js", "--read-only"],
      env: { OMB_TERMINAL_TOKEN: "grant" },
    };
    expect(translateMspServerForWsl(server)).toEqual({
      transport: "stdio",
      command: toWslPath(server.command),
      args: server.args,
      env: server.env,
    });
  });

  it("mounts every Orbit server Grok Build gets, each on the stdio transport", () => {
    const stdio = (name: string) => ({ command: `${name}-cmd`, args: [`${name}.js`], env: { T: name } });
    const servers = mspMcpServers(
      {
        agents: stdio("agents"),
        composio: stdio("composio"),
        browser: stdio("browser"),
        terminal: stdio("terminal"),
        phone: stdio("phone"),
        localComputer: { ...stdio("computer"), platform: "linux", scope: "local-computer" },
      },
      { wsl: false },
    );
    expect(Object.keys(servers!).sort()).toEqual([
      "agents",
      "browser",
      "composio",
      "computer",
      "phone",
      "terminal",
    ]);
    for (const server of Object.values(servers!)) expect(server.transport).toBe("stdio");
    expect(servers!.phone).toEqual({ transport: "stdio", command: "phone-cmd", args: ["phone.js"], env: { T: "phone" } });
  });

  it("folds the ask-driven agents tools behind the catalog unless the switch says 0", () => {
    const agents = { command: "agents-cmd", args: ["agents.js"], env: { T: "agents" } };
    vi.stubEnv("ORBIT_WINK_TOOL_CATALOG", "");
    expect(mspMcpServers({ agents }, { wsl: false })!.agents.env).toEqual({ T: "agents", OMB_WINK_TOOL_CATALOG: "1" });
    vi.stubEnv("ORBIT_WINK_TOOL_CATALOG", "0");
    expect(mspMcpServers({ agents }, { wsl: false })!.agents.env).toEqual({ T: "agents" });
    vi.unstubAllEnvs();
  });

  it("mounts a cloud box computer through the computer proxy", () => {
    const servers = mspMcpServers(
      { computer: { kind: "box", boxId: "box-1", token: "box-token" } },
      { wsl: false },
    );
    expect(servers!.computer.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1", OGB_BOX_ID: "box-1" });
  });

  it("omits the config key entirely when the turn mounts nothing", () => {
    expect(mspMcpServers(undefined, { wsl: false })).toBeUndefined();
    expect(mspMcpServers({}, { wsl: false })).toBeUndefined();
  });

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-msp-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_MSP_MODE;
    delete process.env.FAKE_MSP_COALESCE;
    delete process.env.FAKE_MSP_DUMP;
    delete process.env.FAKE_MSP_STATE;
    delete process.env.FAKE_MSP_RPC_DUMP;
    delete process.env.FAKE_MSP_USAGE;
    delete process.env.FAKE_MSP_USAGE_CHANGED;
    delete process.env.FAKE_MSP_ITEMS;
    delete process.env.FAKE_MSP_GATE_FILE;
    delete process.env.FAKE_MSP_VERSION;
    delete process.env.META_API_KEY;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it.each([
    ["Muse Code 1.4.15 (1.4.15-R8339.1)", ["serve", "--trust-workspace", "-c", "run.reminder_roster.agents=[]"]],
    ["Muse Code 1.4.14 (1.4.14-R7309.1)", ["serve"]],
  ])("serves %s with %j", async (version, argv) => {
    const dump = join(scratch, "muse-serve-args.json");
    process.env.FAKE_MSP_DUMP = dump;
    process.env.FAKE_MSP_VERSION = version;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-serve-args", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(dump, "utf8")).argv).toEqual(argv);
  });

  describe("system text", () => {
    const sent = (dump: string) => JSON.parse(readFileSync(`${dump}.turn.json`, "utf8"))[0].text;
    const turn = async (text: string, system: string, resumeCursor?: string) => {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "t-system", text, system, resumeCursor });
      return recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    };

    it("goes out once per session and again when it changes", async () => {
      const dump = join(scratch, "muse-system-once.json");
      process.env.FAKE_MSP_DUMP = dump;
      await create();
      await turn("one", "RULES");
      expect(sent(dump)).toBe("RULES\n\none");
      await turn("two", "RULES", "fake-msp-session");
      expect(sent(dump)).toBe("two");
      await turn("three", "RULES v2", "fake-msp-session");
      expect(sent(dump)).toBe("RULES v2\n\nthree");
      await turn("four", "RULES v2", "fake-msp-session");
      expect(sent(dump)).toBe("four");
    });

    it("goes out again after the host compacts the session", async () => {
      const dump = join(scratch, "muse-system-compacted.json");
      process.env.FAKE_MSP_DUMP = dump;
      process.env.FAKE_MSP_ITEMS = JSON.stringify([
        { method: "item/started", params: { item: { itemId: "compact-1", kind: "compaction", status: "inProgress" } } },
        { method: "item/completed", params: { item: { itemId: "compact-1", kind: "compaction", status: "completed" } } },
      ]);
      await create();
      await turn("one", "RULES");
      await turn("two", "RULES", "fake-msp-session");
      expect(sent(dump)).toBe("RULES\n\ntwo");
    });

    it("goes out again after a turn that failed", async () => {
      const dump = join(scratch, "muse-system-failed.json");
      process.env.FAKE_MSP_DUMP = dump;
      await create("fail-after-text");
      expect(await turn("one", "RULES")).toMatchObject({ ok: false });
      await turn("two", "RULES", "fake-msp-session");
      expect(sent(dump)).toBe("RULES\n\ntwo");
    });

    it("goes out again after a turn that was stopped", async () => {
      const dump = join(scratch, "muse-system-stopped.json");
      process.env.FAKE_MSP_DUMP = dump;
      await create("hang");
      for (const [text, resumeCursor] of [["one", undefined], ["two", "fake-msp-session"]] as const) {
        const { turnId } = await instance.adapter.sendTurn({ threadId: "t-system", text, system: "RULES", resumeCursor });
        await vi.waitFor(() => expect(sent(dump)).toBe(`RULES\n\n${text}`));
        await instance.adapter.interruptTurn("t-system");
        expect(await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId)).toMatchObject({ stopReason: "cancelled" });
      }
    });

    it("goes out on the fresh session a rejected resume falls back to", async () => {
      const dump = join(scratch, "muse-system-fallback.json");
      process.env.FAKE_MSP_DUMP = dump;
      const rpcDump = join(scratch, "muse-system-fallback-rpc.json");
      process.env.FAKE_MSP_RPC_DUMP = rpcDump;
      await create("resume-fails");
      await turn("one", "RULES");
      await turn("two", "RULES", "gone-session");
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toContain("session/resume");
      expect(sent(dump)).toBe("RULES\n\ntwo");
    });
  });

  it("starts a session with the requested model and folds text", async () => {
    const dump = join(scratch, "muse-model.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-model", text: "hi", model: "muse-spark-1.3" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toContainEqual({
      method: "session/start",
      modelId: "muse-spark-1.3",
    });
    expect(JSON.parse(readFileSync(`${dump}.turn.json`, "utf8"))).toEqual([{ type: "text", text: "hi" }]);
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "session.started", sessionId: "fake-msp-session" }),
    );
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "content.delta", delta: "hello from fake msp" }),
    );
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "item.completed", text: "hello from fake msp" }),
    );
  });

  it("shows tool activity before reply text and completes each call once", async () => {
    const item = { itemId: "tool-1", kind: "toolCall", tool: "read_file", status: "inProgress" };
    process.env.FAKE_MSP_ITEMS = JSON.stringify([
      { method: "item/started", params: { item } },
      { method: "item/started", params: { item } },
      { method: "item/delta", params: { itemId: item.itemId, field: "text", delta: "private tool output" } },
      { method: "item/completed", params: { item: { ...item, status: "completed" } } },
      { method: "item/completed", params: { item: { ...item, status: "completed" } } },
    ]);
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-tool", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => "itemType" in e && e.itemType === "tool")).toEqual([
      expect.objectContaining({ type: "item.started", itemId: "tool-1", title: "read_file", threadId: "t-tool", turnId }),
      expect.objectContaining({ type: "item.completed", itemId: "tool-1", ok: true, threadId: "t-tool", turnId }),
    ]);
    const start = recorder.events.findIndex((e) => e.type === "item.started");
    expect(start).toBeLessThan(recorder.events.findIndex((e) => e.type === "content.delta"));
    expect(recorder.events.filter((e) => e.type === "content.delta").map((e) => e.delta)).toEqual(["hello from fake msp"]);
  });

  it.each(["failed", "cancelled", "rejected", "timedOut", "unknownTerminal"])("completes a %s tool without failing its turn", async (status) => {
    const item = { itemId: "tool-fail", kind: "toolCall", tool: "shell", status: "inProgress" };
    process.env.FAKE_MSP_ITEMS = JSON.stringify([
      { method: "item/started", params: { item } },
      { method: "item/completed", params: { item: { ...item, status } } },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-tool-fail", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.filter((e) => "itemType" in e && e.itemType === "tool")).toEqual([
      expect.objectContaining({ type: "item.started", itemId: "tool-fail", title: "shell" }),
      expect.objectContaining({ type: "item.completed", itemId: "tool-fail", ok: false }),
    ]);
  });

  it.each(["happy", "fail-after-text", "hang"])("settles an open tool when the turn ends (%s)", async (mode) => {
    process.env.FAKE_MSP_ITEMS = JSON.stringify([
      { method: "item/started", params: { item: { itemId: "tool-open", kind: "toolCall", tool: "shell", status: "inProgress" } } },
    ]);
    await create(mode);
    await instance.adapter.sendTurn({ threadId: "t-tool-open", text: "hi" });
    if (mode === "hang") {
      expect(await recorder.until((e) => e.type === "item.started")).toMatchObject({ itemId: "tool-open" });
      expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
      await instance.adapter.interruptTurn("t-tool-open");
    }
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => "itemType" in e && e.itemType === "tool")).toEqual([
      expect.objectContaining({ type: "item.started", itemId: "tool-open" }),
      expect.objectContaining({ type: "item.completed", itemId: "tool-open", ok: false }),
    ]);
    const done = recorder.events.findIndex((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(done).toBeLessThan(recorder.events.findIndex((e) => e.type === "turn.completed"));
  });

  it("holds an echo-gated turn open until its gate file exists", async () => {
    const gate = join(scratch, "turn.gate");
    const rpcDump = join(scratch, "muse-gated-rpc.json");
    process.env.FAKE_MSP_GATE_FILE = gate;
    process.env.FAKE_MSP_RPC_DUMP = rpcDump;
    await create("echo-gated");
    await instance.adapter.sendTurn({ threadId: "t-gated", text: "steer me" });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toContain("turn/start"));
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    writeFileSync(gate, "open");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.filter((e) => e.type === "content.delta").map((e) => e.delta)).toEqual(["echo: steer me"]);
  });

  it("keeps reasoning and reminder children out of tool activity", async () => {
    process.env.FAKE_MSP_ITEMS = JSON.stringify([
      { method: "item/started", params: { item: { id: "reason-1", kind: "reasoning" } } },
      { method: "item/delta", params: { itemId: "reason-1", field: "text", delta: "thinking" } },
      { method: "item/completed", params: { item: { id: "reason-1", kind: "reasoning", status: "completed" } } },
      { method: "item/started", params: { item: { itemId: "reminder-1", kind: "reminderChild", status: "inProgress" } } },
      { method: "item/completed", params: { item: { itemId: "reminder-1", kind: "reminderChild", status: "completed" } } },
    ]);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-tool-filter", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => "itemType" in e && e.itemType === "tool")).toEqual([]);
    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    expect(deltas.filter((e) => e.streamKind === "assistant_text").map((e) => e.delta)).toEqual(["hello from fake msp"]);
    expect(recorder.events).not.toContainEqual(expect.objectContaining({ type: "item.completed", text: expect.stringContaining("thinking") }));
  });

  it("folds stable usage/changed notifications into account windows", async () => {
    const payload = {
      observedAtMs: 1_790_000_000_000,
      tier: "pro",
      window: { usedPercent: 22, windowDurationMins: 300, resetsAtMs: 1_790_000_000_000 },
      weekly: { usedPercent: 61, resetsAtMs: 1_790_172_800_000 },
    };
    process.env.FAKE_MSP_USAGE_CHANGED = JSON.stringify(payload);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-usage", text: "hi" });
    expect(await recorder.until((e) => e.type === "account.rate-limits.updated")).toMatchObject({
      type: "account.rate-limits.updated",
      observedAt: new Date(payload.observedAtMs).toISOString(),
      windows: [
        { id: "five_hour", usedPercent: 22, windowMinutes: 300, resetsAt: 1_790_000_000_000 },
        { id: "seven_day", usedPercent: 61, windowMinutes: 10_080, resetsAt: 1_790_172_800_000 },
      ],
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("reads the cached usage snapshot before settling a completed turn", async () => {
    const payload = {
      observedAtMs: 1_790_000_000_100,
      tier: "pro",
      window: { usedPercent: 23, windowDurationMins: 300, resetsAtMs: 1_790_000_000_000 },
      weekly: { usedPercent: 62, resetsAtMs: 1_790_172_800_000 },
    };
    process.env.FAKE_MSP_USAGE = JSON.stringify(payload);
    await create();
    await instance.adapter.sendTurn({ threadId: "t-usage-read", text: "hi" });
    expect(await recorder.until((e) => e.type === "account.rate-limits.updated")).toMatchObject({
      type: "account.rate-limits.updated",
      observedAt: new Date(payload.observedAtMs).toISOString(),
      windows: [
        { id: "five_hour", usedPercent: 23 },
        { id: "seven_day", usedPercent: 62 },
      ],
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("does not emit an account update when usage/read has no observation", async () => {
    process.env.FAKE_MSP_USAGE = JSON.stringify({});
    await create();
    await instance.adapter.sendTurn({ threadId: "t-usage-empty", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.some((event) => event.type === "account.rate-limits.updated")).toBe(false);
  });

  it.each(["usage-auth", "usage-transport"] as const)(
    "keeps a completed turn successful when usage/read has a %s failure",
    async (mode) => {
      await create(mode);
      await instance.adapter.sendTurn({ threadId: `t-${mode}`, text: "hi" });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(recorder.events.some((event) => event.type === "account.rate-limits.updated")).toBe(false);
    },
  );

  it("omits modelId when no model is picked", async () => {
    const dump = join(scratch, "muse-nomodel.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-nomodel", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toContainEqual({
      method: "session/start",
      modelId: null,
    });
  });

  it("forwards effort verbatim as reasoningEffort on turn/start", async () => {
    const dump = join(scratch, "muse-effort.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "ultra" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.turn-params.json`, "utf8"))).toMatchObject({
      reasoningEffort: "ultra",
    });
  });

  it("sends literal max without mapping it to ultra", async () => {
    const dump = join(scratch, "muse-effort-max.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-effort-max", text: "hi", effort: "max" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(`${dump}.turn-params.json`, "utf8"))).toMatchObject({
      reasoningEffort: "max",
    });
  });

  it("omits reasoningEffort when effort is unset", async () => {
    const dump = join(scratch, "muse-effort-unset.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-effort-unset", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    // SAFETY: the fake writes msg.params verbatim; only the effort key is read.
    const params = JSON.parse(readFileSync(`${dump}.turn-params.json`, "utf8")) as { reasoningEffort?: string };
    expect(params).not.toHaveProperty("reasoningEffort");
  });

  it("omits reasoningEffort when effort is none", async () => {
    const dump = join(scratch, "muse-effort-none.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-effort-none", text: "hi", effort: "none" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    // SAFETY: the fake writes msg.params verbatim; only the effort key is read.
    const params = JSON.parse(readFileSync(`${dump}.turn-params.json`, "utf8")) as { reasoningEffort?: string };
    expect(params).not.toHaveProperty("reasoningEffort");
  });

  it("resumes a remembered session instead of starting one", async () => {
    const rpcDump = join(scratch, "muse-resume-rpc.json");
    process.env.FAKE_MSP_RPC_DUMP = rpcDump;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "old-session" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    const methods = JSON.parse(readFileSync(rpcDump, "utf8")) as string[];
    expect(methods).toContain("session/resume");
    expect(methods).not.toContain("session/start");
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "session.started", sessionId: "old-session" }),
    );
  });

  it("carries the terminal MCP server through resume and fresh recovery", async () => {
    const dump = join(scratch, "muse-resume-terminal.json");
    process.env.FAKE_MSP_DUMP = dump;
    process.env.FAKE_MSP_RPC_DUMP = join(scratch, "muse-resume-terminal-rpc.json");
    await create("resume-fails");
    const terminal = {
      command: "node",
      args: ["terminal-proxy.mjs"],
      env: { OMB_TERMINAL_TOKEN: "test-token" },
    };
    await instance.adapter.sendTurn({
      threadId: "t-resume-terminal",
      text: "again",
      resumeCursor: "old-session",
      resumeFallback: { text: "fallback hi" },
      integrations: { terminal },
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
    expect(calls).toContainEqual({
      method: "session/start",
      modelId: null,
      mcpServers: { terminal: { transport: "stdio", ...terminal } },
    });
  });

  it("passes the terminal MCP server to remembered sessions", async () => {
    const dump = join(scratch, "muse-resume-terminal-live.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    const terminal = {
      command: "node",
      args: ["terminal-proxy.mjs"],
      env: { OMB_TERMINAL_TOKEN: "test-token" },
    };
    await instance.adapter.sendTurn({
      threadId: "t-resume-terminal-live",
      text: "again",
      resumeCursor: "old-session",
      integrations: { terminal },
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
    expect(calls).toContainEqual({
      method: "session/resume",
      params: expect.objectContaining({
        config: { mcpServers: { terminal: { transport: "stdio", ...terminal } } },
      }),
    });
  });

  // The host ignores unknown keys instead of rejecting them, so a top-level
  // mount or a missing sessionMcp grant loses every tool in silence.
  it("negotiates the sessionMcp grant so the mount is not rejected", async () => {
    const dump = join(scratch, "muse-session-mcp.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-session-mcp",
      text: "hi",
      integrations: { terminal: { command: "node", args: ["terminal-proxy.mjs"], env: {} } },
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
    // The fake only records servers it accepted out of `config.mcpServers`,
    // and only once the grant was negotiated at initialize.
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
    expect(calls[0]).toMatchObject({ method: "session/start", mcpServers: { terminal: { transport: "stdio" } } });
  });

  it("settles a hung turn as cancelled on interrupt", async () => {
    const rpcDump = join(scratch, "muse-interrupt-rpc.json");
    process.env.FAKE_MSP_RPC_DUMP = rpcDump;
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-hang", text: "hi" });
    await recorder.until((e) => e.type === "session.started");
    await instance.adapter.interruptTurn("t-hang");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({
      ok: true,
      stopReason: "cancelled",
    });
    expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toContain("turn/interrupt");
    expect(instance.adapter.hasSession("t-hang")).toBe(false);
  });

  it("fails the turn when the host exits early", async () => {
    await create("exit-early");
    await instance.adapter.sendTurn({ threadId: "t-exit", text: "hi" });
    await recorder.until((e) => e.type === "runtime.error");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
  });

  it("keeps streamed text when the turn fails after it", async () => {
    await create("fail-after-text");
    await instance.adapter.sendTurn({ threadId: "t-fail", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "content.delta", delta: "half a report, then a crash" }),
    );
  });

  it("settles when turn/completed shares the turn/start ack's stdout chunk", async () => {
    process.env.FAKE_MSP_COALESCE = "1";
    await create("fail-after-text");
    await instance.adapter.sendTurn({ threadId: "t-coalesced", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: false });
  });

  it("ignores a resumed session's replayed completion of the prior turn", async () => {
    await create("resume-stale-cancel");
    await instance.adapter.sendTurn({ threadId: "t-stale-cancel", text: "hi", resumeCursor: "prior-session" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true, stopReason: null });
    expect(recorder.events.some((e) => e.type === "item.completed")).toBe(true);
  });

  it("rejects a second turn while one is in flight", async () => {
    await create("hang");
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "first" });
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "second" })).rejects.toThrow(
      /already running/,
    );
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("decides an approval with the approved choice and requirement", async () => {
    const dump = join(scratch, "muse-approve.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval");
    await instance.adapter.sendTurn({ threadId: "t-approve", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell" });
    expect(await instance.adapter.respondToRequest("t-approve", opened.requestId!, { behavior: "allow" })).toBe(
      "allowed-once",
    );
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    const [decide] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(decide).toMatchObject({
      method: "approval/decide",
      params: {
        approvalId: "fake-approval-1",
        choiceId: "allow-once",
        requirementId: { approvalId: "fake-approval-1", sourceIndex: 0 },
      },
    });
    expect(decide.params.commandId).toMatch(V7);
    // The resolved event trails the decide ack by a microtask; await it.
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({
      behavior: "allow",
      source: "user",
    });
  });

  it("decides the denied choice on deny", async () => {
    const dump = join(scratch, "muse-deny.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval");
    await instance.adapter.sendTurn({ threadId: "t-deny", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(await instance.adapter.respondToRequest("t-deny", opened.requestId!, { behavior: "deny" })).toBe(
      "rejected",
    );
    await recorder.until((e) => e.type === "turn.completed");
    const [decide] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(decide.params).toMatchObject({ choiceId: "deny" });
  });

  it("settles a deny as user-denied when the decide settlement fails, without failing the turn", async () => {
    const dump = join(scratch, "muse-denyfail.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval-decide-fails");
    await instance.adapter.sendTurn({ threadId: "t-denyfail", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(await instance.adapter.respondToRequest("t-denyfail", opened.requestId!, { behavior: "deny" })).toBe(
      "rejected",
    );
    // The card settles as denied by the user — the one outcome message —
    // instead of failing the turn over the host's settlement internals.
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({
      behavior: "deny",
      source: "user",
    });
    const [decide] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(decide.params).toMatchObject({ choiceId: "deny" });
    // The turn is still alive: interrupting it settles as cancelled, and no
    // runtime.error (ledger/fence internals) ever surfaced.
    await instance.adapter.interruptTurn("t-denyfail");
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({
      ok: true,
      stopReason: "cancelled",
    });
    expect(recorder.events.map((e) => e.type)).not.toContain("runtime.error");
  });

  it("answers the receipt for an id-bearing approval request", async () => {
    const dump = join(scratch, "muse-approval-rpc.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval-request");
    await instance.adapter.sendTurn({ threadId: "t-approval-rpc", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-approval-rpc", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    const calls = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(calls).toContainEqual({ method: "approval/receipt", result: {} });
    expect(calls).toContainEqual(expect.objectContaining({ method: "approval/decide" }));
  });

  it("opens and decides one card when the host sends both approval/request and approval/requested", async () => {
    const dump = join(scratch, "muse-approval-both.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval-both");
    await instance.adapter.sendTurn({ threadId: "t-approval-both", text: "hi" });
    await recorder.until((e) => e.type === "request.opened");
    // Auto-approve answers every card it sees, like the server's auto-mode.
    for (const e of recorder.events.filter((e) => e.type === "request.opened")) {
      await instance.adapter.respondToRequest("t-approval-both", e.requestId!, { behavior: "allow" });
    }
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(1);
    expect(recorder.events.map((e) => e.type)).not.toContain("runtime.error");
    const calls = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(calls.filter((c: { method: string }) => c.method === "approval/decide")).toHaveLength(1);
  });

  it("decides every stage of a staged approval after one allow", async () => {
    const dump = join(scratch, "muse-approval-staged.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval-staged");
    await instance.adapter.sendTurn({ threadId: "t-approval-staged", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-approval-staged", opened.requestId!, { behavior: "allow" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.filter((e) => e.type === "request.opened")).toHaveLength(1);
    const decides = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(decides.map((c: any) => [c.params.choiceId, c.params.requirementId.sourceIndex])).toEqual([
      ["allow-once", 0],
      ["allow-once", 1],
      ["allow-once", 2],
    ]);
  });

  it("keeps the turn alive when an allow decide lands but its settlement ack fails", async () => {
    const dump = join(scratch, "muse-settle-fails.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval-settle-fails");
    await instance.adapter.sendTurn({ threadId: "t-settle-fails", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-settle-fails", opened.requestId!, { behavior: "allow" });
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({
      behavior: "allow",
      source: "user",
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.map((e) => e.type)).not.toContain("runtime.error");
    const decides = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(decides).toHaveLength(2);
  });

  it("settles a stale allow decide without failing the turn", async () => {
    await create("approval-stale");
    await instance.adapter.sendTurn({ threadId: "t-approval-stale", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-approval-stale", opened.requestId!, { behavior: "allow" });
    expect(await recorder.until((e) => e.type === "request.resolved")).toMatchObject({
      behavior: "deny",
      source: "system",
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.map((e) => e.type)).not.toContain("runtime.error");
  });

  it("auto-allows without a card in fullAuto", async () => {
    const dump = join(scratch, "muse-auto.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("approval", true);
    await instance.adapter.sendTurn({ threadId: "t-auto", text: "hi" });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.map((e) => e.type)).not.toContain("request.opened");
    const [decide] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(decide.params).toMatchObject({ choiceId: "allow-once" });
  });

  it("answers a userInput question", async () => {
    const dump = join(scratch, "muse-ui.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("userinput");
    await instance.adapter.sendTurn({ threadId: "t-ui", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "question" });
    expect(
      await instance.adapter.respondToRequest("t-ui", opened.requestId!, { behavior: "answer", message: "A" }),
    ).toBe("answered");
    await recorder.until((e) => e.type === "turn.completed");
    const [answer] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(answer).toMatchObject({
      method: "userInput/answer",
      params: { userInputId: "fake-ui-1", answers: [{ questionId: "q1", freeText: "A" }] },
    });
  });

  it("cancels a userInput question on deny", async () => {
    const dump = join(scratch, "muse-uicancel.json");
    process.env.FAKE_MSP_DUMP = dump;
    await create("userinput");
    await instance.adapter.sendTurn({ threadId: "t-uicancel", text: "hi" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(await instance.adapter.respondToRequest("t-uicancel", opened.requestId!, { behavior: "deny" })).toBe(
      "rejected",
    );
    await recorder.until((e) => e.type === "turn.completed");
    const [cancel] = JSON.parse(readFileSync(`${dump}.decide.json`, "utf8"));
    expect(cancel).toMatchObject({ method: "userInput/cancel", params: { userInputId: "fake-ui-1" } });
  });

  it("falls back to a fresh session with fallback text when resume is rejected", async () => {
    const dump = join(scratch, "muse-resumefail.json");
    process.env.FAKE_MSP_DUMP = dump;
    process.env.FAKE_MSP_RPC_DUMP = join(scratch, "muse-resumefail-rpc.json");
    await create("resume-fails");
    await instance.adapter.sendTurn({
      threadId: "t-resumefail",
      text: "original",
      resumeCursor: "gone-session",
      resumeFallback: { text: "fallback hi" },
    });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
    const methods = JSON.parse(readFileSync(join(scratch, "muse-resumefail-rpc.json"), "utf8")) as string[];
    expect(methods).toContain("session/resume");
    expect(methods).toContain("session/start");
    expect(JSON.parse(readFileSync(`${dump}.turn.json`, "utf8"))).toEqual([{ type: "text", text: "fallback hi" }]);
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "session.started", sessionId: "fake-msp-session" }),
    );
  });

  it.each(["resume-poisoned", "resume-poisoned-rpc"])(
    "recovers poisoned history (%s) with one fresh session and the fallback text",
    async (mode) => {
      const dump = join(scratch, `muse-poison-${mode}.json`);
      process.env.FAKE_MSP_DUMP = dump;
      await create(mode);
      await instance.adapter.sendTurn({
        threadId: "t-poison",
        text: "original",
        resumeCursor: "foreign-session",
        resumeFallback: { text: "fallback hi" },
      });
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({ ok: true });
      expect(recorder.events.filter((e) => e.type === "session.started").map((e) => (e as { sessionId?: string }).sessionId))
        .toEqual(["foreign-session", "fake-msp-session"]);
      expect(JSON.parse(readFileSync(`${dump}.turn.json`, "utf8"))).toEqual([{ type: "text", text: "fallback hi" }]);
    },
  );

  it("pins a new model via setModel and the switch sticks", async () => {
    const dump = join(scratch, "muse-switch.json");
    process.env.FAKE_MSP_DUMP = dump;
    process.env.FAKE_MSP_STATE = join(scratch, "muse-switch-state.json");
    await create();
    expect(instance.adapter.capabilities.sessionModelSwitch).toBe("in-session");

    await instance.adapter.sendTurn({ threadId: "t-switch", text: "hi", model: "muse-spark-1.3" });
    const first = await recorder.until((e) => e.type === "turn.completed");
    expect(first).toMatchObject({ ok: true });
    const started = recorder.events.find((e) => e.type === "session.started");
    if (started?.type !== "session.started") throw new Error("no session started");

    const second = await instance.adapter.sendTurn({
      threadId: "t-switch",
      text: "again",
      resumeCursor: started.sessionId,
      model: "muse-spark-1.3-contributor",
    });
    expect(
      await recorder.until((e) => e.type === "turn.completed" && (e as { turnId?: string }).turnId === second.turnId),
    ).toMatchObject({ ok: true });
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{
      method: string;
      params: Record<string, unknown>;
    }>;
    const set = calls.find((c) => c.method === "session/setModel");
    expect(set?.params).toMatchObject({
      sessionId: "fake-msp-session",
      model: { modelId: "muse-spark-1.3-contributor" },
    });
    expect(set?.params.commandId).toMatch(V7);

    await instance.adapter.sendTurn({ threadId: "t-switch", text: "third", resumeCursor: started.sessionId });
    await recorder.until(
      (e) => e.type === "turn.completed" && (e as { turnId?: string }).turnId !== second.turnId && e !== first,
    );
    const lastStarted = [...recorder.events].reverse().find((e) => e.type === "session.started");
    expect(lastStarted).toMatchObject({ sessionId: "fake-msp-session", model: "muse-spark-1.3-contributor" });
  });

  it("recovers Contributor 1.3 when resumed reasoning is not issued to the caller", async () => {
    const dump = join(scratch, "muse-contributor-encrypted.json");
    process.env.FAKE_MSP_DUMP = dump;
    process.env.FAKE_MSP_STATE = join(scratch, "muse-contributor-encrypted-state.json");
    await create("resume-encrypted-poisoned");
    await instance.adapter.sendTurn({ threadId: "t-contributor-encrypted", text: "hey", model: "muse-spark-1.3" });
    const first = await recorder.until((e) => e.type === "turn.completed");
    expect(first).toMatchObject({ ok: true });

    const second = await instance.adapter.sendTurn({
      threadId: "t-contributor-encrypted",
      text: "hey",
      resumeCursor: "fake-msp-session",
      resumeFallback: { text: "hey" },
      model: "muse-spark-1.3-contributor",
    });
    expect(
      await recorder.until((e) => e.type === "turn.completed" && (e as { turnId?: string }).turnId === second.turnId),
    ).toMatchObject({ ok: true });
    expect(recorder.events).not.toContainEqual(
      expect.objectContaining({ type: "runtime.error", message: expect.stringContaining("encrypted_content") }),
    );
    expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toContainEqual({
      method: "session/start",
      modelId: "muse-spark-1.3-contributor",
    });
    expect(JSON.parse(readFileSync(`${dump}.turn.json`, "utf8"))).toEqual([{ type: "text", text: "hey" }]);
  });

  it("skips setModel when the session already runs the model", async () => {
    const dump = join(scratch, "muse-samemodel.json");
    process.env.FAKE_MSP_DUMP = dump;
    process.env.FAKE_MSP_STATE = join(scratch, "muse-samemodel-state.json");
    await create();
    await instance.adapter.sendTurn({ threadId: "t-same", text: "hi", model: "muse-spark-1.3" });
    await recorder.until((e) => e.type === "turn.completed");
    const started = recorder.events.find((e) => e.type === "session.started");
    if (started?.type !== "session.started") throw new Error("no session started");
    const retry = await instance.adapter.sendTurn({
      threadId: "t-same",
      text: "again",
      resumeCursor: started.sessionId,
      model: "muse-spark-1.3",
    });
    expect(
      await recorder.until((e) => e.type === "turn.completed" && (e as { turnId?: string }).turnId === retry.turnId),
    ).toMatchObject({ ok: true });
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{ method: string }>;
    expect(calls.map((c) => c.method)).not.toContain("session/setModel");
  });

  it("maps an authRequired mid-turn failure to setup", async () => {
    await create("auth-failure");
    await instance.adapter.sendTurn({ threadId: "t-authfail", text: "hi" });
    const error = await recorder.until((e) => e.type === "runtime.error");
    expect(error).toMatchObject({ message: "login expired", signIn: true });
    expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({
      ok: false,
      stopReason: "auth_required",
    });
  });
});

describe("MSP prewarm (fake host)", () => {
  let instance: ProviderInstance;
  let scratch: string;
  let rpcDump: string;

  const create = async (isAuthenticated: () => boolean | Promise<boolean> = () => true, warmPool?: WarmPool) => {
    const Driver = createMspDriver({
      warmPool,
      driverKind: "museAgent",
      displayName: "MSP Prewarm",
      models: { default: "muse-spark-1.3", options: [] },
      defaultCli: FAKE_CLI,
      nativeSource: "muse.msp",
      loginNote: "sign in",
      isAuthenticated,
      requireAuthenticationBeforeSpawn: true,
    });
    instance = await Driver.create({
      instanceId: "msp-prewarm",
      displayName: "MSP Prewarm",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch },
    });
  };
  const runTurn = async (threadId: string) => {
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId, text: "hi" });
      return await recorder.until((e) => e.type === "turn.completed");
    } finally {
      recorder.stop();
    }
  };
  const serveSpawns = (spawn: { mock: { calls: unknown[][] } }) =>
    spawn.mock.calls.filter((call) => (call[1] as string[]).includes("serve")).length;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = temps.make(join(tmpdir(), "omb-msp-prewarm-"));
    rpcDump = join(scratch, "rpc.json");
    process.env.FAKE_MSP_RPC_DUMP = rpcDump;
  });

  afterEach(async () => {
    delete process.env.FAKE_MSP_RPC_DUMP;
    delete process.env.FAKE_MSP_INIT_DELAY_MS;
    vi.useRealTimers();
    await instance?.dispose();
    vi.restoreAllMocks();
    await removeTempDir(scratch);
  });

  it("hands the prewarmed host to the next turn without a second initialize", async () => {
    const spawn = vi.spyOn(procs, "spawnCli");
    await create();
    await instance.prepare!();
    expect(serveSpawns(spawn)).toBe(1);
    // `initialized` is a notification, so the fake host logs it after prepare() resolves.
    await vi.waitFor(() => expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize", "initialized"]));

    expect(await runTurn("t-prewarm")).toMatchObject({ ok: true });
    expect(serveSpawns(spawn)).toBe(1);
    const methods = JSON.parse(readFileSync(rpcDump, "utf8")) as string[];
    expect(methods.filter((m) => m === "initialize")).toHaveLength(1);
    expect(methods).toContain("turn/start");
  });

  it("runs the handshake host at low priority until a turn adopts it", async () => {
    const spawn = vi.spyOn(procs, "spawnCli");
    const priority = vi.spyOn(procs, "setCliPriority");
    await create();
    await instance.prepare!();
    const child = spawn.mock.results[0].value;
    expect(priority.mock.calls).toEqual([[child, "low"]]);
    expect(await runTurn("t-prewarm")).toMatchObject({ ok: true });
    expect(priority.mock.calls).toEqual([[child, "low"], [child, "normal"]]);
  });

  it("drops a Stop during the warm handshake without starting the turn", async () => {
    process.env.FAKE_MSP_INIT_DELAY_MS = "30000";
    const spawn = vi.spyOn(procs, "spawnCli");
    await create();
    void instance.prepare!();
    await vi.waitFor(() => expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize"]));
    const child = spawn.mock.results[0].value as ReturnType<typeof procs.spawnCli>;
    const recorder = recordEvents(instance.adapter);
    try {
      const sent = instance.adapter.sendTurn({ threadId: "t-warm-stop", text: "hi" });
      await new Promise((resolve) => setImmediate(resolve));
      await instance.adapter.interruptTurn("t-warm-stop");
      await sent;
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({
        ok: true,
        stopReason: "cancelled",
      });
      expect(recorder.events.map((e) => e.type)).toEqual(["turn.started", "turn.stage", "turn.completed"]);
    } finally {
      recorder.stop();
    }
    expect(serveSpawns(spawn)).toBe(1);
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize"]);
    expect(instance.adapter.hasSession("t-warm-stop")).toBe(false);
  });

  it("drops a Stop during the auth check without spawning", async () => {
    let authed!: (ok: boolean) => void;
    const spawn = vi.spyOn(procs, "spawnCli");
    await create(() => new Promise<boolean>((resolve) => (authed = resolve)));
    const recorder = recordEvents(instance.adapter);
    try {
      const sent = instance.adapter.sendTurn({ threadId: "t-auth-stop", text: "hi" });
      await instance.adapter.interruptTurn("t-auth-stop");
      authed(true);
      await sent;
      expect(await recorder.until((e) => e.type === "turn.completed")).toMatchObject({
        ok: true,
        stopReason: "cancelled",
      });
    } finally {
      recorder.stop();
    }
    expect(serveSpawns(spawn)).toBe(0);
    expect(instance.adapter.hasSession("t-auth-stop")).toBe(false);
  });

  it("kills an unclaimed prewarmed host after the idle TTL and cold-spawns the next turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const spawn = vi.spyOn(procs, "spawnCli");
    await create();
    await instance.prepare!();
    const child = spawn.mock.results[0].value as ReturnType<typeof procs.spawnCli>;
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(child.exitCode).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);

    expect(await runTurn("t-expired")).toMatchObject({ ok: true });
    expect(serveSpawns(spawn)).toBe(2);
  });

  it("a small PC holds a click-warmed host 60 s, then a Claude prepared session is admitted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const small = createWarmPool({ totalmem: () => 4 * 1024 ** 3, freemem: () => 3 * 1024 ** 3, cpus: () => 4 });
    const spawn = vi.spyOn(procs, "spawnCli");
    await create(() => true, small);
    await instance.prepare!();
    const child = spawn.mock.results[0].value as ReturnType<typeof procs.spawnCli>;
    const claude = () => small.reserve({ engine: "claudeAgent", instanceId: "claude", threadId: "t" }, "fp", { generation: 0, incarnation: "c", identity: "i" }, "speculative");
    expect(claude()).toBe("denied");
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(claude()).not.toBe("denied");
    await small.closeAll("test", { final: true });
  });

  it("keeps at most one idle prewarmed host", async () => {
    const spawn = vi.spyOn(procs, "spawnCli");
    await create();
    await Promise.all([instance.prepare!(), instance.prepare!()]);
    await instance.prepare!();
    expect(serveSpawns(spawn)).toBe(1);
  });

  it("probes the CLI version once per instance, not per turn", async () => {
    const exec = vi.spyOn(procs, "execCli");
    await create();
    expect(await runTurn("t-probe-1")).toMatchObject({ ok: true });
    expect(await runTurn("t-probe-2")).toMatchObject({ ok: true });
    const versionProbes = () => exec.mock.calls.filter((call) => (call[1] as string[]).includes("--version"));
    expect(versionProbes()).toHaveLength(1);
    await instance.prepare!();
    expect(versionProbes()).toHaveLength(1);
  });
});

describe.runIf(process.platform === "win32")("MSP Muse host start (fake install)", () => {
  let instance: ProviderInstance | undefined;
  let dir: string;
  let install: { cli: string; exe: string };
  let mapped: Set<string>;
  let spawn: MockInstance<typeof procs.spawnCli>;
  const realSpawn = procs.spawnCli;
  const serveCalls = () => spawn.mock.calls.filter((call) => call[1].includes("serve"));
  const start = async () => (instance ??= await MspMuseAgentDriver.create({
    instanceId: "muse-direct",
    displayName: "Muse",
    environment: {},
    enabled: true,
    config: { cli: install.cli, fullAuto: true, workspace: dir },
  }));
  const runTurn = async (threadId: string) => {
    const instance = await start();
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId, text: "hi" });
      return await recorder.until((e) => e.type === "turn.completed");
    } finally {
      recorder.stop();
    }
  };

  beforeEach(() => {
    ensureDirs();
    process.env.META_API_KEY = "meta-key";
    dir = temps.make(join(tmpdir(), "omb-muse-install-"));
    install = fakeMuseInstall(dir, FAKE_CLI);
    // A mapped placeholder exe runs the fake host; an unmapped one fails to start.
    mapped = new Set([install.exe]);
    spawn = vi.spyOn(procs, "spawnCli").mockImplementation((cli, args, opts) => realSpawn(mapped.has(cli) ? FAKE_CLI : cli, args, opts));
  });

  afterEach(async () => {
    delete process.env.META_API_KEY;
    await instance?.dispose();
    instance = undefined;
    vi.restoreAllMocks();
  });

  it("starts the engine exe itself with the env the launcher sets", async () => {
    const exec = vi.spyOn(procs, "execCli");
    expect(await runTurn("t-direct")).toMatchObject({ ok: true });
    const [[command, , opts]] = serveCalls();
    expect(command).toBe(install.exe);
    expect(opts.env).toMatchObject({
      MUSE_RELEASE_INFO: readFileSync(join(dir, ".muse-release-info.json"), "utf8"),
      PSExecutionPolicyPreference: "Bypass",
    });
    // The version probe still runs the launcher, and with it Muse's update check.
    expect(exec.mock.calls.some(([cli, args]) => cli === install.cli && args.includes("--version"))).toBe(true);
  });

  it("lowers a direct-started handshake host and leaves the launcher at Normal", async () => {
    // The host inherits the runner's class, which can itself be below Normal.
    const runner = os.getPriority();
    os.setPriority(os.constants.priority.PRIORITY_NORMAL);
    const hostPriority = async () => {
      await (await start()).prepare!();
      const index = spawn.mock.calls.findLastIndex((call) => call[1].includes("serve"));
      return os.getPriority(spawn.mock.results[index].value.pid);
    };
    try {
      expect(await hostPriority()).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL);
      await instance!.dispose();
      instance = undefined;
      mapped.clear();
      expect(await hostPriority()).toBe(os.constants.priority.PRIORITY_NORMAL);
      expect(serveCalls().map(([command]) => command)).toEqual([install.exe, install.exe, install.cli]);
    } finally {
      os.setPriority(runner);
    }
  });

  it("follows an update that renames the exe", async () => {
    expect(await runTurn("t-before")).toMatchObject({ ok: true });
    const next = museUpdate(dir, "1.4.19-R2.1");
    mapped.add(next);
    rmSync(install.exe);
    expect(await runTurn("t-after")).toMatchObject({ ok: true });
    expect(serveCalls().map(([command]) => command)).toEqual([install.exe, next]);
  });

  it.each<[string, () => void]>([
    ["the version file is missing", () => rmSync(join(dir, ".muse-version"))],
    ["the exe it names is gone", () => rmSync(install.exe)],
    ["Muse's update check is due", () => writeFileSync(join(dir, ".muse-update-checked-at"), "0\n")],
    ["the exe fails to start", () => mapped.clear()],
  ])("falls back to the launcher when %s", async (_, breakInstall) => {
    breakInstall();
    expect(await runTurn("t-fallback")).toMatchObject({ ok: true });
    expect(serveCalls().at(-1)![0]).toBe(install.cli);
  });
});

describe("MSP warm host (recorded transport)", () => {
  const fixture = JSON.parse(readFileSync("test/fixtures/recorded/muse/two-turns-one-host.json", "utf8"));
  type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
  const wire = fixture.reply.wire as Array<{ at: number; dir: "in" | "out"; msg: Message }>;
  const blocks = new Map<string, Array<{ request: Message; replies: Message[] }>>();
  wire.forEach((entry, index) => {
    if (entry.dir !== "out" || !entry.msg.method) return;
    const replies: Message[] = [];
    for (const next of wire.slice(index + 1)) {
      if (next.dir === "out") break;
      replies.push(next.msg);
    }
    blocks.set(entry.msg.method, [...(blocks.get(entry.msg.method) ?? []), { request: entry.msg, replies }]);
  });
  const recordedSession: string = blocks.get("session/start")![0].replies.find((m) => m.id !== undefined)!.result.session.sessionId;
  const MODEL = fixture.stamp.model as string;

  /** Runs before each recorded reply is written; may edit it, hold it, or return false to drop it. */
  type Gate = (method: string, message: Message, peer: number, nth: number) => Promise<void | false> | void | false;
  let peers: ReturnType<typeof makePeer>[];
  let pool: WarmPool;
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let account: string | undefined;
  let authed: () => boolean | Promise<boolean>;
  let accountCalls: number;
  const labelHash = (label: string) => createHash("sha256").update(label).digest("hex");
  let gate: Gate;
  let answerInterrupt: boolean;

  function makePeer(index: number) {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
      signalCode: null as string | null, killed: false, pid: index + 910_000,
    });
    const requests: Message[] = [];
    const responses: Message[] = [];
    const counts = new Map<string, number>();
    const end = (code: number) => {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      child.stdout.end();
      child.emit("exit", code);
      child.emit("close", code);
    };
    const write = (message: Message) => {
      if (child.exitCode === null) child.stdout.write(`${JSON.stringify(message)}\n`);
    };
    const replay = async (request: Message) => {
      const method = request.method!;
      const n = counts.get(method) ?? 0;
      counts.set(method, n + 1);
      // The recording has no resume: a resume answers like the recorded start, on the asked-for id.
      const recorded = blocks.get(method === "session/resume" ? "session/start" : method);
      if (!recorded) {
        if (request.id !== undefined) write({ id: request.id, error: fixture.reply.unknownMethod });
        return;
      }
      const block = recorded[n % recorded.length];
      const session = request.params?.sessionId ?? recordedSession;
      let text = JSON.stringify(block.replies).split(recordedSession).join(session);
      if (block.request.params?.commandId && request.params?.commandId) {
        text = text.split(block.request.params.commandId).join(request.params.commandId);
      }
      for (const reply of JSON.parse(text) as Message[]) {
        if (reply.id !== undefined) reply.id = request.id;
        if ((await gate(method, reply, index, n + 1)) === false) continue;
        await Promise.resolve();
        write(reply);
      }
    };
    const stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const message: Message = JSON.parse(line);
        if (!message.method) {
          responses.push(message);
          continue;
        }
        requests.push(message);
        // The recording has no interrupt: answer it the way muse serve does.
        if (message.method === "turn/interrupt") {
          if (answerInterrupt) write({ jsonrpc: "2.0", method: "turn/completed", params: { ...message.params, terminal: "cancelled" } } as Message);
          continue;
        }
        void replay(message);
      }
      done();
    } });
    stdin.on("finish", () => setTimeout(() => end(0), fixture.reply.exit.stdinCloseMs));
    return { child: Object.assign(child, { stdin }), requests, responses, write, end };
  }

  const start = async () => {
    const Driver = createMspDriver({
      driverKind: "museAgent",
      displayName: "Meta Muse",
      models: { default: "muse-spark-1.3", options: [] },
      defaultCli: "recorded-muse",
      nativeSource: "muse.msp",
      loginNote: "sign in",
      isAuthenticated: () => authed(),
      account: () => {
        accountCalls += 1;
        return account;
      },
      requireAuthenticationBeforeSpawn: true,
      warmPool: pool,
    } as Parameters<typeof createMspDriver>[0]);
    instance = await Driver.create({
      instanceId: "recorded-muse", incarnation: "muse#7", displayName: "Meta Muse", environment: {}, enabled: true,
      config: { cli: "recorded-muse", fullAuto: false, workspace: "<workspace>" },
    });
    recorder = recordEvents(instance.adapter);
  };
  const send = async (input: Partial<SendTurnInput> = {}) => {
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "recorded-thread", text: "Reply only OK.", model: MODEL, effort: "medium", cwd: "<workspace>", ...input,
    });
    return turnId;
  };
  const completed = (turnId: string) => recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
  const cursorOf = (turnId: string) =>
    (recorder.events.find((e) => e.type === "session.started" && e.turnId === turnId) as { sessionId: string }).sessionId;
  const methods = (peer: { requests: Message[] }) => peer.requests.map((m) => m.method);

  beforeEach(() => {
    peers = [];
    account = "Recorded Name";
    accountCalls = 0;
    authed = () => true;
    gate = () => {};
    answerInterrupt = true;
    pool = createWarmPool({ totalmem: () => 32 * 1024 ** 3, freemem: () => 16 * 1024 ** 3, cpus: () => 16 });
    vi.spyOn(procs, "execCli").mockImplementation((_cli, _args, _options, callback) => callback(null, fixture.stamp.cliVersion));
    vi.spyOn(procs, "spawnCli").mockImplementation(() => {
      const peer = makePeer(peers.length);
      peers.push(peer);
      return peer.child as unknown as ReturnType<typeof procs.spawnCli>;
    });
    vi.spyOn(procs, "killCliTree").mockImplementation((child) => {
      const peer = peers.find((p) => p.child === (child as unknown));
      if (peer) {
        peer.child.killed = true;
        peer.end(0);
      }
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    recorder?.stop();
    await instance?.dispose();
    await pool.closeAll("test complete", { final: true });
    for (const peer of peers) peer.end(0);
    vi.restoreAllMocks();
  });

  it("two completed turns use one host and skip the second initialize and resume", async () => {
    await start();
    const first = await send();
    expect(await completed(first)).toMatchObject({ ok: true, stopReason: null });
    const second = await send({ resumeCursor: cursorOf(first), effort: "low", text: "Reply only OK again." });
    expect(await completed(second)).toMatchObject({ ok: true, stopReason: null });
    expect(peers).toHaveLength(1);
    expect(methods(peers[0]).filter((m) => m === "initialize")).toHaveLength(1);
    expect(methods(peers[0])).not.toContain("session/resume");
    expect(peers[0].requests.filter((m) => m.method === "turn/start").map((m) => m.params.reasoningEffort)).toEqual(["medium", "low"]);
  });
  const kept = () => pool.stats().idle;
  const exited = (peer: { child: { exitCode: number | null } }) => peer.child.exitCode !== null;
  const stagesOf = (turnId: string) =>
    recorder.events.filter((e) => e.type === "turn.stage" && e.turnId === turnId).map((e) => (e as { stage: string }).stage);
  const indexOf = (match: (e: (typeof recorder.events)[number]) => boolean) => recorder.events.findIndex(match);
  const answers = (turnId: string) =>
    recorder.events.filter((e) => e.type === "item.completed" && e.turnId === turnId && e.itemType === "assistant_text");
  const hold = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    return { held, release };
  };
  const shapeFor = (input: Partial<PrepareTurn> = {}): PrepareTurn => ({
    threadId: "recorded-thread",
    model: MODEL,
    effort: "high",
    cwd: "<workspace>",
    depth: 0,
    captured: { generation: pool.generation({ engine: "museAgent", instanceId: "recorded-muse" }), incarnation: "muse#7", identity: account ? labelHash(account) : "" },
    ...input,
  });
  const smallerPc = () => {
    vi.spyOn(os, "totalmem").mockReturnValue(4 * 1024 ** 3);
  };
  const turnStarts = (peer: { requests: Message[] }) => peer.requests.filter((m) => m.method === "turn/start");
  /** Prepares a session for `cursor` whose resume reply is held until released. */
  const pendingPrepare = async (cursor: string) => {
    const gateOpen = hold();
    gate = (method, _reply, peer) => (peer === 0 && method === "session/resume" ? gateOpen.held : undefined);
    void instance.prepare!(shapeFor({ resumeCursor: cursor }));
    await vi.waitFor(() => expect(peers[0] && methods(peers[0])).toContain("session/resume"));
    return gateOpen;
  };

  it("never ends the turn at foregroundCompleted; background items land before turn.completed", async () => {
    const background = hold();
    gate = (method, reply) => (method === "turn/start" && reply.method === "usage/changed" ? background.held : undefined);
    await start();
    const turnId = await send();
    await recorder.until((e) => e.type === "turn.stage" && e.stage === "finishing");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recorder.events.some((e) => e.type === "turn.completed")).toBe(false);
    expect(instance.adapter.hasSession("recorded-thread")).toBe(true);
    background.release();
    expect(await completed(turnId)).toMatchObject({ ok: true, stopReason: null });
    const finishing = indexOf((e) => e.type === "turn.stage" && e.stage === "finishing");
    const usage = indexOf((e) => e.type === "account.rate-limits.updated");
    expect(usage).toBeGreaterThan(finishing);
    expect(usage).toBeLessThan(indexOf((e) => e.type === "turn.completed"));
  });

  it("emits finishing at foregroundCompleted, after the answer text", async () => {
    await start();
    const turnId = await send();
    await completed(turnId);
    const answer = indexOf((e) => e.type === "item.completed" && e.itemType === "assistant_text" && e.text === "OK");
    const finishing = indexOf((e) => e.type === "turn.stage" && e.stage === "finishing");
    expect(answer).toBeGreaterThan(-1);
    expect(finishing).toBeGreaterThan(answer);
    expect(finishing).toBeLessThan(indexOf((e) => e.type === "turn.completed"));
  });

  it("warm loaded session retains poisoned-history recovery", async () => {
    let starts = 0;
    gate = (method, reply, _peer, nth) => {
      if (method === "session/start" && reply.id !== undefined) starts += 1;
      if (method === "session/start" && starts === 2 && reply.result?.session) reply.result.session.sessionId = "fresh-session";
      if (method === "turn/start" && nth === 2 && reply.method === "turn/completed") {
        reply.params.terminal = "failed";
        reply.params.error = { message: "provider-private history is incompatible with the active route" };
      }
    };
    await start();
    const first = await send();
    await completed(first);
    const second = await send({ resumeCursor: cursorOf(first) });
    expect(await completed(second)).toMatchObject({ ok: true, stopReason: null });
    expect(peers).toHaveLength(1);
    expect(methods(peers[0]).filter((m) => m === "session/start")).toHaveLength(2);
    expect(turnStarts(peers[0]).at(-1)!.params.sessionId).toBe("fresh-session");
    expect(recorder.events.filter((e) => e.type === "session.started" && e.turnId === second).map((e) => (e as { sessionId: string }).sessionId))
      .toEqual([cursorOf(first), "fresh-session"]);
    await expect.poll(() => exited(peers[0])).toBe(true);
    expect(kept()).toBe(0);
  });

  it("replayed old turn/started cannot capture a new turn", async () => {
    await start();
    const first = await send();
    await completed(first);
    const old = turnStarts(peers[0])[0].params.commandId;
    const session = cursorOf(first);
    gate = (method, reply, peer, nth) => {
      if (method !== "turn/start" || nth !== 2 || reply.id === undefined) return;
      peers[peer].write({ jsonrpc: "2.0", method: "turn/started", params: { sessionId: session, turnId: old } } as Message);
      peers[peer].write({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: session, turnId: old, terminal: "cancelled" } } as Message);
    };
    const second = await send({ resumeCursor: session });
    expect(await completed(second)).toMatchObject({ ok: true, stopReason: null });
    expect(answers(second).map((e) => (e as { text: string }).text)).toEqual(["OK"]);
  });

  it("foreground completion before ack belongs to the correct turn", async () => {
    await start();
    const first = await send();
    await completed(first);
    let ack: Message | undefined;
    let foreground = false;
    gate = (method, reply, peer, nth) => {
      if (method !== "turn/start" || nth !== 2) return;
      if (reply.id !== undefined) {
        ack = reply;
        return false;
      }
      if (foreground && ack) {
        peers[peer].write(ack);
        ack = undefined;
      }
      if (reply.method === "turn/foregroundCompleted") foreground = true;
    };
    const second = await send({ resumeCursor: cursorOf(first) });
    expect(await completed(second)).toMatchObject({ ok: true, stopReason: null });
    expect(stagesOf(first)).toEqual(["setup", "prompt-sent", "finishing"]);
    expect(stagesOf(second)).toEqual(["prompt-sent", "finishing"]);
    expect(answers(second)).toHaveLength(1);
  });

  it("retained host has one handler set", async () => {
    await start();
    const first = await send();
    await completed(first);
    const exitListeners = peers[0].child.listenerCount("exit");
    const dataListeners = peers[0].child.stdout.listenerCount("data");
    const turns = [first];
    for (const effort of ["low", "medium"] as const) {
      const turnId = await send({ resumeCursor: cursorOf(first), effort });
      await completed(turnId);
      turns.push(turnId);
    }
    expect(peers).toHaveLength(1);
    expect(peers[0].child.listenerCount("exit")).toBe(exitListeners);
    expect(peers[0].child.stdout.listenerCount("data")).toBe(dataListeners);
    for (const turnId of turns) {
      expect(answers(turnId)).toHaveLength(1);
      expect(recorder.events.filter((e) => e.type === "content.delta" && e.turnId === turnId)).toHaveLength(1);
      expect(stagesOf(turnId).filter((stage) => stage === "finishing")).toHaveLength(1);
    }
  });

  it("a delayed request or notification between turns reaches no turn", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    await start();
    const first = await send();
    await completed(first);
    const before = recorder.events.length;
    const session = cursorOf(first);
    peers[0].write({ jsonrpc: "2.0", method: "item/started", params: { sessionId: session, item: { itemId: "late", kind: "agentMessage", turnId: "late-turn" } } } as Message);
    peers[0].write({ jsonrpc: "2.0", method: "item/delta", params: { sessionId: session, itemId: "late", field: "text", delta: "late text" } } as Message);
    peers[0].write({
      jsonrpc: "2.0", id: 9001, method: "approval/request",
      params: { sessionId: session, turnId: "late-turn", approvalId: "late-approval", availableChoices: [{ choiceId: "yes", decision: "approved" }] },
    } as Message);
    await vi.waitFor(() => expect(peers[0].responses.some((m) => m.id === 9001)).toBe(true));
    expect(peers[0].responses.find((m) => m.id === 9001)!.error.code).toBe(-32601);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("idle host dropped item/delta"));
    expect(recorder.events).toHaveLength(before);
    const second = await send({ resumeCursor: session });
    await completed(second);
    expect(recorder.events.some((e) => e.type === "content.delta" && e.delta === "late text")).toBe(false);
    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
  });

  it("an effort change keeps the warm session; a model or folder change drops it", async () => {
    await start();
    const first = await send();
    await completed(first);
    await completed(await send({ resumeCursor: cursorOf(first), effort: "low" }));
    expect(peers).toHaveLength(1);
    const model = await send({ resumeCursor: cursorOf(first), model: "muse-spark-1.3" });
    await completed(model);
    expect(peers).toHaveLength(2);
    expect(exited(peers[0])).toBe(true);
    await completed(await send({ resumeCursor: cursorOf(model), model: "muse-spark-1.3", cwd: "<workspace>/other" }));
    expect(peers).toHaveLength(3);
    expect(exited(peers[1])).toBe(true);
    expect(kept()).toBe(1);
  });

  it("prepare and sendTurn build the same fingerprint for the same shape", async () => {
    await start();
    await instance.prepare!(shapeFor({ resumeCursor: "cursor-1", effort: "high" }));
    expect(kept()).toBe(1);
    const turnId = await send({ resumeCursor: "cursor-1", effort: "low" });
    expect(await completed(turnId)).toMatchObject({ ok: true, stopReason: null });
    expect(peers).toHaveLength(1);
    expect(methods(peers[0]).filter((m) => m === "initialize" || m === "session/resume")).toEqual(["initialize", "session/resume"]);
    expect(stagesOf(turnId)).toEqual(["prompt-sent", "finishing"]);
  });

  it.each([0, 1])("a pending prepare never makes the turn later than cold (winner %i)", async (winner) => {
    vi.spyOn(os, "cpus").mockReturnValue(Array.from({ length: 16 }, () => ({} as os.CpuInfo)));
    vi.spyOn(os, "totalmem").mockReturnValue(32 * 1024 ** 3);
    const ready = [hold(), hold()];
    gate = (method, _reply, peer) => method === "initialize" ? ready[peer].held : undefined;
    await start();
    const preparing = instance.prepare!(shapeFor());
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    const sent = send();
    await vi.waitFor(() => expect(peers).toHaveLength(2));
    expect(peers.flatMap(turnStarts)).toHaveLength(0);
    ready[winner].release();
    await recorder.until((e) => e.type === "turn.stage" && e.stage === "prompt-sent");
    expect(turnStarts(peers[winner])).toHaveLength(1);
    expect(turnStarts(peers[1 - winner])).toHaveLength(0);
    expect(exited(peers[1 - winner])).toBe(true);
    ready[1 - winner].release();
    await preparing;
    expect(await completed(await sent)).toMatchObject({ ok: true, stopReason: null });
  });

  it.each([false, true])("an identity change before Send drops the host (prepared %s)", async (prepared) => {
    await start();
    let cursor = "cursor-1";
    if (prepared) await instance.prepare!(shapeFor({ resumeCursor: cursor }));
    else {
      const first = await send();
      await completed(first);
      cursor = cursorOf(first);
    }
    account = "Other Name";
    const second = await send({ resumeCursor: cursor });
    expect(await completed(second)).toMatchObject({ ok: true, stopReason: null });
    expect(exited(peers[0])).toBe(true);
    expect(turnStarts(peers[0])).toHaveLength(prepared ? 0 : 1);
    expect(peers).toHaveLength(2);
    expect(turnStarts(peers[1])).toHaveLength(1);
    expect(instance.cachedCapture?.()?.identity).toBe(labelHash(account));
  });

  it("an identity change seen at focus drops the host", async () => {
    await start();
    const first = await send();
    await completed(first);
    expect(kept()).toBe(1);
    account = "Other Name";
    await instance.prepare!();
    await expect.poll(() => exited(peers[0])).toBe(true);
    const second = await send({ resumeCursor: cursorOf(first) });
    await completed(second);
    expect(turnStarts(peers[0])).toHaveLength(1);
    expect(methods(peers.at(-1)!)).toContain("session/resume");
  });

  it("sign-out during adoption keeps nothing", async () => {
    smallerPc();
    await start();
    const prepared = await pendingPrepare("cursor-1");
    const sent = send({ resumeCursor: "cursor-1" });
    await recorder.until((e) => e.type === "turn.stage" && e.stage === "setup");
    account = undefined;
    authed = () => false;
    await instance.prepare!();
    await completed(await sent);
    prepared.release();
    expect(exited(peers[0])).toBe(true);
    await expect.poll(() => peers.every(exited)).toBe(true);
    await expect.poll(() => pool.stats().reserved).toBe(0);
  });

  it("Stop during adopted setup keeps nothing", async () => {
    smallerPc();
    await start();
    const prepared = await pendingPrepare("cursor-1");
    const sent = send({ resumeCursor: "cursor-1" });
    await recorder.until((e) => e.type === "turn.stage" && e.stage === "setup");
    await instance.adapter.interruptTurn("recorded-thread");
    expect(await completed(await sent)).toMatchObject({ ok: true, stopReason: "cancelled" });
    prepared.release();
    expect(peers).toHaveLength(1);
    expect(turnStarts(peers[0])).toHaveLength(0);
    await expect.poll(() => exited(peers[0])).toBe(true);
    await expect.poll(() => pool.stats().reserved).toBe(0);
  });

  it("Stop during Finishing up interrupts and keeps nothing", async () => {
    const background = hold();
    gate = (method, reply) =>
      method === "turn/start" && reply.method === "item/completed" && reply.params.item.kind === "reminderChild" ? background.held : undefined;
    await start();
    const turnId = await send();
    await recorder.until((e) => e.type === "turn.stage" && e.stage === "finishing");
    await instance.adapter.interruptTurn("recorded-thread");
    expect(await completed(turnId)).toMatchObject({ ok: true, stopReason: "cancelled" });
    background.release();
    expect(methods(peers[0])).toContain("turn/interrupt");
    await expect.poll(() => exited(peers[0])).toBe(true);
    expect(pool.stats().reserved).toBe(0);
  });

  it("Stop during usage/read keeps nothing", async () => {
    const usage = hold();
    gate = (method) => (method === "usage/read" ? usage.held : undefined);
    // The host already completed natively: it sends no second completion.
    answerInterrupt = false;
    await start();
    const turnId = await send();
    await vi.waitFor(() => expect(methods(peers[0])).toContain("usage/read"));
    await instance.adapter.interruptTurn("recorded-thread");
    usage.release();
    expect(await completed(turnId)).toMatchObject({ ok: true, stopReason: null });
    await expect.poll(() => exited(peers[0])).toBe(true);
    expect(pool.stats().reserved).toBe(0);
  });

  it("forwards reasoning deltas as reasoning_text", async () => {
    gate = (method, reply, peer) => {
      if (method !== "turn/start" || reply.method !== "item/started" || reply.params.item.kind !== "agentMessage") return;
      const turnId = reply.params.item.turnId;
      peers[peer].write({ jsonrpc: "2.0", method: "item/started", params: { item: { itemId: "reason-1", kind: "reasoning", turnId } } } as Message);
      peers[peer].write({ jsonrpc: "2.0", method: "item/delta", params: { itemId: "reason-1", field: "summary.0", delta: "Weighing it" } } as Message);
    };
    await start();
    const turnId = await send();
    await completed(turnId);
    expect(recorder.events.filter((e) => e.type === "content.delta").map((e) => [e.streamKind, e.delta]))
      .toEqual([["reasoning_text", "Weighing it"], ["assistant_text", "OK"]]);
    expect(answers(turnId).map((e) => (e as { text: string }).text)).toEqual(["OK"]);
  });

  it("emits setup then prompt-sent on a cold turn and only prompt-sent on a warm turn", async () => {
    await start();
    const cold = await send();
    await completed(cold);
    const warm = await send({ resumeCursor: cursorOf(cold) });
    await completed(warm);
    expect(stagesOf(cold)).toEqual(["setup", "prompt-sent", "finishing"]);
    expect(stagesOf(warm)).toEqual(["prompt-sent", "finishing"]);
    const started = indexOf((e) => e.type === "turn.started" && e.turnId === cold);
    expect(recorder.events[started + 1]).toMatchObject({ type: "turn.stage", stage: "setup" });
  });

  it("an idle warm host exits on stdin close", async () => {
    expect(fixture.reply.exit.stdinCloseMs).toBeLessThan(2_000);
    await start();
    const first = await send();
    await completed(first);
    expect(kept()).toBe(1);
    const closedAt = Date.now();
    peers[0].child.stdin.end();
    await expect.poll(() => pool.stats().reserved, { timeout: 2_000 }).toBe(0);
    expect(Date.now() - closedAt).toBeLessThan(2_000);
    await completed(await send({ resumeCursor: cursorOf(first) }));
    expect(peers).toHaveLength(2);
  });

  describe("free RAM under the warm floor", () => {
    let now: number;
    let free: number;
    let sweep: () => void;
    const minutes = (n: number) => {
      for (let i = 0; i < n; i++) {
        now += 60_000;
        sweep();
      }
    };
    beforeEach(() => {
      now = 0;
      // This PC: 32 GB with 3.9 GB free, under the 4.8 GB (15%) floor.
      free = 3.9 * 1024 ** 3;
      sweep = () => {};
      pool = createWarmPool({
        totalmem: () => 32 * 1024 ** 3, freemem: () => free, cpus: () => 16, now: () => now,
        timers: { setInterval: (fn) => { sweep = fn; return 1; }, clearInterval: () => {} },
      });
    });

    it("keeps the host and session for the next turn on the thread", async () => {
      await start();
      const first = await send();
      await completed(first);
      minutes(1);
      const second = await send({ resumeCursor: cursorOf(first) });
      await completed(second);
      expect(peers).toHaveLength(1);
      expect(exited(peers[0])).toBe(false);
      expect(methods(peers[0]).filter((m) => m === "session/start" || m === "session/resume")).toEqual(["session/start"]);
      expect(stagesOf(second)).toEqual(["prompt-sent", "finishing"]);
      expect(kept()).toBe(1);
    });

    it("still closes the kept host after the idle TTL", async () => {
      await start();
      await completed(await send());
      minutes(9);
      expect(kept()).toBe(1);
      minutes(1);
      expect(kept()).toBe(0);
      await expect.poll(() => exited(peers[0])).toBe(true);
    });

    it("drops the kept host when free RAM falls under 1.5 GB", async () => {
      await start();
      await completed(await send());
      free = 1024 ** 3;
      minutes(1);
      expect(kept()).toBe(0);
    });

    it("keeps at most two idle Muse hosts", async () => {
      await start();
      for (const threadId of ["t1", "t2", "t3"]) await completed(await send({ threadId }));
      expect(peers).toHaveLength(3);
      expect(kept()).toBe(2);
      expect(exited(peers[2])).toBe(true);
    });
  });
  it("cachedCapture returns the probe's label hash and the registry incarnation", async () => {
    await start();
    expect(instance.cachedCapture!()).toBeNull();
    await instance.snapshot();
    const calls = accountCalls;
    const captured = instance.cachedCapture!();
    expect(captured).toEqual({
      generation: pool.generation({ engine: "museAgent", instanceId: "recorded-muse" }),
      incarnation: "muse#7",
      identity: labelHash("Recorded Name"),
    });
    instance.cachedCapture!();
    instance.cachedCapture!();
    expect(accountCalls).toBe(calls);
  });

  it("no label gives no cached capture and today's handshake host", async () => {
    account = undefined;
    await start();
    await instance.snapshot();
    expect(instance.cachedCapture!()).toBeNull();
    await instance.prepare!();
    expect(methods(peers[0])).toEqual(["initialize", "initialized"]);
    const turnId = await send();
    expect(await completed(turnId)).toMatchObject({ ok: true, stopReason: null });
    expect(peers).toHaveLength(1);
    expect(stagesOf(turnId)).toEqual(["setup", "prompt-sent", "finishing"]);
    await expect.poll(() => exited(peers[0])).toBe(true);
    expect(pool.stats().reserved).toBe(0);
  });

  it("a barrier, a signed-out snapshot and dispose clear it", async () => {
    await start();
    await instance.snapshot();
    expect(instance.cachedCapture!()).not.toBeNull();
    pool.barrier({ instanceId: "recorded-muse" }, "test")();
    expect(instance.cachedCapture!()).toBeNull();
    await instance.snapshot();
    expect(instance.cachedCapture!()?.generation).toBe(pool.generation({ engine: "museAgent", instanceId: "recorded-muse" }));
    authed = () => false;
    await instance.snapshot();
    expect(instance.cachedCapture!()).toBeNull();
    authed = () => true;
    await instance.snapshot();
    expect(instance.cachedCapture!()).not.toBeNull();
    await instance.dispose();
    expect(instance.cachedCapture!()).toBeNull();
  });

  it("prepare declines a shape from another incarnation or identity", async () => {
    await start();
    await instance.snapshot();
    const captured = instance.cachedCapture!()!;
    await instance.prepare!(shapeFor({ captured: { ...captured, incarnation: "muse#6" } }));
    await instance.prepare!(shapeFor({ captured: { ...captured, identity: labelHash("Other Name") } }));
    await instance.prepare!(shapeFor({ captured: { ...captured, generation: captured.generation + 1 } }));
    expect(peers).toHaveLength(0);
    await instance.prepare!(shapeFor({ captured }));
    expect(peers).toHaveLength(1);
    expect(kept()).toBe(1);
  });

  it("a registry-style invalidate drops the host lease", async () => {
    await start();
    const turnId = await send();
    await completed(turnId);
    expect(kept()).toBe(1);
    pool.invalidate({ instanceId: "recorded-muse", incarnation: "muse#6" }, "reload");
    expect(kept()).toBe(1);
    pool.invalidate({ instanceId: "recorded-muse", incarnation: "muse#7" }, "reload");
    await expect.poll(() => exited(peers[0])).toBe(true);
    expect(pool.stats().reserved).toBe(0);
  });

  it("the label and its hash reach no log or event", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    account = "Secret Label Name";
    await start();
    const snapshot = await instance.snapshot();
    await instance.prepare!(shapeFor({ resumeCursor: "cursor-1", captured: instance.cachedCapture!()! }));
    const turnId = await send({ resumeCursor: "cursor-1" });
    await completed(turnId);
    await instance.prepare!();
    const hash = labelHash(account);
    const seen = JSON.stringify([recorder.events, logs.flatMap((spy) => spy.mock.calls)]);
    expect(seen).not.toContain(account);
    expect(seen).not.toContain(hash);
    expect(JSON.stringify(snapshot)).not.toContain(hash);
  });
});
