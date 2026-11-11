import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { accountLaunch } from "./account-policy.ts";
import { DATA_DIR } from "./config.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { workerReportText } from "./drivers/terminal-proxy.ts";
import type { RateLimitsReport } from "./rate-limits-store.ts";
import { createSpawnUsage } from "./spawn-usage.ts";
import { createUsageBoard } from "./usage-board.ts";
import { createUsageHistory } from "./usage-history.ts";
import { createWorkerLaunch } from "./worker-launch.ts";
import { workerLaunchResponse } from "./worker-panes.ts";
import { createWorkerTurns } from "./worker-turn.ts";

const credit = await import("./codex-credit.ts").catch(() => null);
const { managedWorkerCommand } = await import(new URL("../electron/terminal-worker.mjs", import.meta.url).href);

const KEY = "sk-proj-WINKFAKECREDITKEY-leak-sweep-0001";
const ENV = "WINK_OPENAI_CREDIT_KEY";
const CHATGPT = { id: "acct_7d6e234b-1c2d-4e5f-8a9b-0c1d2e3f4a5b", of: "codex", home: join(DATA_DIR, "accounts", "chatgpt"), generation: 1 };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let serial = 0;

function setup(enabled = true) {
  expect(credit, "codex credit exists").not.toBeNull();
  const root = join(DATA_DIR, `codex-credit-${++serial}`);
  const bases: InstanceConfigMap = {
    codex: { driver: "codex", environment: { CODEX_HOME: join(root, "base-codex") } },
    claude: { driver: "claudeAgent", environment: { CLAUDE_CONFIG_DIR: join(root, "base-claude") } },
  };
  mkdirSync(join(root, "base-codex"), { recursive: true });
  writeFileSync(join(root, "base-codex", "AGENTS.md"), "fixture guide");
  const saved: { key?: string } = { key: KEY };
  const turns = createWorkerTurns();
  turns.capture("bot", "thread", { instanceId: "codex", driverKind: "codex" });
  const usage = createSpawnUsage({ rateLimits: new Map(), refresh: async () => ({}), save() {}, environment: () => undefined });
  const prepare = createWorkerLaunch({ enabled: () => enabled, resolveWorkerTurn: turns.resolveWorkerTurn, bases: () => bases, available: () => true,
    usage, nameOf: (id) => id === "codex" ? "Codex 1" : "Claude 1", accounts: () => [], credit: () => credit?.codexCredit(root, bases, saved.key) });
  const input = { botId: "bot", label: "worker", command: "$env:CODEX_HOME='OpenAI credit'; codex --model fixture 'task'",
    environment: { ...process.env, OPENAI_API_KEY: "inherited-wrong", CODEX_HOME: "inherited-wrong" } as Record<string, string> };
  return { root, bases, saved, prepare, input, home: join(root, "codex-credit") };
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    return stat.isSymbolicLink() ? [] : stat.isDirectory() ? files(path) : [path];
  });
}

function powershell(command: string, env: NodeJS.ProcessEnv) {
  const script = "$ProgressPreference = 'SilentlyContinue'; $command = [Console]::In.ReadToEnd(); try { Invoke-Expression $command } catch {}; "
    + `if (Test-Path Env:${ENV}) { 'left' } else { 'cleared' }`;
  return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { input: command, encoding: "utf8", windowsHide: true, timeout: 20_000, env });
}

describe("OpenAI credit Codex account", () => {
  it("names the key's env var in argv and puts the key only in the child env", () => {
    const account = credit?.codexCredit(DATA_DIR, { codex: { driver: "codex" } }, KEY)?.account;
    expect(account).toEqual({ id: "codex-credit", of: "codex", home: join(DATA_DIR, "codex-credit"), generation: 1 });
    const launch = accountLaunch(account!, "codex", ["--model", "fixture"], { OPENAI_API_KEY: "inherited-wrong", CODEX_HOME: "inherited-wrong", PATH: "fixture-path" }, true, KEY);
    expect(launch.args).toEqual(["--model", "fixture", "-c", `sqlite_home=${JSON.stringify(join(account!.home, "state"))}`,
      "-c", 'model_providers.openai_credit.name="OpenAI credit"', "-c", 'model_providers.openai_credit.base_url="https://api.openai.com/v1"',
      "-c", `model_providers.openai_credit.env_key="${ENV}"`, "-c", 'model_providers.openai_credit.wire_api="responses"',
      "-c", 'model_provider="openai_credit"', "-c", `shell_environment_policy.exclude=["${ENV}"]`]);
    expect(launch.args.join(" ")).not.toContain(KEY);
    expect(launch.env).toEqual({ PATH: "fixture-path", CODEX_HOME: account!.home, CODEX_SQLITE_HOME: join(account!.home, "state"), [ENV]: KEY });
    expect(() => accountLaunch(account!, "codex", [], {}, true)).toThrow("OpenAI credit needs a saved OpenAI key");
  });

  it("keeps ChatGPT accounts on today's args even when a key is passed", () => {
    const today = ["--model", "fixture", "-c", `sqlite_home=${JSON.stringify(join(CHATGPT.home, "state"))}`, "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"'];
    for (const account of [CHATGPT, { ...CHATGPT, id: "codex-credit", generation: 0 }]) {
      const launch = accountLaunch(account, "codex", ["--model", "fixture"], {}, true, KEY);
      expect(launch.args).toEqual(today);
      expect(JSON.stringify(launch)).not.toContain(KEY);
    }
  });

  it("is offered only while a key and an enabled Codex base exist", () => {
    const bases: InstanceConfigMap = { codex: { driver: "codex" }, claude: { driver: "claudeAgent" } };
    expect(credit?.codexCredit(DATA_DIR, bases, ` ${KEY} `)?.key).toBe(KEY);
    for (const key of [undefined, "", "  "]) expect(credit?.codexCredit(DATA_DIR, bases, key)).toBeUndefined();
    expect(credit?.codexCredit(DATA_DIR, { codex: { driver: "codex", enabled: false } }, KEY)).toBeUndefined();
    expect(credit?.codexCredit(DATA_DIR, { claude: { driver: "claudeAgent" } }, KEY)).toBeUndefined();
    expect(credit?.codexCredit(DATA_DIR, { ...bases, "codex-credit": { driver: "codex" } }, KEY)).toBeUndefined();
  });

  it.each([true, false])("launches a worker on the credit by Usage name or home with routing %s", async (enabled) => {
    const f = setup(enabled);
    for (const value of ["openai CREDIT", f.home]) {
      const launch = await f.prepare({ ...f.input, command: `$env:CODEX_HOME='${value}'; codex --model fixture 'task'` });
      if (launch?.kind !== "managed") throw new Error("Expected a managed launch");
      expect(launch).toMatchObject({ account: { id: "codex-credit", generation: 1, name: "OpenAI credit" }, clearEnv: [ENV], line: "Worker account: OpenAI credit." });
      expect(launch.args).toEqual(expect.arrayContaining(['model_provider="openai_credit"', `model_providers.openai_credit.env_key="${ENV}"`, "--no-daemon"]));
      expect(launch.args.join(" ")).not.toMatch(/forced_login_method|sk-proj/);
      expect(launch.environment).toMatchObject({ [ENV]: KEY, CODEX_HOME: f.home });
      expect(launch.environment.OPENAI_API_KEY).toBeUndefined();
    }
    expect(existsSync(join(f.home, "state"))).toBe(true);
    expect(readFileSync(join(f.home, "AGENTS.md"), "utf8")).toBe("fixture guide");
    const plain = await f.prepare({ ...f.input, command: "codex 'task'" });
    expect(plain && "environment" in plain ? plain.environment?.[ENV] : undefined).toBeUndefined();
  });

  it("drops the account, its resume and its Usage row when the key is removed", async () => {
    const f = setup();
    const resume = { engine: "codex" as const, nativeId: "00000000-0000-4000-8000-000000000011", accountId: "codex-credit", accountGeneration: 1,
      template: { executable: "codex", args: ["--model", "fixture", "task"] } };
    expect(await f.prepare({ ...f.input, command: "codex", resume })).toMatchObject({ kind: "managed", account: { id: "codex-credit" }, environment: { [ENV]: KEY } });
    const rateLimits = new Map<string, RateLimitsReport>();
    const board = createUsageBoard({
      accounts: { list: () => [{ id: "codex", of: "codex", driverKind: "codex", generation: 0, existing: true, state: "ready" as const, status: { state: "available" as const, authenticated: true } },
        ...(credit?.codexCreditRows(credit.codexCredit(f.root, f.bases, f.saved.key)) ?? [])], defaultFor: () => undefined, drains: {} },
      names: { get: (id) => id === "codex" ? { id, engine: "codex", number: 1, nickname: null, name: "Codex 1" } : null },
      rateLimits, history: createUsageHistory(join(f.root, "history"), { schedule() {} }), runs: async () => ({ known: false, reason: "no-host" }), bots: () => [],
    });
    expect((await board.read()).engines[0].accounts.map(({ id, name, number, signIn, windows, credit }) => ({ id, name, number, signIn, windows, credit }))).toEqual([
      { id: "codex", name: "Codex 1", number: 1, signIn: "ready", windows: [], credit: undefined },
      { id: "codex-credit", name: "OpenAI credit", number: 2, signIn: "ready", windows: [], credit: true },
    ]);
    f.saved.key = undefined;
    board.touch();
    expect((await board.read()).engines[0].accounts.map((account) => account.id)).toEqual(["codex"]);
    await expect(f.prepare(f.input)).rejects.toThrow("Unknown or unavailable worker account; choose Codex 1");
    await expect(f.prepare({ ...f.input, command: "codex", resume })).rejects.toThrow("Worker account is unavailable or signed out");
  });

  it("refuses a launch on the credit once the key is removed with routing off", async () => {
    const f = setup(false);
    f.saved.key = undefined;
    for (const value of ["OpenAI credit", " openai CREDIT "]) {
      await expect(f.prepare({ ...f.input, command: `$env:CODEX_HOME='${value}'; codex 'task'` })).rejects.toThrow(/^OpenAI credit needs a saved OpenAI key\. .*OpenAI 키/);
    }
    expect(await f.prepare({ ...f.input, command: "$env:CODEX_HOME='legacy'; codex 'task'" })).toBeNull();
  });

  it.each(["claude", "codex"] as const)("answers a %s launch off the credit as an unrouted host gets it today", async (engine) => {
    const unused = vi.fn(() => { throw new Error("unexpected routed work"); });
    const usage = Object.assign(unused, { invalidate() {} });
    const report = workerReportText("win32", true);
    const today = createWorkerLaunch({ enabled: () => false, resolveWorkerTurn: unused, bases: unused, available: unused, usage });
    const routed = createWorkerLaunch({ enabled: () => false, resolveWorkerTurn: unused, bases: unused, available: unused, usage,
      credit: () => credit?.codexCredit(DATA_DIR, { codex: { driver: "codex" } }, KEY) });
    const same = (launch: unknown) => JSON.parse(JSON.stringify(launch ?? null).replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>"));
    for (const command of [engine === "claude" ? `claude --model fixture --effort high --dangerously-skip-permissions ${report.claude}'task'`
      : `codex --model fixture -c model_reasoning_effort=high --dangerously-bypass-approvals-and-sandbox ${report.env}${report.notify}'task'`, `${engine} 'task'`]) {
      const input = { botId: "bot", label: "worker", command, environment: { OpenAI_Api_Key: "fixture-key" } };
      const expected = process.platform === "win32" ? await today({ ...input, unrouted: true }) : null;
      const actual = await routed(input);
      if (process.platform === "win32") expect(actual).toMatchObject({ kind: "unrouted", account: { id: engine, generation: 0 } });
      expect(same(actual)).toEqual(same(expected));
      expect(actual).not.toHaveProperty("environment");
      expect(JSON.stringify(actual)).not.toMatch(/sqlite_home|forced_login_method|--setting-sources|openai_credit/);
      expect(await routed({ ...input, mode: "send" })).toBeNull();
    }
    for (const command of ["$env:CODEX_HOME='legacy'; codex 'task'", "$env:CLAUDE_CONFIG_DIR='OpenAI credit'; claude 'task'"]) {
      expect(await routed({ botId: "bot", command, environment: {} })).toBeNull();
    }
    expect(await routed({ botId: "bot", command: "$env:CODEX_HOME='OpenAI credit'; codex 'task'", environment: {}, mode: "send" })).toBeNull();
    expect(unused).not.toHaveBeenCalled();
  });

  it("keeps the key out of argv, logs, pane text, bot lines and files while the fake Codex gets it", { timeout: 30_000 }, async () => {
    const f = setup(false);
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); }));
    try {
      const access = { url: "http://fixture", token: "private-host" };
      const result = await workerLaunchResponse(access, access.token, f.input, f.prepare);
      const launch = (result.body as { launch?: { kind: string; args: string[]; environment: Record<string, string>; line?: string; clearEnv?: string[] } }).launch;
      if (launch?.kind !== "managed") throw new Error("Expected a managed launch");
      const dump = join(f.root, "fake-codex.json");
      const fake = join(f.root, "fake-codex.mjs");
      writeFileSync(fake, `import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
const key = process.env.${ENV};
writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv: process.argv.slice(2), key: key ? createHash("sha256").update(key).digest("hex") : null, home: process.env.CODEX_HOME }));
`);
      const pane = managedWorkerCommand({ ...launch, executable: process.execPath, args: [fake, ...launch.args] }, launch.environment, process.platform);
      const shell = process.platform === "win32" ? powershell(pane, launch.environment)
        : execFileSync("/bin/sh", ["-c", `${pane}; if [ -n "\${${ENV}+x}" ]; then echo left; else echo cleared; fi`], { encoding: "utf8", env: launch.environment, timeout: 20_000 });
      const seen = JSON.parse(readFileSync(dump, "utf8"));
      expect(seen).toMatchObject({ key: sha(KEY), home: f.home });
      expect(seen.argv.join(" ")).toContain(ENV);
      expect(shell.trim().split(/\r?\n/).at(-1)).toBe("cleared");
      for (const text of [JSON.stringify(launch.args), pane, launch.line ?? "", shell, ...logs]) expect(text).not.toContain(KEY);
      for (const file of files(DATA_DIR)) expect(readFileSync(file, "utf8"), file).not.toContain(KEY);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it.each(["win32", "linux"])("renders a %s credit launch that clears the key on exit", (platform) => {
    const worker = { executable: "codex", args: ["--model", "fixture"] };
    const plain = platform === "win32" ? "& 'codex' '--model' 'fixture'" : "'codex' '--model' 'fixture'";
    expect(managedWorkerCommand(worker, {}, platform)).toBe(plain);
    expect(managedWorkerCommand({ ...worker, clearEnv: ["BAD; calc", "lower", "$env:X"] }, {}, platform)).toBe(plain);
    expect(managedWorkerCommand({ ...worker, clearEnv: [ENV] }, {}, platform)).toBe(platform === "win32"
      ? `try { ${plain} } finally { Remove-Item Env:${ENV} -ErrorAction SilentlyContinue }` : `(trap : INT; ${plain}; exit); unset ${ENV}`);
  });

  it("clears the key in a real PowerShell after a clean exit, a failing exit and a missing CLI", { skip: process.platform !== "win32", timeout: 60_000 }, () => {
    for (const worker of [{ executable: process.execPath, args: ["-e", `console.log(process.env.${ENV} ? 'seen' : 'missing')`] },
      { executable: process.execPath, args: ["-e", "process.exit(3)"] }, { executable: "wink-missing-codex-fixture", args: [] }]) {
      const output = powershell(managedWorkerCommand({ ...worker, clearEnv: [ENV] }, {}, "win32"), { ...process.env, [ENV]: KEY });
      expect(output).not.toContain(KEY);
      expect(output.trim().split(/\r?\n/).at(-1)).toBe("cleared");
      if (worker.args[1]?.includes("console")) expect(output).toContain("seen");
    }
  });
});
