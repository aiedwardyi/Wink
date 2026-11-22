import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";
import { freePortBlock } from "./testing/ports.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const EXPIRED = "Failed to authenticate: OAuth session expired and could not be refreshed";

let child: ChildProcess;
let home: string;
let port = 0;
let stderr = "";
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

const messageSchema = z.object({
  id: z.string(),
  kind: z.string(),
  card: z.object({ options: z.array(z.string()) }).passthrough().optional(),
  tool: z.object({ ok: z.boolean().optional(), signIn: z.boolean().optional(), setup: z.boolean().optional() }).passthrough().optional(),
}).passthrough();
const messages = async (threadId: string) => z.object({ messages: z.array(messageSchema) }).parse((await api("GET", `/api/threads/${threadId}/messages`)).body).messages;

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = createFixtureHome("omb-auth-expired-route-");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({ instances: { claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") } } } }),
  );
  const fixture = join(home, "expired-login.json");
  writeFileSync(fixture, JSON.stringify([{ type: "result", subtype: "success", is_error: true, result: EXPIRED }]));

  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      FAKE_CLAUDE_REPLY_FIXTURE: fixture,
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
  removeTestData(home);
});

describe("an expired Claude login", () => {
  it("answering the first question card fails into a sign-in row", { timeout: 30_000 }, async () => {
    const bot = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }).passthrough() }).parse((await api("POST", "/api/bots", { name: "Nova" })).body).bot;
    const card = (await messages(bot.threadId)).find((message) => message.kind === "options" && message.card);
    expect(card).toBeDefined();
    const answer = card!.card!.options[0]!;
    expect((await api("PATCH", `/api/bots/${bot.id}/cards/${card!.id}`, { answered: answer, dismissed: true })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: answer, threadId: bot.threadId, actedAt: Date.now() })).status).toBeLessThan(300);
    const failed = await vi.waitFor(async () => {
      const row = (await messages(bot.threadId)).find((message) => message.kind === "activity" && message.tool?.ok === false);
      if (!row) throw new Error("no error row yet");
      return row;
    }, { timeout: 20_000, interval: 150 });
    expect(failed.tool).toMatchObject({ setup: true, signIn: true });
  });
});
