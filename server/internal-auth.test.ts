import type { ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { agentsHeaders } from "./testing/agents-caller.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { harnessFetch, harnessToken, spawnHarness as spawn } from "./testing/harness-auth.ts";
import { freePortBlock } from "./testing/ports.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

let child: ChildProcess;
let home: string;
let port = 0;
let stderr = "";
let fakeClaudeDump: string;
let cookie = "";
const origin = () => `http://127.0.0.1:${port}`;

const bot = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }).passthrough() });

const api = async (method: "GET" | "POST" | "PATCH", path: string, body?: object) => {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await harnessFetch(`${origin()}${path}`, init);
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = createFixtureHome("omb-internal-auth-");
  fakeClaudeDump = join(home, "fake-claude-dump.json");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({ instances: { claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") } } } }),
  );
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      FAKE_CLAUDE_DUMP: fakeClaudeDump,
      ORBIT_REMOTE_HOST: "wink-test.tail0000.ts.net",
      ORBIT_REMOTE_AUTO: "0",
      XAI_API_KEY: "",
    },
    windowsHide: true,
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await harnessFetch(`${origin()}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const key = z.object({ key: z.string() }).parse(JSON.parse(readFileSync(join(home, ".orbit", "remote-key.json"), "utf8"))).key;
  cookie = `orbit_remote=${key}`;
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  removeTestData(home);
});

describe("internal routes", () => {
  it("refuse the remote browser cookie on every agent route", async () => {
    const { bot: owner } = bot.parse((await api("POST", "/api/bots", {})).body);
    expect((await fetch(`${origin()}/api/bots?messages=0`, { headers: { cookie } })).status).toBe(200);
    const body = { fromBotId: owner.id, fromThreadId: owner.threadId, credentialId: "xaiApiKey", method: "GET", url: "https://api.x.ai/v1/models" };
    const routes: Array<["GET" | "POST" | "PUT", string]> = [
      ["POST", "/api/internal/call-api"], ["POST", "/api/internal/generate-image"], ["POST", "/api/internal/show-image"],
      ["POST", "/api/internal/create-bot"], ["POST", "/api/internal/task-state"], ["POST", "/api/internal/react"],
      ["POST", "/api/internal/keep-going"], ["POST", "/api/internal/wake"], ["POST", "/api/internal/request-credential"],
      ["GET", "/api/internal/agents"], ["GET", `/api/internal/usage?self=${owner.id}`], ["PUT", "/api/internal/terminal-bridge"],
    ];
    for (const [method, path] of routes) {
      const res = await fetch(`${origin()}${path}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      });
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  it("still lets the boot token register the terminal bridge", async () => {
    const res = await fetch(`${origin()}/api/internal/terminal-bridge`, {
      method: "PUT",
      headers: { authorization: `Bearer ${await harnessToken(origin())}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1:9", token: "bridge-token" }),
    });
    expect(res.status).toBe(200);
  });

  it("lets an owner chat bot reach call_api with its own token, and only as itself", async () => {
    const { bot: owner } = bot.parse((await api("POST", "/api/bots", {})).body);
    const { bot: other } = bot.parse((await api("POST", "/api/bots", {})).body);
    const headers = await agentsHeaders(api, fakeClaudeDump, owner.id, owner.threadId);
    const call = (fromBotId: string, fromThreadId: string) => fetch(`${origin()}/api/internal/call-api`, {
      method: "POST",
      headers,
      body: JSON.stringify({ fromBotId, fromThreadId, credentialId: "xaiApiKey", method: "GET", url: "https://api.x.ai/v1/models" }),
    });
    const own = await call(owner.id, owner.threadId);
    expect(own.status).toBe(409);
    expect(z.object({ error: z.string() }).parse(await own.json()).error).toContain("No xAI API Key saved");
    expect((await call(other.id, other.threadId)).status).toBe(403);
  });
});
