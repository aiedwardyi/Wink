import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { runTestNode, spawnHarness } from "../server/testing/harness-auth.ts";
import { createFixtureHome, removeTestData, testHome } from "../server/testing/test-home.ts";
import { checkTestProfilePaths } from "./check-test-profile-paths.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const setupHint = "load server/testing/setup.ts (vite.config.ts setupFiles) before importing";
const linkType = process.platform === "win32" ? "junction" : "dir";

it("scrubs inherited profile overrides in Vitest setup", () => {
  for (const name of ["OMB_USER_DATA", "OMB_DOWNLOADS_DIR", "MUSE_AUTH_PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "ORBIT_WORKTREE_ROOT"]) {
    expect(process.env[name], name).toBeUndefined();
  }
  expect(process.env.APPDATA).toBe(join(testHome(), "AppData", "Roaming"));
  expect(process.env.LOCALAPPDATA).toBe(join(testHome(), "AppData", "Local"));
});

it("keeps the inherited user-data sentinel untouched when the server boots", async () => {
  const home = createFixtureHome("server-home-");
  const sentinel = createFixtureHome("host-user-data-");
  const snag = join(sentinel, "team-snags", "sentinel");
  mkdirSync(dirname(snag));
  writeFileSync(snag, "original");
  const result = await runTestNode(["--input-type=module", "-e", `
    await import("./server/index.ts");
    process.exit(0);
  `], { cwd: root, env: {
    ...process.env, HOME: home, USERPROFILE: home, OMB_USER_DATA: sentinel,
    OMB_PORT: "0", OMB_WEBHOOK_PORT: "0", ORBIT_REMOTE_AUTO: "0", ORBIT_RELAY: "0", ORBIT_NO_WSL: "1",
  } });
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(sentinel, "mailbox-secret")), "mailbox secret written outside the server fixture").toBe(false);
  expect(readFileSync(snag, "utf8")).toBe("original");
});

it("guards a child even if Vitest was omitted from its requested environment", async () => {
  const home = createFixtureHome("minimal-child-");
  const env = { HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot, OMB_DATA_DIR: testHome() };
  const result = await runTestNode(["--input-type=module", "-e", `
    import { requireTestHome } from "./companion/src/test-profile.ts";
    console.log(JSON.stringify([requireTestHome(), process.env.VITEST]));
    await import("./server/config.ts");
  `], { cwd: root, env });
  expect(result.status, result.stderr).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual([home, null]);
  expect(result.stderr).toContain("OMB_DATA_DIR must point inside the verified Vitest home");
});

it("guards the path cache without a config import or Vitest setup", () => {
  const home = createFixtureHome("path-cache-host-");
  const env = scratchEnv(home, home);
  const result = runProbe(`
    const { refreshPathCache } = await import("./server/env-path.ts");
    await refreshPathCache([]);
  `, env);
  expect(existsSync(join(env.OMB_DATA_DIR, "path-cache.json")), "unguarded path cache write").toBe(false);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(setupHint);
});

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
    const link = join(home, key === "OMB_DATA_DIR" ? ".orbit" : ".openmausbot-companion");
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
      import { runTestNode } from "./server/testing/harness-auth.ts";
      const alias = ${JSON.stringify(tempAlias)};
      const home = startTestRun(alias);
      assert.equal(dirname(home), alias);
      process.env.HOME = process.env.USERPROFILE = home;
      process.env.OMB_COMPANION_DIR = join(home, ".openmausbot-companion");
      process.env.OMB_DATA_DIR = join(realpathSync.native(home), ".orbit");
      const deviceFile = join(process.env.OMB_COMPANION_DIR, "sentinel");
      mkdirSync(dirname(deviceFile));
      writeFileSync(deviceFile, "sentinel");
      const config = await import("./server/config.ts");
      assert.equal(config.DATA_DIR, process.env.OMB_DATA_DIR);
      const valid = await runTestNode(["--input-type=module", "-e", 'console.log((await import("./companion/src/state.ts")).DATA_DIR)'],
        { env: config.scrubbedEnv(process.env) });
      assert.equal(valid.status, 0, valid.stderr);
      assert.equal(valid.stdout.trim(), process.env.OMB_COMPANION_DIR);
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
      const parked = join(home, "parked");
      renameSync(branch, parked);
      symlinkSync(fakeProfile, branch, ${JSON.stringify(linkType)});
      assert.throws(() => removeTestData(DATA_DIR), /removeTestData refused a real profile path/);
      for (const target of [osHome, fakeProfile, join(fakeProfile, "data")]) {
        assert.throws(() => removeTestData(target), /removeTestData refused a real profile path/);
      }
      mkdirSync(join(osHome, ".config"));
      for (const name of [".codex", ".openmausbot-companion", ".claude", ".claude-account", ".grok", ".gemini", ".config/muse", ".hermes", ...(
        process.platform === "win32" ? [".CLAUDE-WORK"] : []
      )]) {
        const protectedDir = join(home, name);
        mkdirSync(protectedDir, { recursive: true });
        const token = join(protectedDir, "sentinel");
        writeFileSync(token, "protected");
        const alias = join(osHome, name);
        symlinkSync(protectedDir, alias, ${JSON.stringify(linkType)});
        assert.throws(() => removeTestData(alias), /removeTestData refused a real profile path/);
        assert.throws(() => removeTestData(protectedDir), /removeTestData refused a real profile path/);
        assert.throws(() => removeTestData(home), /removeTestData refused a real profile path/);
        assert.equal(readFileSync(token, "utf8"), "protected");
        unlinkSync(alias);
      }
      assert.throws(() => removeTestData(home), /removeTestData found a changed directory/);
      unlinkSync(branch);
      renameSync(parked, branch);
      removeTestData(home);
      assert.equal(readFileSync(sentinel, "utf8"), "original");
    `, scratchEnv(scratch, scratch));
    expect(result.status, result.stdout + result.stderr).toBe(0);
  } finally {
    removeTestData(scratch);
  }
});

it("allows owned cleanup with a dangling Claude link in the OS home", () => {
  const scratch = createFixtureHome("dangling-claude-");
  const result = runProbe(`
    import assert from "node:assert/strict";
    import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import os from "node:os";
    import { join } from "node:path";
    import { removeTestData, startTestRun } from "./companion/src/test-profile.ts";
    const osHome = join(${JSON.stringify(scratch)}, "os-user");
    mkdirSync(osHome);
    os.userInfo = () => ({ homedir: osHome });
    syncBuiltinESMExports();
    const alias = join(osHome, ".claude-dangling");
    symlinkSync(join(osHome, "missing"), alias, ${JSON.stringify(linkType)});
    const home = startTestRun();
    removeTestData(home);
    assert(!existsSync(home));
    assert(lstatSync(alias).isSymbolicLink());
  `, scratchEnv(scratch, scratch));
  expect(result.status, result.stdout + result.stderr).toBe(0);
});

it("refuses ordinary replacements of imported data directories during direct and parent cleanup", async () => {
  const home = createFixtureHome("replaced-data-");
  const env = scratchEnv(home, testHome());
  const result = await runTestNode(["--input-type=module", "-e", `
    await import("./server/config.ts");
    await import("./companion/src/state.ts");
  `], { cwd: root, env });
  expect(result.status, result.stderr).toBe(0);
  for (const dir of [env.OMB_DATA_DIR, env.OMB_COMPANION_DIR]) {
    writeFileSync(join(dir, "owned"), "owned");
    removeTestData(dir);
    expect(existsSync(join(dir, "owned"))).toBe(false);
    const parked = dir + "-parked";
    const replacement = dir + "-replacement";
    mkdirSync(join(replacement, "nested"), { recursive: true });
    writeFileSync(join(replacement, "nested", "sentinel"), "replacement");
    renameSync(dir, parked);
    renameSync(replacement, dir);
    try {
      expect(() => removeTestData(dir)).toThrow("changed directory");
      expect(() => removeTestData(join(dir, "nested"))).toThrow("changed directory");
      expect(() => removeTestData(home)).toThrow("changed directory");
      expect(readFileSync(join(dir, "nested", "sentinel"), "utf8")).toBe("replacement");
    } finally {
      if (existsSync(dir)) renameSync(dir, replacement);
      renameSync(parked, dir);
    }
  }
  removeTestData(home);
});

it("the repo check rejects raw recursive deletion through aliases and keeps file removal", () => {
  const file = "example.test.ts";
  const hits = checkTestProfilePaths([file], () => `
    import { DATA_DIR as profile } from "./config.ts";
    import { rmSync as erase, promises as fs } from "node:fs";
    const target = join(profile, "fixture");
    const { USERPROFILE: inheritedHome } = process.env;
    erase(target, { recursive: true });
    fs["rm"](target, { recursive: true });
    fs.rm("/profiles/.orbit", { recursive: true });
    fs.rm(inheritedHome, { recursive: true });
    erase(target, { force: true });
    removeTestData(target);
  `);
  expect(hits).toHaveLength(5);
  expect(hits.filter((hit) => hit.includes("use removeTestData"))).toHaveLength(4);
});

it("the repo check rejects raw cleanup of derived profile paths and temp fixtures", () => {
  const hits = checkTestProfilePaths(["example.test.ts"], () => `
    import { WORKSPACES_DIR as workspaces, EVENTS_DIR } from "./config.ts";
    import { workspaceDir } from "./workspace.ts";
    import { createTempDirs as makeTemps } from "./testing/cleanup.ts";
    const temps = makeTemps();
    const unrelated = makeTemps();
    temps.make(join(testHome(), "fixture-"));
    unrelated.make(join(tmpdir(), "fixture-"));
    rmSync(workspaces, { recursive: true });
    rmSync(EVENTS_DIR, { recursive: true });
    rmSync(join(workspaceDir(botId), "memory"), { recursive: true });
    temps.remove();
    unrelated.remove();
  `);
  expect(hits).toHaveLength(4);
  expect(hits.every((hit) => hit.includes("use removeTestData"))).toBe(true);
});

it.skipIf(process.platform !== "win32")("revokes a run even when Windows cannot remove its empty home", () => {
  const scratch = mkdtempSync(join(testHome(), "busy-run-"));
  try {
    const result = runProbe(`
      import assert from "node:assert/strict";
      import { removeTestData, requireTestHome, startTestRun } from "./companion/src/test-profile.ts";
      const home = startTestRun();
      process.env.HOME = process.env.USERPROFILE = home;
      const previous = process.cwd();
      process.chdir(home);
      try { removeTestData(home); }
      finally { process.chdir(previous); }
      assert.throws(() => requireTestHome(), /before importing/);
      removeTestData(startTestRun());
    `, scratchEnv(scratch, scratch));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain("removeTestData left a busy test home");
  } finally {
    removeTestData(scratch);
  }
});
