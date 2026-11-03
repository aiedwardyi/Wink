import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { AccountService } from "./accounts.ts";
import { DATA_DIR } from "./config.ts";
import { createSpawnUsage } from "./spawn-usage.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import type { RateLimitsMap } from "./rate-limits-store.ts";
import { callTool, workerReportText } from "./drivers/terminal-proxy.ts";

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

describe("trusted worker accounts", () => {
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

  it.each([0, 1])("captures dispatch %i before the first account is added", async (index) => {
    const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const dispatches: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "workerTurns.capture") {
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

  it.each(["$env:CODEX_HOME='wrong'; codex 'task'", "$env:CLAUDE_CONFIG_DIR='wrong'; claude 'task'", "codex --profile work 'task'", "codex -c sqlite_home='wrong' 'task'", "codex --config=forced_login_method='api' 'task'", "codex -- 'task'"])("refuses a model selector: %s", async (command) => {
    const f = await fixture();
    await expect(f.prepare({ ...f.input, command })).rejects.toThrow(/Conflicting/);
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it("other-engine workers use the explicitly named base and its home", async () => {
    const f = await fixture();
    const launch = await f.prepare({ ...f.input, command: "claude --model fixture 'task'" });
    expect(launch).toMatchObject({ account: { id: "claude", generation: 0 }, environment: { CLAUDE_CONFIG_DIR: f.bases.claude.environment!.CLAUDE_CONFIG_DIR } });
    if (launch?.kind !== "managed") throw new Error("expected managed launch");
    expect(launch.environment).not.toHaveProperty("CODEX_HOME");
    expect(launch.args.slice(-2)).toEqual(["--setting-sources", "project,local"]);
    expect(f.available).toHaveBeenCalledWith("claude", 0);
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

  it("routes Claude account 3 and replaces only the installed worker settings hook", async () => {
    const f = await fixture();
    await f.accounts.add("claude");
    const added = await f.accounts.add("claude");
    const third = await f.accounts.identify(added.id, "claude-fixture");
    f.turns.capture("bot", "thread", { instanceId: third.id, driverKind: "claudeAgent", account: third });
    const report = workerReportText("win32", true);
    const launch = await f.prepare({ ...f.input, command: `claude --model fixture --effort high --dangerously-skip-permissions ${report.claude}'task'` });
    expect(launch).toMatchObject({ workerSettings: true, account: { id: third.id }, environment: { CLAUDE_CONFIG_DIR: third.home, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } });
    if (launch?.kind !== "managed") throw new Error("expected managed launch");
    expect(launch.args.join(" ")).not.toContain("claude-worker.json");
    expect(launch.args.slice(-2)).toEqual(["--setting-sources", "project,local"]);
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
