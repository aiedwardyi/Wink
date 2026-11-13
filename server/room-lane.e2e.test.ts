// A bot busy in its 1:1 answers a room @ on a second lane. Each held turn
// names hold:<name> and answers once the test writes that file.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 21800 + Math.floor(Math.random() * 6_000);
const BASE = `http://127.0.0.1:${PORT}`;
const READ_ONLY = "leave memory edits, and files your 1:1 is editing, to your 1:1";

let child: ChildProcess;
let home: string;
let holds: string;
let prompts: string;
let dump: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const state = async () => (await api("GET", "/api/bots")).body;
const botOf = async (id: string) => (await state()).bots.find((bot: any) => bot.id === id);
const groupOf = async (id: string) => (await state()).groups.find((group: any) => group.id === id);
const replies = (messages: any[]) => messages.filter((message) => message.role === "bot" && message.kind === "text").length;
const open = (name: string) => writeFileSync(join(holds, name), "");
const sent = (marker: string): Array<{ pid: number; systemPrompt: string; text: string }> => existsSync(prompts)
  ? readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.text.includes(marker))
  : [];
const poll = (fn: () => unknown, timeout = 15_000) => expect.poll(fn, { timeout, interval: 100 });

const newBot = async (instanceId: string, name: string) => {
  const bot = (await api("POST", "/api/bots")).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model: "claude-fake" } })).status).toBe(200);
  return bot as { id: string; threadId: string };
};
const newRoom = async (name: string, memberIds: string[], hosted = false) => {
  const created = await api("POST", "/api/groups", {
    name,
    memberIds,
    ...(hosted ? { hosted } : { setup: { bulletin: "", defaultResponder: { kind: "member", botId: memberIds[0] } } }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.group as { id: string; threadId: string };
};
const say = async (botId: string, text: string) => expect((await api("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
const post = async (groupId: string, text: string) => expect((await api("POST", `/api/groups/${groupId}/messages`, { text })).status).toBe(202);
// a 1:1 turn the engine has accepted and holds open
const holdOneOnOne = async (bot: { id: string }, name: string) => {
  await say(bot.id, `hold:${name} keep working`);
  await poll(() => sent(`hold:${name}`).length).toBe(1);
};
const settled = async (botId: string, groupId?: string) => {
  await poll(async () => (await botOf(botId)).busy).toBe(false);
  if (groupId) await poll(async () => (await groupOf(groupId)).working).toBe(false);
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-room-lane-"));
  holds = join(home, "holds");
  prompts = join(home, "prompts.ndjson");
  dump = join(home, "dump.json");
  mkdirSync(holds, { recursive: true });
  mkdirSync(join(home, ".orbit"), { recursive: true });
  const fixture = (name: string, text: string) => {
    const path = join(home, `${name}.json`);
    writeFileSync(path, JSON.stringify([
      { type: "assistant", message: { id: `msg-${name}`, content: [{ type: "text", text }] } },
      { type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: 0 },
    ]));
    return path;
  };
  const instance = (environment: Record<string, string>) => ({
    driver: "claudeAgent",
    environment: { FAKE_CLAUDE_HOLD_DIR: holds, FAKE_CLAUDE_PROMPT_LOG: prompts, ...environment },
    config: { cli: `"${process.execPath}" "${FAKE_CLAUDE}"`, permissionMode: "bypassPermissions" },
  });
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({
    instances: {
      claude: instance({ FAKE_CLAUDE_DUMP: dump }),
      toBee: instance({ FAKE_CLAUDE_REPLY_FIXTURE: fixture("to-bee", "@Bee over to you") }),
      toAce: instance({ FAKE_CLAUDE_REPLY_FIXTURE: fixture("to-ace", "@Ace back to you") }),
    },
  }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...Object.fromEntries(["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP"].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      OMB_PORT: String(PORT),
      // a terminal bridge, so a room turn has hands the lane must leave behind
      OMB_TERMINAL_URL: "http://127.0.0.1:9",
      OMB_TERMINAL_TOKEN: "room-lane-test",
    },
  });
  child.stderr!.on("data", (c) => (stderr += c));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    if ((await fetch(`${BASE}/api/health`).catch(() => null))?.ok) break;
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 40_000);

afterAll(async () => {
  for (const name of ["one1", "room1", "one2", "room2", "one3", "room3", "one4", "room4", "one5", "one6", "x6", "y6", "a7", "b7"]) open(name);
  child?.kill();
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(resolve, 5_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
});

describe("room lane", () => {
  it("answers a room while the 1:1 runs, and either can settle first", async () => {
    const bot = await newBot("claude", "Ann");
    const room = await newRoom("Lane room", [bot.id]);

    await holdOneOnOne(bot, "one1");
    await post(room.id, "@Ann hold:room1 check the room");
    await poll(() => sent("hold:room1").length).toBe(1);
    const busy = await botOf(bot.id);
    expect(busy.busy).toBe(true);
    expect(busy.activity).toBe("working");
    expect((await groupOf(room.id)).busyBotId).toBe(bot.id);

    open("room1");
    await poll(async () => replies((await groupOf(room.id)).messages)).toBe(1);
    await poll(async () => (await groupOf(room.id)).working).toBe(false);
    const after = await botOf(bot.id);
    expect(after.busy).toBe(true);
    expect(after.activity).toBe("working");
    open("one1");
    await poll(async () => replies((await botOf(bot.id)).messages)).toBe(1);
    await settled(bot.id);

    await holdOneOnOne(bot, "one2");
    await post(room.id, "@Ann hold:room2 again");
    await poll(() => sent("hold:room2").length).toBe(1);
    open("one2");
    await poll(async () => replies((await botOf(bot.id)).messages)).toBe(2);
    await settled(bot.id);
    expect((await groupOf(room.id)).busyBotId).toBe(bot.id);
    open("room2");
    await poll(async () => replies((await groupOf(room.id)).messages)).toBe(2);
    await settled(bot.id, room.id);
  }, 90_000);

  it("stops the lane and the 1:1 apart", async () => {
    const bot = await newBot("claude", "Cy");
    const room = await newRoom("Stop room", [bot.id]);

    await holdOneOnOne(bot, "one3");
    await post(room.id, "@Cy hold:room3 work");
    await poll(() => sent("hold:room3").length).toBe(1);
    expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);
    await poll(async () => (await groupOf(room.id)).working).toBe(false);
    const stopped = await botOf(bot.id);
    expect(stopped.busy).toBe(true);
    expect(stopped.activity).toBe("working");
    open("one3");
    await poll(async () => replies((await botOf(bot.id)).messages)).toBe(1);
    await settled(bot.id);

    await holdOneOnOne(bot, "one4");
    await post(room.id, "@Cy hold:room4 work");
    await poll(() => sent("hold:room4").length).toBe(1);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`, {})).status).toBe(200);
    await poll(async () => (await botOf(bot.id)).busy).toBe(false);
    expect((await groupOf(room.id)).busyBotId).toBe(bot.id);
    open("room4");
    await poll(async () => replies((await groupOf(room.id)).messages)).toBe(1);
    await settled(bot.id, room.id);
  }, 90_000);

  it("leaves the 1:1's session, task record and memory to the 1:1", async () => {
    const bot = await newBot("claude", "Dee");
    // same name and roster, so the two rooms' prompts match; each is a fresh engine process
    const idleRoom = await newRoom("Memory room", [bot.id]);
    const laneRoom = await newRoom("Memory room", [bot.id]);
    const memory = join(home, ".orbit", "workspaces", bot.id, "MEMORY.md");
    mkdirSync(dirname(memory), { recursive: true });
    writeFileSync(memory, "- Dee prefers short answers\n");
    const servers = (marker: string) => {
      const written = JSON.parse(readFileSync(dump, "utf8"));
      expect(written.pid).toBe(sent(marker)[0]!.pid);
      return written.mcpConfig.mcpServers;
    };
    rmSync(dump, { force: true });
    await post(idleRoom.id, "@Dee idle-turn-five hello");
    await poll(async () => replies((await groupOf(idleRoom.id)).messages)).toBe(1);
    await settled(bot.id, idleRoom.id);
    expect(servers("idle-turn-five").terminal).toBeDefined();
    await say(bot.id, "first");
    await poll(async () => replies((await botOf(bot.id)).messages)).toBe(1);
    await settled(bot.id);

    const cursors = () => JSON.parse(readFileSync(join(home, ".orbit", "bots.json"), "utf8"))
      .find((row: any) => row.id === bot.id).tasks.find((task: any) => task.threadId === bot.threadId).resumeCursors;
    const taskState = async () => (await botOf(bot.id)).tasks.find((task: any) => task.threadId === bot.threadId).taskState;
    await poll(() => Object.keys(cursors() ?? {}).length).toBeGreaterThan(0);
    await holdOneOnOne(bot, "one5");
    const before = { cursors: cursors(), taskState: await taskState() };
    rmSync(dump, { force: true });
    await post(laneRoom.id, "@Dee lane-turn-five hello again");
    await poll(async () => replies((await groupOf(laneRoom.id)).messages)).toBe(1);
    await poll(async () => (await groupOf(laneRoom.id)).working).toBe(false);
    expect((await botOf(bot.id)).busy).toBe(true);
    expect(cursors()).toEqual(before.cursors);
    expect(await taskState()).toEqual(before.taskState);
    expect(readFileSync(memory, "utf8")).toBe("- Dee prefers short answers\n");
    const lane = servers("lane-turn-five");
    expect(lane.terminal).toBeUndefined();
    expect(lane.phone).toBeUndefined();
    expect(lane.agents).toBeDefined();

    const idleSystem = sent("idle-turn-five")[0]!.systemPrompt;
    const laneSystem = sent("lane-turn-five")[0]!.systemPrompt;
    expect(laneSystem).toContain(READ_ONLY);
    expect(laneSystem).toContain("- Dee prefers short answers");
    expect(idleSystem).not.toContain(READ_ONLY);
    const memoryAt = (system: string) => system.indexOf("Your private long-term memory file is");
    expect(laneSystem.slice(0, memoryAt(laneSystem))).toBe(idleSystem.slice(0, memoryAt(idleSystem)));
    open("one5");
    await settled(bot.id);
  }, 90_000);

  it("dispatches a busy bot's room once, and drains a second room when the lane frees", async () => {
    const bot = await newBot("claude", "Eve");
    const rooms = { x6: await newRoom("First room", [bot.id], true), y6: await newRoom("Second room", [bot.id], true) };

    await holdOneOnOne(bot, "one6");
    await Promise.all([post(rooms.x6.id, "@Eve hold:x6 first"), post(rooms.y6.id, "@Eve hold:y6 second")]);
    await poll(() => sent("hold:x6").length + sent("hold:y6").length).toBe(1);
    const [ran, waits] = sent("hold:x6").length ? (["x6", "y6"] as const) : (["y6", "x6"] as const);
    expect((await groupOf(rooms[ran].id)).waitingBotIds).toEqual([]);
    await poll(async () => (await groupOf(rooms[waits].id)).waitingBotIds).toEqual([bot.id]);

    open(ran);
    await poll(async () => replies((await groupOf(rooms[ran].id)).messages)).toBe(1);
    await poll(() => sent(`hold:${waits}`).length).toBe(1);
    expect((await botOf(bot.id)).busy).toBe(true);
    expect((await groupOf(rooms[waits].id)).waitingBotIds).toEqual([]);
    open(waits);
    await poll(async () => replies((await groupOf(rooms[waits].id)).messages)).toBe(1);
    await poll(async () => (await groupOf(rooms[waits].id)).working).toBe(false);
    open("one6");
    await settled(bot.id);
    expect(sent("hold:x6")).toHaveLength(1);
    expect(sent("hold:y6")).toHaveLength(1);
    expect(replies((await groupOf(rooms.x6.id)).messages)).toBe(1);
    expect(replies((await groupOf(rooms.y6.id)).messages)).toBe(1);
  }, 90_000);

  it("still stops a bot-to-bot chain after one hop when both 1:1s are busy", async () => {
    const ace = await newBot("toBee", "Ace");
    const bee = await newBot("toAce", "Bee");
    const room = await newRoom("Chain room", [ace.id, bee.id]);
    await holdOneOnOne(ace, "a7");
    await holdOneOnOne(bee, "b7");

    await post(room.id, "@Ace start the chain");
    await poll(async () => replies((await groupOf(room.id)).messages)).toBe(2);
    await poll(async () => (await groupOf(room.id)).working).toBe(false);
    open("a7");
    open("b7");
    await settled(ace.id);
    await settled(bee.id, room.id);
    const lines = (await groupOf(room.id)).messages.filter((message: any) => message.role === "bot" && message.kind === "text");
    expect(lines.map((message: any) => message.text)).toEqual(["@Bee over to you", "@Ace back to you"]);
  }, 90_000);
});
