import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import type { AccountContext } from "./account-policy.ts";
import { createAccountNames } from "./account-names.ts";
import { AccountService } from "./accounts.ts";
import { BotAccounts } from "./bot-accounts.ts";
import { DATA_DIR } from "./config.ts";
import { createSpawnUsage } from "./spawn-usage.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import type { RateLimitsMap } from "./rate-limits-store.ts";
import type { ProviderRegistry } from "./harness/registry.ts";
import type { Store } from "./store.ts";
import { callTool, workerReportText } from "./drivers/terminal-proxy.ts";
import { foldContinuationStart } from "./continuation-turn.ts";
import { RESUME_NUDGE } from "./worker-resume.ts";

const workers = await import("./worker-launch.ts").catch(() => null);
const captures = await import("./worker-turn.ts").catch(() => null);
const panes = await import("./worker-panes.ts").catch(() => null);
let serial = 0;

async function fixture() {
  expect(workers, "trusted worker launch exists").not.toBeNull();
  expect(captures, "active-turn account capture exists").not.toBeNull();
  const root = join(DATA_DIR, `workers-${++serial}`);
  const bases: InstanceConfigMap = {
    codex: { driver: "codex", environment: { CODEX_HOME: join(root, "base-codex") } },
    claude: { driver: "claudeAgent", environment: { CLAUDE_CONFIG_DIR: join(root, "base-claude") } },
    grok: { driver: "grokAgent", environment: { GROK_HOME: join(root, "base-grok") } },
    muse: { driver: "museAgent" }, antigravity: { driver: "antigravityAgent" },
  };
  const accounts = new AccountService(root, () => bases);
  await accounts.add("codex");
  const pending = await accounts.add("codex");
  const third = await accounts.identify(pending.id, "fixture-identity");
  const turns = captures!.createWorkerTurns();
  turns.capture("bot", "thread", { instanceId: third.id, driverKind: "codex", account: third });
  const rateLimits: RateLimitsMap = new Map();
  const refresh = vi.fn(async () => ({}));
  const usage = createSpawnUsage({ rateLimits, refresh, save() {}, environment: () => ({ CODEX_HOME: "configured-home" }) });
  const available = vi.fn(() => true);
  const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: turns.resolveWorkerTurn, bases: () => bases, available, usage });
  const input = { botId: "bot", label: "worker", command: "codex --model fixture 'task'", environment: { CODEX_HOME: "inherited-wrong", CLAUDE_CONFIG_DIR: "inherited-wrong", OpenAI_Api_Key: "fixture-key", BASH_ENV: "profile" } };
  return { accounts, bases, third, turns, rateLimits, refresh, available, prepare, input };
}

function mainRouting(f: Awaited<ReturnType<typeof fixture>>, resumeAccount?: () => AccountContext) {
  const blocked = new Set<string>();
  const registry = { accountAvailable: (id: string) => !blocked.has(id) } as unknown as ProviderRegistry;
  const bots = new BotAccounts(f.accounts, registry, {} as Store, { captured: () => null });
  const usage = createSpawnUsage({ rateLimits: f.rateLimits, refresh: f.refresh, save() {}, environment: () => ({}) });
  const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
    available: f.available, usage, resumeAccount, mainAccount: (of) => bots.mainAccount(of) });
  return { blocked, prepare };
}

describe("trusted worker accounts", () => {
  it.each(["codex", "claude"] as const)("selects a %s worker by Usage name or known home without switching Main", async (engine) => {
    const f = await fixture();
    const selected = engine === "codex" ? f.third : await f.accounts.identify((await f.accounts.add(engine)).id, "selected-claude");
    const names = createAccountNames(join(DATA_DIR, `names-${++serial}`));
    names.sync(f.accounts.list());
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
      available: f.available, usage: createSpawnUsage({ rateLimits: f.rateLimits, refresh: f.refresh, save() {}, environment: () => ({}), nameOf: names.nameOf }),
      accounts: () => f.accounts.snapshot.filter((row) => row.state === "ready"), nameOf: names.nameOf, mainAccount: () => undefined });
    f.turns.capture("bot", "thread", { instanceId: engine, driverKind: engine === "codex" ? "codex" : "claudeAgent" });
    const selector = engine === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const other = f.bases[engine].environment![selector]!;
    mkdirSync(selected.home, { recursive: true });
    mkdirSync(other, { recursive: true });
    const token = engine === "codex" ? "auth.json" : ".credentials.json";
    writeFileSync(join(selected.home, token), "selected-fixture");
    writeFileSync(join(other, token), "main-fixture");
    f.rateLimits.set(selected.id, { observedAt: new Date().toISOString(), windows: [{ id: "seven_day", usedPercent: 20, resetsAt: null }] });
    for (const value of [names.nameOf(selected.id, engine), selected.home]) {
      const launch = await prepare({ ...f.input, command: `$env:${selector}='${value.replace(/'/g, "''")}'; ${engine} 'task'` });
      expect(launch).toMatchObject({ kind: "managed", account: { id: selected.id, generation: selected.generation },
        environment: { [selector]: selected.home }, line: `${names.nameOf(selected.id, engine)} usage left: weekly 80%.` });
      expect(f.accounts.defaultFor(engine)).toBeUndefined();
      expect(readFileSync(join(selected.home, token), "utf8")).toBe("selected-fixture");
      expect(readFileSync(join(other, token), "utf8")).toBe("main-fixture");
    }
    f.rateLimits.set(selected.id, { observedAt: new Date().toISOString(), windows: [{ id: "seven_day", usedPercent: 99, resetsAt: Date.now() + 60_000 }] });
    expect(await prepare({ ...f.input, command: `$env:${selector}='${selected.home}'; ${engine} 'task'` })).toMatchObject({ kind: "hold", hold: expect.stringContaining(names.nameOf(selected.id, engine)) });
    expect(await prepare({ ...f.input, command: `${engine} 'task'` })).toMatchObject({ account: { id: engine, generation: 0 }, environment: { [selector]: other } });
  });

  it.each(["Missing account", "C:/unknown-worker-home"])("refuses unknown account selector %s with valid Usage names", async (value) => {
    const f = await fixture();
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
      available: f.available, usage: Object.assign(vi.fn(async () => ({})), { invalidate() {} }), accounts: () => [f.third],
      nameOf: (id) => id === f.third.id ? "Codex 3" : "Codex 1" });
    await expect(prepare({ ...f.input, command: `$env:CODEX_HOME='${value}'; codex 'task'` })).rejects.toThrow("Unknown or unavailable worker account; choose Codex 1, Codex 3");
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("uses a renamed Usage account through the private worker route", async () => {
    const f = await fixture();
    const names = createAccountNames(join(DATA_DIR, `names-${++serial}`));
    names.sync(f.accounts.list());
    names.setNickname(f.third.id, "작업 계정");
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
      available: f.available, usage: Object.assign(vi.fn(async () => ({})), { invalidate() {} }), accounts: () => [f.third], nameOf: names.nameOf });
    const access = { url: "http://fixture", token: "private-host" };
    const result = await panes!.workerLaunchResponse(access, access.token, { ...f.input, command: "$env:codeX_home='작업 계정'; codex 'task'" }, prepare);
    expect(result).toMatchObject({ status: 200, body: { launch: { account: { id: f.third.id, generation: f.third.generation },
      environment: { CODEX_HOME: f.third.home }, line: "Worker account: 작업 계정." } } });
  });

  it.each(["removed", "generation"])("refuses a selected account whose %s changes during usage refresh", async (change) => {
    const f = await fixture();
    let accounts = [f.third];
    const usage = Object.assign(vi.fn(async () => {
      accounts = change === "removed" ? [] : [{ ...f.third, generation: f.third.generation + 1 }];
      return {};
    }), { invalidate() {} });
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
      available: f.available, usage, accounts: () => accounts, nameOf: () => "Codex 3" });
    await expect(prepare({ ...f.input, command: `$env:CODEX_HOME='${f.third.home}'; codex 'task'` })).rejects.toThrow("Worker account changed before launch");
    expect(existsSync(join(f.third.home, "AGENTS.md"))).toBe(false);
  });

  it("keeps an explicit worker account when Main changes during usage refresh", async () => {
    const f = await fixture();
    f.turns.capture("bot", "thread", { instanceId: "claude", driverKind: "claudeAgent" });
    const mainAccount = vi.fn(() => f.third);
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
      available: f.available, usage: Object.assign(vi.fn(async () => { mainAccount.mockReturnValue({ ...f.third, generation: 99 }); return {}; }), { invalidate() {} }),
      accounts: () => [f.third], nameOf: () => "Codex 3", mainAccount });
    expect(await prepare({ ...f.input, command: `$env:CODEX_HOME='${f.third.home}'; codex 'task'` })).toMatchObject({ account: { id: f.third.id, generation: f.third.generation } });
    expect(mainAccount).not.toHaveBeenCalled();
  });

  it.each(["$env:CODEX_HOME='x'; claude task", "$env:CLAUDE_CONFIG_DIR='x'; codex task", "$env:CODEX_HOME='x'; grok task",
    "$env:CODEX_HOME='x'; $env:CODEX_HOME='y'; codex task", "$env:CODEX_HOME='x'; $env:CLAUDE_CODE_OAUTH_TOKEN='fixture'; codex task"])("refuses conflicting account prefixes: %s", (command) => {
    expect(() => workers!.workerCommand(command)).toThrow(/Worker account prefix|Conflicting worker home/);
  });

  it.each([{ id: "R1", resume: false }, { id: "R2", resume: true }])("$id shares setup on an added Claude worker, resume $resume", async ({ resume }) => {
    const f = await fixture();
    const pending = await f.accounts.add("claude");
    const third = await f.accounts.identify(pending.id, "claude-shared");
    const base = f.bases.claude.environment!.CLAUDE_CONFIG_DIR!;
    for (const name of ["rules", "skills/my-skill", "skills/synced/x"]) mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, "CLAUDE.md"), "fixture rules");
    writeFileSync(join(base, "rules/r1.md"), "fixture rule");
    writeFileSync(join(base, "skills/my-skill/SKILL.md"), "fixture skill");
    writeFileSync(join(base, "skills/synced/x/SKILL.md"), "account skill");
    f.turns.capture("bot", "thread", { instanceId: third.id, driverKind: "claudeAgent", account: third });
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
      available: f.available, usage: Object.assign(vi.fn(async () => ({})), { invalidate() {} }), resumeAccount: () => third });
    const launch = await prepare({ ...f.input, command: "claude 'task'", ...(resume ? { resume: { engine: "claude" as const,
      nativeId: "00000000-0000-4000-8000-000000000001", accountId: third.id, accountGeneration: third.generation,
      template: { executable: "claude", args: ["--model", "fixture", "task"] } } } : {}) });
    if (launch?.kind !== "managed") throw new Error("Expected managed launch");
    expect(launch.args.slice(-2)).toEqual(["--setting-sources", "user,project,local"]);
    expect(launch.args.filter((arg) => arg === "--setting-sources")).toHaveLength(1);
    expect(readFileSync(join(third.home, "CLAUDE.md"), "utf8")).toBe(`@${base.replace(/\\/g, "/").replace(/ /g, "\\ ")}/CLAUDE.md\n`);
    expect(lstatSync(join(third.home, "rules")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(third.home, "skills/my-skill")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(third.home, "skills/synced"))).toBe(false);
  });

  it("R3 shares rules and skills on an added Codex worker", async () => {
    const f = await fixture();
    const base = f.bases.codex.environment!.CODEX_HOME!;
    mkdirSync(join(base, "skills/my-skill"), { recursive: true });
    writeFileSync(join(base, "AGENTS.md"), "fixture global rules");
    writeFileSync(join(base, "skills/my-skill/SKILL.md"), "fixture skill");
    const launch = await f.prepare(f.input);
    expect(existsSync(join(f.third.home, "AGENTS.md"))).toBe(true);
    expect(readFileSync(join(f.third.home, "AGENTS.md"))).toEqual(readFileSync(join(base, "AGENTS.md")));
    expect(lstatSync(join(f.third.home, "skills/my-skill")).isSymbolicLink()).toBe(true);
    expect(launch?.kind === "managed" && launch.environment.CODEX_HOME).toBe(f.third.home);
  });

  it.each(["hold", "refuse"])("writes no user setup when a launch is %s", async (mode) => {
    const f = await fixture();
    const base = f.bases.codex.environment!.CODEX_HOME!;
    mkdirSync(join(base, "skills/my-skill"), { recursive: true });
    writeFileSync(join(base, "AGENTS.md"), "fixture rules");
    const usage = Object.assign(vi.fn(async () => {
      if (mode === "refuse") f.available.mockReturnValue(false);
      return mode === "hold" ? { hold: { reason: "fixture" } as any } : {};
    }), { invalidate() {} });
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn,
      bases: () => f.bases, available: f.available, usage });
    if (mode === "hold") expect(await prepare(f.input)).toMatchObject({ kind: "hold" });
    else await expect(prepare(f.input)).rejects.toThrow("Worker account changed before launch");
    expect(existsSync(join(f.third.home, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(f.third.home, "skills"))).toBe(false);
  });

  it("names the PC sign-in in the signed-out Main line", async () => {
    const f = await fixture();
    f.turns.capture("bot", "thread", { instanceId: "claude", driverKind: "claudeAgent" });
    const nameOf = vi.fn(() => "Codex 1");
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
      available: f.available, usage: Object.assign(vi.fn(async () => ({})), { invalidate() {} }), mainAccount: () => null, nameOf });
    expect(await prepare(f.input)).toMatchObject({ kind: "managed", account: { id: "codex", generation: 0, name: "Codex" },
      line: "Codex Main is signed out, so this worker uses Codex 1." });
    expect(nameOf).toHaveBeenCalledWith("codex", "Codex");
  });

  it.each(["claude", "codex"])("persists the %s argv template before grant substitution", async (engine) => {
    const f = await fixture();
    const command = engine === "codex" ? 'codex -c "shell_environment_policy.set.ORBIT_MSG_AUTH=\'$env:ORBIT_MSG_AUTH\'" task' : "claude --effort high task";
    const launch = await f.prepare({ ...f.input, command });
    const parsed = workers!.workerCommand(command);
    if (parsed.kind !== "managed") throw new Error("Expected managed command");
    expect(launch).toMatchObject({ session: { template: { executable: engine, args: parsed.args } } });
    expect(JSON.stringify(launch?.kind === "managed" && launch.session)).not.toContain("fixture-key");
  });

  it.each(["claude", "codex"] as const)("resumes %s on its exact captured account without an active teacher turn", async (engine) => {
    const f = await fixture();
    f.turns.settled("thread");
    const account = { ...f.third, of: engine };
    const resumeAccount = vi.fn(() => account);
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
      available: f.available, usage: Object.assign(vi.fn(async () => ({ line: "ready" })), { invalidate() {} }), resumeAccount });
    const nativeId = "00000000-0000-4000-8000-000000000001";
    const flags = engine === "claude" ? ["--dangerously-skip-permissions", "--effort", "high", "--session-id", nativeId] : ["--dangerously-bypass-approvals-and-sandbox", "-c", "model_reasoning_effort=high"];
    const launch = await prepare({ ...f.input, command: engine, resume: { engine, nativeId, accountId: account.id, accountGeneration: account.generation,
      template: { executable: engine, args: ["--model", "original", ...flags, "old task"] } } });
    expect(launch).toMatchObject({ kind: "managed", account: { id: account.id }, session: { nativeId, model: "original", effort: "high" } });
    if (launch?.kind !== "managed") throw new Error("Expected managed launch");
    expect(launch.args).toContain(nativeId);
    expect(launch.args).toContain(engine === "claude" ? "-r" : "resume");
    expect(launch.args).not.toContain("--session-id");
    expect(launch.args).not.toContain("old task");
    expect(launch.args.at(-1)).not.toBe("old task");
    expect(launch.args.some((arg) => arg.startsWith("Wink restarted and resumed this conversation."))).toBe(true);
    expect(launch.environment[engine === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]).toBe(account.home);
  });

  it.each([
    { engine: "claude", label: "worker" }, { engine: "claude", label: undefined },
    { engine: "codex", label: "worker" }, { engine: "codex", label: undefined },
  ] as const)("holds both $engine recoveries with label $label on low quota", async ({ engine, label }) => {
    const f = await fixture();
    const account = { ...f.third, of: engine };
    f.rateLimits.set(account.id, { observedAt: new Date().toISOString(), windows: [
      { id: "five_hour", usedPercent: 95, resetsAt: Date.now() + 60_000, windowMinutes: 300 },
    ] });
    const usage = createSpawnUsage({ rateLimits: f.rateLimits, refresh: f.refresh, save() {}, environment: () => ({}) });
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
      available: f.available, usage, resumeAccount: () => account });
    for (const nativeId of ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]) {
      expect(await prepare({ ...f.input, label, command: engine, resume: { engine, nativeId, accountId: account.id,
        accountGeneration: account.generation, template: { executable: engine, args: ["task"] } } })).toMatchObject({ kind: "hold" });
    }
  });

  it("never resumes an unavailable captured account", async () => {
    const f = await fixture();
    f.available.mockReturnValue(false);
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
      available: f.available, usage: Object.assign(vi.fn(async () => ({})), { invalidate() {} }), resumeAccount: () => f.third });
    await expect(prepare({ ...f.input, resume: { engine: "codex", nativeId: "00000000-0000-4000-8000-000000000001", accountId: f.third.id,
      accountGeneration: f.third.generation, template: { executable: "codex", args: ["task"] } } })).rejects.toThrow(/account.*unavailable/i);
  });

  it("rechecks resume admission after usage refresh without falling back", async () => {
    const f = await fixture();
    const resumeAccount = vi.fn().mockResolvedValueOnce(f.third).mockResolvedValueOnce(undefined);
    const prepare = workers!.createWorkerLaunch({ enabled: () => true, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases,
      available: f.available, usage: Object.assign(vi.fn(async () => ({})), { invalidate() {} }), resumeAccount });
    await expect(prepare({ ...f.input, resume: { engine: "codex", nativeId: "00000000-0000-4000-8000-000000000001", accountId: f.third.id,
      accountGeneration: f.third.generation, template: { executable: "codex", args: ["task"] } } })).rejects.toThrow("changed before launch");
  });

  it.each(["claude", "codex"])("records %s launch metadata and clears inherited session ids", async (engine) => {
    const f = await fixture();
    const launch = await f.prepare({ ...f.input, command: `${engine} --model fixture --effort high 'task'`,
      environment: { ...f.input.environment, CODEX_THREAD_ID: "parent", CODEX_SESSION_ID: "parent", CLAUDE_SESSION_ID: "parent", CLAUDE_CODE_SESSION_ID: "parent", CLAUDECODE: "1" } });
    expect(launch).toMatchObject({ session: { engine, model: "fixture", effort: "high", launchGeneration: expect.stringMatching(/^[a-f0-9-]{36}$/) } });
    if (launch?.kind !== "managed") throw new Error("Expected managed launch");
    for (const key of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDECODE"]) expect(launch.environment[key]).toBeUndefined();
    if (engine === "claude") {
      expect(launch.args).toContain("--session-id");
      expect(launch.args[launch.args.indexOf("--session-id") + 1]).toBe(launch.session?.nativeId);
    }
  });

  it.each(["-r exact-id", "-rexact-id", "--resume=exact-id", "-c", "--continue"])("does not assign a new Claude id on %s", async (flags) => {
    const f = await fixture();
    const launch = await f.prepare({ ...f.input, command: `claude ${flags} 'task'` });
    if (launch?.kind !== "managed") throw new Error("Expected managed launch");
    expect(launch.args).not.toContain("--session-id");
    expect(launch).toMatchObject({ session: { nativeId: null } });
  });

  it.each(["--dangerously-bypass-hook-trust", "-c hooks.SessionStart=[]", "-c hooks.state.x.trusted_hash='x'", "-c ' hooks.SessionStart=[]'"])("rejects model-supplied hook trust overrides: %s", async (flags) => {
    const f = await fixture();
    await expect(f.prepare({ ...f.input, command: `codex ${flags} 'task'` })).rejects.toThrow(/hook/i);
  });

  it("captures native effort config and case-insensitive engine commands", async () => {
    const f = await fixture();
    expect(await f.prepare({ ...f.input, command: "CODEX -m fixture -c model_reasoning_effort=high task" }))
      .toMatchObject({ session: { engine: "codex", model: "fixture", effort: "high" } });
  });

  it.each(["HOME", "USERPROFILE"])("resolves pinned Codex workers from the base profile's %s", async (selector) => {
    const f = await fixture();
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("HOME", "");
    vi.stubEnv("USERPROFILE", "");
    try {
      const profile = join(DATA_DIR, "profile-home");
      f.bases.codex.environment = { [selector]: profile };
      f.turns.capture("bot", "thread", { instanceId: "claude", driverKind: "claudeAgent" });
      const launch = await f.prepare({ ...f.input, command: "codex 'task'" });
      expect(launch).toMatchObject({ kind: "managed", environment: { CODEX_HOME: join(profile, ".codex") } });
    } finally { vi.unstubAllEnvs(); }
  });

  it("captures the emitting account when adopting a continuation", async () => {
    const f = await fixture();
    f.turns.settled("thread");
    const live = { instanceId: f.third.id, driverKind: "codex", account: f.third };
    const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true);
    let statement = "";
    const visit = (node: ts.Node) => {
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "foldContinuationStart") statement = node.getText(source);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const noop = () => {};
    runInNewContext(ts.transpile(statement, { target: ts.ScriptTarget.ES2022 }), {
      event: { type: "turn.started", threadId: "thread", turnId: "continued", providerInstanceId: f.third.id }, foldContinuationStart,
      store: { botByThread: () => ({ id: "bot" }), setActivity: noop }, turnStartClaims: new Set(),
      registry: { get: (id: string) => id === f.third.id ? live : null }, providerReload: { started: (_thread: string, id: string) => id === f.third.id ? live : null },
      workerTurns: f.turns, turnRegistry: { start: noop }, rootForStart: () => null, dispatchedThreads: new Map(), liveTurnIdByThread: new Map(),
      turnDispatchedAt: new Map(), tickTurnClock: () => 1, turnStartedAtMs: new Map(), watchdog: { watch: noop },
      paneNoteTurnThreads: new Set(), disownedTurnIds: new Set(),
    });
    expect(await f.prepare(f.input)).toMatchObject({ kind: "managed", account: { id: f.third.id, generation: f.third.generation } });
  });

  it("survives a rejected worker-account startup handshake", async () => {
    const source = ts.createSourceFile("startup-accounts.ts", readFileSync(new URL("./startup-accounts.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true);
    const statement = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "restoreStartupAccounts") as ts.FunctionDeclaration;
    const error = vi.fn();
    await expect(runInNewContext(`(async () => { ${ts.transpile(statement.body!.getText(source), { target: ts.ScriptTarget.ES2022 })} })()`, {
      access: null, restore: async () => {}, startupTiming: { track: (_name: string, work: () => Promise<void>) => work() },
      enableWorkerAccounts: async () => { throw new Error("offline fixture"); }, console: { error },
    })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });

  it.each([undefined, "send"] as const)("allows unrelated shell environment prefixes in %s mode", async (mode) => {
    const f = await fixture();
    expect(await f.prepare({ ...f.input, command: "$env:CI='1'; pnpm test", mode })).toEqual({ kind: "shell" });
    await expect(f.prepare({ ...f.input, command: "$env:HOME='x'; npm test" })).rejects.toThrow(/Conflicting worker home override/);
    await expect(f.prepare({ ...f.input, command: "$env:CI='1'; codex task" })).rejects.toThrow(/Conflicting worker environment override/);
  });

  describe.each([undefined, "send"] as const)("shell wrappers in %s mode", (mode) => {
    it.each([
      String.raw`pwsh -NoProfile -File .\ci-954.ps1`, "powershell -File x.ps1", "cmd /c dir", "bash ./run.sh",
      "pwsh.exe -File x.ps1", "powershell.exe -File x.ps1", "cmd.exe /c dir", "sh ./run.sh", "env CI=1 ./run.sh",
      String.raw`& .\ci-954.ps1`, String.raw`. .\ci-954.ps1`, "iex 'Get-Date'", "invoke-expression 'Get-Date'", "start-process pwsh",
      String.raw`pwsh -File .\codex-watch.ps1`, String.raw`pwsh -File .\mycodex.ps1`, String.raw`pwsh -File .\codex.json`,
    ])("allows an ordinary shell command: %s", async (command) => {
      const f = await fixture();
      expect(await f.prepare({ ...f.input, command, mode })).toEqual({ kind: "shell" });
      expect(f.refresh).not.toHaveBeenCalled();
      expect(f.available).not.toHaveBeenCalled();
    });

    it.each(["claude", "codex", "grok", "muse", "agy"])("refuses wrappers naming %s", async (engine) => {
      const f = await fixture();
      for (const command of [
        `pwsh -Command "${engine} task"`, `powershell -Command "${engine} task"`, `cmd /c ${engine} task`, `bash -lc '${engine} task'`,
        `pwsh.exe -Command "${engine} task"`, `powershell.exe -Command "${engine} task"`, `cmd.exe /c ${engine} task`,
        `sh -c '${engine} task'`, `env CI=1 ${engine} task`, `& ${engine} task`, `. ${engine} task`,
        `iex '${engine} task'`, `invoke-expression '${engine} task'`, `start-process ${engine}`,
        `pwsh -Command "C:/bin/${engine}.exe task"`, `cmd /c C:/bin/${engine}.cmd task`, `pwsh -File C:/bin/${engine}.ps1`,
        `pwsh -Command "echo ${engine}"`,
        `bash -c '${engine.slice(0, 2)}"${engine.slice(2)}" task'`,
        `pwsh -Command "\`${engine} task"`, `cmd /c ^${engine} task`, `bash -c '${engine.slice(0, 2)}\\${engine.slice(2)} task'`,
        `env --split-string='${engine} task'`, `env -S${engine} task`,
      ]) await expect(f.prepare({ ...f.input, command, mode })).rejects.toThrow("Ambiguous worker launch; use a direct engine command");
      expect(f.refresh).not.toHaveBeenCalled();
      expect(f.available).not.toHaveBeenCalled();
    });
  });

  it.each(["codex; id", "codex|more", "(codex 'task')", "$(codex 'task')", "{ codex }"])("refuses a nested or adjacent engine: %s", (command) => {
    expect(() => workers!.workerCommand(command)).toThrow(/Ambiguous worker/);
  });

  it("preserves Claude continue prompts that mention login", async () => {
    const f = await fixture();
    expect(await f.prepare({ ...f.input, command: "claude -c 'fix the login bug'" })).toMatchObject({ kind: "managed", args: expect.arrayContaining(["-c", "fix the login bug"]) });
  });

  it.each(["linux", "darwin"])("preserves POSIX worker quoting on %s", (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    try {
      const cases = [
        [String.raw`claude "Say \"hello\""`, ['Say "hello"']],
        [String.raw`claude "path\\file\q"`, [String.raw`path\file\q`]],
        [String.raw`claude Say\ hello`, ["Say hello"]],
        [String.raw`claude 'it'\''s'`, ["it's"]],
        [String.raw`claude 'it''s'`, ["its"]],
        [String.raw`claude "\$literal \`literal"`, ["$literal `literal"]],
        [String.raw`claude escaped\;value`, ["escaped;value"]],
        ['claude "" a\\\nb', ["", "ab"]],
      ] as const;
      for (const [command, args] of cases) expect(workers!.workerCommand(command)).toMatchObject({ kind: "managed", args });
      expect(() => workers!.workerCommand("claude task\\")).toThrow(/quoting/);
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps Windows worker quoting and backslashes unchanged", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    try {
      expect(workers!.workerCommand(String.raw`claude 'it''s' C:\work\task "Say \"hello\""`))
        .toMatchObject({ kind: "managed", args: ["it's", String.raw`C:\work\task`, "Say \\hello\\"] });
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(["codex", "claude"])("preserves the inherited %s home for an existing account", async (engine) => {
    const f = await fixture();
    const selector = engine === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    const driverKind = engine === "codex" ? "codex" : "claudeAgent";
    const inherited = join(DATA_DIR, "inherited-login");
    vi.stubEnv(selector, inherited);
    try {
      delete f.bases[engine].environment;
      f.turns.capture("bot", "thread", { instanceId: engine, driverKind });
      const launch = await f.prepare({ ...f.input, command: `${engine} 'task'` });
      expect(launch).toMatchObject({ account: { id: engine, generation: 0 }, environment: { [selector]: inherited } });
      f.bases[engine].environment = { [selector]: join(DATA_DIR, "configured-login") };
      expect(await f.prepare({ ...f.input, command: `${engine} 'task'` })).toMatchObject({ environment: f.bases[engine].environment });
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["codex", "claude"])("leaves the default Claude config selector unset from a %s turn", async (engine) => {
    const f = await fixture();
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    try {
      delete f.bases.claude.environment;
      f.turns.capture("bot", "thread", { instanceId: engine, driverKind: engine === "claude" ? "claudeAgent" : "codex" });
      const launch = await f.prepare({ ...f.input, command: "claude 'task'", environment: { ...f.input.environment, Claude_Config_Dir: "inherited-wrong" } });
      expect(launch).toMatchObject({ kind: "managed", account: { id: "claude", generation: 0 } });
      if (launch?.kind !== "managed") throw new Error("expected managed launch");
      expect(launch.environment.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(Object.keys(launch.environment).filter((key) => key.toUpperCase() === "CLAUDE_CONFIG_DIR")).toEqual([]);
      expect(f.available).toHaveBeenCalledWith("claude", 0);
      expect(f.refresh).toHaveBeenCalledExactlyOnceWith("claude", undefined);
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps the default Codex home and isolated worker state", async () => {
    const f = await fixture();
    vi.stubEnv("CODEX_HOME", undefined);
    try {
      delete f.bases.codex.environment;
      f.turns.capture("bot", "thread", { instanceId: "codex", driverKind: "codex" });
      expect(await f.prepare(f.input)).toMatchObject({ account: { id: "codex", generation: 0 },
        environment: { CODEX_HOME: join(homedir(), ".codex"), CODEX_SQLITE_HOME: join(homedir(), ".codex", "state") } });
      expect(f.refresh).toHaveBeenCalledExactlyOnceWith("codex", undefined);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["CLAUDE_CONFIG_DIR", "Claude_Config_Dir"])("preserves an explicit default Claude directory via %s", async (selector) => {
    const f = await fixture();
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
    try {
      f.bases.claude.environment = { [selector]: join(homedir(), ".claude") };
      expect(await f.prepare({ ...f.input, command: "claude 'task'" })).toMatchObject({
        environment: { CLAUDE_CONFIG_DIR: join(homedir(), ".claude") },
      });
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([0, 1])("captures dispatch %i before the first account is added", async (index) => {
    const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true);
    const dispatches: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "workerTurns.capture" && node.expression.arguments[2]?.getText(source) === "live") {
        dispatches.push((ts.isIfStatement(node.parent) ? node.parent : node).getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(dispatches).toHaveLength(2);
    const accounts = new AccountService(join(DATA_DIR, `mid-turn-${++serial}`), () => ({ codex: { driver: "codex" } }));
    const turns = captures!.createWorkerTurns();
    runInNewContext(ts.transpile(dispatches[index], { target: ts.ScriptTarget.ES2022 }), {
      accounts, workerTurns: turns, bot: { id: "bot" }, threadId: "thread", live: { instanceId: "codex", driverKind: "codex" },
    });
    const usage = Object.assign(vi.fn(async () => ({})), { invalidate() {} });
    const prepare = workers!.createWorkerLaunch({ enabled: () => accounts.snapshot.length > 0, resolveWorkerTurn: turns.resolveWorkerTurn,
      bases: () => ({ codex: { driver: "codex" } }), available: () => true, usage });
    const input = { botId: "bot", command: "codex 'task'", environment: {} };
    expect(await prepare(input)).toBeNull();
    await accounts.add("codex");
    expect(await prepare(input)).toMatchObject({ kind: "managed", account: { id: "codex", generation: 0 } });
  });

  it("resolves account 3 from the active dispatch and reuses core policy", async () => {
    const f = await fixture();
    const launch = await f.prepare(f.input);
    expect(launch).toMatchObject({ kind: "managed", account: { id: f.third.id, generation: f.third.generation }, environment: { CODEX_HOME: f.third.home, CODEX_SQLITE_HOME: join(f.third.home, "state") } });
    if (launch?.kind !== "managed") throw new Error("expected managed launch");
    expect(launch.environment).not.toHaveProperty("OpenAI_Api_Key");
    expect(launch.environment).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(launch.args).toContain("--no-daemon");
    expect(launch.args).toContain('forced_login_method="chatgpt"');
    expect(f.refresh).toHaveBeenCalledExactlyOnceWith(f.third.id, undefined);
  });

  it.each(["codex --profile work 'task'", "codex -c sqlite_home='wrong' 'task'", "codex --config=forced_login_method='api' 'task'", "codex -- 'task'"])("refuses a model selector: %s", async (command) => {
    const f = await fixture();
    await expect(f.prepare({ ...f.input, command })).rejects.toThrow(/Conflicting/);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("other-engine workers use the explicitly named base and its home", async () => {
    const f = await fixture();
    const base = f.bases.claude.environment!.CLAUDE_CONFIG_DIR!;
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "CLAUDE.md"), "fixture base rules");
    const launch = await f.prepare({ ...f.input, command: "claude --model fixture 'task'" });
    expect(launch).toMatchObject({ account: { id: "claude", generation: 0 }, environment: { CLAUDE_CONFIG_DIR: f.bases.claude.environment!.CLAUDE_CONFIG_DIR } });
    if (launch?.kind !== "managed") throw new Error("expected managed launch");
    expect(launch.environment).not.toHaveProperty("CODEX_HOME");
    expect(launch.args.slice(-2)).toEqual(["--setting-sources", "project,local"]);
    expect(readFileSync(join(base, "CLAUDE.md"), "utf8")).toBe("fixture base rules");
    expect(readdirSync(base)).toEqual(["CLAUDE.md"]);
    expect(f.available).toHaveBeenCalledWith("claude", 0);
  });

  it("routes an other-engine Codex worker to that engine's ready Main and reports its usage", async () => {
    const f = await fixture();
    const m = mainRouting(f);
    await f.accounts.setDefault("codex", f.third.id);
    f.turns.capture("bot", "thread", { instanceId: "claude", driverKind: "claudeAgent" });
    const observedAt = new Date().toISOString();
    f.rateLimits.set("codex", { observedAt, windows: [{ id: "seven_day", usedPercent: 94, resetsAt: null, windowMinutes: 10080 }] });
    f.rateLimits.set(f.third.id, { observedAt, windows: [{ id: "seven_day", usedPercent: 20, resetsAt: null, windowMinutes: 10080 }] });
    expect(await m.prepare(f.input)).toMatchObject({ kind: "managed", account: { id: f.third.id, generation: f.third.generation },
      environment: { CODEX_HOME: f.third.home, CODEX_SQLITE_HOME: join(f.third.home, "state") }, line: "Codex usage left: weekly 80%." });
    expect(f.available).toHaveBeenCalledWith(f.third.id, f.third.generation);
  });

  it("routes an other-engine Claude worker to that engine's ready Main", async () => {
    const f = await fixture();
    const m = mainRouting(f);
    delete f.bases.claude.environment;
    const main = await f.accounts.identify((await f.accounts.add("claude")).id, "claude-main");
    await f.accounts.setDefault("claude", main.id);
    expect(await m.prepare({ ...f.input, command: "claude 'task'" })).toMatchObject({ kind: "managed", account: { id: main.id, generation: main.generation },
      environment: { CLAUDE_CONFIG_DIR: main.home, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } });
  });

  it("keeps the base when the other engine has no Main", async () => {
    const f = await fixture();
    const m = mainRouting(f);
    f.turns.capture("bot", "thread", { instanceId: "claude", driverKind: "claudeAgent" });
    expect(await m.prepare(f.input)).toMatchObject({ kind: "managed", account: { id: "codex", generation: 0 },
      environment: { CODEX_HOME: f.bases.codex.environment!.CODEX_HOME } });
  });

  it.each(["signed out", "blocked"])("falls back to the base and says so when the other engine's Main is %s", async (state) => {
    const f = await fixture();
    const m = mainRouting(f);
    f.turns.capture("bot", "thread", { instanceId: "claude", driverKind: "claudeAgent" });
    await f.accounts.setDefault("codex", f.third.id);
    if (state === "signed out") await f.accounts.stop(f.third.id);
    if (state === "blocked") m.blocked.add(f.third.id);
    const launch = await m.prepare(f.input);
    expect(launch).toMatchObject({ kind: "managed", account: { id: "codex", generation: 0 },
      environment: { CODEX_HOME: f.bases.codex.environment!.CODEX_HOME } });
    expect(launch && "line" in launch ? launch.line : "").toMatch(/^Codex Main is signed out, so this worker uses your default account\./);
  });

  it.each([
    { from: "claude", to: "codex" }, { from: "codex", to: "claude" },
  ] as const)("rejects a $to worker when Main changes during usage refresh from a $from turn", async ({ from, to }) => {
    const f = await fixture();
    delete f.bases.claude.environment;
    const ready = async (name: string) => f.accounts.identify((await f.accounts.add(to)).id, name);
    const first = to === "codex" ? f.third : await ready("first-identity");
    const second = await ready("second-identity");
    await f.accounts.setDefault(to, first.id);
    f.turns.capture("bot", "thread", from === "claude" ? { instanceId: "claude", driverKind: "claudeAgent" } : { instanceId: "codex", driverKind: "codex" });
    const m = mainRouting(f);
    f.refresh.mockImplementation(async () => { await f.accounts.setDefault(to, second.id); return {}; });
    await expect(m.prepare({ ...f.input, command: `${to} 'task'` })).rejects.toThrow("Worker account changed before launch");
  });

  it("keeps same-engine workers on the captured turn's account when Main is another account", async () => {
    const f = await fixture();
    const m = mainRouting(f);
    const other = await f.accounts.identify(f.accounts.snapshot.find((row) => row.id !== f.third.id)!.id, "other-identity");
    await f.accounts.setDefault("codex", other.id);
    expect(await m.prepare(f.input)).toMatchObject({ account: { id: f.third.id, generation: f.third.generation } });
    f.turns.capture("bot", "thread", { instanceId: "codex", driverKind: "codex" });
    expect(await m.prepare(f.input)).toMatchObject({ account: { id: "codex", generation: 0 } });
  });

  it("resumes a worker on its own account when its engine's Main is another account", async () => {
    const f = await fixture();
    const base = Object.freeze({ id: "codex", of: "codex", generation: 0, home: f.bases.codex.environment!.CODEX_HOME });
    const m = mainRouting(f, () => base);
    await f.accounts.setDefault("codex", f.third.id);
    f.turns.capture("bot", "thread", { instanceId: "claude", driverKind: "claudeAgent" });
    expect(await m.prepare({ ...f.input, resume: { engine: "codex", nativeId: "00000000-0000-4000-8000-000000000001", accountId: "codex",
      accountGeneration: 0, template: { executable: "codex", args: ["task"] } } })).toMatchObject({ kind: "managed", account: { id: "codex", generation: 0 },
      environment: { CODEX_HOME: base.home } });
  });

  it("keeps the existing Codex worker template and trusted pane grant expansion", async () => {
    const f = await fixture();
    const report = workerReportText("win32", true);
    const launch = await f.prepare({ ...f.input, command: `codex --model fixture -c model_reasoning_effort=high -c "projects={'C:/worktree'={trust_level='trusted'}}" --dangerously-bypass-approvals-and-sandbox ${report.env}${report.notify}'task'` });
    expect(launch).toMatchObject({ kind: "managed", account: { id: f.third.id } });
    if (launch?.kind !== "managed") throw new Error("expected managed launch");
    expect(launch.args.join(" ")).toContain("\u0000ORBIT_MSG_AUTH\u0000");
    expect(launch.args).toContain("--no-daemon");
  });

  it.each([true, false])("routes Claude account 3 with a configured base %s and replaces only the installed worker settings hook", async (configured) => {
    const f = await fixture();
    if (!configured) delete f.bases.claude.environment;
    await f.accounts.add("claude");
    const added = await f.accounts.add("claude");
    const third = await f.accounts.identify(added.id, "claude-fixture");
    f.turns.capture("bot", "thread", { instanceId: third.id, driverKind: "claudeAgent", account: third });
    const report = workerReportText("win32", true);
    const launch = await f.prepare({ ...f.input, command: `claude --model fixture --effort high --dangerously-skip-permissions ${report.claude}'task'` });
    expect(launch).toMatchObject({ workerSettings: true, account: { id: third.id }, environment: { CLAUDE_CONFIG_DIR: third.home, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } });
    if (launch?.kind !== "managed") throw new Error("expected managed launch");
    expect(launch.args.join(" ")).not.toContain("claude-worker.json");
    expect(launch.args.slice(-2)).toEqual(["--setting-sources", "user,project,local"]);
  });

  it.each(["& codex 'task'", "codex 'task'; echo done", "pwsh -Command codex", "pnpm exec codex 'task'", "C:/bin/codex.cmd 'task'", "'codex' 'task'", "codex $(whoami)", "codex 'task\x1b[D'"])("refuses ambiguous workers: %s", async (command) => {
    const f = await fixture();
    await expect(f.prepare({ ...f.input, command })).rejects.toThrow(/Ambiguous/);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("does not fall back when an active turn is missing or its account is blocked", async () => {
    const f = await fixture();
    f.available.mockReturnValue(false);
    await expect(f.prepare(f.input)).rejects.toThrow("account is unavailable");
    f.turns.settled("thread");
    await expect(f.prepare(f.input)).rejects.toThrow("No captured active turn");
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("ignores later binding changes until a new dispatch is captured", async () => {
    const f = await fixture();
    const original = f.turns.resolveWorkerTurn("bot");
    await f.accounts.identify(f.third.id, "different-identity");
    expect(f.turns.resolveWorkerTurn("bot")).toBe(original);
    expect(original?.account?.generation).toBe(f.third.generation);
    f.available.mockReturnValue(false);
    await expect(f.prepare(f.input)).rejects.toThrow("unavailable");
  });

  it("rejects a launch if its captured turn settles during usage refresh", async () => {
    const f = await fixture();
    f.refresh.mockImplementation(async () => { f.turns.settled("thread"); return {}; });
    await expect(f.prepare(f.input)).rejects.toThrow("changed before launch");
  });

  it("keeps ordinary shell commands and explicit unmanaged home commands separate", async () => {
    const f = await fixture();
    expect(await f.prepare({ ...f.input, command: "pnpm dev" })).toEqual({ kind: "shell" });
    expect(await f.prepare({ ...f.input, command: "rg 'codex' server" })).toEqual({ kind: "shell" });
    expect(await f.prepare({ ...f.input, command: "$env:CODEX_HOME='power-user-home'; codex 'task'", mode: "send" })).toEqual({ kind: "unmanaged" });
    await expect(f.prepare({ ...f.input, mode: "send" })).rejects.toThrow("terminal_spawn");
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous base rather than choosing another configured profile", async () => {
    const f = await fixture();
    f.bases.otherClaude = f.bases.claude;
    delete f.bases.claude;
    await expect(f.prepare({ ...f.input, command: "claude 'task'" })).rejects.toThrow("base account is unavailable");
  });

  it("does no account, usage, filesystem or engine work without accounts", async () => {
    expect(workers, "trusted worker launch gate exists").not.toBeNull();
    const unused = vi.fn(() => { throw new Error("unexpected no-accounts work"); });
    const prepare = workers!.createWorkerLaunch({ enabled: () => false, resolveWorkerTurn: unused, bases: unused, available: unused, usage: Object.assign(unused, { invalidate() {} }) });
    expect(await prepare({ botId: "bot", command: "$env:CODEX_HOME='legacy'; codex", environment: {} })).toBeNull();
    expect(unused).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"] as const)("captures a zero-account %s session and adds only its capture flags", async (engine) => {
    const unused = vi.fn(() => { throw new Error("unexpected routed work"); });
    const prepare = workers!.createWorkerLaunch({ enabled: () => false, resolveWorkerTurn: unused, bases: unused, available: unused, usage: Object.assign(unused, { invalidate() {} }) });
    const report = workerReportText("win32", true);
    const command = engine === "claude"
      ? `claude --model fixture --effort high --dangerously-skip-permissions ${report.claude}'task'`
      : `codex --model fixture -c model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox ${report.env}${report.notify}'task'`;
    const launch = await prepare({ botId: "bot", label: "worker", command, environment: { OpenAI_Api_Key: "fixture-key" }, unrouted: true });
    const parsed = workers!.workerCommand(command);
    if (parsed.kind !== "managed" || launch?.kind !== "unrouted") throw new Error("Expected an unrouted launch");
    expect(launch).toMatchObject({ account: { id: engine, generation: 0 }, workerSettings: engine === "claude",
      session: { engine, model: "fixture", effort: "high", template: { executable: engine, args: parsed.args } } });
    expect(launch.args).toEqual(engine === "claude" ? ["--session-id", launch.session?.nativeId] : []);
    expect(unused).not.toHaveBeenCalled();
  });

  it.each(["claude -- 'task'", "codex -c hooks.SessionStart=[] 'task'", "$env:CODEX_HOME='x'; codex 'task'", "claude --settings 'C:/custom.json' 'task'",
    "pwsh -Command \"claude task\"", "claude 'task'; rm x", "pnpm test", "grok 'task'", ""])("leaves a zero-account command it cannot capture alone: %s", async (command) => {
    const unused = vi.fn(() => { throw new Error("unexpected routed work"); });
    const prepare = workers!.createWorkerLaunch({ enabled: () => false, resolveWorkerTurn: unused, bases: unused, available: unused, usage: Object.assign(unused, { invalidate() {} }) });
    expect(await prepare({ botId: "bot", command, environment: {}, unrouted: true })).toBeNull();
    expect(unused).not.toHaveBeenCalled();
  });

  it("leaves unrouted requests to the plain launch once accounts exist", async () => {
    const f = await fixture();
    expect(await f.prepare({ ...f.input, unrouted: true })).toBeNull();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.available).not.toHaveBeenCalled();
  });

  it.each(["claude", "codex"] as const)("resumes a zero-account %s run unrouted after the base sign-in and usage checks", async (engine) => {
    const f = await fixture();
    const account = Object.freeze({ id: engine, of: engine, generation: 0, home: join(DATA_DIR, `base-${engine}`) });
    const base = f.bases[engine].environment![engine === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]!;
    mkdirSync(join(base, "skills/my-skill"), { recursive: true });
    writeFileSync(join(base, engine === "claude" ? "CLAUDE.md" : "AGENTS.md"), "fixture global rules");
    const resumeAccount = vi.fn(() => account);
    const usage = Object.assign(vi.fn(async (): Promise<{ hold?: string; line?: string }> => ({ line: "ready" })), { invalidate() {} });
    const prepare = workers!.createWorkerLaunch({ enabled: () => false, resolveWorkerTurn: f.turns.resolveWorkerTurn, bases: () => f.bases, available: f.available, usage, resumeAccount });
    const nativeId = "00000000-0000-4000-8000-000000000002";
    const flags = engine === "claude" ? ["--dangerously-skip-permissions", "--settings", join(homedir(), ".orbit", "bin", "claude-worker.json"), "--session-id", nativeId]
      : ["--dangerously-bypass-approvals-and-sandbox", "-c", "model_provider=custom"];
    const resume = { engine, nativeId, accountId: engine, accountGeneration: 0, unrouted: true as const, template: { executable: engine, args: ["--model", "original", ...flags, "old task"] } };
    const launch = await prepare({ ...f.input, command: engine, resume });
    expect(launch).toMatchObject({ kind: "unrouted", account: { id: engine, generation: 0 }, executable: engine, workerSettings: engine === "claude", line: "ready", session: { nativeId } });
    expect(launch).not.toHaveProperty("environment");
    expect(launch?.kind === "unrouted" && launch.args).not.toContain("--setting-sources");
    expect(existsSync(account.home)).toBe(false);
    expect(launch?.kind === "unrouted" && launch.args).toEqual(engine === "claude" ? ["--model", "original", "--dangerously-skip-permissions", "-r", nativeId, RESUME_NUDGE]
      : ["resume", nativeId, "--model", "original", "--dangerously-bypass-approvals-and-sandbox", "-c", "model_provider=custom", RESUME_NUDGE]);
    expect(usage).toHaveBeenCalledExactlyOnceWith("bot", "worker", engine, undefined, true);
    expect(resumeAccount).toHaveBeenCalledWith(engine, 0);
    usage.mockResolvedValueOnce({ hold: "Held: low usage" });
    expect(await prepare({ ...f.input, command: engine, resume })).toEqual({ kind: "hold", hold: "Held: low usage" });
  });

  it("keeps the no-accounts terminal tool response unchanged using a recorded command", async () => {
    const recorded = JSON.parse(readFileSync(new URL("../test/fixtures/recorded/claude/worker-shell.json", import.meta.url), "utf8"));
    const command = recorded.reply.messages[0].message.content[0].input.command;
    const request = vi.fn<typeof fetch>(async () => Response.json({ sessionId: "pane", generation: 1 }));
    const result = await callTool("terminal_spawn", request, { host: "http://fixture", token: "grant", botId: "bot" }, { label: "shell", command });
    expect(result.content[0].text).toBe('Opened pane "shell": sessionId pane (generation 1). Use terminal_read and terminal_send with this sessionId.');
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ label: "shell", command });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("worker service boundary", () => {
  it("requires the private host token and ignores model account fields", async () => {
    const f = await fixture();
    expect(panes, "private worker launch route exists").not.toBeNull();
    const access = { url: "http://fixture", token: "private-host" };
    const input = { ...f.input, account: { id: "model" }, home: "wrong" };
    expect((await panes!.workerLaunchResponse(access, "bot-read-grant", input, f.prepare)).status).toBe(401);
    const result = await panes!.workerLaunchResponse(access, access.token, input, f.prepare);
    expect(result).toMatchObject({ status: 200, body: { launch: { account: { id: f.third.id } } } });
  });

  it("passes zero-account capture and resume flags through the private route", async () => {
    const access = { url: "http://fixture", token: "private-host" };
    const prepare = vi.fn(async (_input: unknown) => null);
    const resume = { engine: "claude", nativeId: "00000000-0000-4000-8000-000000000003", accountId: "claude", accountGeneration: 0, unrouted: true, template: { executable: "claude", args: [] } };
    await panes!.workerLaunchResponse(access, access.token, { botId: "bot", command: "claude 'task'", environment: {}, unrouted: true }, prepare);
    await panes!.workerLaunchResponse(access, access.token, { botId: "bot", command: "claude", environment: {}, resume }, prepare);
    expect(prepare.mock.calls.map(([input]) => input)).toMatchObject([{ unrouted: true }, { resume: { unrouted: true } }]);
  });

  it("exposes account pane counts and treats unreachable or unknown hosts conservatively", async () => {
    expect(panes, "live pane account interface exists").not.toBeNull();
    const access = { url: "http://fixture", token: "private-host" };
    const request = vi.fn<typeof fetch>(async () => Response.json({ count: 2, unknown: 1, generations: { "3": 2 } }));
    expect(await panes!.livePanesForAccount(access, "acct_third", request)).toEqual({ count: 2, unknown: 1, generations: { "3": 2 } });
    expect(String(request.mock.calls[0][0])).toContain("accountId=acct_third");
    request.mockRejectedValue(new Error("offline"));
    expect(await panes!.livePanesForAccount(access, "acct_third", request)).toEqual({ count: 0, unknown: 1, generations: {} });
    expect(await panes!.livePanesForAccount(null, "acct_third", request)).toEqual({ count: 0, unknown: 1, generations: {} });
  });

  it("enables host policy before accounts can be added and fails closed on an old host", async () => {
    expect(panes, "trusted worker account enable exists").not.toBeNull();
    const request = vi.fn<typeof fetch>(async () => Response.json({ enabled: true }));
    await panes!.enableWorkerAccounts({ url: "http://fixture", token: "host" }, request);
    expect(request.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { authorization: "Bearer host" } });
    request.mockResolvedValue(Response.json({}));
    await expect(panes!.enableWorkerAccounts({ url: "http://fixture", token: "host" }, request)).rejects.toThrow("unavailable");
    request.mockClear();
    await panes!.enableWorkerAccounts(null, request);
    expect(request).not.toHaveBeenCalled();
  });

  it("terminal tools preserve trusted host usage holds and usage lines", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ hold: "Held: captured account" }));
    const config = { host: "http://fixture", token: "grant", botId: "bot" };
    expect(await callTool("terminal_spawn", request, config, { label: "worker", command: "codex 'task'" })).toEqual({ content: [{ type: "text", text: "Held: captured account" }] });
    request.mockResolvedValue(Response.json({ sessionId: "pane", generation: 1, line: "Captured usage left." }));
    expect((await callTool("terminal_spawn", request, config, { label: "worker", command: "codex 'task'" })).content[0].text).toContain("Captured usage left.");
  });
});
