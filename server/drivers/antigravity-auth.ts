import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** The on-disk record of a deferred sign-out. */
export interface SignedOutMark {
  /** When Wink signed out (epoch ms), with no sign-in since; undefined when it has not. */
  read(): number | undefined;
  /** Throws when it cannot be saved. */
  write(signedOutAt: number | undefined): void;
}

function markTime(path: string): number | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    const at = Date.parse(text);
    if (Number.isFinite(at) && new Date(at).toISOString() === text) return at;
  } catch {
    return undefined;
  }
  return undefined;
}

/** The mark as a file holding when Wink signed out. A sign-in or delete that cannot remove it (another process holds
 * it open) writes when it ended beside it, so the next run knows the mark is older than that. */
export function signedOutMarkFile(path: string): SignedOutMark {
  const cleared = `${path}.cleared`;
  return {
    read: () => {
      const at = markTime(path);
      if (at === undefined || (markTime(cleared) ?? -Infinity) < at) return at;
      try {
        rmSync(path, { force: true });
        rmSync(cleared, { force: true });
      } catch (error) {
        console.warn("[antigravity] could not remove an old signed-out mark for agy", error);
      }
      return undefined;
    },
    write: (signedOutAt) => {
      if (signedOutAt !== undefined) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${new Date(signedOutAt).toISOString()}\n`);
        return;
      }
      try {
        rmSync(path, { force: true });
      } catch {
        writeFileSync(cleared, `${new Date().toISOString()}\n`);
        return;
      }
      rmSync(cleared, { force: true });
    },
  };
}

/**
 * Signs agy out by deleting its saved sign-in, without cutting off a running turn: agy before 1.5 rereads that
 * sign-in on every request. The sign-out request and new turns wait for the delete, which lands when the last
 * running turn ends or Wink shuts down.
 *
 * Only the current run may finish a deferred delete. At boot Wink clears any readable mark and uses the saved
 * sign-in as it is, because the keyring cannot identify which login a past run meant to delete.
 *
 * A sign-in holds the delete off while it may be saving a new sign-in. Success clears the pending sign-out, as
 * does a successful agy logout. A failed sign-in lets a pending delete land once no turn runs.
 *
 * One delete at a time: a sign-out while a delete runs gets that delete's answer, and a delete finds out first
 * whether there is still a saved sign-in (`present`), so a second sign-out never fails on the first one's delete.
 */
export function antigravityKeyringSignOut(forget: () => Promise<boolean>, opts: {
  present?: () => Promise<boolean | undefined>;
  mark?: SignedOutMark;
} = {}) {
  const running = new Set<string>();
  const signedOut = new Set<() => void>();
  let deferred: { result: Promise<boolean>; resolve: (ok: boolean) => void } | undefined;
  let signIns = 0;
  // Instances attached in this run; the last one to let go ends the run, and the next attach reads `mark` again.
  let attached = 0;
  let run = 0;
  let loaded = false;
  let landing: Promise<boolean> | undefined;
  const writeMark = (at: number | undefined) => {
    try {
      opts.mark?.write(at);
    } catch (error) {
      console.warn("[antigravity] could not update Wink's signed-out mark for agy", error);
    }
  };
  const finishDeferred = (ok: boolean) => {
    if (!deferred) return;
    const { resolve } = deferred;
    deferred = undefined;
    writeMark(undefined);
    resolve(ok);
  };
  const land = () => landing ??= (async () => {
    let ok = false;
    try {
      ok = (await opts.present?.()) === false || await forget();
      if (ok) for (const listener of signedOut) listener();
      return ok;
    } finally {
      finishDeferred(ok);
      landing = undefined;
    }
  })();
  const landWhenFree = () => {
    if (!deferred || running.size || landing || signIns) return;
    void land().catch((error) => console.warn("[antigravity] could not delete agy's saved sign-in", error));
  };
  return {
    get pending() {
      return deferred?.result ?? landing;
    },
    /** Only this run may finish a deferred delete. */
    attach() {
      attached += 1;
      if (loaded) return;
      loaded = true;
      if (opts.mark?.read() !== undefined) writeMark(undefined);
    },
    /** An instance is gone and its turns stopped: a waiting delete lands now, before Wink can exit. */
    async release(stopped: (turn: string) => boolean) {
      for (const id of running) if (stopped(id)) running.delete(id);
      landWhenFree();
      await landing;
      attached -= 1;
      if (attached > 0) return;
      running.clear();
      finishDeferred(false);
      signIns = 0;
      loaded = false;
      run += 1;
    },
    turnStarted(id: string) {
      running.add(id);
    },
    turnEnded(id: string) {
      if (running.delete(id)) landWhenFree();
    },
    async signOut(): Promise<boolean> {
      if (deferred) return deferred.result;
      if (landing) return landing;
      if (!running.size && !signIns) return land();
      let resolve!: (ok: boolean) => void;
      const result = new Promise<boolean>((done) => { resolve = done; });
      deferred = { result, resolve };
      writeMark(Date.now());
      return result;
    },
    /** agy's own logout succeeded: its saved sign-in is gone, so nothing is left to delete. */
    signedOutByAgy() {
      finishDeferred(true);
    },
    /** A sign-in is starting: once any delete in flight has finished, holds the delete off until `ended`. */
    async signingIn(): Promise<(succeeded: boolean) => void> {
      signIns += 1;
      const started = run;
      await landing;
      let open = true;
      return (succeeded) => {
        if (!open || started !== run) return;
        open = false;
        signIns -= 1;
        if (succeeded) finishDeferred(false);
        else landWhenFree();
      };
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

const appDir = (env: Record<string, string | undefined>) => join(env.HOME || env.USERPROFILE || homedir(), ".gemini", "antigravity-cli");
const logDir = (env: Record<string, string | undefined>) => join(appDir(env), "log");

/** agy saves its sign-in to this file instead of the keyring over SSH (the phone sign-in sets SSH_CONNECTION), and reads both. */
export function hasAntigravityTokenFile(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return statSync(join(appDir(env), "antigravity-oauth-token")).size > 0;
  } catch {
    return false;
  }
}

function latestLogEvent(env: Record<string, string | undefined>): string | null | undefined {
  const dir = logDir(env);
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