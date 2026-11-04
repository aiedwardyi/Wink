import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUpdateHandoff } from "./update-handoff.mjs";

function fixture(t, overrides = {}) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "update-handoff-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const calls = [];
  let current = "1.0.228";
  const handoff = createUpdateHandoff({ userData: () => temporary, version: () => current, message: () => "updating",
    log: (line) => calls.push(line), platform: "win32", temporary,
    stage: () => "script", capture: async () => { calls.push("capture"); return {}; },
    start: async (_script, file) => { calls.push("visible"); writeFileSync(JSON.parse(readFileSync(file, "utf8")).ready, ""); },
    stop: async () => { calls.push("sweep"); }, ...overrides });
  return { handoff, calls, temporary, setVersion: (value) => { current = value; } };
}

test("update captures descendants before cleanup and sweeps before the installer while progress outlives quit", async (t) => {
  const f = fixture(t);
  await f.handoff.run(true, async () => { f.calls.push("cleanup"); });
  f.calls.push("install");
  assert.deepEqual(f.calls.slice(0, 4), ["visible", "capture", "cleanup", "sweep"]);
  assert.equal(f.calls.at(-1), "install");
  const saved = JSON.parse(readFileSync(path.join(f.temporary, "update-progress.json"), "utf8"));
  f.handoff.finish();
  assert.equal(existsSync(path.join(saved.directory, "complete")), false);
  f.setVersion("1.0.229");
  f.handoff.finish();
  assert.equal(existsSync(path.join(saved.directory, "complete")), true);
  assert.equal(existsSync(path.join(f.temporary, "update-progress.json")), false);
});

test("ordinary quit, development and other platforms skip Windows handoff", async (t) => {
  for (const [updating, options] of [[false, {}], [true, { platform: "darwin" }], [true, { packaged: false }]]) {
    const f = fixture(t, options);
    await f.handoff.run(updating, async () => f.calls.push("cleanup"));
    assert.deepEqual(f.calls, ["cleanup"]);
    assert.deepEqual(readdirSync(f.temporary), []);
  }
});

test("repeated quit waits for one visible progress window and one cleanup", async (t) => {
  const f = fixture(t);
  const cleanup = async () => f.calls.push("cleanup");
  const first = f.handoff.run(true, cleanup);
  assert.equal(f.handoff.run(true, cleanup), first);
  await first;
  assert.equal(f.calls.filter((call) => call === "cleanup").length, 1);
});

test("unavailable Windows helpers leave processes alone and preserve the install fallback", async (t) => {
  const f = fixture(t, { capture: async () => { throw new Error("snapshot unavailable"); } });
  await f.handoff.run(true, async () => f.calls.push("cleanup"));
  assert.equal(f.calls.includes("sweep"), false);
  assert.equal(f.calls.includes("cleanup"), true);
});

test("a progress window that never appears is bounded and does not block cleanup", async (t) => {
  let elapsed = 0;
  const f = fixture(t, { start: async () => {}, now: () => elapsed, sleep: async () => { elapsed += 5000; } });
  await f.handoff.run(true, async () => f.calls.push("cleanup"));
  assert.equal(elapsed, 15_000);
  assert.equal(f.calls.includes("cleanup"), true);
  assert.equal(f.calls.includes("sweep"), false);
  const directory = readdirSync(f.temporary).find((entry) => entry.startsWith("wink-update-"));
  assert.equal(existsSync(path.join(f.temporary, directory, "complete")), true);
});

test("a failed sweep is logged and still hands off to the installer", async (t) => {
  const f = fixture(t, { stop: async () => { throw new Error("cannot query processes"); } });
  await f.handoff.run(true, async () => f.calls.push("cleanup"));
  assert.ok(f.calls.some((call) => call.includes("update cleanup incomplete")));
  assert.equal(f.calls.at(-1), "update handoff ready; starting installer");
});

test("an installer that cannot start dismisses its progress window", async (t) => {
  const f = fixture(t);
  await f.handoff.run(true, async () => {});
  const record = path.join(f.temporary, "update-progress.json");
  const saved = JSON.parse(readFileSync(record, "utf8"));
  f.handoff.cancel();
  assert.equal(existsSync(path.join(saved.directory, "complete")), true);
  assert.equal(existsSync(record), false);
});

test("main wraps shutdown in the update handoff and completes it only after the new UI loads", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /updateHandoff\.run\(isUpdateInstallPending\(\), \(\) => Promise\.race/);
  assert.match(main, /if \(isPackagedAppUrl\(win\.webContents\.getURL\(\), SERVER_PORT\)\) updateHandoff\.finish\(\)/);
  const progress = readFileSync(new URL("./update-handoff.ps1", import.meta.url), "utf8");
  assert.match(progress, /Test-Path -LiteralPath \$request\.complete/);
  assert.match(progress, /\$form\.ControlBox = \$false/);
});
