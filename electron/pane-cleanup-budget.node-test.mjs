import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import test from "node:test";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { SWEEP_BUDGET, createPaneCleanup, createPaneCleanupWorker } from "./pane-cleanup.mjs";

const DAY_MS = 86_400_000;
const kind = process.platform === "win32" ? "junction" : "dir";
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();

function count(dir) {
  const found = { dirs: 1, links: 0 };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) found.links++;
    else if (entry.isDirectory()) {
      const inner = count(path.join(dir, entry.name));
      found.dirs += inner.dirs;
      found.links += inner.links;
    }
  }
  return found;
}

async function tree(t, { bystanders = 20, worktrees = 3, files = 0, scratch = 10, nested = 0, budget = SWEEP_BUDGET } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pane-budget-"));
  const worktreeRoot = path.join(home, "worktrees");
  const tempRoot = path.join(home, "temp");
  const shared = path.join(home, "shared", "node_modules");
  for (let index = 0; index < 20; index++) fs.mkdirSync(path.join(shared, `pkg-${index}`), { recursive: true });
  for (let index = 0; index < 30; index++) fs.mkdirSync(path.join(tempRoot, `wink-S${index}`, "a", "b"), { recursive: true });
  for (let by = 0; by < bystanders; by++) {
    const folder = path.join(worktreeRoot, `by-${by}`);
    for (let top = 0; top < 10; top++) for (let sub = 0; sub < 9; sub++) fs.mkdirSync(path.join(folder, `d${top}`, `e${sub}`), { recursive: true });
    for (let link = 0; link < 20; link++) fs.symlinkSync(path.join(shared, `pkg-${link}`), path.join(folder, `d${link % 10}`, `link-${link}`), kind);
    fs.writeFileSync(path.join(folder, "log"), "");
  }
  const main = path.join(home, "repo");
  fs.mkdirSync(main);
  git(main, "init", "--quiet");
  git(main, "config", "user.name", "Test");
  git(main, "config", "user.email", "test@example.test");
  for (let index = 0; index < files; index++) {
    fs.mkdirSync(path.join(main, "src", `d${index % 20}`), { recursive: true });
    fs.writeFileSync(path.join(main, "src", `d${index % 20}`, `f${index}`), "");
  }
  fs.writeFileSync(path.join(main, "file"), "saved");
  git(main, "add", ".");
  git(main, "commit", "--quiet", "-m", "fixture");
  git(main, "update-ref", "refs/remotes/test/main", "HEAD");
  const targets = Array.from({ length: worktrees }, (_, index) => path.join(worktreeRoot, `wt-${index}`));
  for (const [index, target] of targets.entries()) git(main, "worktree", "add", "--quiet", "-b", `wt-${index}`, target);
  let time = Date.now();
  const jobs = [];
  const warnings = [];
  const live = path.join(tempRoot, `wink-S${scratch}`);
  const options = { home, tempRoot, worktreeRoot, budget, now: () => time, setPriority: () => {}, warn: (error) => warnings.push(error), schedule: (run, ms) => { const job = { run, ms }; jobs.push(job); return job; }, cancel: (job) => { const index = jobs.indexOf(job); if (index !== -1) jobs.splice(index, 1); } };
  const cleanup = createPaneCleanup(options);
  cleanup.start(() => [{ id: "live", label: `S${scratch} | model | high`, cwd: home }]);
  let writer = null;
  t.after(async () => {
    writer?.kill();
    cleanup.dispose();
    await cleanup.flush();
    await removeTempDir(home);
  });
  for (const [index, target] of targets.entries()) {
    for (let sub = 0; sub <= nested; sub++) {
      const cwd = sub ? path.join(target, `sub-${sub}`) : target;
      if (sub) fs.mkdirSync(cwd);
      const session = { id: `wt-${index}-${sub}`, botId: "bot", label: "worker", cwd, tempRoot, reportAt: time };
      cleanup.opened(session);
      await cleanup.closed(session, true);
    }
  }
  const rows = Array.from({ length: scratch }, (_, index) => path.join(tempRoot, `wink-S${index}`));
  for (const [index, row] of rows.entries()) {
    const session = { id: `S${index}`, botId: "bot", label: `S${index} | model | high`, cwd: home, tempRoot, reportAt: time };
    cleanup.opened(session);
    await cleanup.closed(session, true);
    assert.equal(fs.existsSync(row), true);
  }
  time += 4 * DAY_MS;
  const roots = () => {
    const found = count(worktreeRoot);
    found.dirs++;
    for (const name of fs.readdirSync(tempRoot).filter((name) => name.startsWith("wink-"))) {
      const inner = count(path.join(tempRoot, name));
      found.dirs += inner.dirs;
      found.links += inner.links;
    }
    return found;
  };
  const events = () => fs.readFileSync(path.join(home, ".orbit", "cleanup.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const write = () => {
    const files = [path.join(worktreeRoot, "by-0", "log"), path.join(live, "log")];
    writer = childProcess.spawn(process.execPath, ["-e", `const fs = require("fs"); setInterval(() => { for (const file of ${JSON.stringify(files)}) fs.appendFileSync(file, "x"); }, 20);`], { stdio: "ignore", windowsHide: true });
    return new Promise((resolve) => setTimeout(resolve, 200));
  };
  return { home, worktreeRoot, tempRoot, cleanup, jobs, targets, rows, live, warnings, roots, events, write };
}

async function calls(t) {
  const promises = await import("node:fs/promises");
  const counted = { calls: 0 };
  for (const method of ["lstat", "stat", "readdir", "readlink", "realpath"]) {
    const original = promises.default[method];
    t.mock.method(promises.default, method, (...args) => {
      counted.calls++;
      return original(...args);
    });
  }
  return counted;
}

test("a sweep walks the folders it will not delete once", async (t) => {
  const small = await tree(t, { bystanders: 20 });
  const large = await tree(t, { bystanders: 80 });
  const extra = large.roots().dirs - small.roots().dirs + large.roots().links - small.roots().links;
  await small.write();
  await large.write();
  const counted = await calls(t);
  await small.cleanup.sweep();
  const before = counted.calls;
  await large.cleanup.sweep();
  const grown = counted.calls - 2 * before;
  t.diagnostic(`calls ${before} -> ${counted.calls - before}; ${extra} extra dirs and links`);
  for (const f of [small, large]) {
    assert.deepEqual([...f.targets, ...f.rows].filter((file) => fs.existsSync(file)), []);
    assert.deepEqual(f.warnings, []);
  }
  assert.ok(grown <= 3 * extra, `${grown} extra calls for ${extra} extra dirs and links`);
});

test("a busy tree still lets a sweep finish", async (t) => {
  const f = await tree(t);
  const { dirs } = f.roots();
  await f.write();
  await f.cleanup.sweep();
  const stats = f.events().findLast((line) => line.kind === "links");
  assert.deepEqual([...f.targets, ...f.rows].filter((file) => fs.existsSync(file)), []);
  assert.equal(fs.existsSync(f.live), true);
  assert.ok(stats.dirs <= dirs, `${stats.dirs} dirs walked for ${dirs}`);
  assert.deepEqual(f.warnings, []);
});

test("deleting a worktree does not make the sweep walk again", async (t) => {
  const f = await tree(t, { bystanders: 5, files: 2_000, scratch: 0 });
  const { dirs } = f.roots();
  await f.cleanup.sweep();
  const stats = f.events().findLast((line) => line.kind === "links");
  assert.deepEqual(f.targets.filter((file) => fs.existsSync(file)), []);
  assert.ok(stats.dirs <= dirs, `${stats.dirs} dirs walked for ${dirs}`);
  assert.deepEqual(f.warnings, []);
});

test("git runs once per worktree, not once per ledger row", async (t) => {
  const f = await tree(t, { bystanders: 0, worktrees: 1, scratch: 0, nested: 4 });
  const [target] = f.targets;
  fs.writeFileSync(path.join(target, "file"), "local");
  git(target, "commit", "--quiet", "-am", "local");
  let spawns = 0;
  const execFile = childProcess.execFile;
  t.mock.method(childProcess, "execFile", (...args) => {
    if (args[0] === "git") spawns++;
    return execFile(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await f.cleanup.sweep();
  const first = spawns;
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(target), true);
  assert.ok(first <= 3, `${first} git spawns for 5 rows`);
  assert.ok(spawns - first <= 1, `${spawns - first} git spawns on an unchanged sweep`);
  assert.deepEqual(f.warnings, []);
});

test("the sweep leaves the loop free", async (t) => {
  const f = await tree(t, { bystanders: 80, worktrees: 0, scratch: 0 });
  const closedAt = Date.now() - 4 * DAY_MS;
  const rows = Array.from({ length: 10 }, (_, index) => ({ id: `FREE-${index}`, instance: "app", botId: "bot", label: `S${index} | model | high`, cwd: f.home, tempRoot: f.tempRoot, scratch: path.join(f.tempRoot, `wink-S${index}`), openedAt: closedAt, closedAt, keep: false, reported: true, worktreeDone: true }));
  fs.writeFileSync(path.join(f.home, ".orbit", "pane-ledger.json"), JSON.stringify(rows));
  const warnings = [];
  const cleanup = createPaneCleanupWorker({ home: f.home, tempRoot: f.tempRoot, worktreeRoot: f.worktreeRoot, dataDir: path.join(f.home, ".orbit"), instance: "app", warn: (error) => warnings.push(error) });
  t.after(() => cleanup.dispose());
  const delay = monitorEventLoopDelay({ resolution: 10 });
  const start = performance.eventLoopUtilization();
  delay.enable();
  await cleanup.sweep();
  delay.disable();
  const { utilization } = performance.eventLoopUtilization(start);
  await cleanup.dispose();
  t.diagnostic(`main loop utilization ${utilization.toFixed(3)}; max delay ${Math.round(delay.max / 1e6)} ms`);
  assert.deepEqual(rows.filter((row) => fs.existsSync(row.scratch)), []);
  assert.ok(utilization < 0.2, `utilization ${utilization}`);
  assert.ok(delay.max / 1e6 < 200, `${delay.max / 1e6} ms`);
  assert.deepEqual(warnings, []);
});

test("a sweep stops at its budget and resumes on the next tick", async (t) => {
  const f = await tree(t, { bystanders: 2, worktrees: 0, scratch: 3, budget: { ...SWEEP_BUDGET, dirs: 1 } });
  const left = () => f.rows.filter((row) => fs.existsSync(row)).length;
  await f.cleanup.sweep();
  assert.equal(left(), 2);
  assert.equal(f.events().filter((line) => line.kind === "budget").length, 1);
  assert.equal(f.jobs.at(-1).ms, 10 * 60_000);
  await f.cleanup.sweep();
  assert.equal(left(), 1);
  await f.cleanup.sweep();
  assert.equal(left(), 0);
  assert.deepEqual(f.warnings, []);
});
