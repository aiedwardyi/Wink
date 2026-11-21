import { describe, expect, it, vi } from "vitest";
import { testHome } from "./testing/test-home.ts";

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { canRefreshUsage, createMuseCheck, createUsageRefresh, isCsrfRejection, museCheckModel, readAntigravityQuota, readAntigravityUsageCommand, readGrokBillingRpc, readMuseUsage, usageRefreshResponse } from "./usage-refresh.ts";
import type { RateLimitWindow } from "./contracts.ts";
import { antigravityRateLimitWindows } from "./drivers/rate-limits.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import type { JsonValue } from "./schema.ts";

const reset = "2026-10-01T12:00:00Z";
const FAKE_MSP_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-msp-cli.ts");
const FAKE_ACP_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const fixtures = {
  codex: { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: Date.parse(reset) / 1000 }, secondary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: Date.parse(reset) / 1000 } } },
  grokAgent: { config: { creditUsagePercent: 42, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: reset } } },
  antigravityAgent: {
    "gemini-5h": { remaining_fraction: 0.58, reset_in_seconds: 3600 },
    "gemini-weekly": { remaining_fraction: 0.81, reset_in_seconds: 518_400 },
  },
  museAgent: {
    usage: {
      observedAtMs: 1_790_000_000_000,
      tier: "pro",
      window: { usedPercent: 22, windowDurationMins: 300, resetsAtMs: 1_790_000_000_000 },
      weekly: { usedPercent: 61, resetsAtMs: 1_790_172_800_000 },
    },
  },
};
const claudeWindows: RateLimitWindow[] = [
  { id: "five_hour", usedPercent: 42, resetsAt: Date.parse(reset), windowMinutes: 300 },
  { id: "seven_day", usedPercent: 19, resetsAt: Date.parse(reset), windowMinutes: 10_080 },
];
const real = {
  codex: z.object({ reply: z.json() }).parse(JSON.parse(readFileSync(new URL("../test/fixtures/recorded/codex/rate-limits.json", import.meta.url), "utf8"))).reply,
  grok: z.object({ reply: z.json(), settled: z.json() }).parse(JSON.parse(readFileSync(new URL("../test/fixtures/recorded/grok/billing-renewal.json", import.meta.url), "utf8"))),
  grokUsed: z.object({ reply: z.json() }).parse(JSON.parse(readFileSync(new URL("../test/fixtures/recorded/grok/billing-used.json", import.meta.url), "utf8"))).reply,
};
const unreadableCodexBuckets: Record<string, JsonValue>[] = [{}, { primary: { usedPercent: "unknown" } }];

it("shares the usage-read availability policy with wait admission", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    expect(canRefreshUsage("claudeAgent", { CLAUDE_CODE_OAUTH_TOKEN: "" }, platform)).toBe(platform !== "darwin");
    expect(canRefreshUsage("claudeAgent", { CLAUDE_CODE_OAUTH_TOKEN: "fake-token" }, platform)).toBe(true);
    expect(canRefreshUsage("codex", {}, platform)).toBe(true);
    expect(canRefreshUsage("unsupported", {}, platform)).toBe(false);
  }
});

describe("usage refresh route result", () => {
  it("preserves every Codex bucket in a read instead of using only the compatibility bucket", async () => {
    const refresh = createUsageRefresh({ rpc: async () => ({ ...fixtures.codex,
      rateLimitsByLimitId: { spark: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Date.parse(reset) / 1000 } } } }) });
    const result = await refresh("codex", { instanceId: "codex" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows).toContainEqual({ id: "spark:five_hour", usedPercent: 100, resetsAt: Date.parse(reset), windowMinutes: 300 });
  });

  it.each(unreadableCodexBuckets)("skips an unreadable scoped Codex bucket and keeps the known windows: %j", async (snapshot) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const refresh = createUsageRefresh({ rpc: async () => ({ ...fixtures.codex, rateLimitsByLimitId: { spark: snapshot } }) });
      const result = await refresh("codex", { instanceId: "codex" });
      expect(result.error).toBeUndefined();
      expect(result.report?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    } finally {
      warn.mockRestore();
    }
  });

  it("returns the read still running to a second request after the cooldown expires", async () => {
    let now = 1_000;
    let finish: (value: JsonValue) => void = () => {};
    const rpc = vi.fn(() => new Promise<JsonValue>((resolve) => { finish = resolve; }));
    const refresh = createUsageRefresh({ now: () => now, rpc });
    const first = refresh("codex", { instanceId: "codex" });
    now += 31_000;
    const second = refresh("codex", { instanceId: "codex" });
    expect(rpc).toHaveBeenCalledTimes(1);
    finish(real.codex);
    expect(await second).toBe(await first);
    now += 31_000;
    void refresh("codex", { instanceId: "codex" });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("shares a Claude usage read that outlives its cooldown", async () => {
    let now = 1_000;
    let answer: (windows: RateLimitWindow[]) => void = () => {};
    const claude = vi.fn(() => new Promise<RateLimitWindow[]>((resolve) => { answer = resolve; }));
    const refresh = createUsageRefresh({ platform: "linux", now: () => now, claude });
    const first = refresh("claudeAgent", { instanceId: "claude" });
    await vi.waitFor(() => expect(claude).toHaveBeenCalledTimes(1));
    now += 31_000;
    const second = refresh("claudeAgent", { instanceId: "claude" });
    await Promise.resolve();
    expect(claude).toHaveBeenCalledTimes(1);
    answer(claudeWindows);
    expect((await second).report).toEqual((await first).report);
  });

  describe("a user-tapped refresh", () => {
    const used = (result: { report?: { windows: { usedPercent: number }[] } }) => result.report?.windows.map((window) => window.usedPercent);
    const codexAt = (percent: number) => ({ rateLimits: { primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: Date.parse(reset) / 1000 } } });

    it("asks the provider again inside the cooldown while automatic checks still share one read", async () => {
      const answers = [38, 12];
      const rpc = vi.fn(async () => codexAt(answers.shift() ?? 0));
      const refresh = createUsageRefresh({ now: () => 1_000, rpc });
      expect(used(await refresh("codex", { instanceId: "codex" }))).toEqual([38]);
      expect(used(await refresh("codex", { instanceId: "codex" }))).toEqual([38]);
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(used(await refresh("codex", { instanceId: "codex", fresh: true }))).toEqual([12]);
      expect(used(await refresh("codex", { instanceId: "codex" }))).toEqual([12]);
      expect(rpc).toHaveBeenCalledTimes(2);
    });

    it("joins a read that is still running instead of starting another", async () => {
      let finish: (value: JsonValue) => void = () => {};
      const rpc = vi.fn(() => new Promise<JsonValue>((resolve) => { finish = resolve; }));
      const refresh = createUsageRefresh({ now: () => 1_000, rpc });
      const auto = refresh("codex", { instanceId: "codex" });
      const tap = refresh("codex", { instanceId: "codex", fresh: true });
      expect(rpc).toHaveBeenCalledTimes(1);
      finish(codexAt(12));
      expect(await tap).toBe(await auto);
    });
  });

  it("lists the default Codex bucket once when rateLimitsByLimitId repeats it", async () => {
    const refresh = createUsageRefresh({ rpc: async () => real.codex });
    const result = await refresh("codex", { instanceId: "codex" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows).toEqual([{ id: "seven_day", usedPercent: 58, resetsAt: 1_793_774_106_000, windowMinutes: 10_080 }]);
  });

  it("lists the default Codex bucket once when its limitId is null", async () => {
    const codex = real.codex as { rateLimits: Record<string, unknown> };
    const refresh = createUsageRefresh({ rpc: async () => ({ ...codex, rateLimits: { ...codex.rateLimits, limitId: null } }) });
    const result = await refresh("codex", { instanceId: "codex" });
    expect(result.report?.windows.map((window) => window.id)).toEqual(["seven_day"]);
  });

  it("keeps a scoped Codex window beside an unreadable sibling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const spark = { primary: { usedPercent: 40, windowDurationMins: 300 }, secondary: { usedPercent: "unknown" } };
      const refresh = createUsageRefresh({ rpc: async () => ({ ...fixtures.codex, rateLimitsByLimitId: { spark } }) });
      const result = await refresh("codex", { instanceId: "codex" });
      expect(result.report?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day", "spark:five_hour"]);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(["claudeAgent", "codex"] as const)("normalizes %s without leaking credentials", async (driver) => {
    const refresh = createUsageRefresh({
      platform: "linux",
      claude: async () => claudeWindows,
      rpc: async () => fixtures.codex,
    });
    const result = await refresh(driver, { instanceId: driver });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows.map((window) => window.usedPercent)).toEqual([42, 19]);
    expect(result.report?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    for (const secret of ["access-secret", "refresh-secret", "Bearer", "access_token", "refresh_token", "authorization"]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(usageRefreshResponse(driver, result))).not.toContain("access-secret");
  });

  it("normalizes grokAgent from ACP billing without reading auth.json", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      billing: async () => fixtures.grokAgent,
    });
    const result = await refresh("grokAgent", { instanceId: "grok" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows).toEqual([
      { id: "seven_day", usedPercent: 42, resetsAt: Date.parse(reset), windowMinutes: 10_080 },
    ]);
    expect(JSON.stringify(result)).not.toContain("access-secret");
  });

  it("accepts zero Grok usage as a real observation", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      billing: async () => ({
        config: { creditUsagePercent: 0, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: reset } },
      }),
    });
    const result = await refresh("grokAgent", { instanceId: "grok" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows).toEqual([
      { id: "seven_day", usedPercent: 0, resetsAt: Date.parse(reset), windowMinutes: 10_080 },
    ]);
  });

  it("reads Grok billing again when the answer after a login renewal has no tier yet", async () => {
    const answers = [real.grok.reply, real.grok.settled];
    const refresh = createUsageRefresh({ platform: "linux", billing: async () => answers.shift() ?? {} });
    const result = await refresh("grokAgent", { instanceId: "grok" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows).toEqual([
      { id: "seven_day", usedPercent: 0, resetsAt: Date.parse("2026-11-05T07:02:43.495651+00:00"), windowMinutes: 10_080 },
    ]);
    expect(answers).toEqual([]);
  });

  it("reads the recorded Grok answer after credit use", async () => {
    const answers = [real.grokUsed, real.grokUsed];
    const refresh = createUsageRefresh({ platform: "linux", billing: async () => answers.shift() ?? {} });
    const result = await refresh("grokAgent", { instanceId: "grok" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows).toEqual([
      { id: "seven_day", usedPercent: 51, resetsAt: Date.parse("2026-11-01T08:45:16.197799+00:00"), windowMinutes: 10_080 },
    ]);
    expect(answers).toHaveLength(1);
  });

  it.each([
    ["empty", {}],
    ["malformed", { config: { creditUsagePercent: "0", currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: reset } } }],
  ] as const)("retains prior Grok data after an %s billing payload", async (_kind, payload) => {
    const refresh = createUsageRefresh({ platform: "linux", billing: async () => payload });
    const previous = { windows: [{ id: "seven_day", usedPercent: 42, resetsAt: Date.parse(reset), windowMinutes: 10_080 }], observedAt: reset };
    const result = await refresh("grokAgent", { instanceId: "grok" }, previous);
    expect(result.report).toEqual(previous);
    expect(result.error).toBe("Could not refresh Grok limits");
  });

  it("uses Grok's launcher, cached-token auth, and billing method contract", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-grok-refresh-"));
    const argsDump = join(scratch, "args.json");
    const rpcDump = join(scratch, "rpc.json");
    try {
      const result = await readGrokBillingRpc(FAKE_ACP_CLI, {
        FAKE_ACP_DUMP: argsDump,
        FAKE_ACP_RPC_DUMP: rpcDump,
      });
      expect(result).toMatchObject({ config: { creditUsagePercent: 42, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } });
      expect(JSON.parse(readFileSync(argsDump, "utf8")).argv).toEqual(["agent", "stdio"]);
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize", "authenticate", "_x.ai/billing"]);
    } finally {
      removeTempDir(scratch);
    }
  });

  it("keeps two Claude logins isolated within the throttle window", async () => {
    const claude = vi.fn(async (_cli: string, env: NodeJS.ProcessEnv) =>
      [{ id: "five_hour", usedPercent: env.CLAUDE_CONFIG_DIR === "account-a" ? 12 : 67, resetsAt: Date.parse(reset), windowMinutes: 300 }]);
    const refresh = createUsageRefresh({ platform: "linux", now: () => 1_000, claude });
    const account = (instanceId: string) => ({ instanceId, environment: { CLAUDE_CONFIG_DIR: instanceId } });
    const first = await refresh("claudeAgent", account("account-a"));
    const second = await refresh("claudeAgent", account("account-b"));
    expect(first.report?.windows[0].usedPercent).toBe(12);
    expect(second.report?.windows[0].usedPercent).toBe(67);
    expect(await refresh("claudeAgent", account("account-a"))).toEqual(first);
    expect(await refresh("claudeAgent", account("account-b"))).toEqual(second);
    expect(claude).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent Claude reads and keeps the last values quietly when the CLI can't report", async () => {
    let now = 1_000;
    const claude = vi.fn(async () => claudeWindows);
    const refresh = createUsageRefresh({ platform: "linux", now: () => now, random: () => 0, claude });
    const [first, second] = await Promise.all([refresh("claudeAgent", { instanceId: "claude" }), refresh("claudeAgent", { instanceId: "claude" })]);
    expect(claude).toHaveBeenCalledTimes(1);
    expect(second.report).toEqual(first.report);
    now += 299_999;
    await refresh("claudeAgent", { instanceId: "claude" });
    expect(claude).toHaveBeenCalledTimes(1);
    now++;
    claude.mockRejectedValueOnce(new Error("old CLI"));
    const failed = await refresh("claudeAgent", { instanceId: "claude" }, first.report);
    expect(claude).toHaveBeenCalledTimes(2);
    expect(failed).toMatchObject({ report: first.report, status: "no_observation" });
    expect(failed.error).toBeUndefined();
    await refresh("claudeAgent", { instanceId: "claude" });
    expect(claude).toHaveBeenCalledTimes(2);
  });

  it("reads one Claude login once for every instance on it", async () => {
    const claude = vi.fn(async () => claudeWindows);
    const refresh = createUsageRefresh({ platform: "linux", now: () => 1_000, claude });
    const results = await Promise.all(["claude", "claude-opus", "claude-sonnet"].map((instanceId) => refresh("claudeAgent", { instanceId })));
    expect(await refresh("claudeAgent", { instanceId: "claude-haiku" })).toEqual(results[0]);
    expect(claude).toHaveBeenCalledTimes(1);
  });

  it("normalizes antigravityAgent from the local quota server without touching credentials", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      antigravity: async () => fixtures.antigravityAgent,
    });
    const result = await refresh("antigravityAgent", { instanceId: "antigravity" });
    expect(result.error).toBeUndefined();
    expect(result.report?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(result.report?.windows.map((window) => window.usedPercent)).toEqual([42, 19]);
    expect(result.report?.windows.map((window) => window.windowMinutes)).toEqual([300, 10_080]);
    expect(JSON.stringify(result)).not.toContain("access-secret");
  });

  it.each(["signin", "refresh"] as const)("keeps the last report after Antigravity %s", async (kind) => {
    const refresh = createUsageRefresh({
      platform: "linux",
      antigravity: async () => {
        throw new Error(kind);
      },
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("antigravityAgent", { instanceId: "antigravity" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe(kind === "signin" ? "Sign in again in Antigravity" : "Could not refresh Antigravity limits");
  });

  it("treats an empty Antigravity quota as a refresh failure", async () => {
    const refresh = createUsageRefresh({ platform: "linux", antigravity: async () => ({}) });
    const result = await refresh("antigravityAgent", { instanceId: "antigravity" });
    expect(result.report).toBeUndefined();
    expect(result.error).toBe("Could not refresh Antigravity limits");
  });

  it("normalizes museAgent from the injected quota source without touching credentials", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      muse: async () => fixtures.museAgent,
    });
    const result = await refresh("museAgent", { instanceId: "muse" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("fresh");
    expect(result.report?.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(result.report?.windows.map((window) => window.usedPercent)).toEqual([22, 61]);
    expect(result.report?.windows.map((window) => window.windowMinutes)).toEqual([300, 10_080]);
    expect(result.report?.windows.map((window) => window.resetsAt)).toEqual([1_790_000_000_000, 1_790_172_800_000]);
    expect(result.report?.observedAt).toBe(new Date(1_790_000_000_000).toISOString());
    expect(JSON.stringify(result)).not.toContain("access-secret");
  });

  it.each(["signin", "refresh"] as const)("keeps the last report after Muse %s", async (kind) => {
    const refresh = createUsageRefresh({
      platform: "linux",
      muse: async () => {
        throw new Error(kind);
      },
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("museAgent", { instanceId: "muse" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe(kind === "signin" ? "Sign in again in Muse" : "Could not refresh Muse limits");
    expect(result.status).toBe(kind === "signin" ? "auth_error" : "transport_error");
  });

  it("reports no observation when Muse returns an empty snapshot", async () => {
    const refresh = createUsageRefresh({ platform: "linux", muse: async () => ({}) });
    const result = await refresh("museAgent", { instanceId: "muse" });
    expect(result.report).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("no_observation");
  });

  it("retains the last report while Muse has no observed snapshot", async () => {
    const refresh = createUsageRefresh({ platform: "linux", muse: async () => ({}) });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("museAgent", { instanceId: "muse" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("no_observation");
  });

  it("reports a transport error for malformed Muse usage", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      muse: async () => ({ usage: { observedAtMs: 1_790_000_000_000, tier: "pro", window: {} } }),
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("museAgent", { instanceId: "muse" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe("Could not refresh Muse limits");
    expect(result.status).toBe("transport_error");
  });

  it("keeps the newer report when Muse returns an older observation", async () => {
    const refresh = createUsageRefresh({
      platform: "linux",
      muse: async () => ({
        usage: {
          observedAtMs: Date.parse("2026-09-01T12:00:00Z"),
          tier: "pro",
          window: { usedPercent: 88, windowDurationMins: 300, resetsAtMs: Date.parse("2026-09-01T17:00:00Z") },
          weekly: { usedPercent: 70, resetsAtMs: Date.parse("2026-09-08T12:00:00Z") },
        },
      }),
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("museAgent", { instanceId: "muse" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("retained");
  });

  it("retains the last report when Muse returns the same observation", async () => {
    const refresh = createUsageRefresh({ muse: async () => fixtures.museAgent });
    const report = {
      windows: [
        { id: "five_hour", usedPercent: 22, resetsAt: 1_790_000_000_000, windowMinutes: 300 },
        { id: "seven_day", usedPercent: 61, resetsAt: 1_790_172_800_000, windowMinutes: 10_080 },
      ],
      observedAt: new Date(1_790_000_000_000).toISOString(),
    };
    const result = await refresh("museAgent", { instanceId: "muse" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("retained");
  });

  it("checks Muse again after the throttle window and marks unchanged data retained", async () => {
    let now = 1_000;
    let calls = 0;
    const refresh = createUsageRefresh({
      now: () => now,
      muse: async () => {
        calls++;
        return fixtures.museAgent;
      },
    });
    const first = await refresh("museAgent", { instanceId: "muse" });
    now += 30_000;
    const second = await refresh("museAgent", { instanceId: "muse" }, first.report);
    expect(calls).toBe(2);
    expect(second.status).toBe("retained");
    expect(second.report).toEqual(first.report);
  });

  it("reads stable usage/read through the Muse serve lifecycle", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-muse-usage-"));
    const rpcDump = join(scratch, "rpc.json");
    process.env.FAKE_MSP_USAGE = JSON.stringify(fixtures.museAgent);
    process.env.FAKE_MSP_RPC_DUMP = rpcDump;
    try {
      await expect(readMuseUsage(FAKE_MSP_CLI, {
        FAKE_MSP_USAGE: process.env.FAKE_MSP_USAGE,
        FAKE_MSP_RPC_DUMP: rpcDump,
      })).resolves.toEqual(fixtures.museAgent);
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize", "initialized", "usage/read"]);
    } finally {
      delete process.env.FAKE_MSP_USAGE;
      delete process.env.FAKE_MSP_RPC_DUMP;
      removeTempDir(scratch);
    }
  });

  it.each([
    ["usage-auth", "signin"],
    ["usage-transport", "refresh"],
  ] as const)("maps Muse %s to %s without changing the MSP sequence", async (mode, expected) => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-muse-usage-failure-"));
    const rpcDump = join(scratch, "rpc.json");
    try {
      await expect(readMuseUsage(FAKE_MSP_CLI, { FAKE_MSP_MODE: mode, FAKE_MSP_RPC_DUMP: rpcDump })).rejects.toThrow(expected);
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize", "initialized", "usage/read"]);
    } finally {
      removeTempDir(scratch);
    }
  });

  it("uses the same MSP sequence for an explicit WSL-resolved Muse CLI", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-muse-usage-wsl-"));
    const rpcDump = join(scratch, "rpc.json");
    try {
      await expect(
        readMuseUsage(
          "wsl muse",
          { META_API_KEY: "fixture-meta-key", FAKE_MSP_USAGE: JSON.stringify(fixtures.museAgent), FAKE_MSP_RPC_DUMP: rpcDump },
          {
            platform: "win32",
            resolveWsl: async (_cli, env) => {
              expect(env.WSLENV).toBe("META_API_KEY");
              return FAKE_MSP_CLI;
            },
          },
        ),
      ).resolves.toEqual(fixtures.museAgent);
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize", "initialized", "usage/read"]);
    } finally {
      removeTempDir(scratch);
    }
  });

  it("checks Muse with one minimal memory-only turn in an empty temp folder", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-muse-check-test-"));
    const dump = join(scratch, "dump.json");
    const rpcDump = join(scratch, "rpc.json");
    try {
      await expect(readMuseUsage(
        FAKE_MSP_CLI,
        { FAKE_MSP_USAGE: JSON.stringify(fixtures.museAgent), FAKE_MSP_DUMP: dump, FAKE_MSP_RPC_DUMP: rpcDump },
        { platform: "linux", check: true },
      )).resolves.toEqual(fixtures.museAgent);
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize", "initialized", "session/start", "turn/start", "usage/read"]);
      const spawn = JSON.parse(readFileSync(dump, "utf8"));
      expect(spawn.argv).toEqual(["serve", "--no-session-log", "--disable-shell", "--disable-write"]);
      expect(spawn.cwd).toContain("omb-muse-check-");
      expect(spawn.cwd).not.toBe(testHome());
      expect(JSON.parse(readFileSync(`${dump}.config.json`, "utf8"))).toEqual([
        { method: "session/start", modelId: "muse-spark-1.3", approvalMode: "denyUnmatched", workspaceRoot: spawn.cwd },
      ]);
      const turn = JSON.parse(readFileSync(`${dump}.turn-params.json`, "utf8"));
      expect(turn.reasoningEffort).toBe("minimal");
      expect(turn.input).toEqual([{ type: "text", text: "Reply with: ok" }]);
      await vi.waitFor(() => expect(existsSync(spawn.cwd)).toBe(false));
    } finally {
      await removeTempDir(scratch);
    }
  });

  it.each([
    ["all contributor", ["muse-spark-1.3-contributor", "muse-spark-1.2-contributor"], "muse-spark-1.3-contributor"],
    ["mixed", ["muse-spark-1.3-contributor", "muse-spark-1.3"], "muse-spark-1.3"],
    ["no Muse bots", [], "muse-spark-1.3"],
    ["standard only", ["muse-spark-1.3", "muse-spark-1.2"], "muse-spark-1.3"],
  ] as const)("checks Muse in the bots' mode: %s", async (_name, botModels, expected) => {
    expect(museCheckModel(botModels)).toBe(expected);
    const scratch = mkdtempSync(join(tmpdir(), "omb-muse-check-mode-"));
    const dump = join(scratch, "dump.json");
    try {
      const check = createMuseCheck({
        muse: (_cli, env, read) => readMuseUsage(FAKE_MSP_CLI, { ...env, FAKE_MSP_USAGE: JSON.stringify(fixtures.museAgent), FAKE_MSP_DUMP: dump }, { ...read, platform: "linux", check: true }),
      });
      const result = await check({ instanceId: "muse", museModel: museCheckModel(botModels) });
      expect(result.status).toBe("fresh");
      const [start] = JSON.parse(readFileSync(`${dump}.config.json`, "utf8"));
      expect(start).toMatchObject({ method: "session/start", modelId: expected });
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("maps an auth-failed Muse check turn to sign-in", async () => {
    await expect(readMuseUsage(FAKE_MSP_CLI, { FAKE_MSP_MODE: "auth-failure" }, { platform: "linux", check: true })).rejects.toThrow("signin");
  });

  it("keeps the old reading when a failed Muse check turn reports nothing", async () => {
    const check = createMuseCheck({
      muse: (_cli, env) => readMuseUsage(FAKE_MSP_CLI, { ...env, FAKE_MSP_MODE: "fail-after-text" }, { platform: "linux", check: true }),
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await check({ instanceId: "muse" }, report);
    expect(result.report).toEqual(report);
    expect(result.status).toBe("no_observation");
  });

  it("says when Muse's limit resets after a check turn hits the quota, with one turn and no WSL retry", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-muse-check-quota-"));
    const rpcDump = join(scratch, "rpc.json");
    const resolveWsl = vi.fn(async () => FAKE_MSP_CLI);
    try {
      const check = createMuseCheck({
        muse: (_cli, env) => readMuseUsage("wsl muse", { ...env, FAKE_MSP_MODE: "quota", FAKE_MSP_RPC_DUMP: rpcDump }, { platform: "win32", resolveWsl, check: true }),
      });
      const report = { windows: [{ id: "five_hour", usedPercent: 41, resetsAt: null }], observedAt: reset };
      const result = await check({ instanceId: "muse" }, report);
      expect(result).toMatchObject({ report, status: "limit_reached", resetsAt: Date.parse("2026-10-10T17:03:32Z") });
      expect(result.error).toBeUndefined();
      expect(JSON.parse(readFileSync(rpcDump, "utf8"))).toEqual(["initialize", "initialized", "session/start", "turn/start"]);
      expect(resolveWsl).toHaveBeenCalledTimes(1);
      expect(usageRefreshResponse("muse", result).resetsAt).toBe(Date.parse("2026-10-10T17:03:32Z"));
    } finally {
      await removeTempDir(scratch);
    }
  });

  it("says Muse's limit is reached without a reset time when the quota error has none", async () => {
    const check = createMuseCheck({
      muse: (_cli, env) => readMuseUsage(FAKE_MSP_CLI, { ...env, FAKE_MSP_MODE: "quota-no-reset" }, { platform: "linux", check: true }),
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 41, resetsAt: null }], observedAt: reset };
    const result = await check({ instanceId: "muse" }, report);
    expect(result).toMatchObject({ report, status: "limit_reached", resetsAt: null });
  });

  it.each(["signin", "refresh"] as const)("keeps the old reading after a Muse check %s", async (kind) => {
    const check = createMuseCheck({
      muse: async () => {
        throw new Error(kind);
      },
    });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await check({ instanceId: "muse" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe(kind === "signin" ? "Sign in again in Muse" : "Could not refresh Muse limits");
    expect(result.status).toBe(kind === "signin" ? "auth_error" : "transport_error");
  });

  it("spends at most one Muse check per instance per minute", async () => {
    let now = 1_000;
    const calls: Array<string | undefined> = [];
    const check = createMuseCheck({
      now: () => now,
      muse: async (cli) => {
        calls.push(cli);
        return fixtures.museAgent;
      },
    });
    const [first, doubleTap] = await Promise.all([check({ instanceId: "muse" }), check({ instanceId: "muse" })]);
    expect(first.status).toBe("fresh");
    expect(doubleTap).toEqual(first);
    now += 59_999;
    await check({ instanceId: "muse" }, first.report);
    expect(calls).toHaveLength(1);
    await check({ instanceId: "muse-two" });
    expect(calls).toHaveLength(2);
    now += 1;
    await check({ instanceId: "muse" }, first.report);
    expect(calls).toHaveLength(3);
  });

  it("leaves Gemini API off the refresh path without inventing numbers", async () => {
    const refresh = createUsageRefresh({ platform: "linux" });
    const report = { windows: [{ id: "five_hour", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const kept = await refresh("geminiAgent", { instanceId: "gemini" }, report);
    expect(kept.report).toEqual(report);
    expect(kept.error).toBe("Usage refresh is not supported");
    expect(kept.retryAt).toBe(0);
    const fresh = await refresh("geminiAgent", { instanceId: "gemini" });
    expect(fresh.report).toBeUndefined();
    expect(fresh.error).toBe("Usage refresh is not supported");
    expect(fresh.retryAt).toBe(0);
    expect(JSON.stringify(kept)).not.toContain("access-secret");
  });

  it.each(["signin", "refresh"] as const)("keeps the last report after Grok billing %s", async (kind) => {
    const refresh = createUsageRefresh({
      platform: "linux",
      billing: async () => {
        throw new Error(kind);
      },
    });
    const report = { windows: [{ id: "seven_day", usedPercent: 12, resetsAt: null }], observedAt: reset };
    const result = await refresh("grokAgent", { instanceId: "grok" }, report);
    expect(result.report).toEqual(report);
    expect(result.error).toBe(kind === "signin" ? "Sign in again in Grok" : "Could not refresh Grok limits");
  });

  it("rejects malformed usage and skips unsupported engines and macOS Keychain access", async () => {
    let calls = 0;
    const refresh = createUsageRefresh({
      platform: "darwin",
      claude: async () => { calls++; return []; },
      billing: async () => ({}),
      antigravity: async () => ({}),
    });
    expect((await refresh("claudeAgent", { instanceId: "claude" })).error).toContain("Keychain");
    expect((await refresh("antigravityAgent", { instanceId: "antigravity" })).error).toBe("Could not refresh Antigravity limits");
    expect((await refresh("opencodeGo", { instanceId: "opencode" })).error).toBe("Usage refresh is not supported");
    expect(calls).toBe(0);
    expect((await refresh("grokAgent", { instanceId: "grok" })).error).toBe("Could not refresh Grok limits");
  });
});

describe("antigravity /usage quota command", () => {
  const groups = {
    groups: [
      {
        buckets: [
          { bucketId: "gemini-5h", displayName: "5 hour", remaining: { remainingFraction: 0.58 }, resetTime: reset },
          { bucketId: "gemini-weekly", displayName: "Weekly", remaining: { remainingFraction: 0.81 }, resetTime: reset },
        ],
      },
    ],
  };
  const usageLine = (data: unknown) => JSON.stringify({ event: "command_result", command: { name: "usage", data } });

  it("reads quota windows from the command_result line without a running server", async () => {
    const seen: Array<{ command: string; args: string[] }> = [];
    const data = await readAntigravityUsageCommand("agy", {}, async (command, args) => {
      seen.push({ command, args });
      return `${usageLine(groups)}\n`;
    });
    expect(data).toEqual(groups);
    expect(antigravityRateLimitWindows(data).map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(seen).toEqual([{ command: "agy", args: ["-p", "/usage", "--output-format", "stream-json"] }]);
  });

  it("falls through to the final result command when the first line carries nothing", async () => {
    const stdout = [
      usageLine({ groups: [] }),
      "not json",
      JSON.stringify({ event: "result", result: { status: "SUCCESS", command: { name: "usage", data: groups } } }),
    ].join("\n");
    const data = await readAntigravityUsageCommand("agy", {}, async () => stdout);
    expect(data).toEqual(groups);
  });

  it("throws refresh on exec failure, garbage, and empty groups — never signin", async () => {
    await expect(readAntigravityUsageCommand("agy", {}, async () => null)).rejects.toThrow("refresh");
    await expect(readAntigravityUsageCommand("agy", {}, async () => "not json\n")).rejects.toThrow("refresh");
    await expect(readAntigravityUsageCommand("agy", {}, async () => `${usageLine({ groups: [] })}\n`)).rejects.toThrow("refresh");
    await expect(readAntigravityUsageCommand("agy", {}, async () => "")).rejects.toThrow("refresh");
  });

  it("ignores foreign or unnamed command payloads even when they carry quota-shaped data", async () => {
    const foreign = JSON.stringify({ event: "command_result", command: { name: "other", data: groups } });
    await expect(readAntigravityUsageCommand("agy", {}, async () => `${foreign}\n`)).rejects.toThrow("refresh");
    const unnamed = JSON.stringify({ event: "command_result", command: { data: groups } });
    await expect(readAntigravityUsageCommand("agy", {}, async () => `${unnamed}\n`)).rejects.toThrow("refresh");
    const wrongEvent = JSON.stringify({ event: "assistant", command: { name: "usage", data: groups } });
    await expect(readAntigravityUsageCommand("agy", {}, async () => `${wrongEvent}\n`)).rejects.toThrow("refresh");
  });

  it("reads a CSRF wall as unreachable, not as signed out", () => {
    expect(isCsrfRejection('{"code":"unauthenticated","message":"missing CSRF token"}')).toBe(true);
    expect(isCsrfRejection('{"code":"unauthenticated","message":"invalid CSRF token"}')).toBe(true);
    expect(isCsrfRejection("missing CSRF token")).toBe(true);
    expect(isCsrfRejection("")).toBe(false);
    expect(isCsrfRejection('{"code":"unauthenticated"}')).toBe(false);
  });

  it("refuses near-miss CSRF mentions so they keep the legacy signin meaning", () => {
    expect(isCsrfRejection('{"code":"unauthenticated","message":"CSRF token for language server expired"}')).toBe(false);
    expect(isCsrfRejection("check the CSRF token configuration and retry")).toBe(false);
    expect(isCsrfRejection('{"code":"unauthenticated","message":"missing CSRF token: quota denied"}')).toBe(false);
  });

  it("tries the usage command first and the RPC scrape only on failure", async () => {
    let rpcCalls = 0;
    const win = await readAntigravityQuota("agy", {}, {
      usage: async () => groups,
      rpc: async () => {
        rpcCalls++;
        return {};
      },
    });
    expect(win).toEqual(groups);
    expect(rpcCalls).toBe(0);

    const fallback = await readAntigravityQuota("agy", {}, {
      usage: async () => {
        throw new Error("refresh");
      },
      rpc: async () => groups,
    });
    expect(fallback).toEqual(groups);
  });

  it("propagates the fallback outcome when the usage command fails", async () => {
    await expect(readAntigravityQuota("agy", {}, {
      usage: async () => {
        throw new Error("refresh");
      },
      rpc: async () => {
        throw new Error("signin");
      },
    })).rejects.toThrow("signin");
    await expect(readAntigravityQuota("agy", {}, {
      usage: async () => {
        throw new Error("refresh");
      },
      rpc: async () => {
        throw new Error("refresh");
      },
    })).rejects.toThrow("refresh");
  });
});
