// Owner-typed turns and automatic wakes in one 1:1 chat share the engine process: a per-turn MCP env respawns it.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch, harnessToken } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = "http://127.0.0.1:" + PORT;
let child: ChildProcess;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(BASE + path, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const rows = (log: string): { pid: number; argv: string[]; text: string }[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((row) => JSON.parse(row)) : [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const busy = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === id)?.busy;
const agentsEnv = (dump: string) => JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents.env as Record<string, string>;

beforeAll(async () => {
  home = createFixtureHome("omb-turn-warm-");
  const staticDir = join(home, "static");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>probe</title>");
  const instance = (name: string, environment: Record<string, string>) => ({ driver: "claudeAgent", displayName: name, environment, config: { cli: FAKE } });
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances: {
    happy: instance("Happy", { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PROMPT_LOG: join(home, "happy.ndjson"), FAKE_CLAUDE_DUMP: join(home, "happy-dump.json") }),
    task: instance("Task", { FAKE_CLAUDE_MODE: "background-task", FAKE_CLAUDE_TASK_GATE: join(home, "task-gate"), FAKE_CLAUDE_PROMPT_LOG: join(home, "task.ndjson") }),
  } }));
  child = spawn(process.execPath, ["--require", join(SERVER_DIR, "testing", "roomy-host.cjs"), join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_PORT: String(PORT),
      OMB_BOX_API: "http://127.0.0.1:1", OMB_COMPOSIO_API: "http://127.0.0.1:1/api/v3.1",
      OMB_STATIC_DIR: staticDir, ORBIT_REMOTE_AUTO: "0",
    },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stderr!.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 25_000;
  for (;;) {
    try { if ((await fetch(BASE + "/api/health")).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server never came up. stderr:\n" + stderr);
    if (child.exitCode !== null) throw new Error("server exited " + child.exitCode + ". stderr:\n" + stderr);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 40_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  removeTestData(home);
});

const newBot = async (instanceId: string) => (await api("POST", "/api/bots", { name: instanceId, modelSelection: { instanceId, model: "claude-sonnet-5" } })).body.bot as { id: string; threadId: string };
const say = async (bot: { id: string }, log: string, text: string) => {
  const before = rows(log).length;
  expect((await api("POST", "/api/bots/" + bot.id + "/messages", { text })).status).toBe(202);
  await expect.poll(() => rows(log).length, { timeout: 15_000 }).toBeGreaterThan(before);
  await expect.poll(() => busy(bot.id), { timeout: 15_000 }).toBe(false);
};
const requestCard = async (bot: { id: string; threadId: string }, host: string) => {
  const res = await fetch(BASE + "/api/internal/request-credential", {
    method: "POST", headers: { authorization: "Bearer " + (await harnessToken(BASE)), "content-type": "application/json" },
    body: JSON.stringify({ fromBotId: bot.id, fromThreadId: bot.threadId, credentialId: "custom", service: { name: "Probe Key", host } }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { messageId: string }).messageId;
};
// The card's own acknowledgement: the wake path that exists before and after #2065.
const provide = async (bot: { id: string; threadId: string }, messageId: string) =>
  expect((await api("POST", "/api/bots/" + bot.id + "/secret-cards/" + messageId + "/provided", { threadId: bot.threadId })).status).toBe(200);
const saveKey = async (host: string) =>
  expect((await api("PUT", "/api/config?secretStorage=external", { customKeys: { [host]: { name: "Probe Key", header: "authorization", prefix: "Bearer ", key: "test-only-probe-key" } } })).status).toBe(200);
const shape = (argv: string[]) => JSON.stringify(argv.filter((arg, i) => !["--mcp-config", "--append-system-prompt", "--resume", "--session-id"].some((flag) => flag === arg || flag === argv[i - 1])));
const wake = (log: string) => rows(log).find((row) => row.text.includes("Wink credential update"));

describe("owner chat engine reuse across typed turns and wakes", () => {
  it("keeps one engine process when a key-save wake lands between typed turns", async () => {
    const log = join(home, "happy.ndjson");
    const dump = join(home, "happy-dump.json");
    const bot = await newBot("happy");
    try {
      await say(bot, log, "one");
      await say(bot, log, "two");
      const card = await requestCard(bot, "api.probe-one.example");
      // turns three to six leave the card four exchanges behind and get past the one-time OMB_IMPORT_MEMORY change
      for (const text of ["three", "four", "five", "six"]) await say(bot, log, text);
      const typedEnv = agentsEnv(dump);
      const typedArgs = shape(JSON.parse(readFileSync(dump, "utf8")).argv);
      await saveKey("api.probe-one.example");
      await provide(bot, card);
      await expect.poll(() => Boolean(wake(log)), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => busy(bot.id), { timeout: 15_000 }).toBe(false);
      const wakeEnv = agentsEnv(dump);
      const wakeArgs = shape(JSON.parse(readFileSync(dump, "utf8")).argv);
      await say(bot, log, "seven");
      await say(bot, log, "eight");
      const seen = rows(log).map((row) => ({ pid: row.pid, resume: row.argv.includes("--resume"), text: row.text.slice(0, 40).replace(/\s+/g, " ") }));
      const differs = [...new Set([...Object.keys(typedEnv), ...Object.keys(wakeEnv)])].filter((key) => typedEnv[key] !== wakeEnv[key]);
      expect(differs, "a wake runs with the same engine env as a typed turn").toEqual([]);
      expect(wakeArgs, "a wake runs with the same engine args as a typed turn").toBe(typedArgs);
      expect(seen[1]!.pid, "control: typed then typed reuses the process").toBe(seen[0]!.pid);
      const settled = seen.slice(seen.findIndex((row) => row.text === "five"));
      expect(settled.map((row) => row.text.slice(0, 5)), "five, six, wake, seven, eight").toHaveLength(5);
      expect(new Set(settled.map((row) => row.pid)).size, "typed, wake, typed should stay on one process").toBe(1);
    } finally {
      await api("PUT", "/api/config?secretStorage=external", { customKeys: { "api.probe-one.example": null } });
      await api("DELETE", "/api/bots/" + bot.id);
    }
  }, 90_000);

  it("keeps a live background task when a key-save wake follows a typed turn", async () => {
    const log = join(home, "task.ndjson");
    const bot = await newBot("task");
    try {
      // six typed turns first, so the one-time OMB_IMPORT_MEMORY change is behind us; each fake process starts its own background task
      for (const text of ["start the task", "two", "three", "four", "five", "six"]) await say(bot, log, text);
      const first = rows(log).at(-1)!.pid;
      expect(rows(log).at(-2)!.pid, "control: typed then typed keeps the background task process").toBe(first);
      expect(alive(first), "background task process is up before the wake").toBe(true);
      const card = await requestCard(bot, "api.probe-two.example");
      await saveKey("api.probe-two.example");
      await provide(bot, card);
      await expect.poll(() => Boolean(wake(log)), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => busy(bot.id), { timeout: 15_000 }).toBe(false);
      const woke = wake(log)!.pid;
      expect(woke, "the wake should land in the process that holds the background task").toBe(first);
      expect(alive(first), "the background task process should outlive the wake").toBe(true);
    } finally {
      writeFileSync(join(home, "task-gate"), "open");
      await api("PUT", "/api/config?secretStorage=external", { customKeys: { "api.probe-two.example": null } });
      await api("DELETE", "/api/bots/" + bot.id);
    }
  }, 90_000);
});
