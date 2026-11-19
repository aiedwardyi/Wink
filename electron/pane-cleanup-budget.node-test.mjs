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

async function tree(t, { bystanders = 20, worktrees = 3, files = 0, scratch = 10, nested = 0, budget = SWEEP_BUDGET, cpu } = {}) {
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
  const options = { home, tempRoot, worktreeRoot, budget, cpu, now: () => time, setPriority: () => {}, warn: (error) => warnings.push(error), schedule: (run, ms) => { const job = { run, ms }; jobs.push(job); return job; }, cancel: (job) => { const index = jobs.indexOf(job); if (index !== -1) jobs.splice(index, 1); } };
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
  const close = async (from, to) => {
    const closed = Array.from({ length: to - from }, (_, index) => path.join(tempRoot, `wink-S${from + index}`));
    for (const [index, row] of closed.entries()) {
      const session = { id: `S${from + index}`, botId: "bot", label: `S${from + index} | model | high`, cwd: home, tempRoot, reportAt: time };
      cleanup.opened(session);
      await cleanup.closed(session, true);
      assert.equal(fs.existsSync(row), true);
    }
    time += 4 * DAY_MS;
    return closed;
  };
  const rows = await close(0, scratch);
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
  // Folders no row owns stay out of a pass while they are written to.
  const written = () => {
    const at = new Date(Date.now() + 9 * DAY_MS);
    for (const name of fs.readdirSync(tempRoot)) fs.utimesSync(path.join(tempRoot, name), at, at);
  };
  return { home, worktreeRoot, tempRoot, cleanup, jobs, targets, rows, live, warnings, roots, events, write, close, written };
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
  let lists = 0;
  const execFile = childProcess.execFile;
  t.mock.method(childProcess, "execFile", (...args) => {
    if (args[0] === "git" && args[1][1].endsWith(".git") && args[1].slice(2).join(" ") === "worktree list --porcelain") lists++;
    else if (args[0] === "git") spawns++;
    return execFile(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await f.cleanup.sweep();
  const first = spawns;
  await f.cleanup.sweep();
  assert.equal(fs.existsSync(target), true);
  assert.ok(first <= 6, `${first} git spawns for 5 rows`);
  assert.ok(spawns - first <= 1, `${spawns - first} git spawns on an unchanged sweep`);
  assert.equal(lists, 2, "one worktree list per known repo per pass");
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

test("a tree past the folder budget is swept in one pass and not walked again", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = await tree(t, { bystanders: 2, worktrees: 0, scratch: 3, budget: { ...SWEEP_BUDGET, dirs: 50 } });
  assert.ok(f.roots().dirs > 50);
  await f.cleanup.sweep();
  assert.deepEqual(f.rows.filter((row) => fs.existsSync(row)), []);
  assert.equal(f.events().some((line) => line.kind === "budget"), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, ".orbit", "cleanup-sweep.json"), "utf8")).done, true);

  const later = await f.close(4, 7);
  f.written();
  const promises = await import("node:fs/promises");
  let reads = 0;
  for (const method of ["lstat", "readdir"]) {
    const original = promises.default[method];
    t.mock.method(promises.default, method, (...args) => {
      if (String(args[0]).startsWith(path.join(f.worktreeRoot, "by-"))) reads++;
      return original(...args);
    });
  }
  await f.cleanup.sweep();
  assert.deepEqual(later.filter((row) => fs.existsSync(row)), []);
  assert.equal(reads, 0);
  assert.deepEqual(f.warnings, []);
});

test("a folder flooded with changes is walked again and no other folder is", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = await tree(t, { bystanders: 2, worktrees: 0, scratch: 3 });
  await f.cleanup.sweep();
  // Small batches, so the watcher's own buffer never overflows and every change is counted.
  for (let index = 0; index < 1_200; index++) {
    fs.writeFileSync(path.join(f.worktreeRoot, "by-0", `file-${index}`), "");
    if (index % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  fs.writeFileSync(path.join(f.worktreeRoot, "by-1", "file"), "");
  const later = await f.close(4, 7);
  const promises = await import("node:fs/promises");
  const read = { "by-0": 0, "by-1": 0 };
  const original = promises.default.readdir;
  t.mock.method(promises.default, "readdir", (...args) => {
    for (const name of Object.keys(read)) if (String(args[0]).startsWith(path.join(f.worktreeRoot, name))) read[name]++;
    return original(...args);
  });
  await f.cleanup.sweep();
  assert.deepEqual(later.filter((row) => fs.existsSync(row)), []);
  assert.ok(read["by-0"] > 0);
  assert.equal(read["by-1"], 0);
  assert.deepEqual(f.warnings, []);
});

test("a sweep stopped by its budget goes on from its cursor in short slices until the ledger is done", async (t) => {
  const f = await tree(t, { bystanders: 2, worktrees: 2, scratch: 3, budget: { ...SWEEP_BUDGET, ms: 0 } });
  for (const target of f.targets) fs.writeFileSync(path.join(target, "dirty"), "");
  const done = () => JSON.parse(fs.readFileSync(path.join(f.home, ".orbit", "cleanup-sweep.json"), "utf8")).done;
  await f.cleanup.sweep();
  let slices = 1;
  while (!done() && slices < 20) {
    const next = f.jobs.at(-1);
    assert.ok(next.ms < 10 * 60_000, `next slice in ${next.ms} ms`);
    next.run();
    await f.cleanup.flush();
    slices++;
  }
  assert.equal(slices, 5);
  assert.deepEqual(f.rows.filter((row) => fs.existsSync(row)), []);
  assert.deepEqual(f.targets.filter((target) => fs.existsSync(target)), f.targets);
  assert.equal(f.jobs.at(-1).ms, 6 * 60 * 60_000);
  assert.deepEqual(f.warnings, []);
});

test("a re-pointed link re-reads only the links that resolve through it", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = await tree(t, { bystanders: 20, worktrees: 0, scratch: 3 });
  await f.cleanup.sweep();
  const later = await f.close(4, 7);
  const moved = path.join(f.worktreeRoot, "by-0", "d0", "link-0");
  fs.unlinkSync(moved);
  fs.symlinkSync(path.join(f.home, "shared", "node_modules", "pkg-1"), moved, kind);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const promises = await import("node:fs/promises");
  const original = promises.default.readlink;
  let reads = 0;
  t.mock.method(promises.default, "readlink", (...args) => { reads++; return original(...args); });
  await f.cleanup.sweep();
  assert.deepEqual(later.filter((row) => fs.existsSync(row)), []);
  assert.ok(reads < 20, `${reads} links read again for one re-pointed link among ${f.roots().links}`);
  assert.deepEqual(f.warnings, []);
});

test("a check settles while other folders keep changing", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  const f = await tree(t, { bystanders: 2, worktrees: 0, scratch: 3 });
  await f.cleanup.sweep();
  const busy = path.join(f.worktreeRoot, "by-0");
  const writer = childProcess.spawn(process.execPath, ["-e", `const fs = require("fs"); let next = 0; setInterval(() => fs.mkdirSync(${JSON.stringify(busy)} + "/n" + next++), 20);`], { stdio: "ignore", windowsHide: true });
  t.after(() => writer.kill());
  await new Promise((resolve) => setTimeout(resolve, 200));
  const later = await f.close(4, 7);
  f.written();
  await f.cleanup.sweep();
  assert.deepEqual(later.filter((row) => fs.existsSync(row)), []);
  assert.deepEqual(f.warnings, []);
});

test("a resting link index is dropped once watching it costs more than building it, and the next pass builds it again", { skip: process.platform !== "win32" && "link watches are Windows-only" }, async (t) => {
  let spent = 0;
  const f = await tree(t, { bystanders: 2, worktrees: 0, scratch: 3, cpu: () => spent });
  const promises = await import("node:fs/promises");
  const readdir = promises.default.readdir;
  const building = t.mock.method(promises.default, "readdir", (...args) => { spent++; return readdir(...args); });
  await f.cleanup.sweep();
  building.mock.restore();
  const builds = () => f.events().filter((line) => line.kind === "links").at(-1).builds;
  assert.equal(builds(), 1);
  const pass = async (from, watching) => {
    spent += watching;
    fs.mkdirSync(path.join(f.worktreeRoot, "by-0", `n${from}`));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const later = await f.close(from, from + 1);
    f.written();
    await f.cleanup.sweep();
    assert.deepEqual(later.filter((row) => fs.existsSync(row)), []);
    return builds();
  };
  assert.equal(await pass(4, 1), 0);
  assert.equal(await pass(5, 1_000_000), 1);
  assert.deepEqual(f.warnings, []);
});
