import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

import type { AccountContext } from "./account-policy.ts";
import { writeFileAtomic } from "./atomic.ts";
import { createClaudeUsageProbe, readClaudeUsage } from "./claude-usage-probe.ts";
import { createUsageRefresh, readUsageRpc } from "./usage-refresh.ts";
import { DATA_DIR } from "./config.ts";
import { join } from "node:path";
import * as procs from "./procs.ts";

vi.mock("./procs.ts", async (original) => ({ ...await original<typeof procs>(), spawnCli: vi.fn(), killCliTree: vi.fn() }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- sees any direct write of the CLI's token file.
vi.mock("./atomic.ts", async (original) => ({ ...await original<typeof import("./atomic.ts")>(), writeFileAtomic: vi.fn() }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- sees any direct read of the CLI's token file.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const stored = JSON.stringify({ claudeAiOauth: { accessToken: "fake-expired", refreshToken: "fake-refresh" } });
  return { ...fs, readFile: vi.fn((...args: Parameters<typeof fs.readFile>) => String(args[0]).endsWith(".credentials.json") ? Promise.resolve(stored) : fs.readFile(...args)) };
});
const account = { id: "acct_fixture", of: "claude", home: join(DATA_DIR, "fixture"), generation: 2 };
const legacyHome = join(DATA_DIR, "legacy-claude");
const payload = { subscription_type: "max", rate_limits_available: true, rate_limits: {
  five_hour: { utilization: 35, resets_at: "2026-11-04T00:00:00Z" }, seven_day: { utilization: 82, resets_at: null },
} };
const windows = [{ id: "five_hour", usedPercent: 35, resetsAt: Date.parse("2026-11-04T00:00:00Z"), windowMinutes: 300 },
  { id: "seven_day", usedPercent: 82, resetsAt: null, windowMinutes: 10080 }];

function childFixture(reply = true, target: AccountContext | null = account, env: NodeJS.ProcessEnv = { PATH: "fixture" }) {
  const frames: Array<{ type: string; request_id: string; request: Record<string, unknown> }> = [];
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), stdin: new Writable({
    write(chunk, _encoding, done) { frames.push(JSON.parse(String(chunk))); done(); },
  }) });
  vi.mocked(procs.spawnCli).mockReturnValue(child as unknown as ReturnType<typeof procs.spawnCli>);
  const respond = (request_id: string, data: unknown, subtype = "success") => stdout.write(`${JSON.stringify({ type: "control_response", response: { subtype, request_id, response: data } })}\n`);
  const pending = readClaudeUsage("fixture-cli", env, target ?? undefined);
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

it("keeps a weekly-only get_usage response when five_hour is null", async () => {
  const f = childFixture();
  f.respond("usage", { ...payload, rate_limits: { five_hour: null, seven_day: { utilization: 98, resets_at: null } } });
  expect(await f.pending).toEqual([{ id: "seven_day", usedPercent: 98, resetsAt: null, windowMinutes: 10080 }]);
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

it("starts the Claude and Codex usage CLIs without saved keys or Wink's token", async () => {
  void childFixture(false).pending.catch(() => undefined);
  vi.mocked(procs.spawnCli).mockClear();
  const env = { PATH: "fixture", GEMINI_API_KEY: "saved", OMB_COMMS_TOKEN: "boot", OPENAI_API_KEY: "saved" };
  const claude = readClaudeUsage("fixture-cli", env, account).catch(() => undefined);
  const codex = readUsageRpc("fixture-cli", env).catch(() => undefined);
  for (const [, , options] of vi.mocked(procs.spawnCli).mock.calls) expect(options?.env).toEqual({ PATH: "fixture" });
  expect(procs.spawnCli).toHaveBeenCalledTimes(2);
  vi.mocked(procs.spawnCli).mock.results.forEach(({ value }) => value.emit("exit"));
  await Promise.all([claude, codex]);
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
  const http = vi.spyOn(globalThis, "fetch");
  try {
    const claude = vi.fn<typeof readClaudeUsage>(async () => windows);
    const refresh = createUsageRefresh({ claude });
    const result = await refresh("claudeAgent", { instanceId: account.id, account, environment: { CLAUDE_CODE_OAUTH_TOKEN: "fake", ANTHROPIC_API_KEY: "fake" } });
    expect(result.report?.windows).toEqual(windows);
    expect(claude.mock.calls[0]).toEqual(["claude", expect.objectContaining({ CLAUDE_CONFIG_DIR: account.home }), account]);
    expect(claude.mock.calls[0]?.[1]).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFileAtomic).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  } finally {
    http.mockRestore();
  }
});

it("retains the current reading and caption when the CLI read fails", async () => {
  const previous = { windows, observedAt: new Date().toISOString() };
  const refresh = createUsageRefresh({ claude: async () => { throw new Error("old CLI"); } });
  expect(await refresh("claudeAgent", { instanceId: account.id, account }, previous)).toMatchObject({ report: previous, status: "no_observation" });
});

it("reads single-account usage through the CLI without the token file, a token refresh or HTTP", async () => {
  const http = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => String(url).includes("/oauth/token")
    ? Response.json({ access_token: "fake-minted", refresh_token: "fake-next", expires_in: 3600 })
    : new Headers(init?.headers).get("authorization") === "Bearer fake-minted" ? Response.json(payload.rate_limits) : new Response(null, { status: 401 }));
  try {
    const claude = vi.fn<typeof readClaudeUsage>(async () => windows);
    const refresh = createUsageRefresh({ claude, platform: "linux" });
    const result = await refresh("claudeAgent", { instanceId: "claude", environment: { CLAUDE_CONFIG_DIR: legacyHome } });
    expect({
      http: http.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${String(url)}`),
      reads: vi.mocked(readFile).mock.calls.map(([path]) => String(path)),
      writes: vi.mocked(writeFileAtomic).mock.calls.map(([path, content]) => `${path} ${content}`),
    }).toEqual({ http: [], reads: [], writes: [] });
    expect(result.report?.windows).toEqual(windows);
    expect(claude.mock.calls).toEqual([["claude", expect.objectContaining({ CLAUDE_CONFIG_DIR: legacyHome }), undefined]]);
  } finally {
    http.mockRestore();
  }
});

it("keeps the last single-account reading as no observation when the CLI can't report, without a token or sign-in", async () => {
  const http = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(null, { status: 401 }));
  try {
    const previous = { windows, observedAt: new Date().toISOString() };
    const refresh = createUsageRefresh({ claude: async () => { throw new Error("old CLI"); }, platform: "linux" });
    const result = await refresh("claudeAgent", { instanceId: "claude", environment: { CLAUDE_CONFIG_DIR: legacyHome } }, previous);
    expect(http).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ report: previous, status: "no_observation" });
    expect(result.error).toBeUndefined();
  } finally {
    http.mockRestore();
  }
});

it("probes one single-account login once for every instance on it", async () => {
  const claude = vi.fn<typeof readClaudeUsage>(async () => windows);
  const refresh = createUsageRefresh({ claude, platform: "linux" });
  const options = (instanceId: string, home = legacyHome) => ({ instanceId, environment: { CLAUDE_CONFIG_DIR: home } });
  const [first, second] = await Promise.all([refresh("claudeAgent", options("claude")), refresh("claudeAgent", options("claude-opus"))]);
  expect(second.report).toEqual(first.report);
  await refresh("claudeAgent", options("claude-haiku"));
  expect(claude).toHaveBeenCalledOnce();
  await refresh("claudeAgent", options("other", join(DATA_DIR, "other-claude")));
  expect(claude).toHaveBeenCalledTimes(2);
  refresh.invalidate("claude");
  await refresh("claudeAgent", options("claude"));
  expect(claude).toHaveBeenCalledTimes(3);
});

it("reads single-account usage with the launch env from a lean folder, killing only its own child", async () => {
  const f = childFixture(true, null, { PATH: "fixture", CLAUDE_CONFIG_DIR: legacyHome, CLAUDE_CODE_OAUTH_TOKEN: "fake", CLAUDECODE: "1" });
  f.respond("usage", payload);
  expect(await f.pending).toEqual(windows);
  expect(procs.spawnCli).toHaveBeenCalledWith("fixture-cli", expect.arrayContaining(["--no-session-persistence"]),
    { cwd: join(DATA_DIR, "helper"), env: { PATH: "fixture", CLAUDE_CONFIG_DIR: legacyHome }, stdio: ["pipe", "pipe", "pipe"] });
  expect(procs.killCliTree).toHaveBeenCalledExactlyOnceWith(f.child);
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
