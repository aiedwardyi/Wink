import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { usageAccount } from "./accounts";

const base: InstanceInfo = {
  instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude",
  snapshot: { state: "available" }, models: { default: "opus", options: [] },
  rateLimits: { observedAt: "2026-11-03T00:00:00Z", windows: [] },
};
const main: InstanceInfo = { ...base, instanceId: "second", accountOf: "claude", accountMain: true };

describe("usageAccount", () => {
  it.each([undefined, "claude"])("keeps the single-account row unchanged with accountOf %s", (accountOf) => {
    const account = { ...base, accountOf };
    expect(usageAccount([account], "claude")).toBe(account);
  });

  it("uses Main from the selected profile without changing the usage rows", () => {
    const foreign = { ...main, instanceId: "foreign", accountOf: "other-profile" };
    const instances = [foreign, base, main];
    const before = JSON.stringify(instances);
    expect(usageAccount(instances, "claude")).toBe(main);
    expect(JSON.stringify(instances)).toBe(before);
  });

  it("keeps an explicit account selection when another account is Main", () => {
    const pinned = { ...main, instanceId: "pinned", accountMain: false };
    expect(usageAccount([base, main, pinned], "pinned")).toBe(pinned);
  });

  it("does not borrow base windows when Main has no reading", () => {
    const pending = { ...main, rateLimits: undefined };
    expect(usageAccount([base, pending], "claude")?.rateLimits).toBeUndefined();
  });

  it.each(["draining", "logout", "signed-out"] as const)("follows the next turn's destination during %s", (phase) => {
    const draining = { ...main, drain: { destinationId: "claude", phase } };
    expect(usageAccount([base, draining], "claude")).toBe(base);
  });

  it("keeps Main after a failed drain", () => {
    const failed = { ...main, drain: { destinationId: "claude", phase: "failed" as const } };
    expect(usageAccount([base, failed], "claude")).toBe(failed);
  });

  it("does not fall back when a routed account is missing", () => {
    const draining = { ...main, drain: { destinationId: "missing", phase: "draining" as const } };
    expect(usageAccount([base, draining], "claude")).toBeUndefined();
    expect(usageAccount([base, main], "missing")).toBeUndefined();
  });
});
