// A turn that runs while Map still loads its chat, a send steered into it, and a composer focus then, read that chat
// by key, newest first or once the load lands: a whole read stalls the server and makes the load quit. cold-turn-hook.ts
// unloads the chat at each send.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { harnessFetch as fetch, spawnHarness as spawn } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess;
let home: string;
let log: string;
let gates: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const entries = (): Array<Record<string, any>> => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const waitFor = async (predicate: () => boolean, what: string) => {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const wholeReads = (threadId: string, from = 0) => entries().slice(from).filter((entry) => entry.wholeRead === threadId);

async function turnWhileLoading(): Promise<{ id: string; threadId: string }> {
  const bot = (await api("POST", "/api/bots")).body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello there" })).status).toBe(202);
  await waitFor(() => entries().some((entry) => entry.settled === bot.threadId), "the turn to settle");
  return bot;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cold-turn-"));
  mkdirSync(join(home, ".orbit"), { recursive: true });
  log = join(home, "cold-turn.jsonl");
  gates = join(home, "gates");
  mkdirSync(gates);
  const instance = { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "narration-plain" }, config: { cli: `"${process.execPath}" "${FAKE_CLAUDE}"`, permissionMode: "bypassPermissions" } };
  const steer = { ...instance, environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_UNTIL_STEER: "1" } };
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances: { claude: instance, other: instance, steer } }));
  child = spawn(process.execPath, ["--import", pathToFileURL(join(SERVER_DIR, "testing", "cold-turn-hook.ts")).href, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...Object.fromEntries(["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP"]
        .flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      OMB_PORT: String(PORT),
      COLD_TURN_LOG: log,
      COLD_TURN_GATES: gates,
    },
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if ((await globalThis.fetch(`${BASE}/api/health`).catch(() => null))?.ok) break;
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server start: ${stderr.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}, 40_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
  });
  rmSync(home, { recursive: true, force: true });
});

it("runs a turn on a chat Map is still loading without reading it whole, and the load lands with the turn's rows", async () => {
  const bot = await turnWhileLoading();
  expect(wholeReads(bot.threadId)).toEqual([]);
  writeFileSync(join(gates, bot.threadId), "");
  await waitFor(() => entries().some((entry) => entry.landed === bot.threadId), "the load to land");
  const shown = (await api("GET", "/api/bots?messages=200")).body.bots.find((row: any) => row.id === bot.id);
  expect(shown.messages.map((row: any) => row.text).filter(Boolean)).toEqual(expect.arrayContaining(["hello there", "plain reply"]));
  expect(shown.unread).toBe(true);
}, 60_000);

it("prepares a composer focus with no resume cursor on a chat Map is still loading without reading it whole", async () => {
  const bot = await turnWhileLoading();
  const from = entries().length;
  writeFileSync(join(gates, "unload"), bot.threadId);
  await waitFor(() => entries().slice(from).some((entry) => entry.unloaded === bot.threadId), "the chat to unload");
  expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "other", model: "claude-fake" } })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/prewarm`)).body).toMatchObject({ prepared: true });
  expect(wholeReads(bot.threadId, from)).toEqual([]);
  writeFileSync(join(gates, bot.threadId), "");
  await waitFor(() => entries().slice(from).some((entry) => entry.landed === bot.threadId), "the load to land");
}, 60_000);

it("steers a send into a turn on a chat Map is still loading without reading it whole, and its quick ack lands", async () => {
  const bot = (await api("POST", "/api/bots")).body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "steer", model: "claude-fake" } });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "hello there" })).status).toBe(202);
  await waitFor(() => entries().some((entry) => entry.started === bot.threadId), "the turn to start");
  const from = entries().length;
  const steer = api("POST", `/api/bots/${bot.id}/messages`, { text: "Please add a test for the parser." });
  writeFileSync(join(gates, bot.threadId), "");
  const sent = (await steer).body;
  expect(sent).toMatchObject({ steered: true });
  await waitFor(() => entries().slice(from).some((entry) => entry.landed === bot.threadId), "the load to land");
  await waitFor(() => entries().slice(from).some((entry) => entry.settled === bot.threadId), "the turn to settle");
  expect(wholeReads(bot.threadId, from)).toEqual([]);
  const shown = (await api("GET", "/api/bots?messages=200")).body.bots.find((row: any) => row.id === bot.id);
  expect(shown.messages.some((row: any) => row.quick?.askId === sent.message.id)).toBe(true);
}, 60_000);
