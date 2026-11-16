import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { agentsHeaders } from "./testing/agents-caller.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

let child: ChildProcess;
let home: string;
let port = 0;
let stderr = "";
let fakeClaudeDump: string;
let chief: { id: string; threadId: string };
let headers: Record<string, string>;
const origin = () => `http://127.0.0.1:${port}`;

const api = async (method: "GET" | "POST" | "PATCH", path: string, body?: object) => {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${origin()}${path}`, init);
  return { status: res.status, body: await res.json() };
};

const listedBot = async (id: string) => {
  const listed = z.object({ bots: z.array(z.object({ id: z.string() }).passthrough()) }).parse((await api("GET", "/api/bots?messages=0")).body);
  return listed.bots.find((row) => row.id === id);
};

// agentsHeaders polls, which vitest only allows inside a test
const createBot = async (name: string, extra: Record<string, unknown> = {}) => {
  if (!headers) {
    chief = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }).passthrough() }).parse((await api("POST", "/api/bots", { name: "Chief" })).body).bot;
    expect((await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, section: "Team" })).status).toBe(200);
    headers = await agentsHeaders(api, fakeClaudeDump, chief.id, chief.threadId);
  }
  const res = await fetch(`${origin()}/api/internal/create-bot`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fromBotId: chief.id,
      fromThreadId: chief.threadId,
      name,
      role: "Research operator",
      instructions: "Research the assigned question and report concise findings.",
      ...extra,
    }),
  });
  return { status: res.status, body: z.object({ id: z.string().optional(), error: z.string().optional() }).passthrough().parse(await res.json()) };
};

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = mkdtempSync(join(tmpdir(), "omb-create-bot-route-"));
  fakeClaudeDump = join(home, "fake-claude-dump.json");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({ instances: {
      claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") } },
      grok: { driver: "grokAgent", displayName: "Fixture Grok", config: { cli: join(SERVER_DIR, "testing", "fake-acp-cli.ts"), fullAuto: true } },
    } }),
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
    },
    windowsHide: true,
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${origin()}/api/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("POST /api/internal/create-bot", () => {
  it("starts the bot on the named model and effort of another engine", async () => {
    const created = await createBot("Grok Operator", { model: "grok-4.6", effort: "xhigh" });
    expect(created.status).toBe(201);
    expect(await listedBot(created.body.id!)).toMatchObject({
      modelSelection: { instanceId: "grok", model: "grok-4.6", effort: "xhigh", mode: "pinned" },
    });
  });

  it("keeps the Chief's model when only effort is named", async () => {
    const created = await createBot("Effort Operator", { effort: "low" });
    expect(created.status).toBe(201);
    expect(await listedBot(created.body.id!)).toMatchObject({
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5", effort: "low" },
    });
  });

  it("refuses an unknown model id and lists the valid ids", async () => {
    const created = await createBot("Ghost Operator", { model: "not-a-model" });
    expect(created.status).toBe(400);
    expect(created.body.error).toContain('model "not-a-model" is not offered; valid ids:');
    expect(created.body.error).toContain("grok-4.6");
    expect(created.body.error).toContain("claude-sonnet-5");
  });

  it.each([true, false])("copies the Chief's approval settings (autoApprove %s)", async (on) => {
    expect((await api("PATCH", `/api/bots/${chief.id}`, { autoApprove: on, approvePeerComms: on, composio: on })).status).toBe(200);
    const created = await createBot(`Settings Operator ${on}`);
    expect(created.status).toBe(201);
    expect(await listedBot(created.body.id!)).toMatchObject({
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      autoApprove: on,
      approvePeerComms: on,
      composio: on,
    });
  });
});
