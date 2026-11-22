// Every engine gets a custom bot's current picks, never a replaced one, on the 1:1 and the room route.
// Boots the real server on each engine's fake CLI and reads what the CLI received.
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

const CUSTOM = "Keep build notes in the team wiki.";
const TIMELINE = [
  "# Decision timeline",
  "",
  "## 2026-11-17 10:00 | forum look | replaced by 2026-11-17 10:03",
  "- Picked: ~~A - plain list~~",
  '- Said: "a looks cleanest"',
  "",
  "## 2026-11-17 10:03 | forum look | current",
  "- Picked: C - Reddit cards",
  "- Picture: C:\\mock\\C.png",
  "- Over: A - plain list; B - tiles",
  '- Said: "actually c"',
  '- Tweak 2026-11-17 10:06: "make the header smaller"',
  "",
].join("\n");
const HEADER = "Current picks, newest first:";
const PICK = '- forum look (11-17): C - Reddit cards (C:\\mock\\C.png) + tweaks: "make the header smaller" (11-17)';

const ENGINE_NAMES = ["claude", "codex", "gemini", "grok", "muse"] as const;
type Engine = (typeof ENGINE_NAMES)[number];
type EngineSpec = { driver: string; cli: string; dump: string; model: string; env: Record<string, string> };
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const ENGINES = {
  claude: { driver: "claudeAgent", cli: "fake-claude-cli.ts", dump: "FAKE_CLAUDE_DUMP", model: "claude-sonnet-5", env: {} },
  codex: { driver: "codex", cli: "fake-codex-app-server.ts", dump: "FAKE_CODEX_DUMP", model: "gpt-5.5", env: {} },
  gemini: { driver: "antigravityAgent", cli: "fake-agy-cli.ts", dump: "FAKE_AGY_DUMP", model: "gemini-3-pro", env: {} },
  grok: { driver: "grokAgent", cli: "fake-acp-cli.ts", dump: "FAKE_ACP_DUMP", model: "grok-4.6", env: { FAKE_ACP_MODE: "happy" } },
  muse: { driver: "museAgent", cli: "fake-msp-cli.ts", dump: "FAKE_MSP_DUMP", model: "muse-spark", env: { META_API_KEY: "fixture-meta-key" } },
} satisfies Record<Engine, EngineSpec>;

describe("current picks on every engine", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: Json): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const dumpDir = (engine: Engine) => join(home, "dumps", engine);
  const received = (engine: Engine) => {
    const dir = dumpDir(engine);
    return existsSync(dir) ? readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8")).join("\n") : "";
  };
  const sendAndRead = async (engine: Engine, path: string, text: string) => {
    removeTestData(dumpDir(engine));
    mkdirSync(dumpDir(engine), { recursive: true });
    expect((await api("POST", path, { text })).status).toBe(202);
    const deadline = Date.now() + 20_000;
    while (!received(engine).includes(text)) {
      if (Date.now() > deadline) throw new Error(`${engine} never received "${text}". stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // JSON dumps escape quotes; compare on the decoded text
    return received(engine).replaceAll("\\\\", "\\").replaceAll("\\'", "'").replaceAll('\\"', '"');
  };
  const expectPicks = (prompt: string) => {
    expect(prompt).toContain(HEADER);
    expect(prompt).toContain(PICK);
    expect(prompt).not.toContain("plain list");
  };
  const writeTimeline = (botId: string) => {
    const memory = join(home, ".orbit", "workspaces", botId, "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "decisions.md"), TIMELINE);
  };

  beforeAll(async () => {
    home = createFixtureHome("omb-picks-prompt-");
    mkdirSync(join(home, ".orbit"), { recursive: true });
    const instances = Object.fromEntries(ENGINE_NAMES.map((engine) => {
      const spec = ENGINES[engine];
      chmodSync(fake(spec.cli), 0o755);
      return [engine, {
        driver: spec.driver,
        environment: { ...spec.env, [spec.dump]: join(dumpDir(engine), "dump.json") },
        config: { cli: fake(spec.cli), fullAuto: true },
      }];
    }));
    writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    // Without SystemRoot, winsock fails to initialize in the child.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    removeTestData(home);
  });

  it.each(ENGINE_NAMES)("reach a custom bot on %s in a 1:1 and a room", async (engine) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    let room: { id: string } | undefined;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: engine, model: ENGINES[engine].model },
        description: CUSTOM,
      })).status).toBe(200);
      writeTimeline(bot.id);
      const prompt = await sendAndRead(engine, `/api/bots/${bot.id}/messages`, `pick the look on ${engine}`);
      expect(prompt).toContain(CUSTOM);
      expectPicks(prompt);
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);

      const group = (await api("POST", "/api/groups", {
        name: `Picks room ${engine}`,
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
      })).body.group;
      room = group;
      const roomPrompt = await sendAndRead(engine, `/api/groups/${group.id}/messages`, `pick the room look on ${engine}`);
      expect(roomPrompt).toContain(CUSTOM);
      expectPicks(roomPrompt);
    } finally {
      if (room) {
        await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
      }
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
    }
  }, 60_000);
});
