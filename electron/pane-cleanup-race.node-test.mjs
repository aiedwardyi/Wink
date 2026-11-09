import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { createPaneCleanup } from "./pane-cleanup.mjs";

const DAY_MS = 86_400_000;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pane-cleanup-race-"));
  const tempRoot = path.join(home, "temp");
  const worktreeRoot = path.join(home, "worktrees");
  const main = path.join(home, "repo");
  const target = path.join(worktreeRoot, "worker");
  const shared = path.join(home, "external");
  const host = path.join(worktreeRoot, "host");
  for (const dir of [tempRoot, worktreeRoot, main, shared, host, path.join(home, ".orbit")]) fs.mkdirSync(dir);
  git(main, "init", "--quiet");
  git(main, "config", "user.name", "Test");
  git(main, "config", "user.email", "test@example.test");
  fs.writeFileSync(path.join(main, "file"), "saved");
  fs.writeFileSync(path.join(main, ".gitignore"), "node_modules\n");
  git(main, "add", ".");
  git(main, "commit", "--quiet", "-m", "fixture");
  git(main, "update-ref", "refs/remotes/test/main", "HEAD");
  git(main, "worktree", "add", "--quiet", "-b", "worker", target);
  fs.symlinkSync(shared, path.join(target, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const time = Date.now();
  const ledger = [{ id: "old", label: "RACE", cwd: target, tempRoot, scratch: path.join(tempRoot, "wink-RACE"), scratchDone: true, openedAt: time, closedAt: time, keep: true }];
  fs.writeFileSync(path.join(home, ".orbit", "pane-ledger.json"), JSON.stringify(ledger));
  const panes = [];
  const pins = [];
  const warnings = [];
  const hooks = {};
  const cleanup = createPaneCleanup({ home, tempRoot, worktreeRoot, now: () => time + 4 * DAY_MS, pinned: () => { hooks.pinned?.(); return pins; }, warn: (error) => warnings.push(String(error)), schedule: () => ({}), cancel() {}, setPriority() {} });
  cleanup.start(() => panes);
  t.after(async () => { cleanup.dispose(); await cleanup.flush(); await removeTempDir(home); });
  const claim = (kind) => {
    const next = { id: "live", label: "LIVE", cwd: target, tempRoot };
    if (kind === "pane") panes.push(next);
    else if (kind === "pin") pins.push(target);
    else cleanup.opened(next);
  };
  return { home, target, host, worktreeRoot, warnings, hooks, cleanup, claim };
}

function armAfterBackup(t) {
  const state = { armed: false, fired: false };
  const cp = fsp.cp;
  t.mock.method(fsp, "cp", async (...args) => { const result = await cp(...args); state.armed = true; return result; });
  return state;
}

function onRootLstat(t, f, state, run) {
  const lstat = fsp.lstat;
  t.mock.method(fsp, "lstat", async (...args) => {
    const result = await lstat(...args);
    if (args[0] === f.worktreeRoot && state.armed && !state.fired) { state.fired = true; run(); }
    return result;
  });
}

for (const kind of ["pane", "pin"]) {
  test(`${kind} claiming a worktree during the first link scan keeps its junctions`, async (t) => {
    const f = fixture(t);
    const readdir = fsp.readdir;
    let claimed = false;
    t.mock.method(fsp, "readdir", async (...args) => {
      const result = await readdir(...args);
      if (args[0] === f.host && !claimed) { claimed = true; f.claim(kind); }
      return result;
    });
    await f.cleanup.sweep();
    assert.equal(claimed, true);
    assert.deepEqual(f.warnings, []);
    assert.equal(fs.existsSync(f.target), true);
    assert.equal(fs.existsSync(path.join(f.target, "node_modules")), true);
  });
}

for (const kind of ["pane", "pin", "ledger"]) {
  test(`${kind} claiming a worktree during the final link scan keeps it`, async (t) => {
    const f = fixture(t);
    const state = armAfterBackup(t);
    onRootLstat(t, f, state, () => f.claim(kind));
    await f.cleanup.sweep();
    assert.equal(state.fired, true);
    assert.deepEqual(f.warnings, []);
    assert.equal(fs.existsSync(f.target), true);
  });

  test(`${kind} claiming a worktree at the final pin check keeps it`, async (t) => {
    const f = fixture(t);
    const state = armAfterBackup(t);
    f.hooks.pinned = () => { if (state.armed && !state.fired) { state.fired = true; f.claim(kind); } };
    await f.cleanup.sweep();
    assert.equal(state.fired, true);
    assert.equal(fs.existsSync(f.target), true);
  });
}

test("worktree swapped for a junction to itself during the final link scan is not removed through it", async (t) => {
  const f = fixture(t);
  const state = armAfterBackup(t);
  const parked = path.join(f.home, "parked-worker");
  onRootLstat(t, f, state, () => {
    fs.renameSync(f.target, parked);
    fs.symlinkSync(parked, f.target, process.platform === "win32" ? "junction" : "dir");
  });
  await f.cleanup.sweep();
  assert.equal(state.fired, true);
  assert.equal(fs.existsSync(path.join(parked, "file")), true);
});
