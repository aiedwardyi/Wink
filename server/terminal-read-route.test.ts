// The phone's terminal read leaves one server.log line (timing only) and the terminal's own text never reaches it.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const BOT_ID = "term-bot";
const SCREEN = "SCREEN-TEXT-must-stay-out-of-the-log";
const COMMS_TOKEN = "c".repeat(48);
const BRIDGE_TOKEN = "bridge-token-must-stay-out-of-the-log";

let child: ChildProcess;
let bridge: Server;
let home: string;
let port = 0;
let output = "";

const logged = () => output.split("\n").filter((line) => line.includes("terminal read:"));

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = createFixtureHome("omb-terminal-read-");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }));
  writeFileSync(
    join(home, ".orbit", "bots.json"),
    JSON.stringify([
      {
        id: BOT_ID,
        threadId: "term-thread",
        name: "Terminal",
        title: "",
        description: "",
        notifications: true,
        color: "blue",
        unread: false,
        modelSelection: { instanceId: "ghost", model: "none" },
        resumeCursors: {},
        createdAt: 1,
        tasks: [{ threadId: "term-thread", title: "New task", createdAt: 1, resumeCursors: {} }],
      },
    ]),
  );
  bridge = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ botId: BOT_ID, sessionId: "s1", generation: 1, cwd: "C:\\work", exited: false, screenText: SCREEN, recentText: SCREEN }));
  });
  await new Promise<void>((done) => bridge.listen(0, "127.0.0.1", done));

  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_COMMS_TOKEN: COMMS_TOKEN };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up:\n${output}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${output}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}, 30_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await new Promise((done) => bridge.close(done));
  removeTestData(home);
});

describe("terminal read log line", () => {
  it("carries the bot, route, arrival, answer time, bytes and status, and none of the terminal's text", async () => {
    const address = z.object({ port: z.number() }).parse(bridge.address());
    const put = await fetch(`http://127.0.0.1:${port}/api/internal/terminal-bridge`, {
      method: "PUT",
      headers: { authorization: `Bearer ${COMMS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token: BRIDGE_TOKEN }),
    });
    expect(put.status).toBe(200);
    const read = await fetch(`http://127.0.0.1:${port}/api/bots/${BOT_ID}/terminal`);
    expect(read.status).toBe(200);
    expect(await read.text()).toContain(SCREEN);
    const deadline = Date.now() + 5_000;
    while (!logged().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(logged()).toHaveLength(1);
    expect(logged()[0]).toMatch(new RegExp(`^terminal read: bot=${BOT_ID} via=local arrived=\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z ms=\\d+ bytes=[1-9]\\d* status=200$`));
    expect(output).not.toContain(SCREEN);
    expect(output).not.toContain(BRIDGE_TOKEN);
  });
});
