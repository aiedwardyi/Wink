import { readFileSync, statSync } from "node:fs";

const fileChecks = new Map<string, { identity: string; authenticated: boolean }>();
const fileAccounts = new Map<string, { identity: string; account?: string }>();
export const SIGN_IN_CACHE_MS = 30_000;

function fileIdentity(path: string): string {
  const stat = statSync(path);
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Only a missing file is signed out; an unreadable or half-written one keeps the last answer. */
export function storedSignIn(path: string, classify: (text: string) => boolean): boolean | undefined {
  try {
    const identity = fileIdentity(path);
    const cached = fileChecks.get(path);
    if (cached?.identity === identity) return cached.authenticated;
    const authenticated = classify(readFileSync(path, "utf8"));
    fileChecks.set(path, { identity, authenticated });
    return authenticated;
  } catch (error) {
    // SAFETY: Filesystem failures expose Node's errno code; a parse error has none.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fileChecks.get(path)?.authenticated;
    fileChecks.delete(path);
    return false;
  }
}

export function accountLabel(...fields: unknown[]): string | undefined {
  for (const field of fields) if (typeof field === "string" && field.trim()) return field.trim();
  return undefined;
}

export function storedAccount(path: string, read: (auth: unknown) => string | undefined): string | undefined {
  try {
    const identity = fileIdentity(path);
    const cached = fileAccounts.get(path);
    if (cached?.identity === identity) return cached.account;
    const account = read(JSON.parse(readFileSync(path, "utf8")));
    fileAccounts.set(path, { identity, account });
    return account;
  } catch {
    fileAccounts.delete(path);
    return undefined;
  }
}

/** Reuses only a signed-in result, so a fresh terminal sign-in shows on the next check. */
export function cachedSignIn<T = boolean | undefined>(
  probe: () => Promise<T>,
  signedIn: (result: T) => boolean = (result) => result === true,
) {
  let cached: Promise<T> | undefined;
  let reuseUntil = 0;
  return (refresh = false) => {
    if (refresh || !cached || Date.now() >= reuseUntil) {
      const current = probe();
      cached = current;
      reuseUntil = Infinity;
      void current.then((result) => {
        if (cached === current) reuseUntil = signedIn(result) ? Date.now() + SIGN_IN_CACHE_MS : 0;
      });
    }
    return cached;
  };
}
