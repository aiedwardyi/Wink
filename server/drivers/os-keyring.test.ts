// No test may reach the real OS credential store: Wink's own calls go through runKeyringTool, which every test
// swaps for a fake (server/testing/setup.ts), and no test file may run cmdkey or security itself.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { runTestNode } from "../testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "../testing/test-home.ts";
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

  it("is a fake in a server child a test spawns, with only the env a route test hands it", async () => {
    // server/usage-gemini-route.test.ts starts server/index.ts this way: a fixture home, PATH and nothing else.
    const home = createFixtureHome("omb-keyring-child-");
    try {
      const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home };
      if (process.env.PATH) env.PATH = process.env.PATH;
      if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      const keyring = JSON.stringify(new URL("./os-keyring.ts", import.meta.url).href);
      const auth = JSON.stringify(new URL("./antigravity-auth.ts", import.meta.url).href);
      // Only asks the store anything once it is known not to be the OS one.
      const run = await runTestNode(["--input-type=module", "-e", `
        const { usesOsKeyringTool } = await import(${keyring});
        const { probeAntigravitySignIn, forgetAntigravitySignIn, ANTIGRAVITY_KEYRING } = await import(${auth});
        const usesOs = usesOsKeyringTool();
        const asked = usesOs ? {} : {
          probe: (await probeAntigravitySignIn("win32")) ?? null,
          forget: await forgetAntigravitySignIn(ANTIGRAVITY_KEYRING, "win32"),
        };
        console.log(JSON.stringify({ usesOs, ...asked }));
      `], { env });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout.trim().split("\n").at(-1)!)).toEqual({ usesOs: false, probe: null, forget: false });
    } finally {
      removeTestData(home);
    }
  });

  it("is never run by a test file directly", () => {
    expect(keyringSpawners()).toEqual([]);
  });
});
