import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

test("main records the lock loser before exit and the winner before startup", () => {
  const source = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(source, /appendUpdateTrace\(app, process, "lock lost"\);[\s\S]*?process.exit\(0\)/);
  const wiring = source.slice(source.indexOf('appendUpdateTrace(app, process, "start");'), source.indexOf("function deliverPackageInstall"));
  for (const won of [false, true]) {
    const calls = [];
    const exit = new Error("exit");
    const run = () => vm.runInNewContext(wiring, {
      app: { requestSingleInstanceLock: () => { calls.push("lock"); return won; } },
      process: { exit: (code) => { assert.equal(code, 0); calls.push("exit"); throw exit; } },
      console: { log() {} }, appendUpdateTrace: (_app, _runtime, event) => calls.push(event),
    });
    if (won) run();
    else assert.throws(run, (error) => error === exit);
    assert.deepEqual(calls, won ? ["start", "lock", "lock won"] : ["start", "lock", "lock lost", "exit"]);
  }
});

const facts = { pid: 42, ppid: 7, version: "1.0.230", packaged: true, uptime: 0.125, argv: ["C:\\사용자 이름\\Orbit.exe", "--updated", "--force-run", "secret-token", "C:\\private path"] };

test("new-module formatter prints only allowlisted facts and counts other arguments", async () => {
  const { formatUpdateTrace } = await import("./update-trace.mjs");
  assert.equal(formatUpdateTrace("start", { ...facts, secret: "hidden" }), "update start pid=42 ppid=7 version=1.0.230 packaged=1 uptime=0.125 updated=1 forcerun=1 otherArgs=2");
  const line = formatUpdateTrace("lock lost", { ...facts, version: "bad\nC:\\사용자 이름", argv: ["electron", "entry path", "--updated=secret"], packaged: false });
  assert.match(line, /version=unknown packaged=0.*updated=0 forcerun=0 otherArgs=1$/);
  assert.doesNotMatch(line, /사용자|secret|entry|bad|\n/);
  assert.doesNotMatch(formatUpdateTrace("start", { ...facts, version: "1.0.230\n" }), /\n/);
  assert.equal(formatUpdateTrace("secret", facts), null);
});

test("new-module writer appends synchronously to a Unicode and space log path", async (t) => {
  const { appendUpdateTrace } = await import("./update-trace.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, "사용자 이름", "logs");
  const app = { getPath: (name) => { assert.equal(name, "logs"); return logs; }, getVersion: () => facts.version, isPackaged: true };
  const runtime = { ...facts, uptime: () => facts.uptime };
  appendUpdateTrace(app, runtime, "start");
  assert.match(fs.readFileSync(path.join(logs, "update-trace.log"), "utf8"), /^\[\d{4}-[^\]]+Z\] update start pid=42.*otherArgs=2\n$/);
});

const traceLines = (logs) => fs.readdirSync(logs).flatMap((name) => fs.readFileSync(path.join(logs, name), "utf8").split("\n")).filter((line) => line.includes(" update "));

test("new-module writer still records when server.log is past 1 MB and leaves it alone", async (t) => {
  const { appendUpdateTrace } = await import("./update-trace.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = { getPath: () => dir, getVersion: () => facts.version, isPackaged: true };
  const runtime = { ...facts, uptime: () => facts.uptime };
  for (const size of [1048576 - 1, 1048576, 1048576 + 1, 3 * 1048576]) {
    fs.writeFileSync(path.join(dir, "server.log"), "x".repeat(size));
    const before = traceLines(dir).length;
    for (const event of ["start", "lock won", "lock lost"]) appendUpdateTrace(app, runtime, event);
    assert.equal(traceLines(dir).length, before + 3);
    assert.equal(fs.statSync(path.join(dir, "server.log")).size, size);
  }
});

test("new-module writer rotates into at most two bounded files and keeps the newest record", async (t) => {
  const { appendUpdateTrace } = await import("./update-trace.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = { getPath: () => dir, getVersion: () => facts.version, isPackaged: true };
  for (let pid = 1; pid <= 1000; pid++) {
    appendUpdateTrace(app, { ...facts, pid, uptime: () => facts.uptime }, "start");
    assert.ok(fs.readdirSync(dir).length <= 2);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ["update-trace.1.log", "update-trace.log"]);
  assert.ok(fs.readdirSync(dir).every((name) => fs.statSync(path.join(dir, name)).size < 32768 + 300));
  assert.ok(traceLines(dir).length >= 200);
  assert.match(traceLines(dir).at(-1), /update start pid=1000 /);
});

test("new-module writer rotation keeps a record another launch appends mid-rotation", async (t) => {
  const { appendUpdateTrace } = await import("./update-trace.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "update-trace.log");
  const app = { getPath: () => dir, getVersion: () => facts.version, isPackaged: true };
  const runtime = { ...facts, uptime: () => facts.uptime };
  fs.writeFileSync(file, `[2026-11-05T00:00:00.000Z] update start pid=1 ppid=7 version=1.0.230 packaged=1 uptime=0.100 updated=0 forcerun=0 otherArgs=0\n`.repeat(400));
  let raced = false;
  const other = () => { if (!raced) { raced = true; fs.appendFileSync(file, "[2026-11-05T00:00:01.000Z] update lock lost pid=999 ppid=7 version=1.0.230 packaged=1 uptime=0.100 updated=0 forcerun=0 otherArgs=0\n"); } };
  const io = { ...fs, statSync: (target) => { const stat = fs.statSync(target); other(); return stat; }, readFileSync: (target, encoding) => { const text = fs.readFileSync(target, encoding); other(); return text; } };
  appendUpdateTrace(app, runtime, "lock won", io);
  const lines = traceLines(dir);
  assert.ok(raced);
  assert.equal(lines.filter((line) => line.includes("pid=999")).length, 1);
  assert.equal(lines.filter((line) => line.includes("update lock won pid=42")).length, 1);
});

test("new-module writer swallows filesystem and app lookup failures", async () => {
  const { appendUpdateTrace } = await import("./update-trace.mjs");
  const app = { getPath: () => "fake logs", getVersion: () => facts.version, isPackaged: true };
  const runtime = { ...facts, uptime: () => facts.uptime };
  for (const code of ["ENOENT", "EACCES", "EBUSY", "ENOSPC"]) {
    for (const method of ["mkdirSync", "statSync", "renameSync", "appendFileSync"]) {
      let writes = 0;
      const io = { mkdirSync() {}, statSync: () => ({ size: 1048576 }), renameSync() {}, appendFileSync() { writes++; } };
      io[method] = () => { throw Object.assign(new Error(code), { code }); };
      assert.doesNotThrow(() => appendUpdateTrace(app, runtime, "start", io));
      assert.equal(writes, method === "statSync" || method === "renameSync" ? 1 : 0);
    }
  }
  assert.doesNotThrow(() => appendUpdateTrace({ getPath() { throw new Error("lookup"); } }, runtime, "start"));
});
