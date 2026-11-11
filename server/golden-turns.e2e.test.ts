// Golden baseline: what 1:1 and ordinary room turns send to the engine. Team
// rooms must leave every line of it unchanged. GOLDEN_UPDATE=1 rewrites it.
import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const HOOK = join(SERVER_DIR, "testing", "golden-hook.ts");
const GOLDEN = join(SERVER_DIR, "testing", "golden", "turns-no-rooms.json");
const FIRST_PORT = 18800 + Math.floor(Math.random() * 10_000);
// Argv and socket paths differ per OS; Wink ships on Windows and CI runs there.
const windowsOnly = describe.skipIf(process.platform !== "win32");

const SECRET_ENV = /TOKEN|KEY|SECRET|PASSWORD/i;

function normalize(lines: Array<Record<string, any>>, home: string, port: number): unknown[] {
  const ids = new Map<string, string>();
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const paths = [
    [home, "<home>"],
    [ROOT, "<repo>"],
    [process.execPath, "<node>"],
    [tmpdir(), "<tmp>"],
  ] as const;
  const scrub = (text: string) => {
    let out = text;
    for (const [from, to] of paths) {
      for (const form of new Set([from.replaceAll("\\", "\\\\\\\\"), from.replaceAll("\\", "\\\\"), from, from.replaceAll("\\", "/")])) {
        out = out.replace(new RegExp(literal(form), "gi"), to);
      }
    }
    return out
      .replaceAll(String(port), "<port>")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => {
        if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
        return ids.get(id)!;
      })
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, "<time>")
      .replace(/\b1\d{12}\b/g, "<ms>")
      .replace(/(<tmp>(?:\\\\|\/)[\w-]+-)[A-Za-z0-9]{6}\b/g, "$1XXXXXX")
      .replace(/\b(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{32,}\b/g, "<token>");
  };
  return lines.map((line) => {
    if (line.kind === "spawn") {
      line.env = Object.fromEntries(Object.entries(line.env as Record<string, string | null>)
        .map(([key, value]) => [key, value === null ? null : key === "PATH" ? "<path>" : SECRET_ENV.test(key) ? "<masked>" : value]));
    }
    return JSON.parse(scrub(JSON.stringify(line)));
  });
}

const WORLDS = ["no team room", "a plain room", "an active team room"] as const;
const captured = new Map<string, string>();

// A team room with people and a log must not change one byte next to the same plain room.
windowsOnly.each(WORLDS)("golden turns with %s", (world) => {
  const PORT = FIRST_PORT + WORLDS.indexOf(world);
  const hosted = world === "an active team room";
  const BASE = `http://127.0.0.1:${PORT}`;
  let child: ChildProcess;
  let home: string;
  let log: string;
  let gate: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const bots = async () => (await api("GET", "/api/bots")).body;
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const botTexts = async (id: string) =>
    (await bots()).bots.find((bot: any) => bot.id === id).messages.filter((m: any) => m.role === "bot" && m.kind === "text").length;
  const newBot = async (instanceId: string, name: string) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: { instanceId, model: "claude-fake" } });
    return bot.id as string;
  };
  const say = async (id: string, text: string, replies: number) => {
    expect((await api("POST", `/api/bots/${id}/messages`, { text })).status).toBe(202);
    await waitFor(async () => (await botTexts(id)) >= replies && !(await bots()).bots.find((bot: any) => bot.id === id).busy, `reply to ${text}`);
  };
  const seedRoom = async () => {
    const created = await api("POST", "/api/groups", { name: "Team room", memberIds: [await newBot("claude", "Roomie")], ...(hosted ? { hosted } : {}) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    if (!hosted) return;
    const db = JSON.stringify(pathToFileURL(join(SERVER_DIR, "rooms", "db.ts")).href);
    const seed = [
      `import { addPerson, appendRoomEntry } from ${db};`,
      "const room = process.env.ROOM_ID;",
      'const mina = addPerson(room, "Mina", "ask", ["Roomie"]);',
      'addPerson(room, "Jun", "trusted", ["Roomie"]);',
      'const ask = appendRoomEntry(room, { author: { kind: "person", id: mina.id, name: mina.name }, text: "@Roomie hello" });',
      'appendRoomEntry(room, { author: { kind: "bot", id: "roomie", name: "Roomie" }, text: "Hi Mina.", replyToId: ask.id, askId: "a1", grant: "words", clean: false });',
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", seed], {
      cwd: ROOT,
      env: { ...process.env, OMB_DATA_DIR: join(home, ".orbit"), ROOM_ID: created.body.group.hosted.roomId },
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(0);
  };
  const mark = (name: string) => writeFileSync(log, `${JSON.stringify({ kind: "fixture", name })}\n`, { flag: "a" });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-golden-"));
    mkdirSync(join(home, ".orbit"), { recursive: true });
    log = join(home, "golden.ndjson");
    gate = join(home, "task.gate");
    const instance = (environment: Record<string, string>) => ({
      driver: "claudeAgent",
      environment,
      config: { cli: `"${process.execPath}" "${FAKE_CLAUDE}"`, permissionMode: "bypassPermissions" },
    });
    writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({
      ...(hosted ? { features: { teamRooms: true } } : {}),
      instances: {
        claude: instance({}),
        claudeTask: instance({ FAKE_CLAUDE_MODE: "background-task", FAKE_CLAUDE_TASK_GATE: gate }),
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
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
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

  it("matches the recorded engine inputs", async () => {
    if (world !== "no team room") await seedRoom();
    mark("1:1 cold");
    const solo = await newBot("claude", "Solo");
    await say(solo, "first message", 1);
    mark("1:1 warm");
    await say(solo, "second message", 2);

    mark("1:1 background-task continuation");
    const tasker = await newBot("claudeTask", "Tasker");
    await say(tasker, "start the task", 1);
    writeFileSync(gate, "open");
    await waitFor(async () => (await bots()).bots.find((bot: any) => bot.id === tasker).messages
      .some((m: any) => m.text === "background task done"), "the continuation reply");
    await waitFor(async () => !(await bots()).bots.find((bot: any) => bot.id === tasker).busy, "the continuation to settle");

    mark("ordinary group");
    const member = await newBot("claude", "Member");
    const created = await api("POST", "/api/groups", {
      name: "Ordinary room",
      memberIds: [member],
      setup: { bulletin: "Be brief.", defaultResponder: { kind: "member", botId: member } },
    });
    expect(created.status).toBe(201);
    const groupId = created.body.group.id;
    expect((await api("POST", `/api/groups/${groupId}/messages`, { text: "hello room" })).status).toBe(202);
    const group = async () => (await bots()).groups.find((g: any) => g.id === groupId);
    await waitFor(async () => {
      const g = await group();
      return !g.working && g.messages.some((m: any) => m.role === "bot" && m.kind === "text");
    }, "the room reply");
    mark("end");

    const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const actual = `${JSON.stringify(normalize(lines, home, PORT), null, 2)}\n`;
    captured.set(world, actual);
    if (world === "a plain room") return;
    if (hosted) return expect(actual).toBe(captured.get("a plain room"));
    if (process.env.GOLDEN_UPDATE === "1" || !existsSync(GOLDEN)) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, actual);
    }
    // Windows checkouts may turn the file's LF into CRLF.
    expect(actual).toBe(readFileSync(GOLDEN, "utf8").replace(/\r\n/g, "\n"));
  }, 120_000);
});
