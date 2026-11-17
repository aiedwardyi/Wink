import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { cachedSignIn, storedSignIn } from "./auth-status.ts";

describe("local sign-in cache", () => {
  it("shares pending probes and refreshes on demand and after expiry", async () => {
    vi.useFakeTimers();
    const probe = vi.fn<() => Promise<boolean | undefined>>().mockResolvedValue(false);
    const check = cachedSignIn(probe);
    try {
      expect(check()).toBe(check());
      expect(await check()).toBe(false);
      expect(probe).toHaveBeenCalledTimes(1);
      probe.mockResolvedValue(true);
      expect(await check(true)).toBe(true);
      expect(probe).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(30_000);
      await check();
      expect(probe).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-probes after a signed-out result so a fresh sign-in shows at once", async () => {
    const probe = vi.fn<() => Promise<boolean | undefined>>().mockResolvedValue(false);
    const check = cachedSignIn(probe);
    expect(await check()).toBe(false);
    probe.mockResolvedValue(true);
    expect(await check()).toBe(true);
    expect(await check()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("caches the classification and invalidates changed or removed files", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-auth-cache-"));
    const path = join(home, "auth.json");
    const classify = vi.fn((text: string) => JSON.parse(text).signedIn === true);
    try {
      expect(storedSignIn(path, classify)).toBe(false);
      writeFileSync(path, '{"signedIn":true}');
      expect(storedSignIn(path, classify)).toBe(true);
      expect(storedSignIn(path, classify)).toBe(true);
      expect(classify).toHaveBeenCalledTimes(1);
      writeFileSync(path, '{"signedIn":false}');
      expect(storedSignIn(path, classify)).toBe(false);
      rmSync(path);
      expect(storedSignIn(path, classify)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the last answer while the file is half-written and never reads unknown as signed out", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-auth-torn-"));
    const path = join(home, "auth.json");
    const fresh = join(home, "fresh.json");
    const classify = (text: string) => JSON.parse(text).signedIn === true;
    try {
      writeFileSync(path, '{"signedIn":true}');
      expect(storedSignIn(path, classify)).toBe(true);
      writeFileSync(path, '{"signedIn":tr');
      expect(storedSignIn(path, classify)).toBe(true);
      writeFileSync(fresh, '{"signedIn":tr');
      expect(storedSignIn(fresh, classify)).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
