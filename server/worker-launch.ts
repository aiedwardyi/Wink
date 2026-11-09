import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { accountLaunch, canonicalAccountHome, type AccountContext } from "./account-policy.ts";
import { shareUserSetup } from "./account-shared-setup.ts";
import { CODEX_CREDIT_ENV, CODEX_CREDIT_NAME, isCodexCredit, withCodexCredit, type CodexCredit } from "./codex-credit.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import type { createSpawnUsage } from "./spawn-usage.ts";
import type { WorkerTurnResolver } from "./worker-turn.ts";
import { applyCredentialAllowlist } from "./config.ts";
import { workerSession } from "./worker-session.ts";
import { baseAccount, resumeArgs, type WorkerResume } from "./worker-resume.ts";

const ENGINES = new Map([
  ["claude", { driver: "claudeAgent", base: "claude", name: "Claude" }],
  ["codex", { driver: "codex", base: "codex", name: "Codex" }],
  ["grok", { driver: "grokAgent", base: "grok", name: "Grok" }],
  ["muse", { driver: "museAgent", base: "muse", name: "Muse" }],
  ["agy", { driver: "antigravityAgent", base: "antigravity", name: "Gemini" }],
]);
const HOME_SELECTOR = /^(?:CODEX_HOME|CODEX_SQLITE_HOME|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|GROK_HOME|MUSE_AUTH_PATH|XDG_CONFIG_HOME|XDG_DATA_HOME|HOME|USERPROFILE)$/i;
const ENV_PREFIX = /^\s*\$env:(\w+)\s*=\s*('(?:[^']|'')*'|"[^"$`]*"|[^\s;]+)\s*;/i;
const WRAPPER = /^(?:&|\.|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|bash|sh|env|iex|invoke-expression|start-process)$/i;

function tokens(command: string): string[] {
  const result: string[] = [];
  const windows = process.platform === "win32";
  let token = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (!windows && char === "\\" && quote !== "'") {
      const next = command[i + 1];
      if (next === undefined) throw new Error("Ambiguous worker launch quoting");
      if (quote === '"' && !/["\\$`\n]/.test(next)) { token += char; started = true; continue; }
      i++;
      if (next !== "\n") { token += next; started = true; }
    } else if (char === "'" && quote !== '"') {
      if (windows && quote && command[i + 1] === "'") { token += "'"; i++; }
      else quote = quote ? "" : "'";
      started = true;
    } else if (char === '"' && quote !== "'") {
      quote = quote ? "" : '"'; started = true;
    } else if (char === "$" && quote !== "'") {
      const variable = /^\$env:(ORBIT_(?:PANE|BOT|TEACHER|URL|MSG_AUTH))\b/i.exec(command.slice(i));
      if (!variable) throw new Error("Ambiguous worker launch expression");
      token += `\u0000${variable[1].toUpperCase()}\u0000`;
      i += variable[0].length - 1;
    } else if (!quote && /\s/.test(char)) {
      if (started) result.push(token);
      token = ""; started = false;
    } else {
      if (char === "\u0000" || (!quote && /[;&|<>(){}\r\n`]/.test(char)) || (quote === '"' && char === "`")) throw new Error("Ambiguous worker launch expression");
      token += char; started = true;
    }
  }
  if (quote) throw new Error("Ambiguous worker launch quoting");
  if (started) result.push(token);
  return result;
}

function engineToken(token: string) {
  return token.split(/[\\/]/).at(-1)?.replace(/\.(?:exe|cmd|ps1)$/i, "").toLowerCase() ?? "";
}

export function workerCommand(command: string, unmanaged = false) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) throw new Error("Ambiguous worker launch control input");
  let rest = command.trim();
  const environment: Record<string, string> = {};
  let home: { selector: string; value: string } | undefined;
  for (let match = ENV_PREFIX.exec(rest); match; match = ENV_PREFIX.exec(rest)) {
    if (HOME_SELECTOR.test(match[1])) {
      if (unmanaged) return { kind: "unmanaged" as const };
      if (home || !/^(?:CODEX_HOME|CLAUDE_CONFIG_DIR)$/i.test(match[1])) throw new Error("Conflicting worker home override");
      home = { selector: match[1].toUpperCase(), value: match[2].startsWith("'") ? match[2].slice(1, -1).replace(/''/g, "'") : match[2].replace(/^"|"$/g, "") };
    } else environment[match[1].toUpperCase()] = match[2].replace(/^['"]|['"]$/g, "");
    rest = rest.slice(match[0].length);
  }
  const first = /^\s*([^\s]+)/.exec(rest)?.[1] ?? "";
  const engine = ENGINES.get(first.toLowerCase());
  if (!engine) {
    if (home) throw new Error("Worker account prefix requires a direct engine command");
    if ((WRAPPER.test(first) && [/["'`^]/g, /["'`^\\]/g].some((escapes) => rest.replace(escapes, "").split(/[\s;&|(){}<>=]+/).some((token) => [token, token.replace(/^-+\w/, "")].some((name) => ENGINES.has(engineToken(name)))))) || /(?:^|[;&|(){}\r\n])\s*&?\s*["']?(?:[^\s"']*[\\/])?(?:claude|codex|grok|muse|agy)(?:\.(?:exe|cmd|ps1))?(?=[\s"';&|(){}<>]|$)/i.test(rest)
      || /^(?:pnpm|npm|npx|bunx)\s+(?:exec\s+)?(?:claude|codex|grok|muse|agy)\b/i.test(rest)) throw new Error("Ambiguous worker launch; use a direct engine command");
    return { kind: "shell" as const };
  }
  if (home && home.selector !== (engine.driver === "codex" ? "CODEX_HOME" : engine.driver === "claudeAgent" ? "CLAUDE_CONFIG_DIR" : "")) throw new Error("Worker account prefix must match the engine");
  if (Object.keys(environment).some((name) => name !== "AGY_CLI_DISABLE_AUTO_UPDATE")) throw new Error("Conflicting worker environment override");
  const [executable, ...args] = tokens(rest);
  if (engineToken(executable) !== first.toLowerCase()) throw new Error("Ambiguous worker executable");
  return { kind: "managed" as const, executable, args, environment, home, ...engine };
}

function withoutWorkerSettings(args: string[]) {
  const settings = canonicalAccountHome(join(homedir(), ".orbit", "bin", "claude-worker.json"));
  let workerSettings = false;
  const rest = args.filter((arg, index) => {
    if (index > 0 && args[index - 1] === "--settings" && canonicalAccountHome(arg) === settings) return false;
    if (arg === "--settings" && args[index + 1] && canonicalAccountHome(args[index + 1]) === settings) { workerSettings = true; return false; }
    return true;
  });
  return { args: rest, workerSettings };
}

// Without account routing the pane still types the bot's own command, so only the session flags get appended.
function unroutedLaunch(text: string) {
  try {
    const command = workerCommand(text);
    if (command.kind !== "managed" || command.home || command.args.some((arg) => arg === "--" || arg === "--%")) return null;
    const { args, workerSettings } = command.driver === "claudeAgent" ? withoutWorkerSettings(command.args) : { args: [...command.args], workerSettings: false };
    if (command.driver === "claudeAgent" && !workerSettings && args.some((arg) => /^--settings(?:=|$)/.test(arg))) return null;
    const typed = args.length;
    const session = workerSession(command.executable, args, {}, { executable: command.executable, args: [...command.args] });
    return session ? { kind: "unrouted" as const, account: { id: command.base, generation: 0 }, args: args.slice(typed), workerSettings, session } : null;
  } catch {
    return null;
  }
}

export function createWorkerLaunch(options: {
  enabled(): boolean; resolveWorkerTurn: WorkerTurnResolver; bases(): InstanceConfigMap;
  available(id: string, generation: number): boolean; usage: ReturnType<typeof createSpawnUsage>;
  resumeAccount?(id: string, generation: number): AccountContext | undefined | Promise<AccountContext | undefined>;
  mainAccount?(of: string): AccountContext | undefined | null;
  nameOf?(id: string, engine: string): string;
  accounts?(): readonly AccountContext[];
  credit?(): CodexCredit | undefined;
}) {
  const deps = withCodexCredit(options);
  const onCredit = (text: string) => {
    const credit = deps.credit?.();
    try {
      const command = credit && workerCommand(text);
      const home = command && command.kind === "managed" && command.driver === "codex" ? command.home?.value : undefined;
      return home !== undefined && (canonicalAccountHome(home) === canonicalAccountHome(credit!.account.home)
        || home.trim().normalize("NFC").toLowerCase() === CODEX_CREDIT_NAME.toLowerCase());
    } catch {
      return false;
    }
  };
  return async (input: { botId: string; label?: string; command: string; environment: NodeJS.ProcessEnv; mode?: "send"; resume?: WorkerResume; unrouted?: true }) => {
    if (input.unrouted) return deps.enabled() ? null : unroutedLaunch(input.command);
    // Routing is on for the credit alone; every other launch gets the answer an unrouted host gets today.
    if (!deps.enabled() && !input.resume && (input.mode === "send" || !onCredit(input.command))) return deps.credit && process.platform === "win32" && input.mode !== "send" ? unroutedLaunch(input.command) : null;
    const resume = input.resume;
    const command = resume ? { ...workerCommand(resume.engine), args: resumeArgs(resume) } : workerCommand(input.command, input.mode === "send");
    if (command.kind !== "managed") return command;
    if (input.mode === "send") throw new Error("Managed worker launches require a new terminal_spawn pane");
    const resumedAccount = resume ? await deps.resumeAccount?.(resume.accountId, resume.accountGeneration) : undefined;
    if (resume && (!resumedAccount || resumedAccount.id !== resume.accountId || resumedAccount.generation !== resume.accountGeneration)) throw new Error("Worker account is unavailable or signed out");
    const turn = resumedAccount ? { instanceId: resumedAccount.id, driverKind: command.driver, account: resumedAccount } : deps.resolveWorkerTurn(input.botId);
    if (!turn) throw new Error("No captured active turn for this worker launch");
    const bases = deps.bases();
    const sameEngine = turn.driverKind === command.driver;
    const candidates = () => [
      ...Object.entries(deps.bases()).filter(([, base]) => base.enabled !== false && base.driver === command.driver)
        .map(([id, base]) => baseAccount(id, command.driver, { ...process.env, ...base.environment })),
      ...(deps.accounts?.() ?? []).filter((account) => bases[account.of]?.enabled !== false && bases[account.of]?.driver === command.driver),
    ];
    let selected: AccountContext | undefined;
    if (command.home) {
      const value = command.home.value;
      const matches = candidates().filter((account) => deps.available(account.id, account.generation)
        && (canonicalAccountHome(account.home) === canonicalAccountHome(value)
          || deps.nameOf?.(account.id, command.name).normalize("NFC").toLowerCase() === value.trim().normalize("NFC").toLowerCase()));
      if (matches.length !== 1) throw new Error(`Unknown or unavailable worker account; choose ${candidates().filter((account) => deps.available(account.id, account.generation)).map((account) => deps.nameOf?.(account.id, command.name) ?? command.name).join(", ") || "a signed-in account in Usage"}`);
      selected = matches[0];
    }
    const baseId = selected?.of ?? (sameEngine ? turn.account?.of ?? turn.instanceId : command.base);
    const base = Object.hasOwn(bases, baseId) ? bases[baseId] : undefined;
    if (!base || base.enabled === false || base.driver !== command.driver) throw new Error("Worker base account is unavailable");
    const baseEnvironment = { ...process.env, ...base.environment };
    const main = sameEngine || selected ? undefined : deps.mainAccount?.(baseId);
    const mainDown = main === null || (main !== undefined && !deps.available(main.id, main.generation));
    const account = selected ?? (sameEngine && turn.account ? turn.account : main && !mainDown ? main : baseAccount(baseId, command.driver, baseEnvironment));
    if (!deps.available(account.id, account.generation)) throw new Error("Worker account is unavailable");
    let args = command.args;
    if (args.includes("--")) throw new Error("Conflicting worker account selector");
    let workerSettings = false;
    if (command.driver === "claudeAgent") ({ args, workerSettings } = withoutWorkerSettings(args));
    for (let i = 0; command.driver === "codex" && !resume?.unrouted && i < args.length; i++) {
      const value = /^(?:--config|-c)$/.test(args[i]) ? args[++i] : /^(?:--config=|-c=?)(.+)$/.exec(args[i])?.[1];
      const key = value?.split("=", 1)[0].trim();
      if (key && !/^shell_environment_policy\.set\.ORBIT_(?:PANE|BOT|TEACHER|URL|MSG_AUTH)$/.test(key)
        && /(?:home|auth|login|provider|profile|^shell_environment_policy(?:\.|$))/i.test(key)) throw new Error("Conflicting worker account selector");
    }
    const source = { ...input.environment, ...base.environment, ...command.environment };
    const template = resume?.template ?? { executable: command.executable, args: [...command.args] };
    const session = workerSession(command.executable, args, source, template);
    if (session && resume) session.nativeId = resume.nativeId;
    if (resume?.unrouted) {
      const usage = await deps.usage(input.botId, input.label ?? "", resume.engine, undefined, true);
      if (usage.hold) return { kind: "hold" as const, hold: usage.hold };
      const current = await deps.resumeAccount?.(resume.accountId, resume.accountGeneration);
      if (!deps.available(account.id, account.generation) || current?.id !== account.id || current.generation !== account.generation) throw new Error("Worker account changed before launch");
      return { kind: "unrouted" as const, account: { id: account.id, generation: account.generation }, executable: command.executable, args, workerSettings, session, line: usage.line };
    }
    const managedEngine = ["claudeAgent", "codex"].includes(command.driver);
    const creditKey = isCodexCredit(account) ? deps.credit?.()?.key : undefined;
    const policy = accountLaunch(managedEngine ? account : undefined, command.driver, args, source, account.generation > 0, creditKey);
    if (command.driver === "claudeAgent" && account.generation === 0
      && !Object.entries(baseEnvironment).some(([key, value]) => key.toUpperCase() === "CLAUDE_CONFIG_DIR" && value)) {
      // Setting the default directory moves Claude's config from ~/.claude.json to ~/.claude/.claude.json.
      delete policy.env.CLAUDE_CONFIG_DIR;
    }
    if (command.driver === "codex" && !policy.args.includes("--no-daemon")) policy.args.push("--no-daemon");
    if (!managedEngine) {
      applyCredentialAllowlist(policy.env, []);
      for (const key of Object.keys(policy.env)) if (HOME_SELECTOR.test(key)) delete policy.env[key];
      policy.env.HOME = base.environment?.HOME ?? homedir();
      policy.env.USERPROFILE = base.environment?.USERPROFILE ?? homedir();
      for (const name of ["GROK_HOME", "MUSE_AUTH_PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) if (base.environment?.[name]) policy.env[name] = base.environment[name];
      if (command.executable === "grok") policy.env.GROK_HOME ??= join(policy.env.HOME, ".grok");
    }
    const captured = Object.freeze({ id: account.id, generation: account.generation, name: selected ? deps.nameOf?.(account.id, command.name) ?? command.name : command.name });
    const usage = await deps.usage(input.botId, input.label ?? "", input.command, captured, Boolean(resume));
    if (usage.hold) return { kind: "hold" as const, hold: usage.hold };
    const current = resume ? await deps.resumeAccount?.(resume.accountId, resume.accountGeneration) : undefined;
    const nowMain = sameEngine || selected ? undefined : deps.mainAccount?.(baseId);
    if (nowMain?.id !== main?.id || nowMain?.generation !== main?.generation || !deps.available(account.id, account.generation)
      || (selected && !candidates().some((row) => row.id === selected.id && row.generation === selected.generation && row.home === selected.home))
      || (resume ? !current || current.id !== account.id || current.generation !== account.generation : deps.resolveWorkerTurn(input.botId) !== turn)) throw new Error("Worker account changed before launch");
    if (creditKey) mkdirSync(join(account.home, "state"), { recursive: true });
    if (managedEngine && account.generation > 0) shareUserSetup(command.driver, account, baseAccount(baseId, command.driver, baseEnvironment).home);
    return { kind: "managed" as const, account: captured, executable: command.executable, args: policy.args,
      environment: policy.env, workerSettings, session, ...(creditKey ? { clearEnv: [CODEX_CREDIT_ENV] } : {}),
      line: mainDown ? [`${command.name} Main is signed out, so this worker uses ${deps.nameOf?.(captured.id, command.name) ?? "your default account"}.`, usage.line].filter(Boolean).join(" ") : usage.line ?? (selected ? `Worker account: ${captured.name}.` : undefined) };
  };
}
