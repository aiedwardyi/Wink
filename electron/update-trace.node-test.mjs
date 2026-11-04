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
  assert.match(fs.readFileSync(path.join(logs, "server.log"), "utf8"), /^\[\d{4}-[^\]]+Z\] update start pid=42.*otherArgs=2\n$/);
  for (const size of [1048576 - 1, 1048576, 1048576 + 1]) {
    fs.writeFileSync(path.join(logs, "server.log"), "x".repeat(size));
    appendUpdateTrace(app, runtime, "lock won");
    assert.equal(fs.statSync(path.join(logs, "server.log")).size, size);
  }
});

test("new-module writer swallows filesystem and app lookup failures", async () => {
  const { appendUpdateTrace } = await import("./update-trace.mjs");
  const app = { getPath: () => "fake logs", getVersion: () => facts.version, isPackaged: true };
  const runtime = { ...facts, uptime: () => facts.uptime };
  for (const code of ["ENOENT", "EACCES", "EBUSY", "ENOSPC"]) {
    for (const method of ["statSync", "mkdirSync", "appendFileSync"]) {
      let writes = 0;
      const io = { statSync: () => ({ size: 0 }), mkdirSync() {}, appendFileSync() { writes++; } };
      io[method] = () => { throw Object.assign(new Error(code), { code }); };
      assert.doesNotThrow(() => appendUpdateTrace(app, runtime, "start", io));
      assert.equal(writes, method === "statSync" && code === "ENOENT" ? 1 : 0);
    }
  }
  assert.doesNotThrow(() => appendUpdateTrace({ getPath() { throw new Error("lookup"); } }, runtime, "start"));
});
