// A new chat's 4th typed message reuses the warm engine process the first 3 used, on every engine:
// the import_memory tool closing must not change the agents env each engine keys its warm process by.
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const HOOK = fake("spawn-log-hook.ts");
const FIRST_PORT = 18800 + Math.floor(Math.random() * 10_000);

const ENGINES = {
  claude: { driver: "claudeAgent", cli: "fake-claude-cli.ts", model: "claude-sonnet-5", env: {} },
  codex: { driver: "codex", cli: "fake-codex-app-server.ts", model: "gpt-5.5", env: {} },
  // one agy per turn: the next turn's standby starts once the last turn's agy exits
  gemini: { driver: "antigravityAgent", cli: "fake-agy-cli.ts", model: "gemini-3-pro", env: {}, standby: true },
  grok: { driver: "grokAgent", cli: "fake-acp-cli.ts", model: "grok-4.6", env: { FAKE_ACP_MODE: "happy" } },
} as const;
const ENGINE_NAMES = ["claude", "codex", "gemini", "grok"] as const;
type Engine = (typeof ENGINE_NAMES)[number];

// one server per engine: the warm pool's slots are shared across engines
describe.each(ENGINE_NAMES)("import_memory closing keeps the warm engine on %s", (engine) => {
  const BASE = `http://127.0.0.1:${FIRST_PORT + ENGINE_NAMES.indexOf(engine)}`;
  let child: ChildProcess;
  let home: string;
  let log: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: { text: string } | { modelSelection: { instanceId: string; model: string } }): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const processes = (engine: Engine) => {
    const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const mine = lines.filter((line) => line.fake === ENGINES[engine].cli);
    const ids = new Set(mine.filter((line) => line.event === "spawn").map((line) => line.id));
    const gone = new Set(mine.filter((line) => line.event === "exit").map((line) => line.id));
    const prompted = new Set(mine.filter((line) => line.event === "stdin").map((line) => line.id));
    const live = [...ids].filter((id) => !gone.has(id));
    return {
      spawned: ids.size,
      live: live.length,
      unprompted: live.filter((id) => !prompted.has(id)).length,
      busy: live.filter((id) => prompted.has(id)).length,
      unused: [...gone].filter((id) => !prompted.has(id)).length,
    };
  };
  const waitFor = async (predicate: () => Promise<boolean>, what: string) => {
    const deadline = Date.now() + 30_000;
    while (!(await predicate())) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  // a kept engine is between turns once one process is left; a one-per-turn engine once its turn's agy is gone
  const settledSpawns = async (engine: Engine) => {
    const standby = "standby" in ENGINES[engine];
    await waitFor(async () => standby ? processes(engine).busy === 0 : processes(engine).live === 1, `${engine} to settle between turns`);
    return processes(engine).spawned;
  };

  beforeAll(async () => {
    home = createFixtureHome("omb-import-warm-");
    mkdirSync(join(home, ".orbit"), { recursive: true });
    log = join(home, "spawns.ndjson");
    // Grok keeps a session warm only for a signed-in account
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(join(home, ".grok", "auth.json"), JSON.stringify({ key: "fixture" }));
    const spec = ENGINES[engine];
    chmodSync(fake(spec.cli), 0o755);
    const instances = { [engine]: { driver: spec.driver, environment: spec.env, config: { cli: fake(spec.cli), fullAuto: true } } };
    writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(FIRST_PORT + ENGINE_NAMES.indexOf(engine)), SPAWN_LOG: log };
    if (process.env.PATH) env.PATH = process.env.PATH;
    // Without SystemRoot, winsock fails to initialize in the child.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, ["--import", pathToFileURL(HOOK).href, join(SERVER_DIR, "index.ts")], {
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

  it("message 4 starts no engine process message 3 did not", async () => {
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: engine, model: ENGINES[engine].model } })).status).toBe(200);
    const counts = [processes(engine).spawned];
    for (let i = 1; i <= 5; i++) {
      const text = `message ${i} on ${engine}`;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text })).status).toBe(202);
      await waitFor(async () => {
        const row = (await api("GET", "/api/bots")).body.bots.find((entry: any) => entry.id === bot.id);
        return row.busy === false && row.messages.filter((m: any) => m.role === "bot" && m.kind === "text").length >= i;
      }, `the reply to ${text}`);
      counts.push(await settledSpawns(engine));
    }
    // the pool may offer no standby on a busy PC, so a one-per-turn engine counts launches thrown away unprompted
    if ("standby" in ENGINES[engine]) return expect(processes(engine).unused, "agy launches never prompted").toBe(0);
    const started = counts.slice(1).map((count, i) => count - counts[i]);
    expect(started.slice(2), `engine processes started per message: ${started.join(", ")}`).toEqual([started[2], started[2], started[2]]);
  }, 120_000);
});
