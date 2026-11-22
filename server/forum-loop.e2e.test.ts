// The Forum loop on a default install: the real server and Claude driver on the fake CLI, toolDetailCapture never set.
// Bot A fails, edits and passes, then posts the fix; bot B on the same error gets it once; bot C on another error gets nothing.
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY_ERROR = "Exit code 1\nTraceback (most recent call last):\n  File \"loader.py\", line 12, in load\nKeyError: 'name'";

describe("forum loop on a default install", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const bot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((entry: any) => entry.id === id);
  const replies = async (id: string) => (await bot(id)).messages.filter((m: any) => m.role === "bot" && m.kind === "text").length;
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string) => {
    const deadline = Date.now() + 30_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const newBot = async (instanceId: string) => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { name: instanceId, modelSelection: { instanceId, model: "claude-fake" } });
    return created.id as string;
  };
  const say = async (id: string, text: string) => {
    const before = await replies(id);
    expect((await api("POST", `/api/bots/${id}/messages`, { text })).status).toBe(202);
    await waitFor(async () => (await replies(id)) > before && !(await bot(id)).busy, `reply to ${text}`);
  };
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const sent = (instance: string) => read(join(home, `${instance}.ndjson`)).map((entry: { text?: string }) => entry.text ?? "").join("\n");
  const rows = () => read(join(home, ".orbit", "forum-loop.ndjson")) as Array<{ kind: string; botId: string; postId?: string }>;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-forum-loop-e2e-"));
    mkdirSync(join(home, ".orbit"), { recursive: true });
    chmodSync(FAKE, 0o755);
    const bash = (command: string, content: string, is_error = false) => ({ name: "Bash", input: { command }, content, is_error });
    const edit = { name: "Edit", input: { file_path: join(home, "loader.py"), old_string: "a", new_string: "b" }, content: "The file has been updated." };
    const instance = (name: string, steps: unknown[]) => {
      const fixture = join(home, `${name}.json`);
      writeFileSync(fixture, JSON.stringify(steps));
      return [name, {
        driver: "claudeAgent",
        environment: { FAKE_CLAUDE_TOOL_FIXTURE: fixture, FAKE_CLAUDE_PROMPT_LOG: join(home, `${name}.ndjson`), FAKE_CLAUDE_DUMP: join(home, `${name}-dump.json`) },
        config: { cli: FAKE, permissionMode: "bypassPermissions" },
      }];
    };
    writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({
      instances: Object.fromEntries([
        instance("astra", [bash("python -m pytest tests/test_loader.py", KEY_ERROR, true), edit, bash("python -m pytest tests/test_loader.py", "1 passed")]),
        instance("nova", [bash("python -m pytest tests/test_loader.py", KEY_ERROR, true)]),
        instance("sol", [bash("pnpm tsc --noEmit", "Exit code 2\nsrc/app.ts(3,1): error TS2304: Cannot find name 'foo'.", true)]),
      ]),
    }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), OMB_PORT: String(PORT) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    // Without SystemRoot, winsock fails to initialize in the child.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      return fetch(`${BASE}/api/health`).then((res) => res.ok, () => false);
    }, "server");
  }, 60_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("hands bot B the fix bot A proved, once, and bot C nothing", async () => {
    const astra = await newBot("astra");
    await say(astra, "fix the loader");
    await waitFor(() => rows().some((row) => row.kind === "proven" && row.botId === astra), "the proven row");
    const token = JSON.parse(readFileSync(join(home, "astra-dump.json"), "utf8")).mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    const posted = await api("POST", "/api/internal/board-post", { kind: "fix", title: "KeyError 'name' in loader", body: "Use cfg.get('name'); the key is optional." }, { authorization: `Bearer ${token}` });
    expect(posted.status).toBe(200);

    const nova = await newBot("nova");
    await say(nova, "run the loader tests");
    await say(nova, "and once more");
    expect(sent("nova").split("<forum-note>")).toHaveLength(2);
    expect(sent("nova")).toContain(`Forum ${posted.body.id}`);
    expect(sent("nova")).toContain("Use cfg.get('name')");
    // the fake CLI replays its fixture on a steer that lands after its burst, so "again" can show more than once
    const [first, ...rest] = rows().filter((row) => row.botId === nova).map((row) => row.kind);
    expect([first, [...new Set(rest)]]).toEqual(["repeat", ["again"]]);

    const sol = await newBot("sol");
    await say(sol, "typecheck");
    expect(sent("sol")).not.toContain("<forum-note>");
    expect(rows().filter((row) => row.botId === sol)).toEqual([]);
  }, 90_000);
});
