import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "side-hook.cjs");
const REASON = "Quick answers are read-only: Read, Glob or Grep, at most 3. If you cannot answer that way, reply with exactly HANDOFF.";

describe("side hook", () => {
  let dir: string;
  let root: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-side-hook-"));
    root = join(dir, "work");
    mkdirSync(root);
    writeFileSync(join(dir, "side-hook.json"), JSON.stringify({ roots: [root] }));
  });

  afterEach(() => removeTempDir(dir));

  const decide = (tool_name: string, tool_input: Record<string, unknown> = {}, preload: string[] = []) => {
    const run = spawnSync(process.execPath, [...preload, HOOK, dir], {
      input: JSON.stringify({ session_id: "fork-1", hook_event_name: "PreToolUse", cwd: root, tool_name, tool_input }),
      encoding: "utf8",
      windowsHide: true,
    });
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
  };

  it("allows Read, Glob and Grep inside the roots", () => {
    expect(decide("Read", { file_path: join(root, "plan.txt") }).permissionDecision).toBe("allow");
    expect(decide("Glob", { pattern: "**/*.md" }).permissionDecision).toBe("allow");
    expect(decide("Grep", { pattern: "port", path: "src" }).permissionDecision).toBe("allow");
  });

  it("denies reads outside the roots", () => {
    for (const [tool, input] of [
      ["Read", { file_path: join(dir, "secret.txt") }],
      ["Read", { file_path: "../secret.txt" }],
      ["Read", { file_path: `${root}2/plan.txt` }],
      ["Glob", { pattern: join(dir, "**", "*").replaceAll("\\", "/") }],
      ["Glob", { pattern: "..\\**\\*.env" }],
      ["Grep", { pattern: "x", path: dirname(dir) }],
    ] as const) {
      expect(decide(tool, input)).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: REASON });
    }
  });

  // Logs each fs call the hook makes; one outside the temp dir fails as missing instead of being probed.
  const probed = (tool_name: string, tool_input: Record<string, unknown>, denied?: string) => {
    const log = join(dir, "probes.log");
    const spy = join(dir, "spy.cjs");
    const homes = [dir, realpathSync.native(dir)];
    const outside = (path: string) => homes.every((home) => relative(home, path).startsWith("..") || isAbsolute(relative(home, path)));
    writeFileSync(spy, [
      `const fs = require("node:fs");`,
      `const { isAbsolute, relative } = require("node:path");`,
      `const homes = ${JSON.stringify(homes)};`,
      `const wrap = (name, fn) => function (path, ...rest) {`,
      `  if (typeof path !== "string") return fn.call(this, path, ...rest);`,
      `  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([name, path]) + "\\n");`,
      `  if (homes.every((home) => relative(home, path).startsWith("..") || isAbsolute(relative(home, path)))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });`,
      `  if (name === "lstatSync" && path === ${JSON.stringify(denied)}) throw Object.assign(new Error("EACCES"), { code: "EACCES" });`,
      `  return fn.call(this, path, ...rest);`,
      `};`,
      `const native = fs.realpathSync.native;`,
      `for (const name of ["existsSync", "lstatSync", "readlinkSync"]) fs[name] = wrap(name, fs[name]);`,
      `fs.realpathSync.native = wrap("realpath", native);`,
    ].join("\n"));
    writeFileSync(log, "");
    const decision = decide(tool_name, tool_input, ["-r", spy]).permissionDecision;
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as [string, string]);
    return { decision, outside: calls.filter(([, path]) => outside(path)), calls };
  };

  // Backslash paths are plain file names off Windows.
  it.each([
    ["an out-of-root path", "../../elsewhere/notes.txt"],
    ...(process.platform === "win32"
      ? [["a UNC path", String.raw`\\wink-test.invalid\share\notes.txt`], ["a device path", String.raw`\\?\C:\notes.txt`], ["a local device", String.raw`\\.\pipe\notes`]]
      : []),
  ])("refuses %s before any filesystem call", (_, file_path) => {
    expect(probed("Read", { file_path })).toMatchObject({ decision: "deny", outside: [] });
    expect(probed("Grep", { pattern: "x", path: file_path })).toMatchObject({ decision: "deny", outside: [] });
  });

  it("refuses a link out of the roots without following it", () => {
    mkdirSync(join(dir, "outside"));
    symlinkSync(join(dir, "outside"), join(root, "out"), "junction");
    mkdirSync(join(root, "docs"));
    symlinkSync(join(root, "docs"), join(root, "in"), "junction");
    const out = probed("Read", { file_path: join(root, "out", "notes.txt") });
    expect(out.decision).toBe("deny");
    expect(out.calls.filter(([name, path]) => name === "realpath" && path.startsWith(join(root, "out")))).toEqual([]);
    expect(decide("Read", { file_path: join(root, "in", "plan.txt") }).permissionDecision).toBe("allow");
  });

  it("refuses a path whose parent cannot be inspected without following links below it", () => {
    mkdirSync(join(dir, "outside"));
    mkdirSync(join(root, "restricted"));
    symlinkSync(join(dir, "outside"), join(root, "restricted", "net"), "junction");
    const out = probed("Read", { file_path: join(root, "restricted", "net", "notes.txt") }, join(root, "restricted"));
    expect(out.decision).toBe("deny");
    expect(out.calls.filter(([name, path]) => name === "realpath" && path.startsWith(join(root, "restricted", "net")))).toEqual([]);
  });

  it("denies edits, commands, agents and every MCP tool", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task", "WebFetch", "mcp__agents__ask_bot", "mcp__ogb__approve"]) {
      expect(decide(tool, { file_path: join(root, "plan.txt") })).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: REASON });
    }
  });

  it("denies the fourth read", () => {
    for (let i = 0; i < 3; i += 1) expect(decide("Read", { file_path: join(root, `f${i}.txt`) }).permissionDecision).toBe("allow");
    expect(decide("Read", { file_path: join(root, "f3.txt") })).toMatchObject({ permissionDecision: "deny", permissionDecisionReason: REASON });
  });

  it("does not spend a read on a denied call", () => {
    decide("Bash", { command: "ls" });
    decide("Read", { file_path: join(dir, "secret.txt") });
    for (let i = 0; i < 3; i += 1) expect(decide("Read", { file_path: join(root, `f${i}.txt`) }).permissionDecision).toBe("allow");
  });
});
