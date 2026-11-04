import { homedir } from "node:os";
import { join } from "node:path";

import type { AccountContext } from "./account-policy.ts";
import type { AccountService } from "./accounts.ts";
import type { InstanceConfigMap } from "./contracts.ts";

export const RESUME_NUDGE = "Wink restarted and resumed this conversation. Your last step may not have finished. Check the real state first (git status, git log, remote branch, test output) and skip anything already done. Never redo a push, merge or release unless you confirm it did not happen; if unsure, report BLOCKED with what you found. Then continue the card.";

export interface WorkerResume {
  engine: "claude" | "codex";
  nativeId: string;
  accountId: string;
  accountGeneration: number;
  template: { executable: string; args: string[] };
  unrouted?: true;
}

export function baseAccount(id: string, driver: string, environment: NodeJS.ProcessEnv): AccountContext {
  const selector = driver === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const home = Object.entries(environment).find(([key]) => key.toUpperCase() === selector)?.[1]
    || join(driver === "codex" ? environment.HOME || environment.USERPROFILE || homedir() : homedir(), driver === "codex" ? ".codex" : ".claude");
  return Object.freeze({ id, of: id, generation: 0, home });
}

export function createResumeAccount(registry: {
  describeCached(): Promise<readonly { instanceId: string; snapshot: { state: string; authenticated?: boolean } }[]>;
  get(id: string): { enabled: boolean; driverKind: string; account?: AccountContext } | null | undefined;
  accountAvailable(id: string): boolean;
}, accounts: AccountService, bases: () => InstanceConfigMap) {
  return async (id: string, generation: number) => {
    const row = (await registry.describeCached()).find((entry) => entry.instanceId === id);
    const live = registry.get(id);
    if (!row || !live || !live.enabled || row.snapshot.state !== "available" || row.snapshot.authenticated !== true
      || !registry.accountAvailable(id) || accounts.drains[id]) return undefined;
    if (generation !== 0) {
      const account = accounts.get(id);
      return account?.state === "ready" && account.generation === generation && live.account?.generation === generation ? account : undefined;
    }
    const base = bases()[id];
    return !live.account && base && base.enabled !== false ? baseAccount(id, live.driverKind, { ...process.env, ...base.environment }) : undefined;
  };
}

const VALUES = new Set(["--model", "-m", "--effort", "--settings", "--setting-sources", "--permission-mode", "--allowedTools", "--allowed-tools",
  "--disallowedTools", "--disallowed-tools", "--tools", "--add-dir", "--mcp-config", "--system-prompt", "--append-system-prompt", "--agent", "--agents",
  "--betas", "--fallback-model", "--max-budget-usd", "--output-format", "--input-format", "--config", "--sandbox", "-s", "--ask-for-approval", "-a",
  "--enable", "--disable", "--image", "-i", "--cd", "-C"]);
const SWITCHES = new Set(["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--strict-mcp-config", "--verbose", "--debug",
  "--dangerously-bypass-approvals-and-sandbox", "--full-auto", "--no-alt-screen", "--no-daemon", "--search", "--disable-slash-commands"]);

export function resumeArgs(resume: WorkerResume) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(resume.nativeId)
    || resume.template.executable.toLowerCase() !== resume.engine) throw new Error("Invalid worker resume identity");
  const args: string[] = [];
  const input = resume.template.args;
  let prompt = false;
  for (let i = 0; i < input.length; i++) {
    const arg = input[i];
    const key = arg.split("=", 1)[0];
    if (["--session-id", "--resume", "-r"].includes(key)) { if (!arg.includes("=")) i++; continue; }
    if (["--continue", "--last", "--fork-session", "--all"].includes(key) || (resume.engine === "claude" && arg === "-c")) continue;
    if (arg === "resume" && resume.engine === "codex") { if (input[i + 1] && !input[i + 1].startsWith("-")) i++; continue; }
    if (VALUES.has(key) || (resume.engine === "codex" && key === "-c")) {
      args.push(arg);
      if (!arg.includes("=")) {
        if (input[i + 1] === undefined) throw new Error("Incomplete worker resume flags");
        args.push(input[++i]);
      }
    } else if (SWITCHES.has(key)) args.push(arg);
    else if (arg.startsWith("-r") && resume.engine === "claude") continue;
    else if (arg.startsWith("-")) throw new Error("Unsupported worker resume flags");
    else if (prompt) throw new Error("Ambiguous worker resume prompt");
    else prompt = true;
  }
  return [...(resume.engine === "codex" ? ["resume", resume.nativeId, ...args] : [...args, "-r", resume.nativeId]), RESUME_NUDGE];
}
