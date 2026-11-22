import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { cachedSignIn } from "./auth-status.ts";
import { runKeyringTool, type KeyringExec } from "./os-keyring.ts";

/** Where agy saves its sign-in: the OS keyring entry service "gemini", account "antigravity". */
export const ANTIGRAVITY_KEYRING = "gemini:antigravity";

export function probeAntigravitySignIn(platform = process.platform, run: KeyringExec = runKeyringTool): Promise<boolean | undefined> {
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

/** Deletes agy's saved sign-in from the OS keyring, and no other entry: any other name is refused.
 * False where there is none to delete or it fails. */
export function forgetAntigravitySignIn(target: typeof ANTIGRAVITY_KEYRING, platform = process.platform, run: KeyringExec = runKeyringTool): Promise<boolean> {
  if (target !== ANTIGRAVITY_KEYRING || (platform !== "win32" && platform !== "darwin")) return Promise.resolve(false);
  const file = platform === "win32" ? "cmdkey.exe" : "security";
  const args = platform === "win32" ? ["/delete:gemini:antigravity"] : ["delete-generic-password", "-s", "gemini", "-a", "antigravity"];
  return new Promise((resolve) => {
    run(file, args, { windowsHide: true, timeout: 5000, encoding: "utf8" }, (error) => resolve(!error));
  });
}

/**
 * Signs agy out by deleting its saved sign-in, without cutting off a running turn: agy before 1.5 rereads that
 * sign-in on every request, so a delete under a running turn fails its reply. While turns run, sign-out reads as
 * done and no new turn starts; the delete lands when the last running turn ends. A sign-in drops a waiting delete.
 */
export function antigravityKeyringSignOut(forget: () => Promise<boolean>) {
  const running = new Set<string>();
  const signedOut = new Set<() => void>();
  let waiting = false;
  let landing: Promise<boolean> | undefined;
  const land = () => landing ??= (async () => {
    try {
      const ok = await forget();
      if (ok) for (const listener of signedOut) listener();
      return ok;
    } finally {
      waiting = false;
      landing = undefined;
    }
  })();
  return {
    /** A sign-out is waiting for running turns or its delete: read as signed out, start no turn. */
    get waiting() {
      return waiting;
    },
    turnStarted(id: string) {
      running.add(id);
    },
    turnEnded(id: string) {
      if (!running.delete(id) || !waiting || running.size || landing) return;
      void land().then((ok) => {
        if (!ok) console.warn("[antigravity] could not delete agy's saved sign-in after its running turns ended");
      });
    },
    /** True once signed out, or once the delete is waiting on running turns. */
    async signOut(): Promise<boolean> {
      waiting = true;
      return running.size && !landing ? true : land();
    },
    signingIn() {
      waiting = false;
    },
    onSignedOut(listener: () => void) {
      signedOut.add(listener);
      return () => signedOut.delete(listener);
    },
  };
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