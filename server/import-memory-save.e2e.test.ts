// import_memory saves only from the calling turn: the owner's typed turn its rule opened, read against Settings now.
// The warm pin keeps the tool listed and nothing more.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

import { waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const HOOK = join(SERVER_DIR, "testing", "spawn-log-hook.ts");
const CLOSED = "Import Memory saves from a new chat's first few messages only. Tell the user Settings > Import Memory still works.";
const paste = (fact: string) => `- The user prefers ${fact}.\nSource: ChatGPT`;

type Agents = Record<string, string>;
type Body = Record<string, string | number | boolean | Record<string, string | number>>;
let child: ChildProcess | undefined;
let home: string | undefined;

afterEach(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  child = undefined;
  if (home) removeTestData(home);
  home = undefined;
});

async function boot() {
  home = createFixtureHome("omb-import-save-");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  const log = join(home, "spawns.ndjson");
  const prompts = join(home, "prompts.ndjson");
  const holds = join(home, "holds");
  mkdirSync(holds);
  const environment = { FAKE_CLAUDE_PROMPT_LOG: prompts, FAKE_CLAUDE_HOLD_DIR: holds };
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", environment, config: { cli: CLI, fullAuto: true } } } }));
  const port = 30800 + Math.floor(Math.random() * 10_000);
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(port), SPAWN_LOG: log };
  if (process.env.PATH) env.PATH = process.env.PATH;
  // Without SystemRoot, winsock fails to initialize in the child.
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const server = spawn(process.execPath, ["--import", pathToFileURL(HOOK).href, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child = server;
  let stderr = "";
  server.stderr!.on("data", (chunk) => (stderr += chunk));
  const until = async <T>(read: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() > deadline || server.exitCode !== null) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  await until(async () => { try { return (await fetch(`${base}/api/health`)).ok || undefined; } catch { return undefined; } }, "the server");
  const api = async (method: string, path: string, body?: Body, agents?: Agents): Promise<{ status: number; body: any }> => {
    const headers = new Headers({ "content-type": "application/json" });
    if (agents) headers.set("authorization", `Bearer ${agents.OMB_COMMS_TOKEN}`);
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const rows = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const launches = (botId: string): Agents[] => rows(log).filter((row) => row.event === "spawn" && row.agents?.OMB_BOT_ID === botId).map((row) => row.agents);
  const bot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((entry: any) => entry.id === id);
  const replies = async (id: string, count: number) => until(async () => {
    const row = await bot(id);
    return row && !row.busy && row.messages.filter((m: any) => m.role === "bot" && m.kind === "text").length >= count ? row : undefined;
  }, `reply ${count}`);
  const create = async () => {
    const id = String((await api("POST", "/api/bots")).body.bot.id);
    expect((await api("PATCH", `/api/bots/${id}`, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).status).toBe(200);
    return id;
  };
  const post = async (id: string, text: string) => expect((await api("POST", `/api/bots/${id}/messages`, { text })).status).toBe(202);
  const send = async (id: string, text: string, count: number) => { await post(id, text); return replies(id, count); };
  // the turn is live once its engine has the prompt
  const hold = async (id: string, text: string, name: string) => {
    await post(id, `${text}\nhold:${name}`);
    await until(() => rows(prompts).some((row) => row.text.includes(`hold:${name}`)) || undefined, "the held turn");
    return () => writeFileSync(join(holds, name), "");
  };
  const save = (agents: Agents, body: Body = {}) => api("POST", "/api/internal/import-memory", body, agents);
  const memory = async () => JSON.stringify((await api("GET", "/api/about-you")).body);
  return { api, create, send, hold, replies, launches, save, memory };
}

it.each(["saved", "declined"])("a live owner turn saves nothing once Settings has %s", async (state) => {
  const w = await boot();
  const id = await w.create();
  await w.send(id, "hello", 1);
  const release = await w.hold(id, paste("wooden picture frames"), "m2");
  try {
    const change = state === "saved" ? await w.api("POST", "/api/about-you", { text: paste("recycled paper") }) : await w.api("POST", "/api/about-you/decline", {});
    expect(change.status).toBe(200);
    expect((await w.save(w.launches(id).at(-1)!)).body.text).toBe(CLOSED);
    expect(await w.memory()).not.toContain("wooden picture frames");
  } finally {
    release();
    await w.replies(id, 2);
  }
}, 40_000);

it("a routine on the owner's chat saves nothing from the typed message before it", async () => {
  const w = await boot();
  const id = await w.create();
  await w.send(id, paste("rail travel"), 1);
  const routine = await w.api("POST", "/api/routines", { name: "Check in", prompt: "Say hello", botId: id, runOn: "maus", enabled: false, schedule: { type: "once", at: Date.now() + 900_000 } });
  expect(routine.status).toBe(201);
  expect((await w.api("POST", `/api/routines/${routine.body.routine.id}/run`, {})).status).toBe(201);
  await w.replies(id, 2);
  const turn = w.launches(id).at(-1)!;
  expect(turn.OMB_IMPORT_MEMORY).toBeUndefined();
  expect((await w.save(turn)).body.text).toBe(CLOSED);
  expect(await w.memory()).not.toContain("rail travel");
}, 40_000);

it("an early save still lands after 32 other new chats open the tool", async () => {
  const w = await boot();
  const id = await w.create();
  const release = await w.hold(id, paste("ceramic tiles"), "m1");
  try {
    const holder = w.launches(id).at(-1)!;
    expect(holder.OMB_IMPORT_MEMORY).toBe("1");
    for (let i = 0; i < 32; i++) {
      const other = await w.create();
      await w.send(other, `chat ${i} first message`, 1);
      expect(w.launches(other).at(-1)!.OMB_IMPORT_MEMORY).toBe("1");
    }
    expect((await w.save(holder)).body.text).toContain("Import Memory says: Added");
    expect(await w.memory()).toContain("ceramic tiles");
  } finally {
    release();
    await w.replies(id, 1);
  }
}, 180_000);

it("a session recycled for new system text drops the tool once, so message 5 resumes it warm", async () => {
  const w = await boot();
  const id = await w.create();
  for (let i = 1; i <= 3; i++) await w.send(id, `message ${i}`, i);
  expect(w.launches(id).at(-1)!.OMB_IMPORT_MEMORY).toBe("1");
  // too big to ride as a system update, so message 4 starts a new session
  const text = Array.from({ length: 50 }, (_, i) => `- The user collects item ${i}: ${"in illustrated pottery catalogs ".repeat(10)}.`).join("\n") + "\nSource: ChatGPT";
  expect((await w.api("POST", "/api/about-you", { text })).status).toBe(200);
  const before = w.launches(id).length;
  await w.send(id, "message 4", 4);
  const fourth = w.launches(id);
  expect(fourth.length).toBe(before + 1);
  expect(fourth.at(-1)!.OMB_IMPORT_MEMORY).toBeUndefined();
  await w.send(id, "message 5", 5);
  expect(w.launches(id).length, "message 5 launches nothing message 4 did not").toBe(fourth.length);
}, 60_000);
