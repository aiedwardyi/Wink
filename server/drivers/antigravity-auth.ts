import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { cachedSignIn } from "./auth-status.ts";

type KeyringExec = (file: string, args: string[], options: ExecFileOptionsWithStringEncoding, done: (error: ExecFileException | null, stdout: string) => void) => void;

export function probeAntigravitySignIn(platform = process.platform, run: KeyringExec = execFile): Promise<boolean | undefined> {
  if (platform !== "win32" && platform !== "darwin") return Promise.resolve(undefined);
  const file = platform === "win32" ? "cmdkey.exe" : "security";
  const args = platform === "win32" ? ["/list"] : ["find-generic-password", "-s", "gemini", "-a", "antigravity"];
  return new Promise((resolve) => {
    run(file, args, { windowsHide: true, timeout: 3000, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        resolve(platform === "darwin" && error.code === 44 ? false : undefined);
        return;
      }
      resolve(platform === "darwin" || /(?:^|\s)LegacyGeneric:target=gemini:antigravity\s*$/m.test(stdout));
    });
  });
}

const LOG_EVENT = /applyAuthResult: email=([^,\s]+),|Logging out current user/g;
const LOG_FILES = 20;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
const logResults = new Map<string, { identity: string; last: string | null | undefined }>();

/** What one agy log says last: an email, null for a logout, undefined for neither. */
function logAccount(path: string): string | null | undefined {
  const stat = statSync(path);
  const identity = `${stat.size}:${stat.mtimeMs}`;
  const cached = logResults.get(path);
  if (cached?.identity === identity) return cached.last;
  let last: string | null | undefined;
  if (stat.size <= LOG_MAX_BYTES) {
    for (const match of readFileSync(path, "utf8").matchAll(LOG_EVENT)) last = match[1] ?? null;
  }
  logResults.set(path, { identity, last });
  return last;
}

/** agy keeps no account file; its own logs name the email on every sign-in, subscription or Cloud project. */
export function readAntigravityAccount(env: Record<string, string | undefined> = process.env): string | undefined {
  const dir = join(env.HOME || env.USERPROFILE || homedir(), ".gemini", "antigravity-cli", "log");
  try {
    const names = readdirSync(dir).filter((name) => /^cli-.*\.log$/.test(name)).sort().reverse().slice(0, LOG_FILES);
    for (const name of names) {
      const last = logAccount(join(dir, name));
      if (last !== undefined) return last ?? undefined;
    }
  } catch {
    // No logs yet: the row stays "Connected".
  }
  return undefined;
}

export function antigravitySignIn(probe = probeAntigravitySignIn) {
  let revision = 0;
  let applied = 0;
  let authenticated: boolean | undefined;
  const check = cachedSignIn(async () => {
    const started = ++revision;
    const result = await probe();
    if (result !== undefined && started > applied) {
      applied = started;
      authenticated = result;
    }
    return result;
  });
  return {
    async check(refresh = false) {
      await check(refresh);
      return authenticated;
    },
    record(signedIn: boolean) {
      applied = ++revision;
      authenticated = signedIn;
    },
  };
}
