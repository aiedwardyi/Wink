import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

import { CODEX_CREDIT_ARGS, CODEX_CREDIT_ENV, isCodexCredit } from "./codex-credit.ts";
import { applyCredentialAllowlist } from "./config.ts";

export interface AccountContext {
  readonly id: string;
  readonly of: string;
  readonly home: string;
  readonly generation: number;
}

export function canonicalAccountHome(home: string): string {
  const path = resolve(home);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function claudeAccountAdmission(status: { loggedIn: boolean; email?: unknown; authMethod?: string; configDirectory?: string }, account?: AccountContext) {
  const admitted = !account || (status.authMethod === "claude.ai" && Boolean(status.configDirectory) && canonicalAccountHome(status.configDirectory!) === canonicalAccountHome(account.home));
  const signedIn = status.loggedIn && admitted;
  const email = typeof status.email === "string" ? status.email.trim() : "";
  return { signedIn, ...(account ? { engineSignedIn: status.loggedIn } : {}),
    ...(account && signedIn && email ? { identity: createHash("sha256").update(email.toLowerCase()).digest("hex") } : {}),
  };
}

const SELECTOR = /^(?:ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_|CODEX_|OPENAI_|AZURE_|AWS_|BEDROCK_|VERTEX_|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_CLOUD_|GOOGLE_GENAI_|CLOUD_ML_|CLAUDE_CONFIG_DIR$|CLAUDE_PROFILE$|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|OMB_|OGB_|ORBIT_|COMMS_)/;

export function accountLaunch(
  account: AccountContext | undefined,
  driver: string,
  args: string[],
  source: NodeJS.ProcessEnv,
  userSetup = false,
  creditKey?: string,
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (!account) return { args, env: source };
  if (driver !== "claudeAgent" && driver !== "codex") throw new Error("Unsupported account engine");
  if (args.some((arg) => /^(?:--profile(?:=|$)|--with-api-key$|--api-key(?:=|$)|--oss$|--local-provider(?:=|$))/.test(arg) || (driver === "codex" && arg === "-p"))) throw new Error("Conflicting account launch selector");
  const env = { ...source };
  const grants = Object.keys(env).filter((key) => /^WINK_MCP_[A-Z0-9_]+$/.test(key));
  applyCredentialAllowlist(env, grants);
  for (const key of Object.keys(env)) if (SELECTOR.test(key.toUpperCase())) delete env[key];
  if (driver === "claudeAgent") {
    for (let i = 0; i < args.length; i++) {
      const settings = args[i] === "--settings" ? args[++i] : args[i].startsWith("--settings=") ? args[i].slice(11) : undefined;
      if (settings !== undefined) {
        let value;
        try { value = JSON.parse(settings); } catch { throw new Error("Conflicting account settings"); }
        if (!value || typeof value !== "object" || Object.keys(value).some((key) => key !== "permissions" && key !== "sandbox" && key !== "hooks")) throw new Error("Conflicting account settings");
      }
    }
    env.CLAUDE_CONFIG_DIR = account.home;
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    return { env, args: args[0] === "auth" || args[0] === "--version" ? args : [...args, "--setting-sources", userSetup ? "user,project,local" : "project,local"] };
  }
  env.CODEX_HOME = account.home;
  env.CODEX_SQLITE_HOME = join(account.home, "state");
  if (isCodexCredit(account)) {
    if (!creditKey) throw new Error("OpenAI credit needs a saved OpenAI key");
    env[CODEX_CREDIT_ENV] = creditKey;
    return { env, args: [...args, "-c", `sqlite_home=${JSON.stringify(env.CODEX_SQLITE_HOME)}`, ...CODEX_CREDIT_ARGS] };
  }
  return { env, args: [...args,
    "-c", `sqlite_home=${JSON.stringify(env.CODEX_SQLITE_HOME)}`,
    "-c", 'forced_login_method="chatgpt"',
    "-c", 'model_provider="openai"',
  ] };
}
