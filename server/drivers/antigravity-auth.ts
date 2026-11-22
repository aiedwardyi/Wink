import { execFile, type ExecFileException, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { cachedSignIn } from "./auth-status.ts";

type KeyringExec = (file: string, args: string[], options: ExecFileOptionsWithStringEncoding, done: (error: ExecFileException | null, stdout: string) => void) => void;

/** Where agy saves its sign-in: the OS keyring entry service "gemini", account "antigravity". */
export const ANTIGRAVITY_KEYRING = "gemini:antigravity";

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

/** Deletes a saved agy sign-in (service:account) from the OS keyring; false where there is none to delete or it fails. */
export function forgetAntigravitySignIn(target: string, platform = process.platform, run: KeyringExec = execFile): Promise<boolean> {
  const split = target.indexOf(":");
  if (split < 1 || split === target.length - 1 || (platform !== "win32" && platform !== "darwin")) return Promise.resolve(false);
  const file = platform === "win32" ? "cmdkey.exe" : "security";
  const args = platform === "win32" ? [`/delete:${target}`] : ["delete-generic-password", "-s", target.slice(0, split), "-a", target.slice(split + 1)];
  return new Promise((resolve) => {
    run(file, args, { windowsHide: true, timeout: 5000, encoding: "utf8" }, (error) => resolve(!error));
  });
}

const LOG_EVENT = /applyAuthResult: email=([^,\s]+),|Logging out current user/g;
// `agy -p` writes cli-<stamp>.log and `agy acp` (Wink's sign-in and sign-out) acp-server-<stamp>-<n>.log.
const LOG_NAME = /^(?:cli|acp-server)-(\d{8}_\d{6})\S*\.log$/;
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

function latestLogEvent(env: Record<string, string | undefined>): string | null | undefined {
  const dir = join(env.HOME || env.USERPROFILE || homedir(), ".gemini", "antigravity-cli", "log");
  try {
    const stamp = (name: string) => LOG_NAME.exec(name)![1];
    const names = readdirSync(dir).filter((name) => LOG_NAME.test(name))
      .sort((a, b) => stamp(b).localeCompare(stamp(a)) || b.localeCompare(a)).slice(0, LOG_FILES);
    const listed = new Set(names.map((name) => join(dir, name)));
    for (const path of logResults.keys()) if (dirname(path) === dir && !listed.has(path)) logResults.delete(path);
    for (const name of names) {
      const last = logAccount(join(dir, name));
      if (last !== undefined) return last;
    }
  } catch (error) {
    // SAFETY: Filesystem failures expose Node's errno code.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") console.warn("[antigravity] could not read agy's logs", error);
  }
  return undefined;
}

/** agy keeps no account file; its own logs name the email on every sign-in, subscription or Cloud project. */
export function readAntigravityAccount(env: Record<string, string | undefined> = process.env): string | undefined {
  return latestLogEvent(env) ?? undefined;
}

/** Sign-in as agy's logs last recorded it, for platforms whose keyring cannot be probed. */
export function readAntigravityLogSignIn(env: Record<string, string | undefined> = process.env): boolean | undefined {
  const last = latestLogEvent(env);
  return last === undefined ? undefined : last !== null;
}

export function antigravitySignIn(probe = probeAntigravitySignIn, unprobed: () => boolean | undefined = () => undefined) {
  let revision = 0;
  let applied = 0;
  let authenticated: boolean | undefined;
  const check = cachedSignIn(async () => {
    const started = ++revision;
    const result = (await probe()) ?? unprobed();
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