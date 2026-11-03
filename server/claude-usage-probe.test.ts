import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

import { createClaudeUsageProbe, readClaudeUsage } from "./claude-usage-probe.ts";
import { createUsageRefresh } from "./usage-refresh.ts";
import { DATA_DIR } from "./config.ts";
import { join } from "node:path";
import * as procs from "./procs.ts";

vi.mock("./procs.ts", async (original) => ({ ...await original<typeof procs>(), spawnCli: vi.fn(), killCliTree: vi.fn() }));
const account = { id: "acct_fixture", of: "claude", home: join(DATA_DIR, "fixture"), generation: 2 };
const payload = { subscription_type: "max", rate_limits_available: true, rate_limits: {
  five_hour: { utilization: 35, resets_at: "2026-11-04T00:00:00Z" }, seven_day: { utilization: 82, resets_at: null },
} };
const windows = [{ id: "five_hour", usedPercent: 35, resetsAt: Date.parse("2026-11-04T00:00:00Z"), windowMinutes: 300 },
  { id: "seven_day", usedPercent: 82, resetsAt: null, windowMinutes: 10080 }];

function childFixture(reply = true) {
  const frames: Array<{ type: string; request_id: string; request: Record<string, unknown> }> = [];
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), stdin: new Writable({
    write(chunk, _encoding, done) { frames.push(JSON.parse(String(chunk))); done(); },
  }) });
  vi.mocked(procs.spawnCli).mockReturnValue(child as unknown as ReturnType<typeof procs.spawnCli>);
  const respond = (request_id: string, data: unknown, subtype = "success") => stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype, request_id, response: data } })}\n`);
  const pending = readClaudeUsage("fixture-cli", { PATH: "fixture" }, account);
  if (reply) respond("initialize", {});
  return { child, frames, respond, pending };
}

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

it("initializes then reads usage in the account home without sending a prompt", async () => {
  const f = childFixture();
  f.respond("usage", payload);
  expect(await f.pending).toEqual(windows);
  expect(f.frames).toEqual([
    { type: "control_request", request_id: "initialize", request: { subtype: "initialize", hooks: {} } },
    { type: "control_request", request_id: "usage", request: { subtype: "get_usage", skip_behaviors: true } },
  ]);
  expect(procs.spawnCli).toHaveBeenCalledWith("fixture-cli", expect.arrayContaining(["--input-format", "stream-json", "--no-session-persistence"]),
    { cwd: account.home, env: { PATH: "fixture" }, stdio: ["pipe", "pipe", "pipe"], account, accountDriver: "claudeAgent" });
  expect(procs.killCliTree).toHaveBeenCalledWith(f.child);
});

it.each([
  { ...payload, rate_limits_available: false },
  { ...payload, rate_limits: { ...payload.rate_limits, five_hour: { utilization: "35", resets_at: null } } },
  { ...payload, rate_limits: { ...payload.rate_limits, seven_day: { utilization: 82, resets_at: "invalid" } } },
  { ...payload, rate_limits: { five_hour: null, seven_day: null } },
  {},
])("rejects unavailable or malformed usage %j", async (value) => {
  const f = childFixture();
  f.respond("usage", value);
  await expect(f.pending).rejects.toThrow("unavailable");
  expect(procs.killCliTree).toHaveBeenCalledOnce();
});

it.each(["old CLI", "bad id", "invalid JSON", "exit", "spawn error", "EPIPE", "permission request"])("stops on %s without a prompt", async (error) => {
  const f = childFixture(false);
  if (error === "old CLI") f.respond("initialize", {}, "error");
  else if (error === "bad id") f.respond("wrong", {});
  else if (error === "invalid JSON") f.child.stdout.write("not json\n");
  else if (error === "permission request") f.child.stdout.write('{"type":"control_request"}\n');
  else if (error === "EPIPE") f.child.stdin.emit("error", new Error("EPIPE"));
  else f.child.emit(error === "exit" ? "exit" : "error", new Error(error));
  await expect(f.pending).rejects.toThrow("unavailable");
  expect(f.frames).toHaveLength(1);
  expect(procs.killCliTree).toHaveBeenCalledOnce();
});

it("kills the child when initialize or get_usage times out", async () => {
  vi.useFakeTimers();
  for (const initialized of [false, true]) {
    const f = childFixture(initialized);
    const failed = expect(f.pending).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(procs.killCliTree).toHaveBeenCalledWith(f.child);
  }
});

it("runs accounts in sequence and throttles failures and generation changes for five minutes plus jitter", async () => {
  let now = 0;
  let finish!: () => void;
  const read = vi.fn(() => new Promise<typeof windows>((resolve) => { finish = () => resolve(windows); }));
  const probe = createClaudeUsageProbe({ read, now: () => now, random: () => 0.5 });
  const first = probe("fake", {}, account);
  expect(probe("fake", {}, account)).toBe(first);
  const second = probe("fake", {}, { ...account, id: "other" });
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  finish();
  await first;
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  finish();
  await second;
  expect(await probe("fake", {}, { ...account, generation: 3 })).toBeUndefined();
  now = 314_999;
  await probe("fake", {}, account);
  expect(read).toHaveBeenCalledTimes(2);
  now = 315_000;
  read.mockRejectedValue(new Error("old CLI"));
  expect(await probe("fake", {}, account)).toBeUndefined();
  await probe("fake", {}, account);
  expect(read).toHaveBeenCalledTimes(3);
});

it("uses the CLI reading on Refresh without accessing a token file or HTTP", async () => {
  const read = vi.fn();
  const write = vi.fn();
  const request = vi.fn();
  const claude = vi.fn<typeof readClaudeUsage>(async () => windows);
  const refresh = createUsageRefresh({ read, write, request, claude });
  const result = await refresh("claudeAgent", { instanceId: account.id, account, environment: { CLAUDE_CODE_OAUTH_TOKEN: "fake", ANTHROPIC_API_KEY: "fake" } });
  expect(result.report?.windows).toEqual(windows);
  expect(claude.mock.calls[0]).toEqual(["claude", expect.objectContaining({ CLAUDE_CONFIG_DIR: account.home }), account]);
  expect(claude.mock.calls[0]?.[1]).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("retains the current reading and caption when the CLI read fails", async () => {
  const previous = { windows, observedAt: new Date().toISOString() };
  const refresh = createUsageRefresh({ claude: async () => { throw new Error("old CLI"); } });
  expect(await refresh("claudeAgent", { instanceId: account.id, account }, previous)).toMatchObject({ report: previous, status: "no_observation" });
});

it("keeps the single-account usage path on its existing API read", async () => {
  const claude = vi.fn<typeof readClaudeUsage>();
  const request = vi.fn(async () => Response.json(payload.rate_limits));
  const read = vi.fn();
  const refresh = createUsageRefresh({ claude, request, read });
  const result = await refresh("claudeAgent", { instanceId: "claude", environment: { CLAUDE_CODE_OAUTH_TOKEN: "fake" } });
  expect(result.report?.windows).toEqual(windows);
  expect(claude).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();
});

it("drops a late reading after account invalidation", async () => {
  let finish!: (value: typeof windows) => void;
  const refresh = createUsageRefresh({ claude: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = refresh("claudeAgent", { instanceId: account.id, account });
  await Promise.resolve();
  refresh.invalidate(account.id);
  finish(windows);
  expect((await pending).report).toBeUndefined();
});
