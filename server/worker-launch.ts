import { homedir } from "node:os";
import { join } from "node:path";

import { accountLaunch, canonicalAccountHome, type AccountContext } from "./account-policy.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import type { createSpawnUsage } from "./spawn-usage.ts";
import type { WorkerTurnResolver } from "./worker-turn.ts";
import { applyCredentialAllowlist } from "./config.ts";

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
  for (let match = ENV_PREFIX.exec(rest); match; match = ENV_PREFIX.exec(rest)) {
    if (HOME_SELECTOR.test(match[1])) {
      if (unmanaged) return { kind: "unmanaged" as const };
      throw new Error("Conflicting worker home override");
    }
    environment[match[1].toUpperCase()] = match[2].replace(/^['"]|['"]$/g, "");
    rest = rest.slice(match[0].length);
  }
  const first = /^\s*([^\s]+)/.exec(rest)?.[1] ?? "";
  const engine = ENGINES.get(first.toLowerCase());
  if (!engine) {
    if (WRAPPER.test(first) || /(?:^|[;&|(){}\r\n])\s*&?\s*["']?(?:[^\s"']*[\\/])?(?:claude|codex|grok|muse|agy)(?:\.(?:exe|cmd|ps1))?(?=[\s"';&|(){}<>]|$)/i.test(rest)
      || /^(?:pnpm|npm|npx|bunx)\s+(?:exec\s+)?(?:claude|codex|grok|muse|agy)\b/i.test(rest)) throw new Error("Ambiguous worker launch; use a direct engine command");
    return { kind: "shell" as const };
  }
  if (Object.keys(environment).some((name) => name !== "AGY_CLI_DISABLE_AUTO_UPDATE")) throw new Error("Conflicting worker environment override");
  const [executable, ...args] = tokens(rest);
  if (engineToken(executable) !== first.toLowerCase()) throw new Error("Ambiguous worker executable");
  return { kind: "managed" as const, executable, args, environment, ...engine };
}

function baseAccount(id: string, driver: string, environment: NodeJS.ProcessEnv): AccountContext {
  const selector = driver === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const home = Object.entries(environment).find(([key]) => key.toUpperCase() === selector)?.[1]
    ?? join(homedir(), driver === "codex" ? ".codex" : ".claude");
  return Object.freeze({ id, of: id, generation: 0, home });
}

export function createWorkerLaunch(deps: {
  enabled(): boolean; resolveWorkerTurn: WorkerTurnResolver; bases(): InstanceConfigMap;
  available(id: string, generation: number): boolean; usage: ReturnType<typeof createSpawnUsage>;
}) {
  return async (input: { botId: string; label?: string; command: string; environment: NodeJS.ProcessEnv; mode?: "send" }) => {
    if (!deps.enabled()) return null;
    const command = workerCommand(input.command, input.mode === "send");
    if (command.kind !== "managed") return command;
    if (input.mode === "send") throw new Error("Managed worker launches require a new terminal_spawn pane");
    const turn = deps.resolveWorkerTurn(input.botId);
    if (!turn) throw new Error("No captured active turn for this worker launch");
    const bases = deps.bases();
    const sameEngine = turn.driverKind === command.driver;
    const baseId = sameEngine ? turn.account?.of ?? turn.instanceId : command.base;
    const base = Object.hasOwn(bases, baseId) ? bases[baseId] : undefined;
    if (!base || base.enabled === false || base.driver !== command.driver) throw new Error("Worker base account is unavailable");
    const baseEnvironment = { ...process.env, ...base.environment };
    const account = sameEngine && turn.account ? turn.account : baseAccount(baseId, command.driver, baseEnvironment);
    if (!deps.available(account.id, account.generation)) throw new Error("Worker account is unavailable");
    let args = command.args;
    if (args.includes("--")) throw new Error("Conflicting worker account selector");
    let workerSettings = false;
    if (command.driver === "claudeAgent") {
      const settings = join(homedir(), ".orbit", "bin", "claude-worker.json");
      args = args.filter((arg, index) => {
        if (index > 0 && command.args[index - 1] === "--settings" && canonicalAccountHome(arg) === canonicalAccountHome(settings)) return false;
        if (arg === "--settings" && command.args[index + 1] && canonicalAccountHome(command.args[index + 1]) === canonicalAccountHome(settings)) { workerSettings = true; return false; }
        return true;
      });
    }
    for (let i = 0; command.driver === "codex" && i < args.length; i++) {
      const value = /^(?:--config|-c)$/.test(args[i]) ? args[++i] : /^(?:--config=|-c=?)(.+)$/.exec(args[i])?.[1];
      const key = value?.split("=", 1)[0].trim();
      if (key && !/^shell_environment_policy\.set\.ORBIT_(?:PANE|BOT|TEACHER|URL|MSG_AUTH)$/.test(key)
        && /(?:home|auth|login|provider|profile|^shell_environment_policy(?:\.|$))/i.test(key)) throw new Error("Conflicting worker account selector");
    }
    const source = { ...input.environment, ...base.environment, ...command.environment };
    const managedEngine = ["claudeAgent", "codex"].includes(command.driver);
    const policy = accountLaunch(managedEngine ? account : undefined, command.driver, args, source);
    if (command.driver === "claudeAgent" && !(sameEngine && turn.account)
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
    const captured = Object.freeze({ id: account.id, generation: account.generation, name: command.name });
    const usage = await deps.usage(input.botId, input.label ?? "", input.command, captured);
    if (usage.hold) return { kind: "hold" as const, hold: usage.hold };
    if (!deps.available(account.id, account.generation) || deps.resolveWorkerTurn(input.botId) !== turn) throw new Error("Worker account changed before launch");
    return { kind: "managed" as const, account: captured, executable: command.executable, args: policy.args,
      environment: policy.env, workerSettings, line: usage.line };
  };
}
