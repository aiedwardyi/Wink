import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { statsEventSchema } from "../shared/usage-stats.ts";
import { installCrashStats, statsUrl } from "./usage-stats.mjs";

const scratch = process.env.ORBIT_SCRATCH ?? path.join(os.tmpdir(), "wink-STATS-APP");
fs.mkdirSync(scratch, { recursive: true });
const source = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const RELAY = "https://stats.example/v1/stats";

test("a build with no stats address sends nowhere", () => {
  for (const read of [() => { throw new Error("ENOENT"); }, () => JSON.parse("{"), () => null, () => ({}), () => ({ statsUrl: 4 }), () => ({ dsn: RELAY })]) assert.equal(statsUrl(read), "");
  assert.equal(statsUrl(() => ({ dsn: "", statsUrl: RELAY })), RELAY);
  const main = source("./main.mjs");
  assert.match(main, /STATS_URL = verifyProbe \? "" : statsUrl\(\(\) => require\("\.\/error-report-config.json"\)\)/);
  assert.match(main, /WINK_STATS_URL: STATS_URL,/);
});

test("release and dev builds bake the repo stats variable, including empty and unset values", (t) => {
  for (const file of ["release.yml", "dev-build.yml"]) {
    const workflow = source(`../.github/workflows/${file}`);
    assert.match(workflow, /WINK_STATS_URL: \$\{\{ vars\.WINK_STATS_URL \}\}/);
    assert.doesNotMatch(workflow, /WINK_STATS_URL: https?:/);
  }
  const dir = fs.mkdtempSync(path.join(scratch, "stats-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "config.json");
  for (const value of [undefined, "", ` ${RELAY} `]) {
    const env = { ...process.env };
    delete env.ERROR_REPORT_DSN;
    if (value === undefined) delete env.WINK_STATS_URL;
    else env.WINK_STATS_URL = value;
    const result = spawnSync(process.execPath, ["scripts/write-error-report-config.mjs", target], { env, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { dsn: "", statsUrl: value?.trim() ?? "" });
  }
});

function shell(statuses = []) {
  const app = new EventEmitter();
  const owner = {};
  const posted = [];
  const clock = { seconds: 30 };
  const crashes = installCrashStats(app, () => owner, async (events) => {
    posted.push(events);
    return statuses.length ? statuses.shift() : 200;
  }, () => clock.seconds);
  return { app, owner, posted, clock, crashes };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a renderer that dies is one crash event with a kind, an exit code and an uptime step", async () => {
  const { app, owner, posted, clock } = shell();
  app.emit("render-process-gone", {}, owner, { reason: "crashed", exitCode: -1073741819 });
  clock.seconds = 700;
  app.emit("render-process-gone", {}, owner, { reason: "oom", exitCode: 9 });
  app.emit("render-process-gone", {}, owner, { reason: "clean-exit", exitCode: 0 });
  app.emit("render-process-gone", {}, {}, { reason: "crashed", exitCode: 1 });
  await settle();
  assert.deepEqual(posted.flat(), [
    { e: "crash", process: "renderer", kind: "renderer-gone", exit: -1073741819, up: 0 },
    { e: "crash", process: "renderer", kind: "oom", exit: 9, up: 2 },
  ]);
  for (const event of posted.flat()) assert.equal(statsEventSchema.safeParse({ ...event, h: 1 }).success, true);
});

test("a server exit and a startup timeout wait in memory until a server can take them", async () => {
  const { posted, clock, crashes } = shell([null, null, 200]);
  crashes.capture("server", "server-gone", 1);
  await settle();
  clock.seconds = 4000;
  crashes.capture("main", "startup-timeout", null);
  await settle();
  assert.equal(posted.length, 2);
  await crashes.flush();
  await crashes.flush();
  assert.equal(posted.length, 3);
  assert.deepEqual(posted[2], [
    { e: "crash", process: "server", kind: "server-gone", exit: 1, up: 0 },
    { e: "crash", process: "main", kind: "startup-timeout", up: 3 },
  ]);
  for (const event of posted[2]) assert.equal(statsEventSchema.safeParse({ ...event, h: 1 }).success, true);
});

test("holds at most 50 crashes, and drops the ones a server refused", async () => {
  const down = shell(Array(80).fill(null));
  for (let index = 0; index < 60; index++) down.crashes.capture("server", "server-gone", index);
  await settle();
  down.posted.length = 0;
  await down.crashes.flush();
  assert.equal(down.posted[0].length, 50);
  assert.equal(down.posted[0][0].exit, 0);
  const off = shell([409]);
  off.crashes.capture("server", "server-gone", 1);
  await settle();
  await off.crashes.flush();
  assert.equal(off.posted.length, 1);
  const thrown = installCrashStats(new EventEmitter(), () => null, async () => { throw new Error("ECONNREFUSED"); }, () => 1);
  thrown.capture("server", "server-gone", 1);
  await settle();
});

test("main forwards the crashes only it can see and never posts without a server", () => {
  const main = source("./main.mjs");
  assert.match(main, /if \(!killed\) crashStats\.capture\("server", "server-gone", code\);/);
  assert.match(main, /crashStats\.capture\("main", "startup-timeout"\);/);
  assert.match(main, /if \(!serverToken\) return null;/);
  assert.match(main, /void crashStats\.flush\(\);/);
});

test("stats off on any screen turns crash reports off on this PC over the authenticated bridge", async (t) => {
  const { createTerminalBridge } = await import("./terminal-bridge.mjs");
  const { createErrorReports } = await import("./error-reports.mjs");
  const { turnOffErrorReports } = await import("../server/error-reports.ts");
  const { createHmac } = await import("node:crypto");
  const dir = fs.mkdtempSync(path.join(scratch, "stats-consent-"));
  const reporter = createErrorReports({ userData: dir, dsn: "http://public@127.0.0.1:9/1", build: "1.0.0", platform: "win32", arch: "x64" });
  const bridge = createTerminalBridge({ host: { readBot() {}, sendBot() {} }, errorReports: reporter });
  const access = await bridge.start();
  t.after(async () => {
    reporter.stop();
    await bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const grant = createHmac("sha256", access.token).update("orbit-error-report-v1").digest("base64url");
  const post = async (body, authorization = `Bearer ${grant}`) => {
    const response = await fetch(`${access.url}/v1/error-reports`, { method: "POST", headers: { authorization }, body: JSON.stringify(body) });
    await response.body?.cancel();
    return response.status;
  };
  reporter.setConsent(true);
  assert.equal(await post({ consent: false }, `Bearer ${access.token}`), 401);
  // The bridge can only turn reports off: on stays a choice made on the PC itself.
  for (const body of [{ consent: true }, { consent: "false" }, { consent: false, site: 9 }, {}]) assert.equal(await post(body), 400, JSON.stringify(body));
  assert.equal(reporter.consent(), true);
  await turnOffErrorReports(access);
  assert.equal(reporter.consent(), false);
  await turnOffErrorReports(null);
});

test("README inventories what the stats send, where, and every local file", () => {
  const readme = source("../README.md");
  const sends = readme.split("**Sends with no setup**")[1].split("**Sends once you set something up**")[0];
  assert.match(sends, /Anonymous usage stats.*WINK_STATS_URL/);
  assert.match(sends, /256 KB/);
  assert.match(sends, /(?:PC|computer)'s IP/);
  assert.match(sends, /Never message text, file names or paths, bot or room names, emails, account IDs, room codes or error text/);
  assert.doesNotMatch(readme, /relay\.wink\.edwardyi\.dev\/v1\/stats/);
  const stores = readme.split("**Stores**")[1].split("**Approvals**")[0];
  for (const file of ["analytics.json", "stats-id", "stats-queue.ndjson", "stats-active"]) assert.ok(stores.includes(file), file);
  assert.match(stores, /Wink doesn't sync these/);
});
