import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { createPaneCleanup } from "./pane-cleanup.mjs";
import { createTerminalHost } from "./terminal-host.mjs";

const DAY_MS = 86_400_000;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();

function fixture(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pane-cleanup-")));
  const tempRoot = path.join(home, "temp");
  const worktreeRoot = path.join(home, "worktrees");
  fs.mkdirSync(tempRoot);
  fs.mkdirSync(worktreeRoot);
  let time = Date.now();
  let open = [];
  const jobs = [];
  const warnings = [];
  const priorities = [];
  const options = { home, tempRoot, worktreeRoot, now: () => time, setPriority: (pid, priority) => priorities.push({ pid, priority }), warn: (error) => warnings.push(error), schedule: (run, ms) => { const job = { run, ms }; jobs.push(job); return job; }, cancel: (job) => { const index = jobs.indexOf(job); if (index !== -1) jobs.splice(index, 1); } };
  const cleanup = createPaneCleanup(options);
  cleanup.start(() => open);
  t.after(async () => { cleanup.dispose(); await cleanup.flush(); await removeTempDir(home); assert.equal(fs.existsSync(home), false); });
  const session = { id: "pane-1", botId: "bot", label: "TEST | model | high", cwd: home, tempRoot, reportAt: time };
  const scratch = path.join(tempRoot, "wink-TEST");
  fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(scratch, "file"), "scratch");
  const ledger = () => JSON.parse(fs.readFileSync(path.join(home, ".orbit", "pane-ledger.json"), "utf8"));
  return { home, tempRoot, worktreeRoot, session, scratch, cleanup, options, jobs, warnings, priorities, ledger, advance: (ms) => { time += ms; }, open: (panes) => { open = panes; } };
}

function repo(f, name = "worker") {
  const main = path.join(f.home, "repo");
  fs.mkdirSync(main);
  git(main, "init", "--quiet");
  git(main, "config", "user.name", "Test");
  git(main, "config", "user.email", "test@example.test");
  fs.writeFileSync(path.join(main, "file"), "saved");
  fs.writeFileSync(path.join(main, ".gitignore"), "node_modules\n");
  git(main, "add", ".");
  git(main, "commit", "--quiet", "-m", "fixture");
  git(main, "update-ref", "refs/remotes/test/main", "HEAD");
  const target = path.join(f.worktreeRoot, name);
  git(main, "worktree", "add", "--quiet", "-b", `test-${name}`, target);
  f.session.cwd = target;
  return { main, target };
}

async function eligible(f) {
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session, true);
  f.advance(4 * DAY_MS);
}

test("reported scratch is removed and its junction target survives", async (t) => {
  const f = fixture(t);
  const target = path.join(f.home, "user-files");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "precious"), "survives");
  fs.mkdirSync(path.join(f.scratch, "nested"));
  fs.symlinkSync(target, path.join(f.scratch, "nested", "link"), process.platform === "win32" ? "junction" : "dir");
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(fs.existsSync(f.scratch), false);
  assert.equal(fs.readFileSync(path.join(target, "precious"), "utf8"), "survives");
  assert.match(fs.readFileSync(path.join(f.home, ".orbit", "cleanup.log"), "utf8"), /"kind":"scratch"/);
  assert.equal(f.ledger()[0].reported, true);
});

for (const gate of ["keep", "no report", "same nick", "cwd inside", "invalid nick", "not first field", "wrong scratch", "relative temp", "linked root"]) {
  test(`scratch protects ${gate}`, async (t) => {
    const f = fixture(t);
    if (gate === "no report") f.session.reportAt = 0;
    if (gate === "same nick") f.open([{ id: "other", label: "TEST | other", cwd: f.home }]);
    if (gate === "cwd inside") f.open([{ id: "other", label: "OTHER", cwd: path.join(f.scratch, "nested") }]);
    if (gate === "invalid nick") f.session.label = "../TEST | model";
    if (gate === "not first field") f.session.label = "invalid name | TEST";
    if (gate === "wrong scratch") f.session.tempRoot = path.join(f.home, "other-temp");
    if (gate === "relative temp") f.session.tempRoot = "relative-temp";
    let target;
    if (gate === "linked root") {
      target = path.join(f.home, "user-files");
      fs.renameSync(f.scratch, target);
      fs.symlinkSync(target, f.scratch, process.platform === "win32" ? "junction" : "dir");
    }
    f.cleanup.opened(f.session);
    await f.cleanup.closed(f.session, gate === "keep");
    assert.equal(fs.existsSync(f.scratch), true);
    if (target) {
      assert.equal(fs.existsSync(path.join(target, "file")), true);
      fs.unlinkSync(f.scratch);
    }
  });
}

test("kept scratch expires after three days and crash scratch after one", async (t) => {
  for (const keep of [true, false]) {
    const f = fixture(t);
    f.session.reportAt = 0;
    f.cleanup.opened(f.session);
    await f.cleanup.closed(f.session, keep);
    f.advance((keep ? 3 : 1) * DAY_MS - 1);
    await f.cleanup.sweep();
    assert.equal(fs.existsSync(f.scratch), true);
    f.advance(1);
    await f.cleanup.sweep();
    assert.equal(fs.existsSync(f.scratch), false);
  }
});

test("startup recovers an unclosed ledger row without resetting its crash age again", async (t) => {
  const f = fixture(t);
  f.cleanup.opened(f.session);
  const restarted = createPaneCleanup(f.options);
  restarted.start(() => []);
  t.after(() => restarted.dispose());
  assert.ok(f.ledger()[0].closedAt);
  f.advance(DAY_MS);
  await restarted.sweep();
  assert.equal(fs.existsSync(f.scratch), false);
});

test("an old scratch row cannot expire a newer hand-off", async (t) => {
  const f = fixture(t);
  await eligible(f);
  const next = { ...f.session, id: "next-pane" };
  f.cleanup.opened(next);
  await f.cleanup.closed(next, true);
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(f.scratch), true);
  f.advance(3 * DAY_MS);
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(f.scratch), false);
});

test("scratch absent from the ledger is never swept", async (t) => {
  const f = fixture(t);
  f.advance(10 * DAY_MS);
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(f.scratch), true);
});

test("startup and six-hour sweeps use unreferenced timers", (t) => {
  const f = fixture(t);
  assert.equal(f.jobs[0].ms, 1_000);
  f.jobs.shift().run();
  assert.equal(f.jobs[0].ms, 6 * 60 * 60_000);
});

test("a busy delete retries once after sixty seconds and rechecks open panes", async (t) => {
  const f = fixture(t);
  const promises = await import("node:fs/promises");
  const original = promises.default.rm;
  let attempts = 0;
  t.mock.method(promises.default, "rm", async (...args) => {
    if (args[0] === f.scratch) { attempts++; throw Object.assign(new Error("busy"), { code: "EBUSY" }); }
    return original(...args);
  });
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(attempts, 1);
  const retry = f.jobs.find((job) => job.ms === 60_000);
  assert.ok(retry);
  retry.run();
  await f.cleanup.flush();
  assert.equal(attempts, 2);
  assert.equal(f.jobs.filter((job) => job.ms === 60_000).length, 1);
  t.mock.restoreAll();
});

test("a busy retry preserves scratch claimed by a new pane", async (t) => {
  const f = fixture(t);
  const promises = await import("node:fs/promises");
  const original = promises.default.rm;
  let attempts = 0;
  t.mock.method(promises.default, "rm", async (...args) => {
    if (args[0] === f.scratch) { attempts++; throw Object.assign(new Error("busy"), { code: "EBUSY" }); }
    return original(...args);
  });
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  f.open([{ id: "new", label: "TEST", cwd: f.home }]);
  f.jobs.find((job) => job.ms === 60_000).run();
  await f.cleanup.flush();
  assert.equal(attempts, 1);
  assert.equal(fs.existsSync(f.scratch), true);
  t.mock.restoreAll();
});

test("a saved, clean, idle ledger worktree is removed without its branch or link target", async (t) => {
  const f = fixture(t);
  const { main, target } = repo(f);
  const shared = path.join(f.home, "shared-packages");
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, "package"), "safe");
  fs.symlinkSync(shared, path.join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await eligible(f);
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(target), false, f.warnings.map(String).join("\n"));
  assert.ok(f.priorities.length > 0);
  assert.ok(f.priorities.every(({ pid, priority }) => Number.isInteger(pid) && priority === os.constants.priority.PRIORITY_LOW));
  assert.deepEqual(f.warnings, []);
  assert.equal(fs.readFileSync(path.join(shared, "package"), "utf8"), "safe");
  assert.match(git(main, "branch", "--list", "test-worker"), /test-worker/);
  assert.doesNotMatch(git(main, "worktree", "list"), /worktrees[\\/]worker/);
});

test("a primary checkout keeps its links even when its cwd is in the ledger", async (t) => {
  const f = fixture(t);
  const { main } = repo(f);
  const shared = path.join(f.home, "shared-packages");
  fs.mkdirSync(shared);
  fs.symlinkSync(shared, path.join(main, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  f.session.cwd = main;
  await eligible(f);
  const cleanup = createPaneCleanup({ ...f.options, worktreeRoot: f.home });
  cleanup.start(() => []);
  t.after(() => cleanup.dispose());
  await cleanup.sweep();
  assert.equal(fs.existsSync(main), true);
  assert.equal(fs.lstatSync(path.join(main, "node_modules")).isSymbolicLink(), true);
  assert.deepEqual(f.warnings, []);
});

for (const gate of ["dirty", "unpushed", "open pane", "recent close", "recent write", "incoming worktree link", "incoming scratch link", "rel-build", "relay-deploy", "nm-packages", "release-gate", "pinned", "locked", "non-ledger", "user folder", "linked ancestor", "linked worktree"]) {
  test(`worktree protects ${gate}`, async (t) => {
    const f = fixture(t);
    const name = ["rel-build", "relay-deploy", "nm-packages", "release-gate"].includes(gate) ? gate : "worker";
    const { target } = repo(f, name);
    const shared = path.join(f.home, "shared-packages");
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, "package"), "safe");
    fs.symlinkSync(shared, path.join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    if (gate === "locked") git(target, "worktree", "lock", target);
    let link;
    if (gate === "dirty") fs.writeFileSync(path.join(target, "file"), "unsaved");
    if (gate === "unpushed") {
      fs.writeFileSync(path.join(target, "file"), "local commit");
      git(target, "commit", "--quiet", "-am", "local");
    }
    if (gate === "open pane") f.open([{ id: "other", label: "OTHER", cwd: path.join(target, "subfolder") }]);
    if (gate === "incoming worktree link" || gate === "incoming scratch link") {
      const host = gate === "incoming worktree link" ? path.join(f.worktreeRoot, "host") : path.join(f.tempRoot, "wink-OTHER");
      fs.mkdirSync(path.join(host, "one", "two"), { recursive: true });
      link = path.join(host, "one", "two", "link");
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    }
    if (gate === "pinned") f.options.pinned = [target];
    if (gate === "user folder") f.session.cwd = f.home;
    if (gate !== "non-ledger") await eligible(f);
    else f.advance(4 * DAY_MS);
    if (gate === "recent close") {
      f.cleanup.opened({ ...f.session, id: "recent" });
      await f.cleanup.closed({ ...f.session, id: "recent" }, true);
    }
    if (gate === "recent write") {
      const future = new Date(Date.now() + 4 * DAY_MS);
      fs.utimesSync(path.join(target, "file"), future, future);
    }
    let protectedTarget = target;
    if (gate === "linked ancestor") {
      const moved = path.join(f.home, "moved-worktrees");
      fs.renameSync(f.worktreeRoot, moved);
      link = f.worktreeRoot;
      fs.symlinkSync(moved, link, process.platform === "win32" ? "junction" : "dir");
      protectedTarget = path.join(moved, name);
    }
    if (gate === "linked worktree") {
      protectedTarget = path.join(f.home, "moved-worker");
      fs.renameSync(target, protectedTarget);
      link = target;
      fs.symlinkSync(protectedTarget, link, process.platform === "win32" ? "junction" : "dir");
    }
    if (gate === "pinned") {
      const pinned = createPaneCleanup(f.options);
      pinned.start(() => []);
      await pinned.sweep();
      pinned.dispose();
    } else await f.cleanup.sweep();
    assert.equal(fs.existsSync(protectedTarget), true);
    assert.equal(fs.existsSync(path.join(protectedTarget, "file")), true);
    assert.equal(fs.lstatSync(path.join(protectedTarget, "node_modules")).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(shared, "package"), "utf8"), "safe");
    assert.deepEqual(f.warnings, []);
    if (link) fs.unlinkSync(link);
  });
}

for (const close of ["closeForBot", "close"]) {
  test(`${close} cleans reported scratch after retiring the shell`, async (t) => {
    const f = fixture(t);
    const owner = { id: 1, send() {}, isDestroyed: () => false };
    let killed = false;
    const host = createTerminalHost({
      authorize() {}, owner: () => owner, resolveCwd: async () => f.home,
      platform: "linux", env: { SHELL: "/bin/sh", TEMP: f.tempRoot }, freeMemory: () => 64 * 1024 ** 3,
      paneCleanup: f.cleanup,
      loadPty: () => ({ spawn: () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() { killed = true; } }) }),
    });
    t.after(() => host.dispose());
    const pane = await host.openForBot("bot", { label: "TEST | model", command: "codex test" });
    host.attendBot("bot", pane.sessionId, "report");
    if (close === "closeForBot") await host.closeForBot("bot", pane.sessionId);
    else await host.close({ sender: owner }, pane.sessionId);
    await f.cleanup.flush();
    assert.equal(killed, true);
    assert.equal(fs.existsSync(f.scratch), false);
    assert.equal(f.ledger()[0].closedAt > 0, true);
  });
}

for (const action of ["keep", "no report", "dispose", "natural exit"]) {
  test(`host preserves scratch on ${action}`, async (t) => {
    const f = fixture(t);
    const owner = { id: 1, send() {}, isDestroyed: () => false };
    let exit;
    const host = createTerminalHost({
      authorize() {}, owner: () => owner, resolveCwd: async () => f.home,
      platform: "linux", env: { SHELL: "/bin/sh", TEMP: f.tempRoot }, freeMemory: () => 64 * 1024 ** 3,
      paneCleanup: f.cleanup,
      loadPty: () => ({ spawn: () => ({ onData() {}, onExit(cb) { exit = cb; }, write() {}, resize() {}, kill() {} }) }),
    });
    t.after(() => host.dispose());
    const pane = await host.openForBot("bot", { label: "TEST", command: "codex test" });
    if (action !== "no report") host.attendBot("bot", pane.sessionId, "report");
    if (action === "dispose") await host.dispose();
    else if (action === "natural exit") exit({ exitCode: 0 });
    else await host.closeForBot("bot", pane.sessionId, action === "keep");
    await f.cleanup.flush();
    assert.equal(fs.existsSync(f.scratch), true);
  });
}
