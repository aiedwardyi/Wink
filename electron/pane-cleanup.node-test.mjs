import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import test from "node:test";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { SWEEP_BUDGET, createPaneCleanup, createPaneCleanupWorker, readCleanupPins } from "./pane-cleanup.mjs";
import { createTerminalHost } from "./terminal-host.mjs";

const DAY_MS = 86_400_000;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();

function fixture(t, short = false) {
  let home = fs.mkdtempSync(path.join(os.tmpdir(), "pane-cleanup-"));
  if (short) {
    const script = "$ProgressPreference = 'SilentlyContinue'; (New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:PANE_CLEANUP_TEST_HOME).ShortPath";
    const alias = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PANE_CLEANUP_TEST_HOME: home } }).trim();
    if (path.resolve(alias).toLowerCase() === fs.realpathSync.native(home).toLowerCase()) {
      fs.rmdirSync(home);
      t.skip("8.3 names are disabled on the fixture volume");
      return null;
    }
    assert.equal(fs.realpathSync.native(alias), fs.realpathSync.native(home));
    home = alias;
  }
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

function trackedLink(f, target) {
  const precious = path.join(f.home, "precious");
  fs.mkdirSync(precious);
  fs.writeFileSync(path.join(precious, "file"), "safe");
  git(target, "config", "core.symlinks", "true");
  const link = path.join(target, "tracked-link");
  fs.symlinkSync(precious, link, process.platform === "win32" ? "junction" : "dir");
  if (process.platform === "win32") {
    const hash = execFileSync("git", ["-C", target, "hash-object", "-w", "--stdin"], { input: fs.readlinkSync(link), encoding: "utf8", windowsHide: true }).trim();
    git(target, "update-index", "--add", "--cacheinfo", "120000", hash, "tracked-link");
    git(target, "update-index", "--assume-unchanged", "tracked-link");
  } else git(target, "add", "tracked-link");
  git(target, "commit", "--quiet", "-m", "link");
  git(target, "update-ref", "refs/remotes/test/main", "HEAD");
  assert.match(git(target, "ls-files", "--stage", "tracked-link"), /^120000 /);
  assert.equal(git(target, "status", "--porcelain"), "");
  return { precious, link };
}

async function eligible(f) {
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session, true);
  f.advance(4 * DAY_MS);
}

for (const missing of ["bots.json", "groups.json"]) {
  test(`absent ${missing} leaves the other pin collection active`, async (t) => {
    const f = fixture(t);
    const { target } = repo(f);
    const data = path.join(f.home, "data");
    fs.mkdirSync(data);
    const present = path.join(data, missing === "bots.json" ? "groups.json" : "bots.json");
    fs.writeFileSync(present, JSON.stringify([{ cwd: target }]));
    assert.deepEqual(await readCleanupPins(data), [target]);
    await eligible(f);
    const cleanup = createPaneCleanup({ ...f.options, pinned: () => readCleanupPins(data) });
    cleanup.start(() => []);
    t.after(() => cleanup.dispose());
    await cleanup.sweep();
    assert.equal(fs.existsSync(target), true);
    fs.writeFileSync(present, "[]");
    await cleanup.sweep();
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(f.warnings, []);
  });
}

for (const pin of ["checkout", "missing child", "ancestor"]) {
  test(`a symlinked project pin protects its ${pin}`, async (t) => {
    const f = fixture(t);
    const { target } = repo(f);
    const alias = path.join(f.home, "project");
    fs.symlinkSync(pin === "ancestor" ? f.worktreeRoot : target, alias, process.platform === "win32" ? "junction" : "dir");
    const cwd = pin === "missing child" ? path.join(alias, "not-created", "child") : alias;
    await eligible(f);
    const cleanup = createPaneCleanup({ ...f.options, pinned: [cwd] });
    cleanup.start(() => []);
    t.after(() => cleanup.dispose());
    await cleanup.sweep();
    assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
    assert.deepEqual(f.warnings, []);
    fs.unlinkSync(alias);
  });
}

test("an existing dangling pin file blocks worktree deletion", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  const data = path.join(f.home, "data");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "bots.json"), "[]");
  const link = path.join(data, "groups.json");
  fs.symlinkSync(path.join(f.home, "missing"), link, process.platform === "win32" ? "junction" : "dir");
  await eligible(f);
  const cleanup = createPaneCleanup({ ...f.options, pinned: () => readCleanupPins(data) });
  cleanup.start(() => []);
  t.after(() => cleanup.dispose());
  await cleanup.sweep();
  assert.equal(fs.existsSync(target), true);
  await assert.rejects(readCleanupPins(data), { code: "ENOENT" });
  fs.unlinkSync(link);
});

for (const phase of ["traversal", "final directory check"]) {
  test(`scratch handed off during ${phase} keeps its new ownership`, async (t) => {
    const f = fixture(t);
    const link = path.join(f.scratch, "link");
    fs.symlinkSync(f.home, link, process.platform === "win32" ? "junction" : "dir");
    const promises = await import("node:fs/promises");
    const method = phase === "traversal" ? "readdir" : "realpath";
    const original = promises.default[method];
    let visits = 0;
    let claimed = false;
    t.mock.method(promises.default, method, async (...args) => {
      const value = await original(...args);
      if (path.resolve(args[0]) === path.resolve(f.scratch) && ++visits === (phase === "traversal" ? 1 : 2)) {
        claimed = true;
        const next = { ...f.session, id: "next" };
        f.cleanup.opened(next);
        await f.cleanup.closed(next, true);
      }
      return value;
    });
    f.cleanup.opened(f.session);
    await f.cleanup.closed(f.session);
    assert.equal(claimed, true);
    assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
    assert.equal(f.ledger().find((entry) => entry.id === "next").scratchDone, undefined);
    if (phase === "traversal") assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(f.warnings, []);
  });
}

for (const claim of ["open pane", "recent close", "pin", "aliased open pane", "aliased recent close"]) {
  test(`a worktree claimed by a ${claim} during backup survives`, async (t) => {
    const f = fixture(t);
    const { target } = repo(f);
    await eligible(f);
    const pins = [];
    let panes = [];
    const cleanup = createPaneCleanup({ ...f.options, pinned: () => pins });
    cleanup.start(() => panes);
    t.after(() => cleanup.dispose());
    const promises = await import("node:fs/promises");
    const original = promises.default.link;
    let claimed = false;
    const aliased = claim.startsWith("aliased ");
    const kind = aliased ? claim.slice(8) : claim;
    const alias = path.join(f.home, "project");
    if (aliased) fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    const next = { ...f.session, id: "next", cwd: path.join(aliased ? alias : target, "not-created") };
    t.mock.method(promises.default, "link", async (...args) => {
      const value = await original(...args);
      if (!claimed) {
        claimed = true;
        if (kind === "pin") pins.push(target);
        else {
          cleanup.opened(next);
          if (kind === "open pane") panes = [next];
          else await cleanup.closed(next, true);
        }
      }
      return value;
    });
    await cleanup.sweep();
    assert.equal(claimed, true);
    assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
    assert.equal(git(target, "status", "--porcelain"), "");
    assert.equal(f.ledger().filter((entry) => entry.cwd === target).every((entry) => !entry.worktreeDone), true);
    assert.deepEqual(fs.readdirSync(f.worktreeRoot), ["worker"]);
    assert.deepEqual(f.warnings, []);
    if (kind === "open pane") await cleanup.closed(next, true);
    panes = [];
    pins.length = 0;
    f.advance(4 * DAY_MS);
    await cleanup.sweep();
    assert.equal(fs.existsSync(target), false);
    if (aliased) fs.unlinkSync(alias);
  });
}

for (const gate of ["open pane", "unclosed ledger", "recent close"]) {
  for (const missing of [false, true]) {
    test(`a symlinked pane ${gate} protects its worktree${missing ? " with a missing child" : ""}`, async (t) => {
      const f = fixture(t);
      const { target } = repo(f);
      const alias = path.join(f.home, "project");
      fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
      await eligible(f);
      const next = { ...f.session, id: "next", label: "OTHER", cwd: missing ? path.join(alias, "not-created", "child") : alias };
      if (gate === "open pane") f.open([next]);
      else {
        f.cleanup.opened(next);
        if (gate === "recent close") await f.cleanup.closed(next, true);
      }
      await f.cleanup.sweep();
      assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
      assert.deepEqual(f.warnings, []);
      fs.unlinkSync(alias);
      f.open([]);
      if (gate === "unclosed ledger") await f.cleanup.closed(next, true);
      f.advance(4 * DAY_MS);
      await f.cleanup.sweep();
      assert.equal(fs.existsSync(target), false);
    });
  }
}

for (const origin of ["worktree", "scratch"]) {
  test(`deep ordinary ${origin} folders do not block an unrelated worktree`, async (t) => {
    const f = fixture(t);
    const { main, target } = repo(f);
    const root = origin === "worktree" ? path.join(f.worktreeRoot, "other") : path.join(f.tempRoot, "wink-OTHER");
    if (origin === "worktree") git(main, "worktree", "add", "--quiet", "-b", "other", root);
    fs.mkdirSync(path.join(root, "src", "components", "button", "deep", "child"), { recursive: true });
    await eligible(f);
    await f.cleanup.sweep();
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(root), true);
    assert.deepEqual(f.warnings, []);
  });
}

test("a confirmed non-worktree ledger row finishes without repeated warnings", async (t) => {
  const f = fixture(t);
  f.session.cwd = path.join(f.worktreeRoot, "plain");
  fs.mkdirSync(f.session.cwd);
  await eligible(f);
  await f.cleanup.sweep();
  assert.deepEqual(f.ledger(), []);
  await f.cleanup.sweep();
  assert.deepEqual(f.warnings, []);
  assert.equal(fs.existsSync(f.session.cwd), true);
});

test("natural exit starts retention without removing a visible pane's scratch", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  const owner = { id: 1, send() {}, isDestroyed: () => false };
  let exit;
  const host = createTerminalHost({
    authorize() {}, owner: () => owner, resolveCwd: async () => target, now: f.options.now,
    platform: "linux", env: { SHELL: "/bin/sh", TEMP: f.tempRoot }, freeMemory: () => 64 * 1024 ** 3,
    paneCleanup: f.cleanup,
    loadPty: () => ({ spawn: () => ({ onData() {}, onExit(cb) { exit = cb; }, write() {}, resize() {}, kill() {} }) }),
  });
  t.after(() => host.dispose());
  const pane = await host.openForBot("bot", { label: "TEST", command: "codex test" });
  host.attendBot("bot", pane.sessionId, "report");
  exit({ exitCode: 0 });
  await f.cleanup.flush();
  assert.equal(f.ledger()[0].closedAt, f.options.now());
  assert.equal(fs.existsSync(f.scratch), true);
  f.advance(4 * DAY_MS);
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(f.scratch), true);
  await host.dispose();
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(f.scratch), false);
  assert.equal(fs.existsSync(target), false);
});

test("scratch reopened during a throttled walk retains its files and links", async (t) => {
  const f = fixture(t);
  const marker = path.join(f.scratch, "next");
  const link = path.join(f.scratch, "z-link");
  fs.writeFileSync(marker, "keep");
  fs.symlinkSync(f.home, link, process.platform === "win32" ? "junction" : "dir");
  let time = Date.now();
  t.mock.method(Date, "now", () => time);
  const promises = await import("node:fs/promises");
  const lstat = promises.default.lstat;
  let reopened = false;
  t.mock.method(promises.default, "lstat", async (...args) => {
    const stat = await lstat(...args);
    if (args[0] === marker) {
      reopened = true;
      f.open([{ id: "other", label: "OTHER", cwd: f.scratch }]);
      time += 250;
    }
    if (args[0] === link) f.open([]);
    return stat;
  });
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(reopened, true);
  assert.equal(fs.readFileSync(marker, "utf8"), "keep");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.deepEqual(f.warnings, []);
});

test("scratch reopened inside the throttle window keeps its links", async (t) => {
  const f = fixture(t);
  const marker = path.join(f.scratch, "next");
  const link = path.join(f.scratch, "z-link");
  fs.writeFileSync(marker, "keep");
  fs.symlinkSync(f.home, link, process.platform === "win32" ? "junction" : "dir");
  const promises = await import("node:fs/promises");
  const lstat = promises.default.lstat;
  let reopened = false;
  t.mock.method(promises.default, "lstat", async (...args) => {
    const stat = await lstat(...args);
    if (args[0] === marker && !reopened) {
      reopened = true;
      f.open([{ id: "other", label: "OTHER", cwd: f.scratch }]);
    }
    return stat;
  });
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(reopened, true);
  assert.equal(fs.readFileSync(marker, "utf8"), "keep");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.deepEqual(f.warnings, []);
});

test("large scratch cleanup bounds synchronous filesystem calls with a full ledger", async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 20_000; index++) fs.writeFileSync(path.join(f.scratch, `file-${index}`), "");
  f.cleanup.opened(f.session);
  const entries = f.ledger();
  for (let index = 0; index < 999; index++) entries.push({ ...entries[0], id: `old-${index}`, scratch: path.join(f.tempRoot, `wink-OLD-${index}`) });
  fs.writeFileSync(path.join(f.home, ".orbit", "pane-ledger.json"), JSON.stringify(entries));
  const cleanup = createPaneCleanup(f.options);
  cleanup.start(() => [{ id: "other", label: "OTHER", cwd: f.home }]);
  t.after(() => cleanup.dispose());
  let calls = 0;
  const lstatSync = fs.lstatSync;
  const realpathSync = fs.realpathSync.native;
  t.after(() => { fs.lstatSync = lstatSync; fs.realpathSync.native = realpathSync; });
  fs.lstatSync = (...args) => { calls++; return lstatSync(...args); };
  fs.realpathSync.native = (...args) => { calls++; return realpathSync(...args); };
  const promises = await import("node:fs/promises");
  const lstat = promises.default.lstat;
  t.mock.method(promises.default, "lstat", (...args) => {
    if (calls > 500_000) throw new Error("cleanup sync filesystem budget exceeded");
    return lstat(...args);
  });
  await cleanup.closed(f.session);
  t.diagnostic(`sync filesystem calls: ${calls}`);
  assert.ok(calls < 500_000, `${calls} sync filesystem calls`);
  assert.equal(fs.existsSync(f.scratch), false);
  assert.deepEqual(f.warnings, []);
});

test("superseded scratch entries do not scan roots before the eligible owner", async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 49; index++) {
    const session = { ...f.session, id: `old-${index}` };
    f.cleanup.opened(session);
    await f.cleanup.closed(session, true);
  }
  f.advance(4 * DAY_MS);
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session, true);
  const promises = await import("node:fs/promises");
  const lstat = promises.default.lstat;
  const readdir = promises.default.readdir;
  let stats = 0;
  let reads = 0;
  t.mock.method(promises.default, "lstat", (...args) => {
    if (args[0] === f.worktreeRoot) stats++;
    return lstat(...args);
  });
  t.mock.method(promises.default, "readdir", (...args) => {
    if (args[0] === f.worktreeRoot) reads++;
    return readdir(...args);
  });
  await f.cleanup.sweep();
  assert.ok(stats <= 1, `${stats} root stats`);
  assert.equal(reads, 0);
  assert.equal(fs.existsSync(f.scratch), true);
  const first = stats;
  f.advance(4 * DAY_MS);
  await f.cleanup.sweep();
  assert.ok(stats > first && stats - first <= 10, `${stats - first} root stats`);
  assert.equal(reads, 1);
  assert.equal(fs.existsSync(f.scratch), false);
  assert.deepEqual(f.warnings, []);
});

test("a large worktree scan bounds synchronous calls across queued scratch entries", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  const folders = 20;
  const queued = 50;
  const hosts = [];
  for (let index = 0; index < folders; index++) {
    const folder = path.join(f.worktreeRoot, `host-${index}`);
    fs.mkdirSync(folder);
    hosts.push(folder);
    for (let file = 0; file < 2_000; file++) fs.writeFileSync(path.join(folder, `file-${file}`), "");
  }
  fs.symlinkSync(target, path.join(hosts.at(-1), "z-link"), process.platform === "win32" ? "junction" : "dir");
  for (let index = 0; index < queued; index++) {
    const session = { ...f.session, id: `queued-${index}`, label: `QUEUED-${index}` };
    fs.mkdirSync(path.join(f.tempRoot, `wink-${session.label}`));
    f.cleanup.opened(session);
    await f.cleanup.closed(session, true);
  }
  f.advance(4 * DAY_MS);
  const budget = 2_000 * (folders + queued);
  let calls = 0;
  let reads = 0;
  const lstatSync = fs.lstatSync;
  const realpathSync = fs.realpathSync.native;
  t.after(() => { fs.lstatSync = lstatSync; fs.realpathSync.native = realpathSync; });
  fs.lstatSync = (...args) => { calls++; return lstatSync(...args); };
  fs.realpathSync.native = (...args) => { calls++; return realpathSync(...args); };
  const promises = await import("node:fs/promises");
  const lstat = promises.default.lstat;
  const readdir = promises.default.readdir;
  t.mock.method(promises.default, "lstat", (...args) => {
    if (calls > budget) throw new Error("cleanup sync filesystem budget exceeded");
    return lstat(...args);
  });
  t.mock.method(promises.default, "readdir", (...args) => {
    if (hosts.includes(args[0])) reads++;
    return readdir(...args);
  });
  await f.cleanup.sweep();
  t.diagnostic(`sync filesystem calls: ${calls}; unrelated folder reads: ${reads}`);
  assert.ok(calls < budget, `${calls} sync filesystem calls`);
  assert.equal(reads, folders);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.readdirSync(f.tempRoot).filter((name) => name.startsWith("wink-QUEUED-")).length, 0);
  assert.deepEqual(f.warnings, []);
});

for (const phase of ["before cleanup", "during traversal"]) {
  test(`an incoming link ${phase} preserves scratch`, async (t) => {
    const f = fixture(t);
    const host = path.join(f.worktreeRoot, "host");
    fs.mkdirSync(host);
    const link = path.join(host, "incoming");
    const create = () => fs.symlinkSync(path.join(f.scratch, "missing"), link, process.platform === "win32" ? "junction" : "dir");
    if (phase === "before cleanup") create();
    else {
      const promises = await import("node:fs/promises");
      const readdir = promises.default.readdir;
      let created = false;
      t.mock.method(promises.default, "readdir", async (...args) => {
        if (args[0] === f.scratch && !created) { created = true; create(); }
        return readdir(...args);
      });
    }
    f.cleanup.opened(f.session);
    await f.cleanup.closed(f.session);
    assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(f.warnings, []);
    fs.unlinkSync(link);
  });
}

test("overlapping TEMP roots preserve incoming links in unrestricted subfolders", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  const host = path.join(f.tempRoot, "wink-HOST");
  const folder = path.join(host, "project");
  fs.mkdirSync(folder, { recursive: true });
  const link = path.join(folder, "incoming");
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  await eligible(f);
  const cleanup = createPaneCleanup({ ...f.options, tempRoot: host });
  cleanup.start(() => []);
  t.after(() => cleanup.dispose());
  await cleanup.sweep();
  assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
  assert.equal(fs.realpathSync(link), fs.realpathSync(target));
  assert.deepEqual(f.warnings, []);
  fs.unlinkSync(link);
});

for (const claim of ["ledger row", "open pane"]) {
  test(`a scratch ${claim} during async ownership checks preserves its links`, async (t) => {
    const f = fixture(t);
    const link = path.join(f.scratch, "link");
    fs.symlinkSync(f.home, link, process.platform === "win32" ? "junction" : "dir");
    f.cleanup.opened(f.session);
    const other = { ...f.session, id: "other", label: "OTHER" };
    f.cleanup.opened(other);
    await f.cleanup.closed(other, true);
    const marker = path.join(f.tempRoot, "wink-OTHER");
    const promises = await import("node:fs/promises");
    const lstat = promises.default.lstat;
    const resolve = path.resolve;
    let claimed = false;
    let armed = false;
    t.mock.method(promises.default, "lstat", async (...args) => {
      const stat = await lstat(...args);
      if (args[0] === link) armed = true;
      return stat;
    });
    t.mock.method(path, "resolve", (...args) => {
      const file = resolve(...args);
      if (args[0] === marker && armed && !claimed) {
        claimed = true;
        queueMicrotask(() => {
          const next = { ...f.session, id: "next", label: "NEXT", cwd: f.scratch };
          if (claim === "ledger row") f.cleanup.opened({ ...next, label: f.session.label });
          else f.open([next]);
        });
      }
      return file;
    });
    await f.cleanup.closed(f.session);
    assert.equal(claimed, true);
    assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(f.warnings, []);
  });
}

test("a missing worktree root does not block reported scratch cleanup", async (t) => {
  const f = fixture(t);
  fs.rmdirSync(f.worktreeRoot);
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(fs.existsSync(f.scratch), false);
  assert.deepEqual(f.warnings, []);
});

test("AF_UNIX sockets in TEMP do not block reported scratch cleanup", { skip: process.platform !== "win32" && "AF_UNIX reparse points are Windows-only" }, async (t) => {
  const f = fixture(t);
  const host = path.join(f.tempRoot, "wink-HOST");
  fs.mkdirSync(host);
  const script = "$s = [System.Net.Sockets.Socket]::new('Unix', 'Stream', 'Unspecified'); $s.Bind([System.Net.Sockets.UnixDomainSocketEndPoint]::new($env:PANE_CLEANUP_SOCKET)); Stop-Process -Id $PID -Force";
  for (const dir of [host, f.scratch]) {
    try { execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: "ignore", env: { ...process.env, PANE_CLEANUP_SOCKET: path.join(dir, "control.sock") } }); } catch {}
    if (!fs.readdirSync(dir).includes("control.sock")) return t.skip("pwsh cannot create AF_UNIX sockets");
  }
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(fs.existsSync(f.scratch), false);
  assert.deepEqual(f.jobs.filter((job) => job.ms === 60_000), []);
  assert.deepEqual(f.warnings, []);
});

test("a link appearing in the final scratch walk aborts removal", async (t) => {
  const f = fixture(t);
  const link = path.join(f.scratch, "late-link");
  const promises = await import("node:fs/promises");
  const readdir = promises.default.readdir;
  let visits = 0;
  t.mock.method(promises.default, "readdir", async (...args) => {
    if (args[0] === f.scratch && ++visits === 2) fs.symlinkSync(f.home, link, process.platform === "win32" ? "junction" : "dir");
    return readdir(...args);
  });
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.match(f.warnings[0]?.message ?? "", /link appeared during cleanup/);
});

test("a new incoming link during backup invalidates the sweep scan", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  const host = path.join(f.worktreeRoot, "host");
  fs.mkdirSync(host);
  const link = path.join(host, "incoming");
  const promises = await import("node:fs/promises");
  const original = promises.default.link;
  let created = false;
  t.mock.method(promises.default, "link", async (...args) => {
    const result = await original(...args);
    if (!created) {
      created = true;
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    }
    return result;
  });
  await eligible(f);
  await f.cleanup.sweep();
  assert.equal(created, true);
  assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
  assert.equal(f.ledger().some((entry) => !entry.worktreeDone), true);
  assert.deepEqual(f.warnings, []);
  fs.unlinkSync(link);
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(target), false);
});

async function scratchRows(f, labels) {
  const rows = [];
  for (const label of labels) {
    const session = { ...f.session, id: label, label };
    const scratch = path.join(f.tempRoot, `wink-${label}`);
    if (!fs.existsSync(scratch)) fs.mkdirSync(scratch);
    f.cleanup.opened(session);
    await f.cleanup.closed(session, true);
    rows.push(scratch);
  }
  f.advance(4 * DAY_MS);
  return rows;
}

async function walkCounter(t, f) {
  const folders = Array.from({ length: 20 }, (_, index) => path.join(f.worktreeRoot, "host", `folder-${index}`));
  for (const folder of folders) fs.mkdirSync(folder, { recursive: true });
  const promises = await import("node:fs/promises");
  const lstat = promises.default.lstat;
  let visits = 0;
  t.mock.method(promises.default, "lstat", (...args) => {
    if (folders.includes(args[0])) visits++;
    return lstat(...args);
  });
  return () => visits / folders.length;
}

test("a sweep walks the link roots once for every scratch it removes", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = fixture(t);
  const rows = await scratchRows(f, ["TEST", "SECOND", "THIRD"]);
  const walks = await walkCounter(t, f);
  await f.cleanup.sweep();
  assert.deepEqual(rows.filter((row) => fs.existsSync(row)), []);
  assert.equal(walks(), 1);
  assert.deepEqual(f.warnings, []);
});

test("a reported scratch close walks the link roots once", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = fixture(t);
  const walks = await walkCounter(t, f);
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(fs.existsSync(f.scratch), false);
  assert.equal(walks(), 1);
  assert.deepEqual(f.warnings, []);
});

test("a link made outside scratch after the sweep's link scan still blocks its delete", async (t) => {
  const f = fixture(t);
  const [first, late] = await scratchRows(f, ["TEST", "LATE"]);
  fs.writeFileSync(path.join(late, "file"), "late");
  const host = path.join(f.worktreeRoot, "host");
  fs.mkdirSync(host);
  const link = path.join(host, "incoming");
  const promises = await import("node:fs/promises");
  const rm = promises.default.rm;
  t.mock.method(promises.default, "rm", async (...args) => {
    const result = await rm(...args);
    if (args[0] === first && !fs.existsSync(link)) fs.symlinkSync(late, link, process.platform === "win32" ? "junction" : "dir");
    return result;
  });
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.readFileSync(path.join(late, "file"), "utf8"), "late");
  assert.equal(fs.realpathSync(link), fs.realpathSync(late));
  assert.deepEqual(f.warnings, []);
  fs.unlinkSync(link);
});

test("an outside junction re-pointed after the sweep's link scan still blocks its delete", async (t) => {
  const f = fixture(t);
  const [first, late] = await scratchRows(f, ["TEST", "LATE"]);
  fs.writeFileSync(path.join(late, "file"), "late");
  const kind = process.platform === "win32" ? "junction" : "dir";
  const away = path.join(f.home, "away");
  const hop = path.join(f.home, "hop");
  fs.mkdirSync(away);
  fs.symlinkSync(away, hop, kind);
  const host = path.join(f.worktreeRoot, "host");
  fs.mkdirSync(host);
  const link = path.join(host, "incoming");
  fs.symlinkSync(hop, link, kind);
  const promises = await import("node:fs/promises");
  const rm = promises.default.rm;
  t.mock.method(promises.default, "rm", async (...args) => {
    const result = await rm(...args);
    if (args[0] === first) {
      fs.unlinkSync(hop);
      fs.symlinkSync(late, hop, kind);
    }
    return result;
  });
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.readFileSync(path.join(late, "file"), "utf8"), "late");
  assert.deepEqual(f.warnings, []);
  fs.unlinkSync(link);
  fs.unlinkSync(hop);
});

test("a link made while the sweep re-checks a change still blocks its delete", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = fixture(t);
  const [first, late] = await scratchRows(f, ["TEST", "LATE"]);
  fs.writeFileSync(path.join(late, "file"), "late");
  const host = path.join(f.worktreeRoot, "host");
  fs.mkdirSync(host);
  const [one, two] = ["one", "two"].map((name) => path.join(host, name));
  const link = path.join(host, "incoming");
  const promises = await import("node:fs/promises");
  const rm = promises.default.rm;
  t.mock.method(promises.default, "rm", async (...args) => {
    const result = await rm(...args);
    if (args[0] === first) fs.mkdirSync(one);
    return result;
  });
  const lstat = promises.default.lstat;
  t.mock.method(promises.default, "lstat", (...args) => {
    if (args[0] === one && !fs.existsSync(two)) fs.mkdirSync(two);
    else if (args[0] === two && !fs.existsSync(link)) fs.symlinkSync(late, link, "junction");
    return lstat(...args);
  });
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.readFileSync(path.join(late, "file"), "utf8"), "late");
  assert.deepEqual(f.warnings, []);
  fs.unlinkSync(link);
});

test("a link missed by a rebuilt index that went stale still blocks its delete", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = fixture(t);
  await scratchRows(f, ["TEST"]);
  const host = path.join(f.worktreeRoot, "host");
  fs.mkdirSync(host);
  const other = path.join(f.tempRoot, "wink-OTHER");
  fs.mkdirSync(other);
  const link = path.join(host, "incoming");
  const roots = [];
  const watch = fs.watch;
  t.mock.method(fs, "watch", (...args) => {
    const watcher = watch(...args);
    if (args[0] === f.worktreeRoot) roots.push(watcher);
    return watcher;
  });
  const promises = await import("node:fs/promises");
  let lost = false;
  const readdir = promises.default.readdir;
  t.mock.method(promises.default, "readdir", (...args) => {
    if (args[0] === f.scratch && !lost) { lost = true; roots.at(-1).emit("error", new Error("overflow")); }
    return readdir(...args);
  });
  const lstat = promises.default.lstat;
  t.mock.method(promises.default, "lstat", (...args) => {
    if (args[0] === other && lost && !fs.existsSync(link)) {
      fs.symlinkSync(f.scratch, link, "junction");
      roots.at(-1).emit("error", new Error("overflow"));
    }
    return lstat(...args);
  });
  await f.cleanup.sweep();
  assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
  assert.deepEqual(f.warnings, []);
  fs.rmSync(link, { force: true });
});

async function staleTwice(t, f, fallback) {
  await scratchRows(f, ["TEST"]);
  fs.mkdirSync(path.join(f.worktreeRoot, "host"));
  const other = path.join(f.tempRoot, "wink-OTHER");
  fs.mkdirSync(other);
  const roots = [];
  const watch = fs.watch;
  t.mock.method(fs, "watch", (...args) => {
    const watcher = watch(...args);
    if (args[0] === f.worktreeRoot) roots.push(watcher);
    return watcher;
  });
  const promises = await import("node:fs/promises");
  let builds = -1;
  const readdir = promises.default.readdir;
  t.mock.method(promises.default, "readdir", (...args) => {
    if (args[0] === f.scratch && builds === -1) {
      builds = 0;
      roots.at(-1).emit("error", new Error("overflow"));
    }
    return readdir(...args);
  });
  const lstat = promises.default.lstat;
  t.mock.method(promises.default, "lstat", (...args) => {
    if (args[0] === other && builds >= 0) {
      builds++;
      if (builds === 1) roots.at(-1).emit("error", new Error("overflow"));
      if (builds === 2) fallback(roots.at(-1));
    }
    return lstat(...args);
  });
}

test("a link made after a fallback walk whose watcher fails still blocks its delete", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = fixture(t);
  const link = path.join(f.worktreeRoot, "host", "incoming");
  await staleTwice(t, f, (watcher) => {
    fs.symlinkSync(f.scratch, link, "junction");
    watcher.emit("error", new Error("overflow"));
  });
  await f.cleanup.sweep();
  assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
  assert.deepEqual(f.warnings, []);
  fs.rmSync(link, { force: true });
});

test("a worktree root recreated during a fallback walk still blocks its delete", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = fixture(t);
  const aside = path.join(f.home, "aside");
  const link = path.join(f.worktreeRoot, "incoming");
  await staleTwice(t, f, () => {
    fs.renameSync(f.worktreeRoot, aside);
    fs.mkdirSync(f.worktreeRoot);
    fs.symlinkSync(f.scratch, link, "junction");
  });
  await f.cleanup.sweep();
  assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
  assert.deepEqual(f.warnings, []);
  fs.rmSync(link, { force: true });
});

test("a link queued during a fallback walk still blocks its delete", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = fixture(t);
  const link = path.join(f.worktreeRoot, "host", "incoming");
  await staleTwice(t, f, () => fs.symlinkSync(f.scratch, link, "junction"));
  await f.cleanup.sweep();
  assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
  assert.deepEqual(f.warnings, []);
  fs.rmSync(link, { force: true });
});

test("a link in a worktree root renamed aside and recreated still blocks its delete", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = fixture(t);
  await scratchRows(f, ["TEST"]);
  const aside = path.join(f.home, "aside");
  const link = path.join(f.worktreeRoot, "incoming");
  const promises = await import("node:fs/promises");
  const readdir = promises.default.readdir;
  t.mock.method(promises.default, "readdir", (...args) => {
    if (args[0] === f.scratch && !fs.existsSync(aside)) {
      fs.renameSync(f.worktreeRoot, aside);
      fs.mkdirSync(f.worktreeRoot);
      fs.symlinkSync(f.scratch, link, "junction");
    }
    return readdir(...args);
  });
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(aside), true);
  assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
  assert.deepEqual(f.warnings, []);
  fs.unlinkSync(link);
});

test("no link watcher outlives its close or sweep", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = fixture(t);
  const open = new Set();
  let opened = 0;
  const watch = fs.watch;
  t.mock.method(fs, "watch", (...args) => {
    const watcher = watch(...args);
    opened++;
    open.add(watcher);
    const close = watcher.close.bind(watcher);
    watcher.close = () => { open.delete(watcher); close(); };
    return watcher;
  });
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(fs.existsSync(f.scratch), false);
  assert.equal(open.size, 0);
  await scratchRows(f, ["FAILS"]);
  const promises = await import("node:fs/promises");
  t.mock.method(promises.default, "rm", async () => { throw Object.assign(new Error("disk failure"), { code: "EIO" }); });
  await f.cleanup.sweep();
  assert.match(f.warnings[0]?.message ?? "", /disk failure/);
  assert.ok(opened >= 4, `${opened} watchers`);
  assert.equal(open.size, 0);
});

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

test("short aliases remove reported scratch without following its junction", { skip: process.platform !== "win32" && "8.3 aliases require Windows" }, async (t) => {
  const f = fixture(t, true);
  if (!f) return;
  const target = path.join(f.home, "user-files");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "precious"), "survives");
  fs.symlinkSync(target, path.join(f.scratch, "link"), "junction");
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(fs.existsSync(f.scratch), false);
  assert.equal(fs.readFileSync(path.join(target, "precious"), "utf8"), "survives");
  assert.deepEqual(f.warnings, []);
});

test("short aliases preserve scratch claimed through a long cwd", { skip: process.platform !== "win32" && "8.3 aliases require Windows" }, async (t) => {
  const f = fixture(t, true);
  if (!f) return;
  f.open([{ id: "other", label: "OTHER", cwd: path.join(fs.realpathSync.native(f.scratch), "not-created") }]);
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
});

test("short aliases cannot bypass a newer long-path scratch hand-off", { skip: process.platform !== "win32" && "8.3 aliases require Windows" }, async (t) => {
  const f = fixture(t, true);
  if (!f) return;
  await eligible(f);
  const next = { ...f.session, id: "next", tempRoot: fs.realpathSync.native(f.tempRoot) };
  f.cleanup.opened(next);
  await f.cleanup.closed(next, true);
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(f.scratch), true);
  f.advance(3 * DAY_MS);
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(f.scratch), false);
});

for (const gate of ["TEMP root", "TEMP ancestor"]) {
  test(`scratch refuses a substituted junction at its ${gate}`, async (t) => {
    const f = fixture(t);
    const target = path.join(f.home, "user-files");
    const temp = path.join(target, "temp");
    const scratch = path.join(temp, "wink-TEST");
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, "precious"), "survives");
    const link = path.join(f.home, "original-temp");
    f.session.tempRoot = gate === "TEMP root" ? link : path.join(link, "temp");
    fs.mkdirSync(f.session.tempRoot, { recursive: true });
    f.cleanup.opened(f.session);
    fs.rmdirSync(f.session.tempRoot);
    if (gate === "TEMP ancestor") fs.rmdirSync(link);
    fs.symlinkSync(gate === "TEMP root" ? temp : target, link, process.platform === "win32" ? "junction" : "dir");
    await f.cleanup.closed(f.session);
    assert.equal(fs.readFileSync(path.join(scratch, "precious"), "utf8"), "survives");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    fs.unlinkSync(link);
  });
}

for (const source of ["default", "session"]) {
  for (const gate of ["root", "ancestor"]) {
    for (const delayed of [false, true]) {
      test(`symlinked TEMP ${gate} from ${source} removes ${delayed ? "expired" : "reported"} scratch`, async (t) => {
        const f = fixture(t);
        const link = path.join(f.home, "linked");
        fs.symlinkSync(gate === "root" ? f.tempRoot : f.home, link, process.platform === "win32" ? "junction" : "dir");
        const alias = gate === "root" ? link : path.join(link, "temp");
        const cleanup = createPaneCleanup({ ...f.options, tempRoot: source === "default" ? alias : f.tempRoot });
        cleanup.start(() => []);
        t.after(() => cleanup.dispose());
        const session = { ...f.session, tempRoot: source === "session" ? alias : undefined, reportAt: delayed ? 0 : f.session.reportAt };
        cleanup.opened(session);
        await cleanup.closed(session);
        if (delayed) {
          assert.equal(fs.existsSync(f.scratch), true);
          f.advance(DAY_MS);
          await cleanup.sweep();
        }
        assert.equal(fs.existsSync(f.scratch), false);
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
        assert.deepEqual(f.warnings, []);
        fs.unlinkSync(link);
      });
    }
  }
}

for (const gate of ["root", "ancestor"]) {
  test(`a symlinked TEMP ${gate} does not block worktree cleanup`, async (t) => {
    const f = fixture(t);
    const { target } = repo(f);
    const link = path.join(f.home, "linked");
    fs.symlinkSync(gate === "root" ? f.tempRoot : f.home, link, process.platform === "win32" ? "junction" : "dir");
    const cleanup = createPaneCleanup({ ...f.options, tempRoot: gate === "root" ? link : path.join(link, "temp") });
    cleanup.start(() => []);
    t.after(() => cleanup.dispose());
    const session = { ...f.session, tempRoot: undefined };
    cleanup.opened(session);
    await cleanup.closed(session, true);
    f.advance(4 * DAY_MS);
    await cleanup.sweep();
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(f.warnings, []);
    fs.unlinkSync(link);
  });
}

for (const missing of [false, true]) {
  test(`canonical TEMP ownership protects a pane using its scratch alias${missing ? " with a missing child" : ""}`, async (t) => {
    const f = fixture(t);
    const link = path.join(f.home, "linked");
    fs.symlinkSync(f.home, link, process.platform === "win32" ? "junction" : "dir");
    f.session.tempRoot = path.join(link, "temp");
    const cwd = path.join(link, "temp", "wink-TEST", ...(missing ? ["not-created", "child"] : []));
    f.open([{ id: "other", label: "OTHER", cwd }]);
    f.cleanup.opened(f.session);
    await f.cleanup.closed(f.session);
    assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
    f.open([]);
    f.advance(DAY_MS);
    await f.cleanup.sweep();
    assert.equal(fs.existsSync(f.scratch), false);
    assert.deepEqual(f.warnings, []);
    fs.unlinkSync(link);
  });
}

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

test("starting cleanup twice keeps one disposable sweep timer", (t) => {
  const f = fixture(t);
  f.cleanup.start(() => []);
  assert.equal(f.jobs.length, 1);
  f.cleanup.dispose();
  assert.equal(f.jobs.length, 0);
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

test("removing a worktree leaves another worktree's registration untouched", async (t) => {
  const f = fixture(t);
  const { main, target } = repo(f);
  const away = path.join(f.home, "away");
  fs.mkdirSync(away);
  git(main, "worktree", "add", "--quiet", "-b", "test-offline", path.join(away, "offline"));
  fs.renameSync(path.join(away, "offline"), path.join(away, "unplugged"));
  const admin = (name) => path.join(main, ".git", "worktrees", name);
  assert.equal(fs.existsSync(admin("offline")), true);
  await eligible(f);
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(target), false, f.warnings.map(String).join("\n"));
  assert.equal(fs.existsSync(admin("worker")), false);
  assert.equal(fs.existsSync(admin("offline")), true);
  assert.deepEqual(f.warnings, []);
});

test("a pin on the volume root protects every worktree under it", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  await eligible(f);
  const cleanup = createPaneCleanup({ ...f.options, pinned: [path.parse(target).root] });
  cleanup.start(() => []);
  t.after(() => cleanup.dispose());
  await cleanup.sweep();
  assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
  assert.deepEqual(f.warnings, []);
});

test("scratch that a live worktree links into keeps its own junctions", async (t) => {
  const f = fixture(t);
  const host = path.join(f.worktreeRoot, "host");
  fs.mkdirSync(host);
  const incoming = path.join(host, "incoming");
  const outgoing = path.join(f.scratch, "outgoing");
  const kind = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(f.scratch, incoming, kind);
  fs.symlinkSync(f.home, outgoing, kind);
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
  assert.equal(fs.lstatSync(outgoing).isSymbolicLink(), true);
  assert.deepEqual(f.warnings, []);
  fs.unlinkSync(incoming);
  fs.unlinkSync(outgoing);
});

test("a candidate's own link does not count as an incoming link", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  fs.symlinkSync(process.platform === "win32" ? target : ".", path.join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await eligible(f);
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(target), false, f.warnings.map(String).join("\n"));
});

for (const short of [false, true]) {
  test(`a failed removal preserves a tracked external symlink${short ? " through a short alias" : ""}`, { skip: short && process.platform !== "win32" && "8.3 aliases require Windows" }, async (t) => {
    const f = fixture(t, short);
    if (!f) return;
    const { target } = repo(f);
    const { precious, link } = trackedLink(f, target);
    const ignored = path.join(target, "node_modules");
    const longTarget = fs.realpathSync.native(target);
    const gitfile = fs.readFileSync(path.join(target, ".git"), "utf8");
    fs.symlinkSync(f.home, ignored, process.platform === "win32" ? "junction" : "dir");
    const promises = await import("node:fs/promises");
    const unlink = promises.default.unlink;
    let raced = false;
    t.mock.method(promises.default, "unlink", async (file) => {
      if (path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)) === path.join(longTarget, "node_modules")) {
        raced = true;
        fs.writeFileSync(path.join(target, "racing-write"), "keep");
      }
      return unlink(file);
    });
    await eligible(f);
    await f.cleanup.sweep();
    assert.equal(raced, true);
    assert.equal(fs.readFileSync(path.join(target, ".git"), "utf8"), gitfile);
    assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
    assert.equal(fs.readFileSync(path.join(target, "racing-write"), "utf8"), "keep");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(precious, "file"), "utf8"), "safe");
    assert.doesNotMatch(git(target, "status", "--porcelain"), /D tracked-link/);
    t.mock.restoreAll();
  });

  test(`a clean worktree preserves a tracked external symlink${short ? " through a short alias" : ""}`, { skip: short && process.platform !== "win32" && "8.3 aliases require Windows" }, async (t) => {
    const f = fixture(t, short);
    if (!f) return;
    const { target } = repo(f);
    const { precious, link } = trackedLink(f, target);
    await eligible(f);
    await f.cleanup.sweep();
    assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
    assert.equal(fs.readFileSync(path.join(precious, "file"), "utf8"), "safe");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(git(target, "status", "--porcelain"), "");
    assert.deepEqual(f.warnings, []);
  });
}

for (const removed of ["tracked file", "whole worktree", "Git metadata"]) {
  test(`a partial removal restores ${removed}`, async (t) => {
    const f = fixture(t);
    const { main, target } = repo(f);
    const gitdir = git(target, "rev-parse", "--absolute-git-dir");
    const gitfile = fs.readFileSync(path.join(target, ".git"), "utf8");
    const execFile = childProcess.execFile;
    const failure = new Error("partial worktree removal");
    let attempted = false;
    t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
      if (file !== "git" || args[2] !== "worktree" || args[3] !== "remove") return execFile(file, args, options, callback);
      attempted = true;
      return execFile(file, ["--version"], options, () => {
        if (removed === "whole worktree") fs.rmSync(target, { recursive: true });
        else {
          fs.unlinkSync(path.join(target, ".git"));
          fs.unlinkSync(path.join(target, "file"));
          if (removed === "Git metadata") fs.rmSync(gitdir, { recursive: true });
        }
        callback(failure, "");
      });
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await eligible(f);
    await f.cleanup.sweep();
    assert.equal(attempted, true);
    assert.equal(fs.readFileSync(path.join(target, ".git"), "utf8"), gitfile);
    assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
    assert.equal(git(target, "status", "--porcelain"), "");
    assert.match(git(main, "worktree", "list"), /worktrees[\\/]worker/);
    assert.equal(f.ledger().some((entry) => !entry.worktreeDone), true);
    assert.deepEqual(f.warnings, [failure]);
    assert.deepEqual(fs.readdirSync(f.worktreeRoot), ["worker"]);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await f.cleanup.sweep();
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(f.ledger(), []);
    assert.deepEqual(fs.readdirSync(f.worktreeRoot), []);
  });
}

test("a backup failure preserves the worktree before removal", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  const gitfile = fs.readFileSync(path.join(target, ".git"), "utf8");
  const promises = await import("node:fs/promises");
  const failure = Object.assign(new Error("backup denied"), { code: "EACCES" });
  t.mock.method(promises.default, "link", async () => { throw failure; });
  await eligible(f);
  await f.cleanup.sweep();
  assert.equal(fs.readFileSync(path.join(target, ".git"), "utf8"), gitfile);
  assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
  assert.equal(git(target, "status", "--porcelain"), "");
  assert.equal(f.ledger().some((entry) => !entry.worktreeDone), true);
  assert.deepEqual(f.warnings, [failure]);
  assert.deepEqual(fs.readdirSync(f.worktreeRoot), ["worker"]);
});

for (const origin of ["worktree", "scratch"]) {
  test(`deep incoming ${origin} links retain their destination`, async (t) => {
    const f = fixture(t);
    const { target } = repo(f);
    const root = origin === "worktree" ? path.join(f.worktreeRoot, "host") : path.join(f.tempRoot, "wink-OTHER");
    const folder = path.join(root, "project", "node_modules", ".pnpm", "pkg", "node_modules");
    fs.mkdirSync(folder, { recursive: true });
    const link = path.join(folder, "pkg");
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    await eligible(f);
    await f.cleanup.sweep();
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.realpathSync(link), fs.realpathSync(target));
    fs.unlinkSync(link);
  });
}

test("a missing old TEMP root does not block another worktree", async (t) => {
  const f = fixture(t);
  const root = path.join(f.home, "old-temp");
  fs.mkdirSync(root);
  const old = { ...f.session, id: "old", tempRoot: root };
  f.cleanup.opened(old);
  await f.cleanup.closed(old, true);
  fs.rmdirSync(root);
  const { target } = repo(f);
  await eligible(f);
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(target), false, f.warnings.map(String).join("\n"));
  assert.deepEqual(f.warnings, []);
});

for (const incoming of [false, true]) {
  test(`a dangling scratch link ${incoming ? "into the candidate retains it" : "elsewhere does not block cleanup"}`, async (t) => {
    const f = fixture(t);
    const { target } = repo(f);
    const link = path.join(f.tempRoot, "wink-OLD");
    fs.symlinkSync(path.join(incoming ? target : f.home, "missing"), link, process.platform === "win32" ? "junction" : "dir");
    await eligible(f);
    await f.cleanup.sweep();
    assert.equal(fs.existsSync(target), incoming, f.warnings.map(String).join("\n"));
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.deepEqual(f.warnings, []);
    fs.unlinkSync(link);
  });
}

for (const restart of [false, true]) {
  test(`removed worktree ownership cannot delete a reused path${restart ? " after restart" : ""}`, async (t) => {
    const f = fixture(t);
    const { main, target } = repo(f);
    fs.mkdirSync(path.join(target, "sub"));
    const other = { ...f.session, id: "other", cwd: path.join(target, "sub") };
    f.cleanup.opened(other);
    await f.cleanup.closed(other, true);
    await eligible(f);
    await f.cleanup.sweep();
    assert.equal(fs.existsSync(target), false);
    git(main, "worktree", "add", "--quiet", "-b", "unrelated", target);
    fs.writeFileSync(path.join(target, "file"), "unrelated");
    git(target, "commit", "--quiet", "-am", "replacement");
    git(target, "update-ref", "refs/remotes/test/replacement", "HEAD");
    f.advance(2 * DAY_MS);
    const cleanup = restart ? createPaneCleanup(f.options) : f.cleanup;
    t.after(() => cleanup.dispose());
    if (restart) cleanup.start(() => []);
    await cleanup.sweep();
    assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "unrelated");
  });
}

test("completed ledger rows are pruned without repeated git errors", async (t) => {
  const f = fixture(t);
  repo(f);
  await eligible(f);
  await f.cleanup.sweep();
  assert.deepEqual(f.ledger(), []);
  await f.cleanup.sweep();
  assert.deepEqual(f.warnings, []);
});

for (const pin of ["bot", "bot task", "room", "room pin", "room task", "unreadable"]) {
  test(`production cleanup refreshes persisted ${pin} paths`, async (t) => {
    const f = fixture(t);
    const { target } = repo(f);
    await eligible(f);
    const dataDir = pin === "bot" ? path.join(f.home, ".orbit") : path.join(f.home, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const savePins = (bots, groups) => {
      fs.writeFileSync(path.join(dataDir, "bots.json"), JSON.stringify(bots));
      fs.writeFileSync(path.join(dataDir, "groups.json"), JSON.stringify(groups));
    };
    savePins([], []);
    const source = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const expression = source.match(/paneCleanup: (createPaneCleanupWorker\(\{[^\n]+\}\)),/)[1];
    const module = await import("./pane-cleanup.mjs");
    const env = { ORBIT_WORKTREE_ROOT: f.worktreeRoot };
    if (pin !== "bot") env.OMB_DATA_DIR = dataDir;
    const options = new Function("app", "process", "path", "slog", "createPaneCleanupWorker", "scratchRoot", `return ${expression};`)(
      { getPath: () => f.home }, { env }, path, () => {}, (value) => value, f.options.tempRoot,
    );
    const cleanup = createPaneCleanup({ ...f.options, ...options, pinned: () => module.readCleanupPins(options.dataDir) });
    cleanup.start(() => []);
    t.after(() => cleanup.dispose());
    const cwd = path.join(target, "not-created");
    if (pin === "bot") savePins([{ cwd }], []);
    if (pin === "bot task") savePins([{ tasks: [{ cwd }] }], []);
    if (pin === "room") savePins([], [{ cwd }]);
    if (pin === "room pin") savePins([], [{ pinnedCwd: cwd }]);
    if (pin === "room task") savePins([], [{ tasks: [{ pinnedCwd: cwd }] }]);
    if (pin === "unreadable") fs.writeFileSync(path.join(dataDir, "bots.json"), "{");
    await cleanup.sweep();
    assert.equal(fs.existsSync(target), true);
    savePins([], []);
    await cleanup.sweep();
    assert.equal(fs.existsSync(target), false);
  });
}

for (const gate of ["none", "open pane", "pinned", "recent close"]) {
  test(`short aliases keep the worktree gate for ${gate}`, { skip: process.platform !== "win32" && "8.3 aliases require Windows" }, async (t) => {
    const f = fixture(t, true);
    if (!f) return;
    const { main, target } = repo(f);
    const longTarget = fs.realpathSync.native(target);
    const shared = path.join(f.home, "shared-packages");
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, "package"), "safe");
    fs.symlinkSync(shared, path.join(target, "node_modules"), "junction");
    if (gate === "open pane") f.open([{ id: "other", label: "OTHER", cwd: path.join(longTarget, "not-created") }]);
    await eligible(f);
    if (gate === "recent close") {
      const next = { ...f.session, id: "next", cwd: longTarget };
      f.cleanup.opened(next);
      await f.cleanup.closed(next, true);
    }
    if (gate === "pinned") {
      const cleanup = createPaneCleanup({ ...f.options, pinned: [longTarget] });
      cleanup.start(() => []);
      t.after(() => cleanup.dispose());
      await cleanup.sweep();
    } else await f.cleanup.sweep();
    assert.equal(fs.existsSync(target), gate !== "none", f.warnings.map(String).join("\n"));
    assert.equal(fs.readFileSync(path.join(shared, "package"), "utf8"), "safe");
    assert.match(git(main, "branch", "--list", "test-worker"), /test-worker/);
    assert.deepEqual(f.warnings, []);
  });
}

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

for (const close of ["closeForBot", "close", "closeBotPanes"]) {
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
    else if (close === "close") await host.close({ sender: owner }, pane.sessionId);
    else await host.closeBotPanes("bot");
    await f.cleanup.flush();
    assert.equal(killed, true);
    assert.equal(fs.existsSync(f.scratch), false);
    assert.equal(f.ledger()[0].closedAt > 0, true);
  });
}

for (const delay of [0, 1]) {
  test(`a follow-up without its own report preserves scratch after ${delay} ms`, async (t) => {
    const f = fixture(t);
    const owner = { id: 1, send() {}, isDestroyed: () => false };
    const host = createTerminalHost({
      authorize() {}, owner: () => owner, resolveCwd: async () => f.home, now: f.options.now,
      platform: "linux", env: { SHELL: "/bin/sh", TEMP: f.tempRoot }, freeMemory: () => 64 * 1024 ** 3,
      paneCleanup: f.cleanup,
      loadPty: () => ({ spawn: () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }) }),
    });
    t.after(() => host.dispose());
    const pane = await host.openForBot("bot", { label: "TEST", command: "codex test" });
    host.attendBot("bot", pane.sessionId, "report");
    f.advance(delay);
    host.sendBot("bot", { sessionId: pane.sessionId, generation: pane.generation, text: "follow up\r" });
    await host.closeForBot("bot", pane.sessionId);
    await f.cleanup.flush();
    assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
    assert.equal(f.ledger()[0].reported, false);
    f.advance(DAY_MS);
    await f.cleanup.sweep();
    assert.equal(fs.existsSync(f.scratch), false);
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

const events = (f) => {
  try { return fs.readFileSync(path.join(f.home, ".orbit", "cleanup.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
};

async function crashBeforeRemoval(t, f) {
  const promises = await import("node:fs/promises");
  const mkdtemp = promises.default.mkdtemp;
  let crash;
  const crashed = new Promise((resolve) => { crash = resolve; });
  let armed = true;
  t.mock.method(promises.default, "mkdtemp", (...args) => {
    if (!armed) return mkdtemp(...args);
    armed = false;
    crash();
    return new Promise(() => {});
  });
  const first = createPaneCleanup(f.options);
  first.start(() => []);
  void first.sweep();
  await crashed;
  first.dispose();
}

test("a worktree sweep with a full ledger makes no synchronous path calls", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  for (let folder = 0; folder < 20; folder++) {
    fs.mkdirSync(path.join(target, "src", `folder-${folder}`), { recursive: true });
    for (let file = 0; file < 100; file++) fs.writeFileSync(path.join(target, "src", `folder-${folder}`, `file-${file}`), "");
  }
  git(target, "add", ".");
  git(target, "commit", "--quiet", "-m", "tracked");
  git(target, "update-ref", "refs/remotes/test/main", "HEAD");
  assert.equal(git(target, "ls-files").split("\n").length, 2_002);
  await eligible(f);
  const cleanup = createPaneCleanup({ ...f.options, pinned: Array.from({ length: 20 }, (_, index) => path.join(f.home, "pins", `${index}`)) });
  cleanup.start(() => []);
  t.after(() => cleanup.dispose());
  for (let index = 0; index < 500; index++) cleanup.opened({ ...f.session, id: `open-${index}`, label: `OPEN-${index}`, cwd: path.join(f.home, "open", `${index}`) });
  let calls = 0;
  const lstatSync = fs.lstatSync;
  const realpathSync = fs.realpathSync.native;
  t.after(() => { fs.lstatSync = lstatSync; fs.realpathSync.native = realpathSync; });
  fs.lstatSync = (...args) => { calls++; return lstatSync(...args); };
  fs.realpathSync.native = (...args) => { calls++; return realpathSync(...args); };
  await cleanup.sweep();
  fs.lstatSync = lstatSync;
  fs.realpathSync.native = realpathSync;
  t.diagnostic(`sync filesystem calls: ${calls}`);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(target), false, f.warnings.map(String).join("\n"));
  assert.deepEqual(f.warnings, []);
});

test("the incoming link scan stays within a few calls per link", async (t) => {
  const f = fixture(t);
  f.session.label = "worker";
  const { target } = repo(f);
  const deep = path.join(f.home, "deep");
  const folder = path.join(deep, "a", "b", "c", "d", "e", "f", "g");
  fs.mkdirSync(folder, { recursive: true });
  const host = path.join(f.worktreeRoot, "host");
  fs.mkdirSync(host);
  for (let index = 0; index < 500; index++) fs.symlinkSync(folder, path.join(host, `link-${index}`), process.platform === "win32" ? "junction" : "dir");
  await eligible(f);
  const watched = [host, deep].map((root) => root.toLowerCase());
  const promises = await import("node:fs/promises");
  let calls = 0;
  for (const method of ["lstat", "realpath", "readlink", "readdir"]) {
    const original = promises.default[method];
    t.mock.method(promises.default, method, (...args) => {
      const file = path.resolve(String(args[0])).toLowerCase();
      if (watched.some((root) => file === root || file.startsWith(`${root}${path.sep}`))) calls++;
      return original(...args);
    });
  }
  await f.cleanup.sweep();
  const stats = events(f).findLast((line) => line.kind === "links") ?? { dirs: 0, links: 0 };
  t.diagnostic(`link scan fs calls: ${calls}; dirs ${stats.dirs}; links ${stats.links}; ${stats.ms} ms`);
  assert.equal(fs.existsSync(target), false, f.warnings.map(String).join("\n"));
  assert.equal(stats.links, 1_000);
  assert.ok(calls <= stats.dirs + 6 * stats.links, `${calls} fs calls`);
  assert.deepEqual(f.warnings, []);
});

test("a crash between marking a worktree deleting and removing it resumes after restart", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  await eligible(f);
  await crashBeforeRemoval(t, f);
  assert.equal(fs.existsSync(target), true);
  assert.equal(f.ledger().some((entry) => !entry.worktreeDone), true);
  const restarted = createPaneCleanup(f.options);
  restarted.start(() => []);
  t.after(() => restarted.dispose());
  await restarted.sweep();
  assert.equal(fs.existsSync(target), false, f.warnings.map(String).join("\n"));
  assert.deepEqual(f.ledger(), []);
  assert.deepEqual(f.warnings, []);
});

test("a crash before removal never deletes a different worktree at the same path", async (t) => {
  const f = fixture(t);
  const { main, target } = repo(f);
  await eligible(f);
  await crashBeforeRemoval(t, f);
  git(main, "worktree", "remove", target);
  git(main, "worktree", "add", "--quiet", "-b", "unrelated", target);
  fs.writeFileSync(path.join(target, "file"), "unrelated");
  git(target, "commit", "--quiet", "-am", "replacement");
  git(target, "update-ref", "refs/remotes/test/replacement", "HEAD");
  const restarted = createPaneCleanup(f.options);
  restarted.start(() => []);
  t.after(() => restarted.dispose());
  f.advance(4 * DAY_MS);
  await restarted.sweep();
  assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "unrelated");
  assert.deepEqual(f.ledger(), []);
  assert.deepEqual(f.warnings, []);
});

test("a commit made after the first unpushed check keeps the worktree", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  await eligible(f);
  const promises = await import("node:fs/promises");
  const link = promises.default.link;
  let committed = false;
  t.mock.method(promises.default, "link", async (...args) => {
    const value = await link(...args);
    if (!committed) {
      committed = true;
      fs.writeFileSync(path.join(target, "late"), "late");
      git(target, "add", "late");
      git(target, "commit", "--quiet", "-m", "late");
    }
    return value;
  });
  await f.cleanup.sweep();
  assert.equal(committed, true);
  assert.equal(fs.readFileSync(path.join(target, "late"), "utf8"), "late");
  assert.notEqual(git(target, "rev-list", "HEAD", "--not", "--remotes"), "");
  assert.equal(f.ledger().every((entry) => !entry.worktreeDone && !entry.deleting), true);
  assert.deepEqual(events(f).filter((line) => line.kind === "kept").map((line) => line.reason), ["unpushed"]);
  assert.deepEqual(f.warnings, []);
});

test("another instance's load leaves this instance's open rows open", async (t) => {
  const f = fixture(t);
  const release = createPaneCleanup({ ...f.options, instance: "release" });
  release.start(() => []);
  t.after(() => release.dispose());
  release.opened(f.session);
  const dev = createPaneCleanup({ ...f.options, instance: "dev" });
  dev.start(() => []);
  t.after(() => dev.dispose());
  assert.equal(f.ledger()[0].closedAt, null);
  f.advance(4 * DAY_MS);
  await dev.sweep();
  assert.equal(f.ledger()[0].closedAt, null);
  assert.equal(fs.existsSync(f.scratch), true);
});

test("a dirty worktree swept twice is listed as kept once", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  fs.writeFileSync(path.join(target, "file"), "unsaved");
  await eligible(f);
  await f.cleanup.sweep();
  await f.cleanup.sweep();
  const kept = events(f).filter((line) => line.kind === "kept");
  assert.deepEqual(kept.map((line) => line.reason), ["dirty"]);
  assert.equal(fs.realpathSync.native(kept[0].path), fs.realpathSync.native(target));
  assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "unsaved");
});

test("the default instance survives a changed executable path", (t) => {
  const f = fixture(t);
  f.cleanup.opened(f.session);
  const execPath = process.execPath;
  process.execPath = path.join(f.home, "new-mount", "wink");
  const restarted = createPaneCleanup(f.options);
  process.execPath = execPath;
  restarted.start(() => []);
  t.after(() => restarted.dispose());
  assert.ok(f.ledger()[0].closedAt);
});

test("a dev launch leaves the packaged app's open rows open", (t) => {
  const f = fixture(t);
  f.cleanup.opened(f.session);
  process.defaultApp = true;
  const dev = createPaneCleanup(f.options);
  delete process.defaultApp;
  dev.start(() => []);
  t.after(() => dev.dispose());
  assert.equal(f.ledger()[0].closedAt, null);
});

test("live-pane rechecks stay within a few filesystem calls per pane", async (t) => {
  const f = fixture(t);
  const shared = path.join(f.home, "live", "a", "b", "c", "d", "e");
  const panes = Array.from({ length: 60 }, (_, index) => ({ id: `live-${index}`, label: `LIVE-${index}`, cwd: path.join(shared, `pane-${index}`) }));
  for (const pane of panes) fs.mkdirSync(pane.cwd, { recursive: true });
  f.open(panes);
  const watched = fs.realpathSync.native(path.join(f.home, "live")).toLowerCase();
  const promises = await import("node:fs/promises");
  let calls = 0;
  for (const method of ["lstat", "realpath"]) {
    const original = promises.default[method];
    t.mock.method(promises.default, method, (...args) => {
      const file = path.resolve(String(args[0])).toLowerCase();
      if (file === watched || file.startsWith(`${watched}${path.sep}`)) calls++;
      return original(...args);
    });
  }
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  t.diagnostic(`live-pane recheck fs calls: ${calls}`);
  assert.equal(fs.existsSync(f.scratch), false);
  assert.ok(calls <= 12 * 4 * panes.length, `${calls} fs calls`);
  assert.deepEqual(f.warnings, []);
});

test("a pane cwd re-pointed at scratch between rechecks keeps it", async (t) => {
  const f = fixture(t);
  const alias = path.join(f.home, "alias");
  fs.mkdirSync(alias);
  f.open([{ id: "other", label: "OTHER", cwd: alias }]);
  const promises = await import("node:fs/promises");
  const readdir = promises.default.readdir;
  let swapped = false;
  t.mock.method(promises.default, "readdir", async (...args) => {
    if (path.resolve(String(args[0])) === path.resolve(f.scratch) && !swapped) {
      swapped = true;
      fs.rmdirSync(alias);
      fs.symlinkSync(f.scratch, alias, process.platform === "win32" ? "junction" : "dir");
    }
    return readdir(...args);
  });
  f.cleanup.opened(f.session);
  await f.cleanup.closed(f.session);
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(path.join(f.scratch, "file"), "utf8"), "scratch");
  assert.deepEqual(f.warnings, []);
  fs.unlinkSync(alias);
});

test("overlapping sweeps run one at a time and each logs its CPU", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  await eligible(f);
  let running = 0;
  let peak = 0;
  const cleanup = createPaneCleanup({ ...f.options, pinned: async () => {
    peak = Math.max(peak, ++running);
    await new Promise((resolve) => setImmediate(resolve));
    running--;
    return [];
  } });
  cleanup.start(() => []);
  t.after(() => cleanup.dispose());
  await Promise.all([cleanup.sweep(), cleanup.sweep()]);
  assert.equal(peak, 1);
  assert.equal(fs.existsSync(target), false, f.warnings.map(String).join("\n"));
  const logged = events(f).filter((line) => line.kind === "sweep");
  assert.equal(logged.length, 2);
  assert.ok(logged.every((line) => Number.isInteger(line.cpuMs) && line.cpuMs >= 0));
});

function sharedHosts(f, count) {
  const shared = path.join(f.home, "shared", "node_modules");
  for (let index = 0; index < 20; index++) fs.mkdirSync(path.join(shared, `pkg-${index}`, "lib"), { recursive: true });
  for (let folder = 0; folder < count; folder++) {
    const host = path.join(f.worktreeRoot, `w-${folder}`);
    for (let sub = 0; sub < 10; sub++) fs.mkdirSync(path.join(host, "src", `d${sub}`), { recursive: true });
    fs.symlinkSync(shared, path.join(host, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
}

const dirs = (dir) => 1 + fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).reduce((sum, entry) => sum + dirs(path.join(dir, entry.name)), 0);

test("a failing link watcher costs one walk, not one per row", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = fixture(t);
  sharedHosts(f, 20);
  const rows = await scratchRows(f, Array.from({ length: 100 }, (_, index) => `ROW-${index}`));
  const tree = dirs(f.worktreeRoot) + dirs(f.tempRoot);
  const watch = fs.watch;
  t.mock.method(fs, "watch", (...args) => {
    const watcher = watch(...args);
    if (args[0] === f.worktreeRoot) setImmediate(() => watcher.emit("error", new Error("overflow")));
    return watcher;
  });
  await f.cleanup.sweep();
  const stats = events(f).findLast((line) => line.kind === "links");
  t.diagnostic(`dirs walked ${stats.dirs} for ${tree}`);
  assert.deepEqual(rows.filter((row) => !fs.existsSync(row)), []);
  assert.ok(stats.dirs <= tree, `${stats.dirs} dirs walked for ${tree}`);
  assert.deepEqual([...new Set(events(f).filter((line) => line.kind === "kept").map((line) => line.reason))], ["doubt"]);
  assert.deepEqual(f.warnings, []);
});

test("a worker sweep makes no filesystem calls on the main thread", async (t) => {
  const f = fixture(t);
  sharedHosts(f, 20);
  const closedAt = Date.now() - 4 * DAY_MS;
  const rows = Array.from({ length: 20 }, (_, index) => ({ id: `FREE-${index}`, instance: "app", botId: "bot", label: `FREE-${index} | model | high`, cwd: f.home, tempRoot: f.tempRoot, scratch: path.join(f.tempRoot, `wink-FREE-${index}`), openedAt: closedAt, closedAt, keep: false, reported: true, worktreeDone: true }));
  for (const row of rows) fs.mkdirSync(row.scratch);
  fs.writeFileSync(path.join(f.home, ".orbit", "pane-ledger.json"), JSON.stringify(rows));
  const warnings = [];
  const cleanup = createPaneCleanupWorker({ home: f.home, tempRoot: f.tempRoot, worktreeRoot: f.worktreeRoot, dataDir: path.join(f.home, ".orbit"), instance: "app", warn: (error) => warnings.push(error) });
  t.after(() => cleanup.dispose());
  cleanup.start(() => [{ id: "open", label: "FREE-0 | model | high", cwd: f.home }]);
  const promises = await import("node:fs/promises");
  let calls = 0;
  for (const method of ["lstat", "stat", "readdir", "readlink", "realpath", "rm"]) {
    const original = promises.default[method];
    t.mock.method(promises.default, method, (...args) => {
      calls++;
      return original(...args);
    });
  }
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  await cleanup.sweep();
  delay.disable();
  await cleanup.dispose();
  t.diagnostic(`main-thread fs calls ${calls}; max loop delay ${Math.round(delay.max / 1e6)} ms`);
  assert.equal(calls, 0);
  assert.ok(delay.max / 1e6 <= 50, `${delay.max / 1e6} ms`);
  assert.deepEqual(rows.filter((row) => fs.existsSync(row.scratch)).map((row) => row.id), ["FREE-0"]);
  assert.deepEqual(warnings, []);
});

test("a linked worktree is kept without statting its files", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  const src = path.join(target, "src");
  fs.mkdirSync(src);
  for (let index = 0; index < 200; index++) fs.writeFileSync(path.join(src, `file-${index}`), "");
  git(target, "add", ".");
  git(target, "commit", "--quiet", "-m", "files");
  git(target, "update-ref", "refs/remotes/test/main", "HEAD");
  const link = path.join(f.worktreeRoot, "host", "incoming");
  fs.mkdirSync(path.dirname(link));
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  await eligible(f);
  const promises = await import("node:fs/promises");
  const lstat = promises.default.lstat;
  let files = 0;
  t.mock.method(promises.default, "lstat", (...args) => {
    if (path.dirname(path.resolve(String(args[0]))) === src) files++;
    return lstat(...args);
  });
  await f.cleanup.sweep();
  assert.equal(files, 0);
  assert.equal(fs.existsSync(path.join(src, "file-0")), true);
  assert.deepEqual(events(f).filter((line) => line.kind === "kept").map((line) => line.reason), ["linked"]);
  assert.deepEqual(f.warnings, []);
  fs.unlinkSync(link);
});

test("a link walk that fails partway cannot clear a later row", async (t) => {
  const f = fixture(t);
  const [, second] = await scratchRows(f, ["ROW-A", "ROW-B"]);
  const fail = path.join(f.worktreeRoot, "a-fail");
  fs.mkdirSync(fail);
  const link = path.join(f.worktreeRoot, "host", "incoming");
  fs.mkdirSync(path.dirname(link));
  fs.symlinkSync(second, link, process.platform === "win32" ? "junction" : "dir");
  const promises = await import("node:fs/promises");
  const readdir = promises.default.readdir;
  let failed = false;
  t.mock.method(promises.default, "readdir", (...args) => {
    if (failed || path.resolve(String(args[0])).toLowerCase() !== fail.toLowerCase()) return readdir(...args);
    failed = true;
    return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
  });
  await f.cleanup.sweep();
  assert.equal(failed, true);
  assert.equal(fs.existsSync(second), true);
  assert.deepEqual(events(f).filter((line) => line.kind === "kept").map((line) => line.reason), ["doubt"]);
  assert.deepEqual(f.warnings, []);
  fs.unlinkSync(link);
});

test("a gone link cannot hide a sibling that reaches the target", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  const kind = process.platform === "win32" ? "junction" : "dir";
  const elsewhere = path.join(f.home, "elsewhere");
  fs.mkdirSync(elsewhere);
  const alias = path.join(f.home, "shared", "alias");
  fs.mkdirSync(path.dirname(alias));
  fs.symlinkSync(elsewhere, alias, kind);
  const [first, second] = ["a-host", "b-host"].map((name) => path.join(f.worktreeRoot, name, "link"));
  for (const link of [first, second]) {
    fs.mkdirSync(path.dirname(link));
    fs.symlinkSync(alias, link, kind);
  }
  await eligible(f);
  let loads = 0;
  const cleanup = createPaneCleanup({ ...f.options, pinned: () => {
    if (++loads === 2) {
      fs.unlinkSync(first);
      fs.unlinkSync(alias);
      fs.symlinkSync(target, alias, kind);
    }
    return [];
  } });
  cleanup.start(() => []);
  t.after(() => cleanup.dispose());
  await cleanup.sweep();
  assert.ok(loads >= 2);
  assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
  assert.deepEqual(events(f).filter((line) => line.kind === "kept").map((line) => line.reason), ["linked"]);
  assert.deepEqual(f.warnings, []);
  fs.unlinkSync(second);
  fs.unlinkSync(alias);
});

test("a fresh reflog keeps an otherwise idle worktree", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  await eligible(f);
  const future = new Date(Date.now() + 4 * DAY_MS);
  fs.utimesSync(path.join(git(target, "rev-parse", "--absolute-git-dir"), "logs", "HEAD"), future, future);
  await f.cleanup.sweep();
  assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
  assert.deepEqual(f.warnings, []);
});

test("an ignored-file walk past its cap keeps the worktree", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  for (let index = 0; index < 5; index++) fs.mkdirSync(path.join(target, "node_modules", `pkg-${index}`), { recursive: true });
  await eligible(f);
  const cleanup = createPaneCleanup({ ...f.options, budget: { ...SWEEP_BUDGET, walk: 3 } });
  cleanup.start(() => []);
  t.after(() => cleanup.dispose());
  await cleanup.sweep();
  assert.equal(fs.readFileSync(path.join(target, "file"), "utf8"), "saved");
  assert.deepEqual(events(f).filter((line) => line.kind === "kept").map((line) => line.reason), ["walk cap"]);
  assert.deepEqual(f.warnings, []);
});

test("a fresh ignored file deep inside keeps an otherwise idle worktree", async (t) => {
  const f = fixture(t);
  const { target } = repo(f);
  const deep = path.join(target, "node_modules", "run", "out", "result.bin");
  fs.mkdirSync(path.dirname(deep), { recursive: true });
  fs.writeFileSync(deep, "running");
  await eligible(f);
  const future = new Date(Date.now() + 4 * DAY_MS);
  fs.utimesSync(deep, future, future);
  await f.cleanup.sweep();
  assert.equal(fs.readFileSync(deep, "utf8"), "running");
  assert.deepEqual(f.warnings, []);
});
