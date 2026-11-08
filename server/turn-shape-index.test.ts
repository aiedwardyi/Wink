import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { isEffortOffered } from "../shared/model-effort.ts";
import { resolveAutomaticSelection } from "./automatic-selection.ts";
import { applicableCompaction, knownCatalogContextWindow, nativeCompactAt, supersededCompactionIds } from "./context-compaction.ts";
import type { ProviderInstance } from "./contracts.ts";
import { canServeTurn, warmToolsKey } from "./drivers/acp/warm-eligibility.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";
import { prewarmTurn, type PrewarmDeps } from "./prewarm-turn.ts";
import { projectPathsFromRecords, resolveProjectFolder, userProjectTexts } from "./project-folder.ts";
import { selectBundledSkills, type BundledSkill } from "./skill-library.ts";
import { Store, type BotRecord, type Message, type TaskRecord } from "./store.ts";
import * as context from "./turn-context.ts";
import { approvalDescriptor, cwdDescriptor } from "./turn-shape.ts";
import { supportsWorkspaceFiles, workspaceDir } from "./workspace.ts";

const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const source = ts.createSourceFile("index.ts", read("./index.ts"), ts.ScriptTarget.Latest, true);
const tool = (name: string) => ({ command: "node", args: [`${name}.ts`], env: { BOT: "bot", THREAD: "chat" } });
const folder = resolve("/fake/project");

function nodes<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => { if (guard(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root);
  return found;
}

function one<T>(found: T[], label: string): T {
  expect(found, label).toHaveLength(1);
  return found[0]!;
}

const start = one(nodes(source, ts.isFunctionDeclaration).filter((node) => node.name?.text === "startClaimedTurn"), "startClaimedTurn");
const variable = (name: string, root: ts.Node = start) => one(nodes(root, ts.isVariableDeclaration).filter((node) => node.name.getText(source) === name), name);
const declaration = (name: string) => `const ${variable(name).getText(source)};`;
const condition = (text: string) => one(nodes(start, ts.isIfStatement).filter((node) => node.expression.getText(source).includes(text)), text).expression.getText(source);

function run(code: string, scope: object, async = false): any {
  const script = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function("scope", async ? `with (scope) { return (async () => { ${script} })(); }` : `with (scope) { ${script} }`)(scope);
}

beforeEach(() => {
  vi.spyOn(fsp, "stat").mockResolvedValue({ isDirectory: () => true } as fs.Stats);
  vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => true } as fs.Stats);
  vi.spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("no tree walk"); });
  syncBuiltinESMExports();
});
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });

function fixture() {
  const bot = { id: "bot", threadId: "chat", computer: "off", cwd: folder, modelSelection: { instanceId: "grok", model: "grok-4.6", effort: "high" } } as BotRecord;
  const task: TaskRecord = { threadId: "chat", title: "Chat", createdAt: 1, cwd: folder, resumeCursors: { grok: "cursor" }, lastInstanceId: "grok", lastModel: "grok-4.6", resumeSeed: { instanceId: "grok", cursor: "cursor", compactionId: null } };
  const activeMessages: Message[] = [{ id: "u1", at: 1, role: "user", kind: "text", text: "earlier" } as Message];
  const captured = { generation: 2, incarnation: "grok#2", identity: "fake-hash" };
  const instance = {
    instanceId: "grok", driverKind: "grokAgent", models: { default: "grok-4.6", options: [{ id: "grok-4.6", label: "Grok", contextWindow: 128_000 }] },
    adapter: { capabilities: { sessionModelSwitch: "unsupported", resumeCursor: true, agentsMcp: true, composioMcp: true, phoneMcp: true, localComputerMcp: true, effortLevels: ["low", "high"] }, hasBackgroundWork: () => false },
    cachedCapture: () => ({ ...captured }),
  } as unknown as ProviderInstance;
  const store = { taskByThread: () => task, activePath: () => activeMessages, messagesFor: () => activeMessages };
  const deps: PrewarmDeps = {
    store, platform: "win32", incarnation: () => "grok#2", resolve: (entry) => ({ ...entry.modelSelection }), requirements: () => [],
    candidate: () => ({ instanceId: "grok", driverKind: "grokAgent", defaultModel: "grok-4.6", available: true, capabilities: {} }), accountOf: () => undefined,
    agents: () => tool("agents"), terminal: () => tool("terminal"), composioConfigured: () => true,
    composio: async () => tool("composio"), boxConfigured: () => false,
  };
  return { bot, task, activeMessages, captured, instance, deps, dry: () => prewarmTurn(deps, bot, instance) };
}

it("live terminal, composio, DWEB and agents statements give the same tools key", async () => {
  const statements = ["bot.shareTerminalWithChat !== false", "bot.composio !== false", "dwebUrl", "instance.adapter.capabilities.agentsMcp === true"]
    .map((text) => one(nodes(start, ts.isIfStatement).filter((node) => node.expression.getText(source).startsWith(text)), text).getText(source));
  for (const enabled of [false, true]) for (const configured of [false, true]) for (const terminal of [false, true]) for (const connected of [false, true]) for (const supported of [false, true]) for (const agents of [false, true]) for (const url of ["", " https://fake.invalid "]) {
    const h = fixture();
    h.bot.composio = enabled; h.bot.shareTerminalWithChat = terminal;
    Object.assign(h.instance.adapter.capabilities, { composioMcp: supported, agentsMcp: agents });
    h.deps.composioConfigured = () => configured;
    h.deps.terminal = () => connected ? tool("terminal") : null;
    vi.stubEnv("DWEB_URL", url);
    const live = await run(`${statements[0]}\n${statements[1]}\n${declaration("dwebUrl")}\n${statements[2]}\n${statements[3]}\nreturn integrations;`, {
      bot: h.bot, instance: h.instance, threadId: "chat", commsDepth: 0, integrations: {}, cfg: {},
      process: { env: { DWEB_URL: url } }, composio: { configured: h.deps.composioConfigured },
      terminalIntegration: h.deps.terminal, connectedAppsIntegration: h.deps.composio, agentsIntegration: h.deps.agents,
    }, true);
    const dry = await h.dry();
    expect(dry).not.toBeNull();
    expect(warmToolsKey(dry!.integrations)).toBe(warmToolsKey(live));
  }
});

it("live approval, model and effort expressions match the descriptor", async () => {
  const approval = one(nodes(start, ts.isPropertyAssignment).filter((node) => node.name.getText(source) === "approval" && node.initializer.getText(source).includes("bot.autoApprove")), "send approval").initializer.getText(source);
  const validation = one(nodes(start, ts.isIfStatement).filter((node) => node.expression.getText(source).includes("!isEffortOffered(")), "effort validation").getText(source);
  for (const autoApprove of [false, true]) for (const model of ["grok-4.6", "custom-model"]) for (const effort of [undefined, "low", "high", "xhigh"] as const) {
    const h = fixture();
    Object.assign(h.bot, { autoApprove }); Object.assign(h.bot.modelSelection, { model, effort });
    const dry = await h.dry();
    const live = () => run(`${declaration("model")}\n${declaration("effort")}\n${validation}\nreturn { model, effort, approval: ${approval} };`, {
      bot: h.bot, instance: h.instance, selection: h.bot.modelSelection, opts: undefined, isEffortOffered,
    });
    expect(approvalDescriptor(h.bot)).toBe(run(`return ${approval};`, { bot: h.bot }));
    if (effort === "xhigh") { expect(live).toThrow(); expect(dry).toBeNull(); }
    else expect(dry).toMatchObject(live());
  }
});

it("live pinned and automatic selectors use the same current and continuity picks", async () => {
  const selector = one(nodes(source, ts.isFunctionDeclaration).filter((node) => node.name?.text === "resolvedBotSelection"), "resolvedBotSelection").getText(source);
  const requirements = one(nodes(source, ts.isFunctionDeclaration).filter((node) => node.name?.text === "automaticRequirements"), "automaticRequirements").getText(source);
  for (const mode of [undefined, "automatic"] as const) for (const continuity of [false, true]) {
    const h = fixture();
    h.bot.modelSelection.mode = mode;
    if (continuity) { h.task.lastInstanceId = "grok-account"; h.deps.accountOf = () => "grok"; }
    h.bot.approvePeerComms = true;
    const candidate = { ...h.deps.candidate("grok")!, capabilities: { agentsMcp: true }, effortLevels: h.instance.adapter.capabilities.effortLevels };
    h.deps.candidate = (id) => id === "grok" ? candidate : undefined;
    h.deps.requirements = (bot) => run(`${requirements}; return automaticRequirements(bot);`, { bot });
    const patchBot = vi.fn(); const describeInstances = vi.fn(() => { throw new Error("no discovery"); });
    const live = await run(`${selector}; return resolvedBotSelection(bot, task);`, {
      bot: h.bot, task: h.task, botAccounts: { resolve: h.deps.resolve }, automaticRequirements: h.deps.requirements,
      accounts: { get: (id: string) => h.deps.accountOf(id) ? { of: h.deps.accountOf(id) } : undefined },
      registry: { get: (id: string) => h.deps.candidate(id) ? h.instance : undefined },
      liveAutomaticCandidate: () => candidate, resolveAutomaticSelection, describeInstances,
      store: { patchBot },
    }, true);
    expect(await h.dry()).toMatchObject({ instanceId: live.instanceId, model: live.model, effort: live.effort });
    expect(describeInstances).not.toHaveBeenCalled(); expect(patchBot).not.toHaveBeenCalled();
  }
});

it("live folder resolution and pin precedence match without writes or a tree walk", async () => {
  for (const state of ["pinned", "settings", "remembered", "workspace", "null", "legacy", "cleared", "historical"] as const) {
    const h = fixture();
    h.bot.cwd = resolve("/fake/settings");
    h.bot.lastProjectCwd = resolve("/fake/remembered");
    if (state !== "pinned" && state !== "null") h.task.cwd = undefined;
    if (state === "settings") h.task.resumeCursors = {};
    if (!["pinned", "settings", "null", "legacy"].includes(state)) { h.bot.cwd = undefined; h.task.resumeCursors = {}; }
    if (["remembered", "cleared", "historical"].includes(state)) h.bot.lastProjectCwd = folder;
    if (["workspace", "remembered"].includes(state)) h.activeMessages.length = 0;
    if (state === "workspace") h.bot.lastProjectCwd = undefined;
    if (state === "cleared") h.bot.projectFolderClearedAt = 2;
    if (state === "null") h.task.cwd = null;
    const dry = await h.dry();
    if (state === "historical") { expect(dry).toBeNull(); continue; }
    const copy = { ...h.task, resumeCursors: { ...h.task.resumeCursors } };
    const fake = { bot: () => h.bot, taskByThread: () => copy, saveBots: vi.fn(), emit: vi.fn() };
    const remember = vi.fn(); const forget = vi.fn();
    const scope = {
      bot: h.bot, task: copy, threadId: "chat", instance: h.instance, opts: undefined, worksInWorkspace: true, privateWorkspace: workspaceDir(h.bot.id),
      userMessage: { at: 3 }, text: "", supportsWorkspaceFiles, userProjectTexts, projectPathsFromRecords,
      store: { bots: [h.bot], groups: [], messagesFor: h.deps.store.messagesFor,
        rememberProjectCwd: remember, forgetProjectCwd: forget,
        pinTaskCwd: (_id: string, _thread: string, fallback?: string) => Store.prototype.pinTaskCwd.call(fake as unknown as Store, "bot", "chat", fallback) },
      applyResolvedProjectFolder: (input: Parameters<typeof resolveProjectFolder>[0]) => resolveProjectFolder(input).cwd ?? undefined,
    };
    const live = run(`${declaration("namedByUser")}\n${declaration("clearedAt")}\n${declaration("currentFolderText")}\n${declaration("resolvedProject")}\n${declaration("pinnedCwd")}\n${declaration("cwd")}\nreturn cwd;`, scope);
    expect(dry).not.toBeNull(); expect(dry!.cwd, state).toBe(live);
    expect(cwdDescriptor({ privateWorkspace: workspaceDir(h.bot.id), taskCwd: h.task.cwd, botCwd: h.bot.cwd, resolvedProject: state === "remembered" || state === "cleared" ? folder : undefined, resumeCursors: h.task.resumeCursors }), state).toBe(live);
    expect(remember).not.toHaveBeenCalled(); expect(forget).not.toHaveBeenCalled(); expect(fs.readdirSync).not.toHaveBeenCalled();
  }
});

function addCompaction(h: ReturnType<typeof fixture>, id = "c1") {
  h.activeMessages.push({ id, parentId: h.activeMessages.at(-1)!.id, at: 2, role: "bot", kind: "compaction", compaction: { v: 1, summary: "Earlier", coveredThroughId: "u1", firstKeptId: null, contextWindow: 128_000, estimatedTokensBefore: 10, sourceMessageCount: 1 } } as Message);
}

it("live freshness, seed, recycle and final cursor decisions agree for every cached branch", async () => {
  const resumeSource = ts.createSourceFile("turn-context.ts", read("./turn-context.ts"), ts.ScriptTarget.Latest, true);
  const build = one(nodes(resumeSource, ts.isFunctionDeclaration).filter((node) => node.name?.text === "buildTurnContext"), "buildTurnContext");
  const resume = one(nodes(build, ts.isVariableDeclaration).filter((node) => node.name.getText(resumeSource) === "resume"), "context resume").initializer!.getText(resumeSource);
  const names = ["rewound", "catalogWindow", "sessionPrompt", "latestCompactionId", "compactedThisTurn", "hasPriorUserTurn", "fresh", "lastTurnToolRounds", "sessionToolRounds", "knownWindow", "supersededIds", "unseeded", "recycleWanted", "recycleDeferred", "recycled"];
  for (const state of ["pinned", "new", "onboard", "rewind", "engine", "model", "switchable", "no-resume", "legacy", "legacy-other", "legacy-many", "no-seed", "wrong-seed", "summary", "superseded", "rounds", "session-rounds", "bound", "input", "total-input", "summed-input", "nondefault-window", "native", "background", "compacted"] as const) {
    const h = fixture();
    if (state === "new") { h.activeMessages.length = 0; h.task.resumeCursors = {}; h.task.resumeSeed = undefined; }
    if (state === "onboard") { h.activeMessages.length = 0; h.activeMessages.push({ id: "card", role: "bot", kind: "text", text: "Welcome" } as Message); h.task.lastInstanceId = "other"; }
    if (state === "rewind") h.bot.rewound = true;
    if (state === "engine") h.task.lastInstanceId = "muse";
    if (state === "model" || state === "switchable") h.task.lastModel = "other";
    if (state === "switchable") h.instance.adapter.capabilities.sessionModelSwitch = "in-session";
    if (state === "no-resume") h.instance.adapter.capabilities.resumeCursor = false;
    if (state.startsWith("legacy")) { h.task.lastInstanceId = undefined; h.task.lastModel = undefined; }
    if (state === "legacy-other") h.task.resumeCursors = { other: "cursor" };
    if (state === "legacy-many") h.task.resumeCursors.other = "cursor";
    if (state === "no-seed" || state === "background") h.task.resumeSeed = undefined;
    if (state === "wrong-seed") h.task.resumeSeed!.cursor = "stale";
    if (state === "summary" || state === "superseded") { addCompaction(h); h.task.resumeSeed!.compactionId = "c1"; }
    if (state === "superseded") addCompaction(h, "c2");
    if (["rounds", "session-rounds", "bound"].includes(state)) {
      for (let i = 0; i < (state === "session-rounds" ? 48 : 24); i++) {
        if (state === "session-rounds" && i === 24) h.activeMessages.push({ id: "u2", at: 2, role: "user", kind: "text", text: "next" } as Message);
        h.activeMessages.push({ id: `a${i}`, at: i + 3, role: "bot", kind: "activity", tool: { ok: true } } as Message);
      }
      if (state === "bound") h.task.providerSessionBoundId = "a23";
    }
    if (state === "input" || state === "total-input") { h.instance.adapter.capabilities.turnInputIsPromptSize = state === "input"; h.task.usage = { input: 100_000, output: 0, costUsd: null, turns: 1, lastInput: 100_000 }; }
    if (state === "summed-input") { h.instance.adapter.capabilities.turnInputIsPromptSize = true; h.task.usage = { input: 1_000_000, output: 0, costUsd: null, turns: 1, lastInput: 100 }; }
    if (state === "nondefault-window") {
      h.instance.models.default = "other";
      h.instance.models.options.push({ id: "other", label: "Other", contextWindow: 500_000 });
      h.instance.adapter.capabilities.turnInputIsPromptSize = true;
      h.task.usage = { input: 100_000, output: 0, costUsd: null, turns: 1, lastInput: 100_000 };
    }
    if (state === "native") h.task.nativePrompt = { cursor: "cursor", first: 100, last: 100_000 };
    if (state === "background") h.instance.adapter.hasBackgroundWork = () => true;
    const compaction = applicableCompaction(h.activeMessages);
    const latestCompactionId = compaction?.messageId ?? null;
    const scope = {
      ...context, bot: h.bot, task: h.task, instance: h.instance, instanceId: "grok", threadId: "chat", model: h.bot.modelSelection.model,
      activeMessages: [...h.activeMessages, { id: "send", role: "user", kind: "text", text: "current send" }], skipTranscript: new Set(["send"]), transcript: [],
      knownCatalogContextWindow, supersededCompactionIds, nativeAt: nativeCompactAt(h.instance.driverKind, h.bot.modelSelection.model, 1_000_000),
    };
    const results = [];
    for (const recovering of [false, true]) for (const expanded of [false, true]) {
      results.push(run(`${names.map(declaration).join("\n")}\nconst resume = ${resume};\n${declaration("resumeCursor")}\nreturn { fresh, unseeded, recycleWanted, recycled, resumeCursor };`, {
        ...scope, recovering, prepared: { expanded, compactionId: latestCompactionId, compaction: state === "compacted" ? {} : undefined },
      }));
    }
    const dry = await h.dry();
    const uncertain = new Set(results.map((r) => `${r.unseeded}:${r.recycleWanted}`)).size !== 1;
    if (uncertain) expect(dry, state).toBeNull();
    else {
      expect(dry, state).not.toBeNull();
      if (state === "compacted") expect(canServeTurn(dry!.session, results[0].resumeCursor)).toBe(false);
      else expect(dry!.resumeCursor, state).toEqual(results[0].resumeCursor);
    }
  }
});

it("live pinned-system and late-grace recycle clear the cursor before take", async () => {
  const pinned = one(nodes(start, ts.isIfStatement).filter((node) => node.expression.getText(source) === "live.adapter.capabilities.pinnedSystem === true" && node.thenStatement.getText(source).includes("const delivered =")), "pinned system");
  const late = one(nodes(start, ts.isIfStatement).filter((node) => node.expression.getText(source) === "systemRecycle || (finalGrace && !finalGrace.safe)"), "late recycle");
  const cleared = one(nodes(late, ts.isIfStatement).filter((node) => node.expression.getText(source) === "!recycleDeferred"), "late cursor clear");
  for (const state of ["unknown-system", "changed-system", "grace", "background"] as const) {
    const h = fixture();
    const dry = await h.dry();
    expect(dry!.resumeCursor).toBe("cursor");
    const clearResumeCursors = vi.fn();
    const scope = {
      instance: h.instance, instanceId: "grok", bot: h.bot, task: h.task, threadId: "chat", opts: undefined,
      live: { adapter: { capabilities: { pinnedSystem: true }, hasBackgroundWork: () => state === "background" } },
      store: { sessionSystem: () => state === "unknown-system" ? undefined : "old", clearResumeCursors, markProviderSessionBound: vi.fn() },
      system: "new", withSystemChanges: (_text: string, _delivered: string, _system: string, limit?: number) => limit === Infinity || state === "grace" ? "update" : null,
      systemTurnInput: (text: string) => ({ text, systemUpdate: "update" }), seed: { cursor: "cursor" }, userMessage: { id: "new-user" },
      activeMessages: h.activeMessages, withLate: (text: string) => text, systemRecycleText: () => "replay",
    };
    const result = run(`let resumeCursor = "cursor"; let text = "send"; let systemUpdate = ""; let systemRecycle = false; ${pinned.getText(source)}
      const finalGrace = ${state === "grace" ? "{ safe: false }" : "null"};
      let recycleDeferred = false;
      if (${late.expression.getText(source)}) { recycleDeferred = live.adapter.hasBackgroundWork?.(threadId) === true; ${cleared.getText(source)} }
      return { resumeCursor, systemRecycle };`, scope);
    expect(result.resumeCursor, state).toBe(state === "background" ? "cursor" : undefined);
    expect(canServeTurn(dry!.session, result.resumeCursor), state).toBe(state === "background");
    expect(clearResumeCursors).toHaveBeenCalledTimes(state === "background" ? 0 : 1);
  }
});

it("live phone selection including a user-only skill changes the tools key", async () => {
  const selected = declaration("selectedSkills");
  const mount = one(nodes(start, ts.isIfStatement).filter((node) => node.expression.getText(source).startsWith("selectedSkills.some(")), "phone mount").getText(source);
  const skill: BundledSkill = { directory: "/fake/user/skills", instructions: "Use phone", manifest: { id: "user-phone", name: "Phone", version: "1", description: "Phone", defaultEnabled: true, triggerTerms: ["my custom phone", "휴대폰"], requiredCapabilities: ["phoneMcp"] } };
  for (const text of ["ordinary text", "my custom phone", "휴대폰"]) for (const supported of [false, true]) {
    const h = fixture();
    h.instance.adapter.capabilities.phoneMcp = supported;
    const dry = await h.dry();
    const integrations = { ...dry!.integrations };
    run(`${selected}\n${mount}`, { text, instance: h.instance, integrations, selectBundledSkills, availableSkills: () => [skill], phoneIntegration: () => tool("phone") });
    expect(warmToolsKey(integrations) === warmToolsKey(dry!.integrations)).toBe(!supported || text === "ordinary text");
  }
});

it("live Auto computer gates match the dry refusal on every platform and backend", async () => {
  const local = one(nodes(start, ts.isIfStatement).filter((node) => node.expression.getText(source).includes("shouldMountLocalComputer(") && node.expression.getText(source).includes("!integrations.localComputer")), "Auto local mount").expression.getText(source);
  const gates = [condition('(wants === "cloud" || wants === undefined) && cloudBackend === "vps"'), condition('cloudBackend === "box" && box.boxConfigured(cfg)'), local];
  for (const platform of ["win32", "linux", "darwin"] as const) for (const backend of [undefined, "vps"] as const) for (const configured of [false, true]) for (const supported of [false, true]) {
    const h = fixture();
    h.bot.computer = undefined; h.bot.cloudBackend = backend;
    h.instance.adapter.capabilities.localComputerMcp = supported; h.deps.platform = platform; h.deps.boxConfigured = () => configured;
    const mounts = gates.map((gate) => run(`return Boolean(${gate});`, {
      wants: undefined, cloudBackend: backend === "vps" ? "vps" : "box", box: { boxConfigured: () => configured }, cfg: {},
      integrations: {}, mountsLocalComputer: supported, shouldMountLocalComputer, process: { platform },
    }));
    expect(await h.dry()).toSatisfy((turn: unknown) => mounts.some(Boolean) ? turn === null : turn !== null);
  }
});

it("room composers pass no bot and every prewarm trigger is bot-guarded", () => {
  const group = ts.createSourceFile("GroupView.tsx", read("../src/components/GroupView.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const composer = one(nodes(group, ts.isJsxSelfClosingElement).filter((node) => node.tagName.getText(group) === "Composer"), "room Composer");
  expect(composer.attributes.properties.some((node) => ts.isJsxAttribute(node) && node.name.getText(group) === "bot")).toBe(false);
  const ui = ts.createSourceFile("Composer.tsx", read("../src/components/Composer.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls = nodes(ui, ts.isCallExpression).filter((node) => node.expression.getText(ui) === "requestBotPrewarm");
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    const parents: ts.Node[] = [];
    for (let parent = call.parent; parent; parent = parent.parent) parents.push(parent);
    expect(parents.filter(ts.isBlock).some((block) => /if \(!bot \|\||if \(bot\?\.id/.test(block.getText(ui)))).toBe(true);
  }
});

it("live registry and driver accessors decline absent, stale, disabled and disposed captures", () => {
  const registry = ts.createSourceFile("registry.ts", read("./harness/registry.ts"), ts.ScriptTarget.Latest, true);
  const incarnation = one(nodes(registry, ts.isMethodDeclaration).filter((node) => node.name.getText(registry) === "incarnation"), "registry incarnation");
  const lookup = new Function("instanceId", incarnation.body!.getText(registry).slice(1, -1));
  const incarnations = new Map([["grok", "grok#2"]]);
  expect(lookup.call({ incarnations }, "grok")).toBe("grok#2");
  incarnations.clear(); expect(lookup.call({ incarnations }, "grok")).toBeUndefined();
  for (const file of ["./drivers/acp/core.ts", "./drivers/msp/runtime.ts"]) {
    const driver = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const accessor = one(nodes(driver, ts.isPropertyAssignment).filter((node) => node.name.getText(driver) === "cachedCapture"), file).initializer.getText(driver);
    for (const state of ["valid", "absent", "stale", "disabled", "disposed", "identity"] as const) {
      const lastCapture = state === "absent" ? null : { generation: 2, identity: state === "identity" ? "" : "fake", incarnation: "grok#2" };
      const value = run(`return (${accessor})();`, { input: { enabled: state !== "disabled" }, disposed: state === "disposed", lastCapture, generationNow: () => state === "stale" ? 3 : 2 });
      expect(value, `${file} ${state}`).toEqual(state === "valid" ? lastCapture : null);
      if (value) expect(value).not.toBe(lastCapture);
    }
  }
});
