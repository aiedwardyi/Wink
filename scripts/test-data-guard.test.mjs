import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { runTestNode, spawnHarness } from "../server/testing/harness-auth.ts";
import { createFixtureHome, removeTestData, testHome } from "../server/testing/test-home.ts";
import { checkTestProfilePaths } from "./check-test-profile-paths.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const setupHint = "load server/testing/setup.ts (vite.config.ts setupFiles) before importing";
const linkType = process.platform === "win32" ? "junction" : "dir";

function scratchEnv(home, temp) {
  const appData = join(home, "AppData");
  const localAppData = join(home, "LocalAppData");
  for (const dir of [appData, localAppData]) mkdirSync(dir, { recursive: true });
  return { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData,
    TEMP: temp, TMP: temp, TMPDIR: temp, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
    OMB_DATA_DIR: join(home, ".orbit"), OMB_COMPANION_DIR: join(home, ".openmausbot-companion") };
}

it("protects both profiles when Vitest skips setupFiles", () => {
  const scratch = realpathSync.native(testHome());
  const home = mkdtempSync(join(scratch, "profile-guard-"));
  try {
    const accounts = join(home, ".orbit", "accounts", "x");
    const devices = join(home, ".openmausbot-companion", "sentinel");
    for (const sentinel of [accounts, devices]) {
      mkdirSync(dirname(sentinel), { recursive: true });
      writeFileSync(sentinel, "sentinel");
    }
    const config = join(home, "vitest.config.mjs");
    writeFileSync(config, 'export default { test: { pool: "forks", fileParallelism: false } };\n');

    const env = { ...scratchEnv(home, home), ORBIT_SCRATCH: scratch };
    delete env.OMB_DATA_DIR;
    delete env.OMB_COMPANION_DIR;
    delete env.WINK_VITEST_HOME;
    delete env.WINK_VITEST_HOME_NONCE;
    const options = { cwd: root, env, encoding: "utf8", windowsHide: true };
    const preflight = spawnSync(process.execPath, ["-p", "require('node:os').homedir()"], options);
    expect(preflight.status, preflight.stderr).toBe(0);
    expect(preflight.stdout.trim()).toBe(home);

    const result = spawnSync(process.execPath, [
      "node_modules/vitest/vitest.mjs", "run", "--config", config,
      "server/verify-site.test.ts", "companion/test/devices.test.ts",
      "-t", "streams to the app and the user's bots|issues a token that authenticates",
    ], options);
    const output = result.stdout + result.stderr;
    console.log(`Missing setupFiles: exit=${result.status}, accounts=${existsSync(accounts)}, devices=${existsSync(devices)}`);
    expect(result.error).toBeUndefined();
    expect(result.status, output).toBe(1);
    expect(output).toContain(`${setupHint} server/config.ts`);
    expect(output).toContain(`${setupHint} companion/src/state.ts`);
    for (const sentinel of [accounts, devices]) expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
  } finally {
    removeTestData(home);
  }
}, 30_000);

function importProfile(module, env) {
  return runProbe(`console.log((await import(${JSON.stringify(`./${module}`)})).DATA_DIR)`, env);
}

function runProbe(source, env) {
  return spawnSync(process.execPath, ["--input-type=module", "-e",
    source,
  ], { cwd: root, env, encoding: "utf8", windowsHide: true });
}

it.each([
  ["server/config.ts", "OMB_DATA_DIR"],
  ["companion/src/state.ts", "OMB_COMPANION_DIR"],
])("rejects an unowned sibling override in %s", async (module, key) => {
  const temp = testHome();
  const home = createFixtureHome("owned-");
  const sibling = createFixtureHome("sibling-");
  try {
    const env = scratchEnv(home, temp);
    const sentinel = join(sibling, "sentinel");
    writeFileSync(sentinel, "sentinel");
    const link = join(home, "redirect");
    symlinkSync(sibling, link, linkType);
    const overrides = [sibling, join(link, "data"), ".", ...(process.platform === "win32" ? [sibling.toUpperCase()] : [])];
    for (const dir of overrides) {
      const result = await runTestNode(["--input-type=module", "-e", `await import(${JSON.stringify(`./${module}`)})`],
        { cwd: root, env: { ...env, [key]: dir } });
      expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`${key} must point`);
    }
  } finally {
    removeTestData(home);
    removeTestData(sibling);
  }
});

it("refuses to mark an unowned sibling when launching a child", () => {
  const temp = testHome();
  const sibling = mkdtempSync(join(temp, "unowned-"));
  try {
    const sentinel = join(sibling, "sentinel");
    writeFileSync(sentinel, "sentinel");
    expect(() => spawnHarness("", [], { env: scratchEnv(sibling, temp) })).toThrow("createFixtureHome");
    expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
    expect(existsSync(join(sibling, ".wink-vitest-home"))).toBe(false);
  } finally {
    removeTestData(sibling);
  }
});

it("rejects a caller-supplied Vitest home without its setup marker", () => {
  const temp = testHome();
  const home = mkdtempSync(join(temp, "unmarked-profile-"));
  try {
    const env = { ...scratchEnv(home, temp), WINK_VITEST_HOME: home };
    for (const module of ["server/config.ts", "companion/src/state.ts"]) {
      const result = importProfile(module, env);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`${setupHint} ${module}`);
    }
  } finally {
    removeTestData(home);
  }
});

it("rejects a junction above an otherwise marked companion home", () => {
  const scratch = mkdtempSync(join(testHome(), "linked-profile-"));
  try {
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    const tempAlias = join(scratch, "os-temp");
    symlinkSync(outside, tempAlias, linkType);
    const result = runProbe(`
      import assert from "node:assert/strict";
      import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
      import { basename, dirname, join } from "node:path";
      import { startTestRun } from "./companion/src/test-profile.ts";
      const alias = ${JSON.stringify(tempAlias)};
      const home = startTestRun(alias);
      assert.equal(dirname(home), alias);
      process.env.HOME = process.env.USERPROFILE = home;
      process.env.OMB_COMPANION_DIR = join(home, ".openmausbot-companion");
      process.env.OMB_DATA_DIR = join(realpathSync.native(home), ".orbit");
      const deviceFile = join(process.env.OMB_COMPANION_DIR, "sentinel");
      mkdirSync(dirname(deviceFile));
      writeFileSync(deviceFile, "sentinel");
      assert.equal((await import("./companion/src/state.ts")).DATA_DIR, process.env.OMB_COMPANION_DIR);
      assert.equal((await import("./server/config.ts")).DATA_DIR, process.env.OMB_DATA_DIR);
      const link = join(${JSON.stringify(scratch)}, "redirect");
      symlinkSync(${JSON.stringify(outside)}, link, ${JSON.stringify(linkType)});
      process.env.HOME = process.env.USERPROFILE = join(link, basename(home));
      await assert.rejects(import("./companion/src/state.ts?redirected"), /before importing companion/);
      assert.equal(readFileSync(deviceFile, "utf8"), "sentinel");
    `, scratchEnv(scratch, scratch));
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    removeTestData(scratch);
  }
});

it("refuses a marker left by an exited launcher even with its original nonce", () => {
  const scratch = mkdtempSync(join(testHome(), "abandoned-run-"));
  try {
    const env = scratchEnv(scratch, scratch);
    const abandoned = runProbe(`
      import { readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { startTestRun } from "./companion/src/test-profile.ts";
      const home = startTestRun();
      writeFileSync(join(home, "sentinel"), "original");
      console.log(JSON.stringify([home, readFileSync(join(home, ".wink-vitest-home"), "utf8").split("\\n")[0]]));
    `, env);
    expect(abandoned.status, abandoned.stderr).toBe(0);
    const [home, nonce] = JSON.parse(abandoned.stdout);
    const stale = { ...scratchEnv(home, scratch), WINK_VITEST_HOME: home, WINK_VITEST_HOME_NONCE: nonce };
    for (const module of ["server/config.ts", "companion/src/state.ts"]) {
      const result = importProfile(module, stale);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(setupHint);
    }
    const fresh = runProbe(`
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      import { join } from "node:path";
      import { removeTestData, startTestRun } from "./companion/src/test-profile.ts";
      const home = startTestRun();
      assert.notEqual(readFileSync(join(home, ".wink-vitest-home"), "utf8").split("\\n")[0], process.env.WINK_VITEST_HOME_NONCE);
      assert.throws(() => removeTestData(process.env.WINK_VITEST_HOME), /removeTestData.*unowned/);
      removeTestData(home);
    `, stale);
    expect(fresh.status, fresh.stdout + fresh.stderr).toBe(0);
    expect(readFileSync(join(home, "sentinel"), "utf8")).toBe("original");
  } finally {
    removeTestData(scratch);
  }
});

it("rechecks the run nonce and refuses a junction swapped in after config import", () => {
  const scratch = mkdtempSync(join(testHome(), "changed-profile-"));
  try {
    const result = runProbe(`
      import assert from "node:assert/strict";
      import { lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import os from "node:os";
      import { join } from "node:path";
      import { removeTestData, startTestRun } from "./companion/src/test-profile.ts";
      const scratch = ${JSON.stringify(scratch)};
      const osHome = join(scratch, "os-user");
      os.userInfo = () => ({ homedir: osHome });
      syncBuiltinESMExports();
      const home = startTestRun();
      process.env.HOME = process.env.USERPROFILE = home;
      const branch = join(home, "original");
      process.env.OMB_DATA_DIR = join(branch, "data");
      const fakeProfile = join(osHome, ".orbit");
      const sentinel = join(fakeProfile, "data", "sentinel");
      mkdirSync(join(fakeProfile, "data"), { recursive: true });
      writeFileSync(sentinel, "original");
      mkdirSync(process.env.OMB_DATA_DIR, { recursive: true });
      const { DATA_DIR } = await import("./server/config.ts");
      const marker = join(home, ".wink-vitest-home");
      const original = readFileSync(marker);
      writeFileSync(marker, "changed");
      assert.throws(() => removeTestData(DATA_DIR), /removeTestData requires the live run/);
      assert(lstatSync(DATA_DIR).isDirectory());
      writeFileSync(marker, original);
      renameSync(branch, join(home, "parked"));
      symlinkSync(fakeProfile, branch, ${JSON.stringify(linkType)});
      assert.throws(() => removeTestData(DATA_DIR), /removeTestData refused a real profile path/);
      for (const target of [osHome, fakeProfile, join(fakeProfile, "data")]) {
        assert.throws(() => removeTestData(target), /removeTestData refused a real profile path/);
      }
      for (const name of [".codex", ".openmausbot-companion"]) {
        const protectedDir = join(home, name);
        mkdirSync(protectedDir);
        const alias = join(osHome, name);
        symlinkSync(protectedDir, alias, ${JSON.stringify(linkType)});
        assert.throws(() => removeTestData(protectedDir), /removeTestData refused a real profile path/);
        assert.throws(() => removeTestData(home), /removeTestData refused a real profile path/);
        unlinkSync(alias);
      }
      removeTestData(home);
      assert.equal(readFileSync(sentinel, "utf8"), "original");
    `, scratchEnv(scratch, scratch));
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    removeTestData(scratch);
  }
});

it("the repo check rejects raw recursive deletion through aliases and keeps file removal", () => {
  const file = "example.test.ts";
  const hits = checkTestProfilePaths([file], () => `
    import { DATA_DIR as profile } from "./config.ts";
    import { rmSync as erase, promises as fs } from "node:fs";
    const target = join(profile, "fixture");
    erase(target, { recursive: true });
    fs["rm"](target, { recursive: true });
    fs.rm("/profiles/.orbit", { recursive: true });
    erase(target, { force: true });
    removeTestData(target);
  `);
  expect(hits).toHaveLength(3);
  expect(hits.every((hit) => hit.includes("use removeTestData"))).toBe(true);
});
