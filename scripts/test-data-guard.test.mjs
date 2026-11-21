import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { allocateTestHome } from "../companion/src/test-profile.ts";
import { scrubbedEnv } from "../server/config.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const setupHint = "load server/testing/setup.ts (vite.config.ts setupFiles) before importing";

function scratchEnv(home, temp) {
  const appData = join(home, "AppData");
  const localAppData = join(home, "LocalAppData");
  for (const dir of [appData, localAppData]) mkdirSync(dir, { recursive: true });
  return { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData,
    TEMP: temp, TMP: temp, TMPDIR: temp, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
    OMB_DATA_DIR: join(home, ".orbit"), OMB_COMPANION_DIR: join(home, ".openmausbot-companion") };
}

it("protects both profiles when Vitest skips setupFiles", () => {
  const scratch = realpathSync.native(process.env.ORBIT_SCRATCH || tmpdir());
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
    rmSync(home, { recursive: true, force: true });
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
])("rejects an unowned sibling override in %s", (module, key) => {
  const temp = mkdtempSync(join(realpathSync.native(tmpdir()), "profile-parent-"));
  const home = allocateTestHome("owned-", process.env.WINK_VITEST_HOME_NONCE, temp);
  const sibling = mkdtempSync(join(temp, "unowned-"));
  try {
    const env = { ...scratchEnv(home, temp), WINK_VITEST_HOME: home };
    const sentinel = join(sibling, "sentinel");
    writeFileSync(sentinel, "sentinel");
    const link = join(home, key === "OMB_DATA_DIR" ? ".orbit" : ".openmausbot-companion");
    symlinkSync(sibling, link, process.platform === "win32" ? "junction" : "dir");
    const overrides = [sibling, link, ".", ...(process.platform === "win32" ? [sibling.toUpperCase()] : [])];
    for (const dir of overrides) {
      const result = importProfile(module, { ...env, [key]: dir });
      expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`${key} must point`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("refuses to mark an unowned sibling when launching a child", () => {
  const temp = mkdtempSync(join(realpathSync.native(tmpdir()), "harness-parent-"));
  const home = allocateTestHome("owned-", process.env.WINK_VITEST_HOME_NONCE, temp);
  const sibling = mkdtempSync(join(temp, "unowned-"));
  try {
    const env = { ...scratchEnv(home, temp), WINK_VITEST_HOME: home };
    const sentinel = join(sibling, "sentinel");
    writeFileSync(sentinel, "sentinel");
    const result = runProbe(`
      import { spawnHarness } from "./server/testing/harness-auth.ts";
      const home = ${JSON.stringify(sibling)};
      spawnHarness("", [], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    `, env);
    expect(readFileSync(sentinel, "utf8")).toBe("sentinel");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(existsSync(join(sibling, ".wink-vitest-home")), result.stderr).toBe(false);
    expect(result.stderr).toContain("createFixtureHome");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("rejects a caller-supplied Vitest home without its setup marker", () => {
  const temp = realpathSync.native(tmpdir());
  const home = mkdtempSync(join(temp, "unmarked-profile-"));
  try {
    const env = { ...scratchEnv(home, temp), WINK_VITEST_HOME: home };
    for (const module of ["server/config.ts", "companion/src/state.ts"]) {
      const result = importProfile(module, env);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(`${setupHint} ${module}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("rejects a junction above an otherwise marked companion home", () => {
  const temp = realpathSync.native(tmpdir());
  const scratch = mkdtempSync(join(temp, "linked-profile-"));
  try {
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    const tempAlias = join(scratch, "os-temp");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(outside, tempAlias, linkType);
    const home = allocateTestHome("home-", process.env.WINK_VITEST_HOME_NONCE, tempAlias);
    expect(dirname(home)).toBe(tempAlias);
    const env = { ...scratchEnv(home, tempAlias), WINK_VITEST_HOME: home };
    const deviceFile = join(env.OMB_COMPANION_DIR, "sentinel");
    mkdirSync(dirname(deviceFile));
    writeFileSync(deviceFile, "sentinel");
    const module = "companion/src/state.ts";
    const valid = importProfile(module, scrubbedEnv(env));
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout.trim()).toBe(env.OMB_COMPANION_DIR);
    const canonicalData = join(realpathSync.native(home), ".orbit");
    const server = importProfile("server/config.ts", { ...env, OMB_DATA_DIR: canonicalData });
    expect(server.status, server.stderr).toBe(0);
    expect(server.stdout.trim()).toBe(canonicalData);

    const childTemp = join(scratch, "temp");
    const link = join(childTemp, "redirect");
    mkdirSync(childTemp);
    symlinkSync(outside, link, linkType);
    const linkedHome = join(link, relative(tempAlias, home));
    const linked = importProfile(module, { ...scratchEnv(linkedHome, childTemp), WINK_VITEST_HOME: linkedHome });
    expect(linked.status, linked.stdout + linked.stderr).toBe(1);
    expect(linked.stderr).toContain(`${setupHint} ${module}`);
    expect(readFileSync(deviceFile, "utf8")).toBe("sentinel");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
