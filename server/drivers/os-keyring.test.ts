// No test may reach the real OS credential store: Wink's own calls go through runKeyringTool, which every test
// swaps for a fake (server/testing/setup.ts), and no test file may run cmdkey or security itself.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { runKeyringTool, usesOsKeyringTool } from "./os-keyring.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TEST_FILE = /\.(?:test|node-test)\.(?:[cm]?[jt]sx?)$/;
const SKIP = new Set(["node_modules", ".git", "dist", "release", "build", ".next", "out"]);
const SPAWNS = /from\s+["'](?:node:)?child_process["']|require\(\s*["'](?:node:)?child_process["']\s*\)|from\s+["'](?:execa|cross-spawn)["']/;
// A process call whose program is the keyring tool, or a test that can spawn and names cmdkey at all.
const KEYRING_CALL = /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork|execa|runTestNode|spawnTestNode)\s*\(\s*["'`](?:cmdkey(?:\.exe)?|security)\b/i;
const CMDKEY = /\bcmdkey\b/i;

function testFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(path, found);
    else if (TEST_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

/** Test files that run the OS keyring tool themselves. */
function keyringSpawners(root = ROOT): string[] {
  return testFiles(root).filter((path) => {
    const text = readFileSync(path, "utf8");
    return KEYRING_CALL.test(text) || (SPAWNS.test(text) && CMDKEY.test(text));
  }).map((path) => relative(root, path).replaceAll("\\", "/"));
}

describe("the OS credential store in tests", () => {
  it("is a fake for every test", () => {
    expect(usesOsKeyringTool()).toBe(false);
    const done = vi.fn();
    runKeyringTool("cmdkey.exe", ["/list"], { encoding: "utf8" }, done);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ message: "tests never run the OS keyring tool" }), "");
  });

  it("is never run by a test file directly", () => {
    expect(keyringSpawners()).toEqual([]);
  });
});
