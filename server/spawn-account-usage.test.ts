import { expect, it, vi } from "vitest";

import { createSpawnUsage } from "./spawn-usage.ts";
import type { RateLimitsMap } from "./rate-limits-store.ts";

const NOW = Date.now();
const COMMAND = "codex 'task'";
const ACCOUNT = { id: "acct_third", generation: 3, name: "Codex" };

function fixture() {
  const rateLimits: RateLimitsMap = new Map(["codex", ACCOUNT.id, "acct_fourth"].map((id) => [id, {
    observedAt: new Date(NOW).toISOString(), windows: [{ id: "five_hour", usedPercent: 95, resetsAt: NOW + 60_000, windowMinutes: 300 }],
  }]));
  const refresh = vi.fn(async () => ({}));
  const check = createSpawnUsage({ rateLimits, refresh, save() {}, environment: () => ({}), now: () => NOW });
  return { check, rateLimits, refresh };
}

it("managed usage reads the captured account rather than reparsing shell text", async () => {
  const f = fixture();
  f.rateLimits.delete("codex");
  expect(await f.check("bot", "worker", "opaque sanctioned command", ACCOUNT)).toHaveProperty("hold");
  expect(f.refresh).not.toHaveBeenCalled();
});

it("hold keys include the captured account id", async () => {
  const { check } = fixture();
  expect(await check("bot", "worker", COMMAND, ACCOUNT)).toHaveProperty("hold");
  expect(await check("bot", "worker", COMMAND, { ...ACCOUNT, id: "acct_fourth" })).toHaveProperty("hold");
  expect(await check("bot", "worker", COMMAND, ACCOUNT)).toHaveProperty("line");
});

it("hold keys include the captured generation", async () => {
  const { check } = fixture();
  expect(await check("bot", "worker", COMMAND, ACCOUNT)).toHaveProperty("hold");
  expect(await check("bot", "worker", COMMAND, { ...ACCOUNT, generation: 4 })).toHaveProperty("hold");
});
