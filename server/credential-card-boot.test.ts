import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { spawnHarness as spawn, harnessFetch as fetch, harnessToken } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const HOST = "api.boot-saved.example";

let child: ChildProcess;
let home: string;
let port = 0;
let output = "";
const origin = () => `http://127.0.0.1:${port}`;

const botsSchema = z.object({
  bots: z.array(z.object({
    id: z.string(),
    busy: z.boolean(),
    messages: z.array(z.object({ id: z.string(), secret: z.object({ provided: z.boolean().optional() }).optional() })),
  })),
});

async function boot(env: Record<string, string> = {}) {
  output = "";
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: { ...process.env, ...env, HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), ORBIT_REMOTE_AUTO: "0" },
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${origin()}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${output}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${output}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = createFixtureHome("omb-credential-boot-");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(
    join(home, ".orbit", "config.json"),
    JSON.stringify({ instances: { claude: { driver: "claudeAgent", displayName: "Fixture Claude", environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PROMPT_LOG: join(home, "prompts.ndjson") }, config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") } } } }),
  );
  await boot();
}, 30_000);

afterAll(async () => {
  if (child?.exitCode === null) await waitForExit(child, { signal: "SIGTERM" });
  removeTestData(home);
});

describe("key cards at boot", () => {
  it("leaves an old card for an already saved key asleep at boot", async () => {
    const created = await fetch(`${origin()}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Waiting" }) });
    const { bot } = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }) }).parse(await created.json());
    const requested = await fetch(`${origin()}/api/internal/request-credential`, {
      method: "POST",
      headers: { authorization: `Bearer ${await harnessToken(origin())}`, "content-type": "application/json" },
      body: JSON.stringify({ fromBotId: bot.id, fromThreadId: bot.threadId, credentialId: "custom", service: { name: "Boot Key", host: HOST } }),
    });
    expect(requested.status).toBe(201);
    const { messageId } = z.object({ messageId: z.string() }).parse(await requested.json());
    await waitForExit(child, { signal: "SIGTERM" });

    await boot({ OMB_CUSTOM_KEYS: JSON.stringify({ [HOST]: { name: "Boot Key", header: "x-api-key", prefix: "", key: "test-only-key" } }) });
    await expect.poll(() => output.includes("startup {"), { timeout: 15_000 }).toBe(true);
    const state = botsSchema.parse(await (await fetch(`${origin()}/api/bots`)).json()).bots.find((row) => row.id === bot.id);
    expect(state?.messages.find((row) => row.id === messageId)?.secret).toBeDefined();
    expect(state?.messages.find((row) => row.id === messageId)?.secret?.provided).toBeUndefined();
    expect(state?.busy).toBe(false);
  }, 60_000);
});
