// A real server: a Sign Out press for an instance whose sign-out already runs joins it and gets its answer,
// even while that sign-out's own logout helper is still pending; an idle Sign Out still honours the sign-in owner.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess;
let home: string;
let dir: string;
let port = 0;
let stderr = "";
const tab = "a".repeat(32);
const otherTab = "b".repeat(32);
const at = (name: string) => join(dir, name);
const send = (method: string, path: string, client: string) => fetch(`http://127.0.0.1:${port}${path}`, {
  method, body: method === "GET" ? undefined : "{}", headers: { "content-type": "application/json", "x-wink-client": client },
});
const signOut = async (client: string) => {
  const response = await send("POST", "/api/instances/claude/sign-out", client);
  return { status: response.status, body: await response.json() as unknown };
};
const claudeRow = async (probe = "?refresh=1") => z.object({ instances: z.array(z.object({ instanceId: z.string(), loginState: z.string().optional(), snapshot: z.object({ authenticated: z.boolean().optional() }).passthrough() }).passthrough()) })
  .parse(await (await send("GET", `/api/instances${probe}`, tab)).json()).instances.find((row) => row.instanceId === "claude");
const authenticated = async () => (await claudeRow())?.snapshot.authenticated;
const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (const deadline = Date.now() + 15_000; !await check();) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`${what} never happened. stderr:\n${stderr.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const logouts = () => existsSync(at("logouts")) ? readFileSync(at("logouts"), "utf8").trim().split("\n").length : 0;
// Presses sent while the first sign-out's logout helper still runs; `early` counts any answered before it ends.
const joined = async (clients: string[]) => {
  let early = 0;
  const presses = clients.map((client) => signOut(client).then((press) => { if (!existsSync(at("release"))) early += 1; return press.status; }));
  // A round trip sent after the presses: once it answers, the server has taken them in.
  await claudeRow();
  writeFileSync(at("release"), "");
  return { early, statuses: await Promise.all(presses) };
};

beforeAll(async () => {
  port = await freePortBlock([0, 1], 24_500, 2_000);
  home = createFixtureHome("omb-instance-sign-out-route-");
  dir = join(home, "fake-claude");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(home, ".orbit"), { recursive: true });
  // Claude's CLI with a login that stays open and a logout that waits for `release`; anything else is the usual fake.
  const cli = at("claude-sign-out.cjs");
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const dir = ${JSON.stringify(dir)}, at = (name) => path.join(dir, name), args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  const loggedIn = fs.existsSync(at("auth.json"));
  process.stdout.write(JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" }) + "\\n", () => process.exit(loggedIn ? 0 : 1));
} else if (args[0] === "auth" && args[1] === "login") {
  process.stdout.write("Visit: https://claude.com/cai/oauth/authorize\\n");
  setInterval(() => {}, 1000);
} else if (args[0] === "auth" && args[1] === "logout") {
  fs.appendFileSync(at("logouts"), "logout\\n");
  fs.writeFileSync(at("logout-started"), "");
  const wait = setInterval(() => {
    if (!fs.existsSync(at("release"))) return;
    clearInterval(wait);
    if (fs.existsSync(at("refuse"))) process.exit(1);
    fs.rmSync(at("auth.json"), { force: true });
    process.exit(0);
  }, 25);
} else {
  const run = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(FAKE_CLAUDE_CLI)}, ...args], { stdio: "inherit" });
  process.exit(run.status ?? 1);
}
`);
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli } } } }));
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1) };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: ROOT, env, windowsHide: true });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { return false; } }, "server start");
  await until(async () => await authenticated() === false, "Claude checked");
}, 40_000);

// A failed step must not leave the fake logout waiting.
afterEach(() => { writeFileSync(at("release"), ""); });

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  removeTestData(home);
});

describe("instance Sign Out route", () => {
  // Gate 2120J: a second press while the first sign-out's logout helper ran got 403 and showed "Didn't finish. Try again."
  it("refuses Sign Out from another tab while a sign-in is pending, and lets any press join a running sign-out", async () => {
    // No sign-out runs: the owner check still keeps another tab from ending this tab's pending sign-in.
    expect(await (await send("POST", "/api/instances/claude/sign-in", tab)).json()).toEqual({ url: "https://claude.com/cai/oauth/authorize" });
    expect(await signOut(otherTab)).toEqual({ status: 403, body: expect.objectContaining({ code: "sign-in-elsewhere" }) });
    expect((await claudeRow(""))?.loginState).toBe("pending");
    expect(logouts()).toBe(0);
    expect((await send("DELETE", "/api/instances/claude/sign-in", tab)).status).toBe(200);
    writeFileSync(at("auth.json"), "");
    await until(async () => await authenticated() === true, "Claude connected");

    const first = signOut(tab);
    await until(() => existsSync(at("logout-started")), "logout helper start");
    const presses = await joined([otherTab, tab, "c".repeat(32)]);
    expect({ ...presses, first: (await first).status }).toEqual({ early: 0, statuses: [200, 200, 200], first: 200 });
    expect(logouts()).toBe(1);
    expect(existsSync(at("auth.json"))).toBe(false);
    expect(await authenticated()).toBe(false);
  }, 40_000);

  it("gives every joined press the real failure when the logout fails, and a fresh press after it starts its own", async () => {
    for (const name of ["logouts", "logout-started", "release"]) rmSync(at(name), { force: true });
    writeFileSync(at("auth.json"), "");
    writeFileSync(at("refuse"), "");
    await until(async () => await authenticated() === true, "Claude connected again");

    const first = signOut(tab);
    await until(() => existsSync(at("logout-started")), "logout helper start");
    const presses = await joined([otherTab, tab]);
    expect({ ...presses, first: (await first).status }).toEqual({ early: 0, statuses: [502, 502], first: 502 });
    expect(logouts()).toBe(1);
    expect(await authenticated()).toBe(true);

    rmSync(at("refuse"));
    expect((await signOut(otherTab)).status).toBe(200);
    expect(logouts()).toBe(2);
    expect(await authenticated()).toBe(false);
  }, 40_000);
});
