// Every engine gets the code-fix rules, even under a bot's own instructions,
// on the 1:1 and the room route, with the line that lets the user's own
// instructions override them, plus the plain-words rule for talking to people,
// the repeat-mistakes rule, the decision-notes rule, the Forum rule and the model picks. Boots
// the real server on each engine's fake CLI and reads what the CLI received.
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FORUM_STUCK_RULE } from "../shared/forum-rule.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

const OVERRIDE = "(the user's own instructions override this)";
const RULES = [
  "fix the root cause; no timer, retry or comment patching around it",
  "a lint rule whose error names the fix",
  "a test failing on the old bug; prose rules last",
  "Add the check first, then list other copies of the bad pattern",
  "running the code yourself",
  "A report is a claim, not proof.",
];
const PLAIN_WORDS = "Talk to people in plain words: no board or PR numbers, worker, pane or card names, or 'my 1:1'; say 'a helper is fixing it'.";
const REPEAT_MISTAKES = "When you make the same mistake a second time (like saying you'll do something with no tool call), log it on one repeat-mistakes page in your memory and fix it in your own notes or scripts that day; a guard that changes Wink code or what the user sees needs the user's OK first.";
const FORUM = `Same error twice: board_search it before a third try. ${FORUM_STUCK_RULE}`;
const CUSTOM = "Keep build notes in the team wiki.";
const DECISIONS = [
  "In any build card, hand-off or note, each thing the user decided or asked quotes their words with the date",
  "Mark everything else 'suggestion, not agreed' and ask before building it.",
  "When the user changes their mind, replace the old note; never keep two that disagree.",
];
const MODEL_PICKS = "Fast work (quick answers, searches, small edits): Grok 4.7 and Gemini 4 Hydrogen, tied; Muse Ember just below them.";

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

describe("code-fix rules on every engine", () => {
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
    rmSync(dumpDir(engine), { recursive: true, force: true });
    mkdirSync(dumpDir(engine), { recursive: true });
    expect((await api("POST", path, { text })).status).toBe(202);
    const deadline = Date.now() + 20_000;
    while (!received(engine).includes(text)) {
      if (Date.now() > deadline) throw new Error(`${engine} never received "${text}". stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // JSON dumps escape quotes; compare on the decoded text
    return received(engine).replaceAll("\\'", "'").replaceAll('\\"', '"');
  };
  const expectRules = (prompt: string) => {
    expect(prompt).toContain(OVERRIDE);
    for (const rule of RULES) expect(prompt).toContain(rule);
    expect(prompt).toContain(PLAIN_WORDS);
    expect(prompt).toContain(REPEAT_MISTAKES);
    expect(prompt).not.toContain("build a guard that day");
    expect(prompt).toContain(FORUM);
    expect(prompt).toContain(MODEL_PICKS);
    for (const rule of DECISIONS) expect(prompt).toContain(rule);
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-code-fix-rules-"));
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
    await removeTempDir(home);
  });

  it.each(ENGINE_NAMES)("reach a custom bot on %s in a 1:1 and a room", async (engine) => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    let room: { id: string } | undefined;
    try {
      expect((await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: engine, model: ENGINES[engine].model },
        description: CUSTOM,
      })).status).toBe(200);
      const prompt = await sendAndRead(engine, `/api/bots/${bot.id}/messages`, `find the flaky test on ${engine}`);
      expect(prompt).toContain(CUSTOM);
      expectRules(prompt);
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);

      const group = (await api("POST", "/api/groups", {
        name: `Rules room ${engine}`,
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
      })).body.group;
      room = group;
      const roomPrompt = await sendAndRead(engine, `/api/groups/${group.id}/messages`, `fix the room bug on ${engine}`);
      expect(roomPrompt).toContain(CUSTOM);
      expectRules(roomPrompt);
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
