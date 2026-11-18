import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { completeOnboarding, hasCompletedOnboarding, loadAnalyticsConsent, saveAnalyticsConsent } from "./analytics-consent.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omb-analytics-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("analytics consent", () => {
  it("is off with no file, a broken file or a wrong shape", () => {
    expect(loadAnalyticsConsent(root)).toBe(false);
    writeFileSync(join(root, "analytics.json"), "{not json");
    expect(loadAnalyticsConsent(root)).toBe(false);
    writeFileSync(join(root, "analytics.json"), JSON.stringify({ enabled: "yes" }));
    expect(loadAnalyticsConsent(root)).toBe(false);
  });

  it("follows the given default with no saved choice, and a saved choice wins", () => {
    expect(loadAnalyticsConsent(root, true)).toBe(true);
    saveAnalyticsConsent(root, false);
    expect(loadAnalyticsConsent(root, true)).toBe(false);
  });

  it("writes its own file and reads it back", () => {
    expect(saveAnalyticsConsent(root, true)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "analytics.json"), "utf8"))).toEqual({ enabled: true });
    expect(loadAnalyticsConsent(root)).toBe(true);
    saveAnalyticsConsent(root, false);
    expect(loadAnalyticsConsent(root)).toBe(false);
  });

  it("creates a missing data dir", () => {
    const nested = join(root, "fresh");
    saveAnalyticsConsent(nested, true);
    expect(loadAnalyticsConsent(nested)).toBe(true);
  });

  it("keeps a saved opt-out when a stale welcome screen submits the default", () => {
    saveAnalyticsConsent(root, false);
    expect(hasCompletedOnboarding(root)).toBe(true);
    expect(completeOnboarding(root, true)).toBeUndefined();
    expect(loadAnalyticsConsent(root, true)).toBe(false);
  });

  it("remembers completion even without a usage sharing choice", () => {
    expect(hasCompletedOnboarding(root)).toBe(false);
    expect(completeOnboarding(root)).toBeUndefined();
    expect(hasCompletedOnboarding(root)).toBe(true);
    expect(loadAnalyticsConsent(root)).toBe(false);
    expect(loadAnalyticsConsent(root, true)).toBe(true);
    expect(completeOnboarding(root, false)).toBe(false);
    expect(loadAnalyticsConsent(root, true)).toBe(false);
    expect(completeOnboarding(root, true)).toBeUndefined();
    expect(loadAnalyticsConsent(root)).toBe(false);
    saveAnalyticsConsent(root, true);
    expect(hasCompletedOnboarding(root)).toBe(true);
    expect(loadAnalyticsConsent(root)).toBe(true);
  });
});
