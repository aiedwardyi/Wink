import { join } from "node:path";
import { harnessTestHome, isTestHomePath } from "../../companion/src/test-profile.ts";

const profilePaths = new Set([
  "OMB_USER_DATA", "OMB_DOWNLOADS_DIR", "MUSE_AUTH_PATH", "APPDATA", "LOCALAPPDATA", "ORBIT_WORKTREE_ROOT",
  "HERMES_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CODEX_SQLITE_HOME", "GROK_HOME",
]);

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
