import { spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { spawnHarness as spawn, harnessFetch as fetch } from "../testing/harness-auth.ts";

const ROOMS_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(ROOMS_DIR, "..");
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;
let home: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const newBot = async (instanceId: string, name: string) => {
  const bot = (await api("POST", "/api/bots")).body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model: "claude-fake" } });
  return bot.id as string;
};
const roomEntries = (roomId: string) => {
  const db = JSON.stringify(pathToFileURL(join(ROOMS_DIR, "db.ts")).href);
  const read = spawnSync(process.execPath, ["--input-type=module", "-e", `import { recentRoomEntries } from ${db}; console.log(JSON.stringify(recentRoomEntries(process.env.ROOM_ID, 50)));`], {
    cwd: ROOT,
    env: { ...process.env, OMB_DATA_DIR: join(home, ".orbit"), ROOM_ID: roomId },
    encoding: "utf8",
    windowsHide: true,
  });
  expect(read.status, read.stderr).toBe(0);
  return JSON.parse(read.stdout) as Array<{ author: { kind: string; name: string }; text: string; replyToId?: string; askId?: string }>;
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-bot-chain-"));
  mkdirSync(join(home, ".orbit"), { recursive: true });
  const fixture = join(home, "handoff.json");
  writeFileSync(fixture, JSON.stringify([
    { type: "assistant", message: { id: "msg-1", content: [{ type: "text", text: "@Beta over to you" }] } },
    { type: "result", subtype: "success", is_error: false, result: "@Beta over to you", total_cost_usd: 0 },
  ]));
  const instance = (environment: Record<string, string>) => ({
    driver: "claudeAgent",
    environment,
    config: { cli: `"${process.execPath}" "${FAKE_CLAUDE}"`, permissionMode: "bypassPermissions" },
  });
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances: { handoff: instance({ FAKE_CLAUDE_REPLY_FIXTURE: fixture }), claude: instance({}) } }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...Object.fromEntries(["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP"].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      OMB_PORT: String(PORT),
    },
  });
  child.stderr!.on("data", (c) => (stderr += c));
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    return (await fetch(`${BASE}/api/health`).catch(() => null))?.ok === true;
  }, "the server");
}, 40_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(resolve, 5_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
});

it("publishes one entry with no reply link for a teammate bot an answer @-mentions", async () => {
  const alpha = await newBot("handoff", "Alpha");
  const beta = await newBot("claude", "Beta");
  const created = await api("POST", "/api/groups", { name: "Crew", memberIds: [alpha, beta], hosted: true });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const { id, hosted } = created.body.group;
  expect((await api("POST", `/api/groups/${id}/messages`, { text: "@Alpha start" })).status).toBe(202);
  const fromBot = (name: string) => roomEntries(hosted.roomId).filter((entry) => entry.author.kind === "bot" && entry.author.name === name);
  await waitFor(async () => fromBot("Beta").length > 0 && !(await api("GET", "/api/bots")).body.groups.find((g: any) => g.id === id)?.working, "Beta's answer");
  expect(fromBot("Alpha").map((entry) => entry.text)).toEqual(["@Beta over to you"]);
  const answers = fromBot("Beta");
  expect(answers).toHaveLength(1);
  expect(answers[0]!.replyToId).toBeUndefined();
  expect(answers[0]!.askId).toBeUndefined();
}, 90_000);
