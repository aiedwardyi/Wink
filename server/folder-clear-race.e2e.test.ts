// A Settings Clear that lands while a send's named folders are checked off the server thread spends that send's folder.
// folder-check-hook.ts holds the check.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { harnessFetch as fetch, spawnHarness as spawn } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess;
let home: string;
let gates: string;
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const waitFor = async (predicate: () => boolean | Promise<boolean>, what: string) => {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-folder-clear-"));
  mkdirSync(join(home, ".orbit"), { recursive: true });
  gates = join(home, "gates");
  mkdirSync(gates);
  const instance = { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "narration-plain" }, config: { cli: `"${process.execPath}" "${FAKE_CLAUDE}"`, permissionMode: "bypassPermissions" } };
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances: { claude: instance } }));
  child = spawn(process.execPath, ["--import", pathToFileURL(join(SERVER_DIR, "testing", "folder-check-hook.ts")).href, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...Object.fromEntries(["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP"]
        .flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      OMB_PORT: String(PORT),
      FOLDER_CHECK_GATES: gates,
    },
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if ((await globalThis.fetch(`${BASE}/api/health`).catch(() => null))?.ok) break;
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server start: ${stderr.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}, 40_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
  });
  rmSync(home, { recursive: true, force: true });
});

it("keeps the folder cleared when Settings Clear lands while the send's folders are checked", async () => {
  const project = join(home, "clear-project");
  mkdirSync(project);
  const bot = (await api("POST", "/api/bots")).body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } });
  const send = api("POST", `/api/bots/${bot.id}/messages`, { text: `add tests in ${project} and ${join(home, "folder-check-hold")}` });
  await waitFor(() => existsSync(join(gates, "held")), "the folder check");
  const cleared = await api("PATCH", `/api/bots/${bot.id}`, { cwd: null });
  expect(cleared.body.bot.rememberedProjectCwd).toBeNull();
  writeFileSync(join(gates, "release"), "");
  expect((await send).status).toBe(202);
  const shown = async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((row: any) => row.id === bot.id);
  await waitFor(async () => (await shown())?.tasks[0]?.cwd !== undefined, "the task folder");
  const after = await shown();
  expect(after.rememberedProjectCwd).toBeNull();
  expect(after.tasks[0].cwd).not.toBe(project);
}, 60_000);

it("remembers and pins a folder the send names when no Clear lands", async () => {
  const project = join(home, "named-project");
  mkdirSync(project);
  const bot = (await api("POST", "/api/bots")).body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: `add tests in ${project}` })).status).toBe(202);
  const shown = async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((row: any) => row.id === bot.id);
  await waitFor(async () => (await shown())?.tasks[0]?.cwd !== undefined, "the task folder");
  const after = await shown();
  expect(after.rememberedProjectCwd).toBe(project);
  expect(after.tasks[0].cwd).toBe(project);
}, 60_000);
