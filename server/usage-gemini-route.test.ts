// A real server with a fake agy: Gemini's Usage row follows what `agy -p /usage` says, switching between a
// plan, an API key / Cloud login and a signed-out CLI without a restart, while Connections' view of the
// instance (its snapshot) never moves.
import type { ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_AGY_CLI = join(SERVER_DIR, "testing", "fake-agy-cli.ts");
const LIVE = join(SERVER_DIR, "testing", "fixtures", "agy-usage-live.jsonl");

const refreshSchema = z.object({
  report: z.object({ windows: z.array(z.object({ id: z.string(), usedPercent: z.number() })) }).optional(),
  error: z.string().optional(),
});
const boardSchema = z.object({
  engines: z.array(z.object({ engine: z.string(), accounts: z.array(z.object({ id: z.string(), windows: z.array(z.object({ id: z.string(), usedPercent: z.number() })) })) })),
});
const instancesSchema = z.object({ instances: z.array(z.object({ instanceId: z.string(), snapshot: z.unknown(), rateLimits: z.unknown().optional() }).passthrough()) });

let child: ChildProcess;
let home: string;
let modeFile: string;
let port = 0;
let stderr = "";
let before: unknown;
const origin = () => `http://127.0.0.1:${port}`;
const get = async (path: string) => (await fetch(`${origin()}${path}`)).json();
const refresh = async () => refreshSchema.parse(await (await fetch(`${origin()}/api/usage/refresh/gemini?fresh=1`, { method: "POST" })).json());
const geminiWindows = async () => {
  const board = boardSchema.parse(await get("/api/usage/board"));
  const accounts = board.engines.filter((engine) => engine.engine === "gemini").flatMap((engine) => engine.accounts);
  return accounts.find((account) => account.id === "gemini")?.windows ?? null;
};
const settled = async () => {
  for (let i = 0; i < 100; i++) {
    const snapshot = z.object({ state: z.string() }).passthrough().parse(await connections());
    if (snapshot.state !== "checking") return snapshot;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Gemini never left the checking state");
};
const connections = async () => instancesSchema.parse(await get("/api/instances")).instances.find((instance) => instance.instanceId === "gemini")?.snapshot;
const setMode = (mode: string) => writeFileSync(modeFile, mode);

beforeAll(async () => {
  port = await freePortBlock([0, 1], 24_300, 2_000);
  home = mkdtempSync(join(tmpdir(), "omb-usage-gemini-route-"));
  mkdirSync(join(home, ".orbit"), { recursive: true });
  modeFile = join(home, "agy-usage-mode");
  setMode("plan");
  copyFileSync(LIVE, join(home, "agy-usage-live.jsonl"));
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({
    instances: {
      gemini: {
        driver: "antigravityAgent",
        displayName: "Fixture Gemini",
        environment: { FAKE_AGY_USAGE_MODE_FILE: modeFile, FAKE_AGY_USAGE_FIXTURE: join(home, "agy-usage-live.jsonl") },
        config: { cli: FAKE_AGY_CLI },
      },
    },
  }));
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1) };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: ROOT, env, windowsHide: true });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try { if ((await fetch(`${origin()}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("Gemini usage follows the login, not a restart", () => {
  it("plan, then API key, then plan again: bars appear, clear, and come back; Connections never moves", async () => {
    before = await settled();
    expect(await geminiWindows()).toEqual([]);

    setMode("plan");
    const plan = await refresh();
    expect(plan.report?.windows.map((window) => [window.id, window.usedPercent])).toEqual([["five_hour", 30], ["seven_day", 8.7]]);
    expect((await geminiWindows())?.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(await connections()).toEqual(before);

    // A timeout or any other transient failure keeps the plan user's bars.
    setMode("transient");
    const transient = await refresh();
    expect(transient.error).toBe("Could not refresh Antigravity limits");
    expect(transient.report?.windows).toHaveLength(2);
    expect(await geminiWindows()).toHaveLength(2);
    expect(await connections()).toEqual(before);

    // agy's definitive "not available with a Gemini API key" (exit 2): no row content, no sentence, no stale bar.
    setMode("apikey");
    const apiKey = await refresh();
    expect(apiKey.report).toBeUndefined();
    expect(apiKey.error).toBeUndefined();
    expect(await geminiWindows()).toEqual([]);
    expect(await connections()).toEqual(before);

    setMode("plan");
    expect((await refresh()).report?.windows).toHaveLength(2);
    expect(await geminiWindows()).toHaveLength(2);
    expect(await connections()).toEqual(before);
  }, 60_000);

  it("a signed-out CLI never shows a bar it did not just read", async () => {
    setMode("signedout");
    const result = await refresh();
    expect(result.error).toBe("Could not refresh Antigravity limits");
    expect(await connections()).toEqual(before);
  }, 30_000);
});
