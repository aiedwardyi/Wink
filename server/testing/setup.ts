// Vitest setup — every test file gets a throwaway home directory so
// DATA_DIR (~/.openmausbot) never touches the real one. os.homedir()
// reads HOME (POSIX) / USERPROFILE (Windows) at call time, and this file
// runs before any test module imports server/config.ts.
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { removeTempDir } from "./cleanup.ts";

const home = mkdtempSync(join(tmpdir(), "omb-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// Worker threads on Windows keep the real profile in homedir(); refuse to run against it.
if (homedir() !== home) throw new Error(`test home isolation failed: homedir() is ${homedir()}, expected ${home}`);
// OMB_DATA_DIR is an intentional production override, but tests must never
// let it escape the throwaway home they are about to delete.
delete process.env.OMB_DATA_DIR;
// Do not let a developer's Hermes global config path leak into per-test homes.
delete process.env.HERMES_HOME;
// A worker pane inherits its account's real login dirs; a test that writes
// credentials would otherwise sign that account out.
for (const name of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME", "CODEX_SQLITE_HOME", "GROK_HOME"]) delete process.env[name];
// The companion keeps its paired devices in its own directory, and resolves
// it from homedir() the same way — so the redirect above already covers it.
// Named explicitly all the same: the device tests delete this directory
// wholesale, and "it is safe because of a line in another file" is not the
// footing that delete should stand on.
process.env.OMB_COMPANION_DIR = join(home, ".openmausbot-companion");

// SQLite keeps the database file open for the lifetime of its handle.
// Windows will not remove a directory containing an open database, so close
// the per-test handle before the next test resets its throwaway data dir.
const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

// Windows holds a directory that is a live process's cwd, and a just-killed
// CLI lets go a beat after the kill call returns — see removeTempDir.
afterAll(async () => {
  closeMessageDb();
  await removeTempDir(home);
});
