// A team room turn and its bot's 1:1 on a real harness with a fake Claude:
// the search tool mounts, the 1:1 stays out of everything the room keeps, and
// the room echo reaches the next 1:1 turn once.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const HOOK = join(SERVER_DIR, "testing", "golden-hook.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const CANARY = "canary-5d1f0c3a";
const ECHO_HEAD = "[Wink note, automated: what you said in rooms since your last turn here.";

describe.skipIf(process.platform !== "win32")("one mind between a room and its bot's 1:1", () => {
  let child: ChildProcess;
  let home: string;
  let log: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown, auth?: string) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const state = async () => (await api("GET", "/api/bots")).body;
  const waitFor = async (predicate: () => Promise<boolean>, what: string) => {
    const deadline = Date.now() + 30_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const turns = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.kind === "sendTurn");
  const say = async (botId: string, text: string) => {
    const before = (await state()).bots.find((bot: any) => bot.id === botId).messages.filter((m: any) => m.role === "bot" && m.kind === "text").length;
    expect((await api("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
    await waitFor(async () => {
      const bot = (await state()).bots.find((row: any) => row.id === botId);
      return !bot.busy && bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text").length > before;
    }, `reply to ${text}`);
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-one-mind-"));
    mkdirSync(join(home, ".orbit"), { recursive: true });
    log = join(home, "turns.ndjson");
    writeFileSync(log, "");
    writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({
      profile: { name: "Edward" },
      instances: { claude: { driver: "claudeAgent", environment: {}, config: { cli: `"${process.execPath}" "${FAKE_CLAUDE}"`, permissionMode: "bypassPermissions" } } },
    }));
    child = spawn(process.execPath, ["--import", pathToFileURL(HOOK).href, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
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
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      return fetch(`${BASE}/api/health`).then((res) => res.ok, () => false);
    }, "the server");
  }, 40_000);

  afterAll(async () => {
    child?.kill();
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(resolve, 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("keeps the 1:1 private, searches it live and echoes the room once", async () => {
    const rando = (await api("POST", "/api/bots")).body.bot.id as string;
    await api("PATCH", `/api/bots/${rando}`, { name: "Rando", notifications: false, modelSelection: { instanceId: "claude", model: "claude-fake" } });
    await say(rando, `Plan for starzum.com: a waitlist page. ${CANARY}`);

    const created = await api("POST", "/api/groups", { name: "Team room", memberIds: [rando], hosted: true, setup: { bulletin: "", defaultResponder: { kind: "member", botId: rando } } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const group = created.body.group;
    expect((await api("POST", `/api/groups/${group.id}/messages`, { text: "@Rando what are we building?" })).status).toBe(202);
    const room = async () => (await state()).groups.find((row: any) => row.id === group.id);
    await waitFor(async () => {
      const g = await room();
      return !g.working && g.messages.some((m: any) => m.role === "bot" && m.kind === "text");
    }, "the room reply");
    const echoes = async () => (await state()).bots.find((bot: any) => bot.id === rando).messages.filter((m: any) => m.roomEcho);
    expect(await echoes()).toHaveLength(1);

    const roomTurn = turns().find((line) => line.input.threadId === group.threadId);
    const env = roomTurn.input.integrations.agents.env;
    expect(env.OMB_OWNER_CHATS).toBe("1");
    expect(JSON.stringify(roomTurn)).not.toContain(CANARY);
    expect(JSON.stringify(await room())).not.toContain(CANARY);
    const orbit = join(home, ".orbit");
    for (const file of readdirSync(orbit).filter((name) => name.startsWith("rooms"))) expect(readFileSync(join(orbit, file)).includes(CANARY), file).toBe(false);

    const replied = say(rando, "use the zebra-route for deploys");
    // the line is stored when the send is accepted; search reads the same database at once
    await waitFor(async () => (await state()).bots.find((bot: any) => bot.id === rando).messages.some((m: any) => m.text === "use the zebra-route for deploys"), "the 1:1 line");
    const search = await api("POST", "/api/internal/my-chats", { query: "zebra-route" }, env.OMB_COMMS_TOKEN);
    expect(search.body.text).toContain("Edward: use the zebra-route for deploys");
    await replied;
    expect((await room()).messages.at(-1).tool.name).toBe("Searched your 1:1: zebra-route");
    const own = turns().find((line) => line.input.threadId !== group.threadId).input.integrations.agents.env.OMB_COMMS_TOKEN;
    expect((await api("POST", "/api/internal/my-chats", { query: "starzum" }, own)).status).toBe(403);

    const oneOnOne = turns().filter((line) => line.input.threadId !== group.threadId);
    expect(oneOnOne.at(-1).input.text).toContain(ECHO_HEAD);
    expect(oneOnOne.slice(0, -1).some((line: any) => line.input.text.includes(ECHO_HEAD))).toBe(false);
    await say(rando, "and now?");
    expect(turns().at(-1).input.text).not.toContain(ECHO_HEAD);
    expect((await echoes())[0].roomEcho.noted).toBe(true);
  }, 120_000);
});
