import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const setupHint = "load server/testing/setup.ts (vite.config.ts setupFiles) before importing";

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

    const env = { ...process.env, ORBIT_SCRATCH: scratch, HOME: home, USERPROFILE: home,
      TEMP: home, TMP: home, TMPDIR: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex") };
    delete env.OMB_DATA_DIR;
    delete env.OMB_COMPANION_DIR;
    delete env.WINK_VITEST_HOME;
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
