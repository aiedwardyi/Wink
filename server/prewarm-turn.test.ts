import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ProviderInstance } from "./contracts.ts";
import { prewarmTurn, type PrewarmDeps } from "./prewarm-turn.ts";
import type { BotRecord, Message, TaskRecord } from "./store.ts";
import { workspaceDir } from "./workspace.ts";

const folder = resolve("/fake/project");
const connection = { command: "node", args: ["proxy.ts"], env: { BOT: "bot" } };

beforeEach(() => {
  vi.spyOn(fsp, "stat").mockResolvedValue({ isDirectory: () => true } as fs.Stats);
  vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => true } as fs.Stats);
  vi.spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("no tree walk"); });
  vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("no writes"); });
  syncBuiltinESMExports();
});
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });

function fixture() {
  const bot = { id: "bot", threadId: "chat", computer: "off", cwd: folder, modelSelection: { instanceId: "grok", model: "grok-4.6", effort: "high" } } as BotRecord;
  const task: TaskRecord = {
    threadId: bot.threadId, title: "Chat", createdAt: 1, cwd: folder,
    resumeCursors: { grok: "cursor" }, lastInstanceId: "grok", lastModel: "grok-4.6",
    resumeSeed: { instanceId: "grok", cursor: "cursor", compactionId: null },
  };
  const messages: Message[] = [{ id: "u1", at: 1, role: "user", kind: "text", text: "earlier question" } as Message];
  const captured = { generation: 3, incarnation: "grok#1", identity: "fake-hash" };
  const instance = {
    instanceId: "grok", driverKind: "grokAgent",
    models: { default: "grok-4.6", options: [{ id: "grok-4.6", label: "Grok", contextWindow: 128_000 }] },
    adapter: { capabilities: { sessionModelSwitch: "unsupported", resumeCursor: true, agentsMcp: true, composioMcp: true, phoneMcp: true, localComputerMcp: true, effortLevels: ["low", "high"] }, hasBackgroundWork: vi.fn(() => false) },
    cachedCapture: vi.fn(() => captured),
  } as unknown as ProviderInstance;
  const deps: PrewarmDeps = {
    store: { taskByThread: vi.fn(() => task), activePath: () => messages, messagesFor: () => messages },
    platform: "win32", incarnation: () => "grok#1", resolve: vi.fn((entry) => ({ ...entry.modelSelection })),
    requirements: () => [], candidate: () => ({ instanceId: "grok", driverKind: "grokAgent", defaultModel: "grok-4.6", available: true, capabilities: {} }),
    accountOf: () => undefined, agents: () => connection, terminal: () => connection,
    composioConfigured: () => false, composio: vi.fn(async () => connection), boxConfigured: () => false,
  };
  return { bot, task, messages, captured, instance, deps, run: () => prewarmTurn(deps, bot, instance) };
}

it("uses the instance's cached capture on a pinned, loaded cursor", async () => {
  const h = fixture();
  expect(await h.run()).toMatchObject({ threadId: "chat", instanceId: "grok", captured: h.captured, model: "grok-4.6", effort: "high", approval: "ask", cwd: folder, resumeCursor: "cursor", session: { kind: "loaded", id: "cursor" } });
  expect(h.instance.cachedCapture).toHaveBeenCalled();
  expect(h.deps.composio).not.toHaveBeenCalled();
});

it.each(["missing", "stale", "absent-accessor"])("a %s capture gives null before tool work", async (state) => {
  const h = fixture();
  if (state === "missing") h.instance.cachedCapture = () => null;
  if (state === "stale") h.captured.incarnation = "grok#0";
  if (state === "absent-accessor") h.instance.cachedCapture = undefined;
  h.deps.terminal = vi.fn(() => connection);
  expect(await h.run()).toBeNull();
  expect(h.deps.terminal).not.toHaveBeenCalled();
});

it.each(["claudeAgent", "codex", "boxAgent", "antigravity"])("declines %s before capture or tool work", async (kind) => {
  const h = fixture();
  Object.assign(h.instance, { driverKind: kind });
  expect(await h.run()).toBeNull();
  expect(h.instance.cachedCapture).not.toHaveBeenCalled();
});

it.each(["local", "cloud"] as const)("a %s computer-use bot gives null", async (computer) => {
  const h = fixture();
  h.bot.computer = computer;
  expect(await h.run()).toBeNull();
});

it.each(["win32", "linux"] as const)("an Auto bot without a mount on %s gets a turn", async (platform) => {
  const h = fixture();
  h.bot.computer = undefined;
  h.deps.platform = platform;
  expect(await h.run()).not.toBeNull();
  expect(h.bot.computer).toBeUndefined();
});

it.each(["Box", "VPS", "macOS"])("an Auto bot with %s gives null", async (backend) => {
  const h = fixture();
  h.bot.computer = undefined;
  if (backend === "Box") h.deps.boxConfigured = () => true;
  if (backend === "VPS") h.bot.cloudBackend = "vps";
  if (backend === "macOS") h.deps.platform = "darwin";
  expect(await h.run()).toBeNull();
});

it.each(["new", "rewound", "engine", "model", "unseeded"])("a %s chat gets a fresh session", async (reason) => {
  const h = fixture();
  if (reason === "new") { h.messages.length = 0; h.task.resumeCursors = {}; h.task.resumeSeed = undefined; }
  if (reason === "rewound") h.bot.rewound = true;
  if (reason === "engine") h.task.lastInstanceId = "muse";
  if (reason === "model") h.task.lastModel = "other";
  if (reason === "unseeded") h.task.resumeSeed = undefined;
  expect(await h.run()).toMatchObject({ resumeCursor: undefined, session: { kind: "fresh" } });
});

it("a fat unseeded session gets a fresh session", async () => {
  const h = fixture();
  h.task.resumeSeed = undefined;
  h.task.nativePrompt = { cursor: "cursor", first: 100, last: 100_000 };
  expect(await h.run()).toMatchObject({ session: { kind: "fresh" } });
});

it("recovery that would change the recycle gives null", async () => {
  const h = fixture();
  h.task.nativePrompt = { cursor: "cursor", first: 100, last: 100_000 };
  expect(await h.run()).toBeNull();
});

it("recovery that cannot change the recycle gives a turn", async () => {
  const h = fixture();
  h.task.nativePrompt = { cursor: "cursor", first: 100, last: 1_000 };
  expect(await h.run()).toMatchObject({ resumeCursor: "cursor" });
});

it("background work defers a certain recycle", async () => {
  const h = fixture();
  h.task.resumeSeed = undefined;
  h.instance.adapter.hasBackgroundWork = () => true;
  expect(await h.run()).toMatchObject({ resumeCursor: "cursor" });
});

it("an expansion that would change the seed gives null", async () => {
  const h = fixture();
  h.messages.push({ id: "c1", parentId: "u1", at: 2, role: "bot", kind: "compaction", compaction: { v: 1, summary: "Earlier", coveredThroughId: "u1", firstKeptId: null, contextWindow: 128_000, estimatedTokensBefore: 10, sourceMessageCount: 1 } } as Message);
  h.task.resumeSeed!.compactionId = "c1";
  expect(await h.run()).toBeNull();
});

it("an automatic bot on its own instance gets a turn", async () => {
  const h = fixture();
  h.bot.modelSelection.mode = "automatic";
  expect(await h.run()).toMatchObject({ instanceId: "grok", model: "grok-4.6" });
});

it("an automatic bot with no live candidate gives null", async () => {
  const h = fixture();
  h.bot.modelSelection.mode = "automatic";
  h.deps.candidate = () => undefined;
  expect(await h.run()).toBeNull();
  expect(h.deps.composio).not.toHaveBeenCalled();
});

it.each(["missing-task", "wrong-selection", "unsupported-effort", "throw"])("%s gives null", async (reason) => {
  const h = fixture();
  if (reason === "missing-task") h.deps.store.taskByThread = () => undefined;
  if (reason === "wrong-selection") h.deps.resolve = () => ({ instanceId: "other", model: "other" });
  if (reason === "unsupported-effort") h.bot.modelSelection.effort = "xhigh";
  if (reason === "throw") h.deps.resolve = () => { throw new Error("unavailable"); };
  expect(await h.run()).toBeNull();
});

it("an unpinned chat with earlier user text gives null", async () => {
  const h = fixture();
  h.task.cwd = undefined; h.bot.cwd = undefined; h.task.resumeCursors = {};
  expect(await h.run()).toBeNull();
  expect(fs.readdirSync).not.toHaveBeenCalled();
});

it.each([false, true])("a new chat uses the remembered folder (cleared history %s)", async (cleared) => {
  const h = fixture();
  h.task.cwd = undefined; h.bot.cwd = undefined; h.task.resumeCursors = {};
  h.bot.lastProjectCwd = folder;
  if (cleared) h.bot.projectFolderClearedAt = 2;
  else h.messages.length = 0;
  expect(await h.run()).toMatchObject({ cwd: folder });
  expect(fs.readdirSync).not.toHaveBeenCalled();
  expect(fs.writeFileSync).not.toHaveBeenCalled();
});

it("a new chat with no remembered folder uses its private workspace", async () => {
  const h = fixture();
  h.task.cwd = undefined; h.bot.cwd = undefined; h.task.resumeCursors = {}; h.messages.length = 0;
  expect(await h.run()).toMatchObject({ cwd: workspaceDir(h.bot.id) });
});

it.each(["missing", "file"])("a %s folder gives null", async (reason) => {
  const h = fixture();
  if (reason === "missing") vi.mocked(fsp.stat).mockRejectedValue(new Error("ENOENT"));
  else vi.mocked(fsp.stat).mockResolvedValue({ isDirectory: () => false } as fs.Stats);
  expect(await h.run()).toBeNull();
});

it.each(["null", "legacy"])("a %s cwd keeps the default folder", async (reason) => {
  const h = fixture();
  h.task.cwd = reason === "null" ? null : undefined;
  expect(await h.run()).toMatchObject({ cwd: undefined });
  expect(fsp.stat).not.toHaveBeenCalled();
});

it.each(["composio", "stat"])("revalidates every snapshot after %s", async (stage) => {
  for (const reason of ["chat", "selection", "cursor", "rewound", "settings", "task", "capture", "incarnation", "history", "config", "background"] as const) {
    const h = fixture();
    const change = () => {
      if (reason === "chat") h.bot.threadId = "other";
      if (reason === "selection") h.bot.modelSelection.model = "other";
      if (reason === "cursor") h.task.resumeCursors.grok = "other";
      if (reason === "rewound") h.bot.rewound = true;
      if (reason === "settings") h.bot.autoApprove = true;
      if (reason === "task") h.deps.store.taskByThread = () => undefined;
      if (reason === "capture") h.captured.generation++;
      if (reason === "incarnation") h.deps.incarnation = () => "grok#2";
      if (reason === "history") h.messages.push({ id: "u2", role: "user", kind: "text", text: "new", at: 2 } as Message);
      if (reason === "config") h.deps.boxConfigured = () => true;
      if (reason === "background") h.instance.adapter.hasBackgroundWork = () => true;
    };
    if (stage === "composio") {
      h.deps.composioConfigured = () => true;
      h.deps.composio = async () => { change(); return connection; };
    } else vi.mocked(fsp.stat).mockImplementationOnce(async () => { change(); return { isDirectory: () => true } as fs.Stats; });
    expect(await h.run(), reason).toBeNull();
  }
});
