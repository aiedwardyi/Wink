import { describe, expect, it } from "vitest";
import { checkHiddenStarts, hiddenStartHits } from "./check-hidden-starts.mjs";

const check = (source) => hiddenStartHits("server/fixture.ts", source);

describe("hidden process start gate", () => {
  it.each([
    'import { spawn } from "node:child_process"; spawn("git", ["status"]);',
    'import { execFile } from "child_process"; execFile("git", ["status"], { timeout: 1000 }, () => {});',
    'import { spawn as start } from "node:child_process"; start("git", [], { stdio: "ignore" });',
    'import { spawnSync, execSync } from "node:child_process"; spawnSync("git", [], { windowsHide: true }); execSync("git status");',
    'import childProcess from "node:child_process"; childProcess.fork("worker.mjs");',
    'import * as cp from "node:child_process"; cp.exec("git status");',
    'const { execFileSync } = require("node:child_process"); execFileSync("git", ["status"], { encoding: "utf8" });',
    'require("node:child_process").spawn("git", [], options);',
    'import { spawn } from "node:child_process"; spawn("git", [], { windowsHide: false });',
  ])("rejects a start without the hidden flag: %s", (source) => {
    expect(check(source)).toHaveLength(1);
  });

  it.each([
    'import { spawn } from "node:child_process"; spawn("git", ["status"], { windowsHide: true });',
    'import { execFile } from "node:child_process"; execFile("git", [], { ...options, windowsHide: true }, done);',
    'import { spawn } from "node:child_process"; spawn("git", [], { ...(win ? { windowsHide: true } : { detached: true }) });',
    'const cp = require("child_process"); cp.spawnSync("git", [], { encoding: "utf8", windowsHide: true });',
  ])("accepts a hidden start: %s", (source) => {
    expect(check(source)).toEqual([]);
  });

  it("ignores type imports, other modules and local functions with the same names", () => {
    expect(check('import type { ChildProcess } from "node:child_process"; import { spawn } from "node-pty"; spawn("pwsh", []); const exec = (s) => s; exec("x"); /re/.exec("x"); db.exec("select 1");')).toEqual([]);
  });

  it("fails the gate for a new file and for an extra start in an allowlisted file", () => {
    const start = 'import { execFile } from "node:child_process"; execFile("sh", []);';
    expect(checkHiddenStarts(["server/fixture.ts"], () => start)).toHaveLength(1);
    expect(checkHiddenStarts(["server/env-path.ts"], () => start)).toEqual([]);
    expect(checkHiddenStarts(["server/env-path.ts"], () => `${start} execFile("sh", []);`)).toHaveLength(1);
  });

  it("fails the gate when an allowlisted file has fewer starts than its entry permits", () => {
    expect(checkHiddenStarts(["server/env-path.ts"], () => "")).toEqual(["server/env-path.ts: the allow-list permits 1 unhidden starts but the file has 0; lower its count"]);
  });

  it("accepts the repository with only its explicit base exceptions", () => {
    expect(checkHiddenStarts()).toEqual([]);
  });
});
