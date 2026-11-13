import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { closeMessageDb } from "../message-db.ts";
import { Store } from "../store.ts";
import { harnessFetch, spawnHarness } from "../testing/harness-auth.ts";
import { closeRoomsDb, createRoom } from "./db.ts";
import { closeInvitesDb, createInvite } from "./invites.ts";

const root = join(import.meta.dirname, "..", "..");
const port = 28800 + Math.floor(Math.random() * 10_000);
const doorPort = port + 1;
const base = `http://127.0.0.1:${port}`;
const door = `http://127.0.0.1:${doorPort}`;
const hostHome = join(homedir(), "host");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const cases: Array<{ driver: string; name: string; roomId: string; code: string; dump: string }> = [];
let child: ChildProcess;
let stderr = "";

async function until(test: () => Promise<boolean>, what: string) {
  const end = Date.now() + 40_000;
  while (!(await test())) {
    if (child?.exitCode !== null || Date.now() > end) throw new Error(`${what}: ${stderr.slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function remote<T = unknown>(path: string, body: unknown, key?: string): Promise<T> {
  const res = await fetch(`${door}/room/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wink-device": "pc-jj-0123456789abcdef", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  const value = await res.json();
  expect(res.status, JSON.stringify(value)).toBe(200);
  return value as T;
}

beforeAll(async () => {
  mkdirSync(hostHome, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  const store = new Store(() => ({ instanceId: "claude", model: "claude-fake" }));
  const instances: Record<string, unknown> = {};
  for (const [driver, name, model, cli, dumpKey] of [
    ["claudeAgent", "Rando", "claude-fake", "fake-claude-cli.ts", "FAKE_CLAUDE_DUMP"],
    ["codex", "Scout", "gpt-6.1-sol", "fake-codex-app-server.ts", "FAKE_CODEX_DUMP"],
  ]) {
    const dump = join(DATA_DIR, `${driver}-input.json`);
    instances[driver!] = {
      driver,
      environment: { [dumpKey!]: dump },
      config: { cli: `"${process.execPath}" "${join(root, "server", "testing", cli!)}"` },
    };
    const bot = store.createBot({ name, modelSelection: { instanceId: driver!, model: model! } }, { seedMessages: false });
    store.patchBot(bot.id, { notifications: false, composio: false, shareTerminalWithChat: false });
    const room = createRoom(`Images ${name}`);
    const { invite, secret } = createInvite(room.id, "JJ", "chat", [name!]);
    cases.push({ driver: driver!, name: name!, roomId: room.id, code: `wkr1:abcdefghijklmnop.wink.test:${invite.id}.${secret}`, dump });
  }
  for (const item of cases) store.createGroup(`Images ${item.name}`, store.bots.map((bot) => bot.id), false, undefined, { completed: true }, { roomId: item.roomId });
  store.flushSaves();
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ instances }));
  expect(store.bots.every((bot) => bot.notifications === false)).toBe(true);
  closeInvitesDb();
  closeRoomsDb();
  closeMessageDb();
  const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(join(root, "server", path)).href);
  const boot = `
    await import(${moduleUrl("index.ts")});
    const { createServer } = await import("node:http");
    const { handleRoomDoor } = await import(${moduleUrl("rooms/door.ts")});
    const door = createServer((req, res) => void handleRoomDoor(req, res, { host: "abcdefghijklmnop.wink.test", peer: "203.0.113.7" }));
    door.listen(${doorPort}, "127.0.0.1");
    process.on("message", (message) => {
      if (message === "done") {
        door.closeAllConnections();
        door.close();
        process.emit("SIGTERM");
      }
    });
  `;
  child = spawnHarness(process.execPath, ["--input-type=module", "-e", boot], {
    cwd: root,
    env: {
      ...Object.fromEntries(["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])),
      HOME: hostHome, USERPROFILE: hostHome, OMB_DATA_DIR: DATA_DIR, OMB_PORT: String(port),
      APPDATA: join(hostHome, "AppData", "Roaming"), LOCALAPPDATA: join(hostHome, "AppData", "Local"),
    },
  });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  await until(async () => (await harnessFetch(`${base}/api/health`).catch(() => null))?.ok === true &&
    (await fetch(`${door}/room/v1/missing`).catch(() => null))?.status === 404, "server start");
}, 60_000);

afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.send("done");
  await ended;
}, 30_000);

it.each(["claudeAgent", "codex"])("delivers a remote room image to the %s turn", async (driver) => {
  const item = cases.find((test) => test.driver === driver)!;
  const joined = await remote<{ key: string }>("join", { code: item.code, name: "JJ", device: "pc-jj-0123456789abcdef" });
  const uploaded = await fetch(`${door}/room/v1/rooms/${item.roomId}/files?uploadId=room-image-upload-0001&name=image.png`, {
    method: "POST",
    headers: { authorization: `Bearer ${joined.key}`, "x-wink-device": "pc-jj-0123456789abcdef", "content-type": "image/png" },
    body: png,
  });
  const { file } = await uploaded.json() as { file: { id: string } };
  expect(uploaded.status).toBe(200);
  await remote(`rooms/${item.roomId}/send`, { text: "my bot is in the room", fileIds: [file.id] }, joined.key);
  await remote(`rooms/${item.roomId}/send`, { text: `@${item.name} what is in the picture?` }, joined.key);
  let input: any;
  await until(async () => {
    if (!existsSync(item.dump)) return false;
    input = JSON.parse(readFileSync(item.dump, "utf8"));
    return driver === "claudeAgent" ? Boolean(input.prompt?.message) : input.calls?.some((call: { method: string }) => call.method === "turn/start");
  }, "captured turn input");
  await until(async () => {
    const state = await (await harnessFetch(`${base}/api/bots`)).json() as { bots: Array<{ busy?: boolean }> };
    return state.bots.every((bot) => !bot.busy);
  }, "settled turns");
  if (driver === "claudeAgent") {
    expect(input.prompt.message.content).toEqual(expect.arrayContaining([
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
    ]));
  } else {
    const turn = input.calls.find((call: { method: string }) => call.method === "turn/start");
    const text = turn.params.input[0].text as string;
    const path = /<attached-image path="([^"]+)"\s*\/>/.exec(text)?.[1];
    expect(path).toBeDefined();
    expect(readFileSync(path!)).toEqual(png);
  }
}, 60_000);
