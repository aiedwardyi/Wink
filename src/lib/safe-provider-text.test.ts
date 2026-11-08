import { describe, expect, it } from "vitest";
import { makeIdentityCanary } from "./identity-canary";
import { safeProviderText } from "./safe-provider-text";

describe("safeProviderText", () => {
  it("removes any email shape, even one that is no known account", () => {
    const text = safeProviderText("Limit hit for someone.else@example.org on this plan.", []);
    expect(text).not.toMatch(/@|someone\.else|example\.org/);
    expect(text).toContain("on this plan.");
  });

  it.each([{ identities: [] }, { identities: ["mary.o'connor@example.org"] }])("removes an apostrophe address without leaving its local prefix ($identities)", ({ identities }) => {
    expect(safeProviderText("Limit hit for mary.o'connor@example.org on this plan.", identities)).toBe("Limit hit for … on this plan.");
  });

  it("removes each part of a known identity on its own, in any case", () => {
    const canary = makeIdentityCanary();
    const raw = `Account ${canary.local.toUpperCase()} at ${canary.domain} (${canary.address}) reached its limit.`;
    const text = safeProviderText(raw, [canary.address, undefined, null]);
    for (const part of [canary.address, canary.local, canary.domain]) expect(text.toLowerCase()).not.toContain(part.toLowerCase());
    expect(text).toContain("reached its limit.");
  });

  it("keeps ordinary text, collapses whitespace and caps the length", () => {
    expect(safeProviderText("  Rate   limit\nreached.  ", [])).toBe("Rate limit reached.");
    const long = safeProviderText("x".repeat(1000), []);
    expect(long.length).toBeLessThanOrEqual(280);
    expect(long.endsWith("…")).toBe(true);
  });

  it("leaves very short identity parts alone so common text survives", () => {
    expect(safeProviderText("Try again in 5 hours.", ["a@b"])).toBe("Try again in 5 hours.");
  });
});
