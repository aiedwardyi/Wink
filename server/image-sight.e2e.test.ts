// A picture the bot showed or linked rides on the host's next message, even into a fresh session.
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claudeUserContent } from "./drivers/claude.ts";
import { REPLY_MARKER } from "./turn-context.ts";
import { harnessFetch as fetch, spawnHarness as spawn } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const HOOK = join(SERVER_DIR, "testing", "golden-hook.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
// a real 1x1 PNG
const FIXTURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
// a second, different 1x1 PNG
const SECOND = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

let child: ChildProcess;
let home: string;
let folder: string;
let log: string;
let claudeDump: string;
let codexDump: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() as any };
};
const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string) => {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const state = async () => (await api("GET", "/api/bots")).body;
const newBot = async (instanceId: string, model: string) => {
  const bot = (await api("POST", "/api/bots")).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId, model }, cwd: folder })).status).toBe(200);
  return bot as { id: string; threadId: string };
};
const say = async (id: string, text: string) => {
  const before = (await state()).bots.find((bot: any) => bot.id === id).messages.filter((m: any) => m.role === "bot" && m.kind === "text").length;
  expect((await api("POST", `/api/bots/${id}/messages`, { text })).status).toBe(202);
  await waitFor(async () => {
    const bot = (await state()).bots.find((b: any) => b.id === id);
    return !bot.busy && bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text").length > before;
  }, `reply to ${text}`);
};
const sent = (threadId: string) => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  .filter((line) => line.kind === "sendTurn" && line.input.threadId === threadId).map((line) => line.input.text as string);
const agentsEnv = () => JSON.parse(readFileSync(claudeDump, "utf8")).mcpConfig.mcpServers.agents.env as Record<string, string>;
const show = async (botId: string, threadId: string, token: string, caption = "the new hero") => {
  const shown = await api("POST", "/api/internal/show-image", { fromBotId: botId, fromThreadId: threadId, path: join(folder, "hero.png"), caption }, { authorization: `Bearer ${token}` });
  expect(shown.status, JSON.stringify(shown.body)).toBe(201);
  return shown.body as { url: string };
};
const images = (text: string) => {
  const content = claudeUserContent(text, join(home, ".orbit", "attachments"));
  return typeof content === "string" ? [] : content.filter((block) => block.type === "image");
};

beforeAll(async () => {
  home = createFixtureHome("omb-image-sight-");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  folder = join(home, "project");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "hero.png"), FIXTURE);
  log = join(home, "turns.ndjson");
  claudeDump = join(home, "claude-input.json");
  codexDump = join(home, "codex-input.json");
  const cli = (name: string) => `"${process.execPath}" "${join(SERVER_DIR, "testing", name)}"`;
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({
    instances: {
      claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_DUMP: claudeDump }, config: { cli: cli("fake-claude-cli.ts"), permissionMode: "bypassPermissions" } },
      claudeOther: { driver: "claudeAgent", environment: { FAKE_CLAUDE_DUMP: claudeDump }, config: { cli: cli("fake-claude-cli.ts"), permissionMode: "bypassPermissions" } },
      codex: {
        driver: "codex",
        environment: { FAKE_CODEX_DUMP: codexDump, FAKE_CODEX_MESSAGES: JSON.stringify([{ text: `Here it is: [hero](<${join(folder, "hero.png")}>)` }]) },
        config: { cli: cli("fake-codex-app-server.ts") },
      },
    },
  }));
  child = spawn(process.execPath, ["--import", pathToFileURL(HOOK).href, join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...Object.fromEntries(["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP"]
        .flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      OMB_PORT: String(PORT),
      GOLDEN_LOG: log,
    },
  });
  child.stderr!.on("data", (c) => (stderr += c));
  await waitFor(async () => (await fetch(`${BASE}/api/health`).catch(() => null))?.ok === true, "the server");
}, 40_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(resolve, 5_000).unref?.();
  });
  removeTestData(home);
});

describe("a shown picture rides on the host's next message", () => {
  it("reaches Claude as pixels after a model switch starts a fresh session, then stops", async () => {
    const bot = await newBot("claude", "claude-fake");
    await say(bot.id, "make a hero");
    await show(bot.id, bot.threadId, agentsEnv().OMB_COMMS_TOKEN!);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claudeOther", model: "claude-fake" } })).status).toBe(200);
    rmSync(claudeDump, { force: true });
    await say(bot.id, "i dont like the font of wink");
    await waitFor(() => existsSync(claudeDump), "the fresh session's input");
    const content = JSON.parse(readFileSync(claudeDump, "utf8")).prompt.message.content;
    expect(Array.isArray(content), "content is blocks, not a plain string").toBe(true);
    const blocks = content.filter((block: any) => block.type === "image");
    expect(blocks).toHaveLength(1);
    expect(sha(Buffer.from(blocks[0].source.data, "base64"))).toBe(sha(FIXTURE));
    const text = content.find((block: any) => block.type === "text").text as string;
    expect(text).toContain("[showed image: ");
    expect(text.indexOf(REPLY_MARKER)).toBeGreaterThan(-1);
    expect(text.indexOf("<attached-image")).toBeGreaterThan(text.indexOf(REPLY_MARKER));
    await say(bot.id, "thanks");
    const last = sent(bot.threadId).at(-1)!;
    expect(last).not.toContain("<attached-image");
    expect(images(last)).toEqual([]);
  }, 60_000);

  it("reaches Codex as a local image for a picture the bot linked", async () => {
    const bot = await newBot("codex", "gpt-6.1-sol");
    await say(bot.id, "make a hero");
    await say(bot.id, "i dont like the font of wink");
    const turns = JSON.parse(readFileSync(codexDump, "utf8")).calls.filter((call: any) => call.method === "turn/start");
    expect(turns[0].params.input).toHaveLength(1);
    const local = turns.at(-1).params.input.filter((item: any) => item.type === "localImage");
    expect(local).toHaveLength(1);
    expect(sha(readFileSync(local[0].path))).toBe(sha(FIXTURE));
    expect(dirname(local[0].path)).toBe(join(home, ".orbit", "attachments"));
  }, 60_000);

  it.each([
    ["a two-line caption", "First line\nSecond line", false],
    ["the missing project notes notice after it", "one line", true],
  ])("reaches Codex as a local image with %s", async (_case, caption, notes) => {
    const bot = await newBot("claude", "claude-fake");
    await say(bot.id, "make a hero");
    await show(bot.id, bot.threadId, agentsEnv().OMB_COMMS_TOKEN!, caption);
    const patch = { modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" }, ...(notes ? { projectNotes: join(folder, "missing-notes.md") } : {}) };
    expect((await api("PATCH", `/api/bots/${bot.id}`, patch)).status).toBe(200);
    await say(bot.id, "inspect the drawing");
    const input = JSON.parse(readFileSync(codexDump, "utf8")).calls.filter((call: any) => call.method === "turn/start").at(-1).params.input;
    const prompt = input.find((item: any) => item.type === "text").text as string;
    expect(prompt).toContain("inspect the drawing");
    if (notes) expect(prompt.lastIndexOf("[Project notes check")).toBeGreaterThan(prompt.lastIndexOf("[The picture this message follows"));
    const local = input.filter((item: any) => item.type === "localImage");
    expect(local).toHaveLength(1);
    expect(sha(readFileSync(local[0].path))).toBe(sha(FIXTURE));
  }, 60_000);

  it("goes text-only when the newest shown picture is gone, never to the older one", async () => {
    const bot = await newBot("claude", "claude-fake");
    await say(bot.id, "draw two drafts");
    const token = agentsEnv().OMB_COMMS_TOKEN!;
    await show(bot.id, bot.threadId, token, "first draft");
    writeFileSync(join(folder, "hero.png"), SECOND);
    const final = await show(bot.id, bot.threadId, token, "final draft");
    writeFileSync(join(folder, "hero.png"), FIXTURE);
    rmSync(join(home, ".orbit", "attachments", final.url.split("/").at(-1)!));
    await say(bot.id, "describe the final draft");
    const prompt = sent(bot.threadId).at(-1)!;
    expect(prompt).toContain("describe the final draft");
    expect(prompt).not.toContain("[The picture this message follows");
    expect(images(prompt)).toEqual([]);
  }, 60_000);

  it("rides in a room on the host's message, for this bot's own picture", async () => {
    const member = await newBot("claude", "claude-fake");
    const created = await api("POST", "/api/groups", { name: "Design room", memberIds: [member.id], setup: { bulletin: "Be brief.", defaultResponder: { kind: "member", botId: member.id } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const groupId = created.body.group.id;
    const group = async () => (await state()).groups.find((g: any) => g.id === groupId);
    const post = async (text: string) => {
      const before = (await group()).messages.filter((m: any) => m.role === "bot" && m.kind === "text").length;
      expect((await api("POST", `/api/groups/${groupId}/messages`, { text })).status).toBe(202);
      await waitFor(async () => {
        const g = await group();
        return !g.working && g.messages.filter((m: any) => m.role === "bot" && m.kind === "text").length > before;
      }, `the room reply to ${text}`);
    };
    rmSync(claudeDump, { force: true });
    await post("make a hero");
    await waitFor(() => existsSync(claudeDump), "the room turn's input");
    const env = agentsEnv();
    await show(member.id, env.OMB_THREAD_ID!, env.OMB_COMMS_TOKEN!);
    await post("the colors are off");
    const text = sent(env.OMB_THREAD_ID!).at(-1)!;
    expect(text).toMatch(/\[The picture this message follows: [^\n]+ - the new hero\]\n<attached-image path="[^"]+" \/>$/);
    const blocks = images(text);
    expect(blocks).toHaveLength(1);
    expect(sha(Buffer.from(blocks[0]!.source.data, "base64"))).toBe(sha(FIXTURE));
  }, 60_000);
});
