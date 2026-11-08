import { describe, expect, it } from "vitest";

import { selectAutoRoute, SHIPPED_AUTO_RULES, type AutoCandidate } from "../shared/auto-routing.ts";
import { workerWindowLow } from "../shared/usage-windows.ts";
import { createSpawnUsage } from "./spawn-usage.ts";

const now = Date.now();
const maker = { engine: "antigravityAgent" as const, model: "gemini-3.8-flash-high", effort: "high" as const };
const candidate: AutoCandidate = {
  engine: maker.engine, account: "gemini", generation: 0, currentGeneration: 0,
  authorized: true, signedIn: true, lifecycle: "ready", subscription: true,
  models: ["gemini-3.8-flash-high", "gemini-4-argon-high"], effortLevels: ["high"],
  tools: [], contextTokens: 100000, pending: 0, active: 0, loadKnown: true, main: true, headroom: 80,
  usage: { observedAt: new Date(now).toISOString(), windows: [{ id: "daily", usedPercent: 20, resetsAt: null }] },
};

describe("approved Auto picks", () => {
  it.each(["architecture", "audit", "design"] as const)("does not choose Argon for %s second eyes", (kind) => {
    expect(selectAutoRoute({ target: "worker", task: { kind, risk: "high", scope: "large", source: "declared", reviewOf: maker },
      now, candidates: [candidate], rules: structuredClone(SHIPPED_AUTO_RULES), rulesVersion: 0,
    })).toMatchObject({ kind: "selected", route: { ...maker, reviewLabel: "same model, fresh look", freshReview: true } });
  });

  it("allows an explicit verified Argon big-job pick", () => {
    expect(selectAutoRoute({ target: "worker", task: { kind: "architecture", risk: "high", scope: "large", source: "declared", reviewOf: maker },
      pin: { engine: maker.engine, model: "gemini-4-argon-high" }, pinVerified: true,
      now, candidates: [candidate], rules: structuredClone(SHIPPED_AUTO_RULES), rulesVersion: 0,
    })).toMatchObject({ kind: "selected", route: { model: "gemini-4-argon-high", reviewLabel: "same family" } });
  });

  it("does not satisfy a different-family rule with a fresh session", () => {
    expect(selectAutoRoute({ target: "worker", task: { kind: "audit", risk: "high", scope: "large", source: "declared", reviewOf: maker, requireSecondFamily: true },
      now, candidates: [candidate], rules: structuredClone(SHIPPED_AUTO_RULES), rulesVersion: 0,
    })).toMatchObject({ kind: "hold" });
  });

  it.each(["daily", "primary", "other"])("uses the session threshold for %s", (id) => {
    expect(workerWindowLow({ id, usedPercent: 75, resetsAt: null })).toBe(false);
    expect(workerWindowLow({ id, usedPercent: 75.01, resetsAt: null })).toBe(true);
    expect(workerWindowLow({ id, usedPercent: 80, resetsAt: null })).toBe(true);
    expect(workerWindowLow({ id: "seven_day", usedPercent: 80, resetsAt: null })).toBe(false);
  });

  it("holds a legacy launch on a daily cap below 25 percent left", async () => {
    const usage = createSpawnUsage({ rateLimits: new Map([["antigravity", { observedAt: new Date(now).toISOString(),
      windows: [{ id: "daily", usedPercent: 80, resetsAt: null, windowMinutes: 1440 }] }]]),
      save() {}, refresh: async () => ({}), environment: () => ({}), now: () => now,
    });
    expect(await usage("bot", "review", "agy --model gemini-3.8-flash-high")).toHaveProperty("hold");
  });
});
