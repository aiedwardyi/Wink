import { join } from "node:path";
import { harnessTestHome, isTestHomePath } from "../../companion/src/test-profile.ts";

const profilePaths = new Set([
  "OMB_USER_DATA", "OMB_DOWNLOADS_DIR", "MUSE_AUTH_PATH", "APPDATA", "LOCALAPPDATA", "ORBIT_WORKTREE_ROOT",
  "HERMES_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CODEX_SQLITE_HOME", "GROK_HOME",
]);

// Unlike the profile keys above, a Vitest child may keep these when they sit inside its test home,
// so only launchers outside Vitest (the packaged smokes) drop them.
const dataOverrides = new Set(["OMB_DATA_DIR", "OMB_COMPANION_DIR"]);

/** The environment for a launcher that runs the app or server against its own disposable home, never the caller's profile. */
export function smokeLauncherEnv(parent: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) {
    if (dataOverrides.has(process.platform === "win32" ? key.toUpperCase() : key)) delete env[key];
  }
  scrubProfileEnv(env, home);
  return env;
}

export function scrubProfileEnv(env: NodeJS.ProcessEnv, home: string, profile?: ReturnType<typeof harnessTestHome>): void {
  for (const key of Object.keys(env)) {
    const name = process.platform === "win32" ? key.toUpperCase() : key;
    if (!profilePaths.has(name) && !name.startsWith("XDG_")) continue;
    const value = env[key];
    if (!profile || !value || !isTestHomePath(profile, value)) delete env[key];
  }
  env.APPDATA ??= join(home, "AppData", "Roaming");
  env.LOCALAPPDATA ??= join(home, "AppData", "Local");
}
