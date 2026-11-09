import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  const decide = (tool_name: string, tool_input: Record<string, unknown> = {}) => {
    const run = spawnSync(process.execPath, [HOOK, dir], {
      input: JSON.stringify({ session_id: "fork-1", hook_event_name: "PreToolUse", cwd: root, tool_name, tool_input }),
      encoding: "utf8",
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
