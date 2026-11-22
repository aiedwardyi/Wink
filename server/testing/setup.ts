// Vitest setup — every test file gets a throwaway home directory so
// DATA_DIR (~/.openmausbot) never touches the real one. os.homedir()
// reads HOME (POSIX) / USERPROFILE (Windows) at call time, and this file
// runs before any test module imports server/config.ts.
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { removeTestData, startTestRun } from "../../companion/src/test-profile.ts";
import { replaceKeyringTool } from "../drivers/os-keyring.ts";
import { scrubProfileEnv } from "./profile-env.ts";

const home = startTestRun();
process.env.HOME = home;
process.env.USERPROFILE = home;
// Worker threads on Windows keep the real profile in homedir(); refuse to run against it.
if (homedir() !== home) throw new Error(`test home isolation failed: homedir() is ${homedir()}, expected ${home}`);
// OMB_DATA_DIR is an intentional production override, but tests must never
// let it escape the throwaway home they are about to delete.
delete process.env.OMB_DATA_DIR;
scrubProfileEnv(process.env, home);
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
// The companion keeps its paired devices in its own directory, and resolves
// it from homedir() the same way — so the redirect above already covers it.
// Named explicitly all the same: the device tests delete this directory
// wholesale, and "it is safe because of a line in another file" is not the
// footing that delete should stand on.
process.env.OMB_COMPANION_DIR = join(home, ".openmausbot-companion");

// The OS credential store (Windows Credential Manager, macOS keychain) is the user's real one whatever HOME
// says: no test runs its tool. Here it is a store that refuses everything; a test that needs one injects its own.
replaceKeyringTool((_file, _args, _options, done) => {
  done(Object.assign(new Error("tests never run the OS keyring tool"), { code: "EACCES" }), "");
});

// SQLite keeps the database file open for the lifetime of its handle.
// Windows will not remove a directory containing an open database, so close
// the per-test handle before the next test resets its throwaway data dir.
const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

afterAll(() => {
  closeMessageDb();
  removeTestData(home);
});
