import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Env every Claude engine Wink starts gets, unless the user already set the value.
export const CLAUDE_LAUNCH_ENV = Object.freeze({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" });

// Windows env names are case-insensitive, so a user's own spelling must count as set.
const keyOf = (env, name) => Object.keys(env).find((key) => key.toUpperCase() === name) ?? name;

/** The `env` block of the settings.json this env's Claude reads as user settings. */
export function claudeUserSettingsEnv(env) {
  const dir = env[keyOf(env, "CLAUDE_CONFIG_DIR")] || join(env.HOME || env.USERPROFILE || homedir(), ".claude");
  try {
    return { ...JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))?.env };
  } catch {
    return {};
  }
}

/** Fills CLAUDE_LAUNCH_ENV into `env` in place; an env value or a settings.json env value wins. */
export function withClaudeLaunchEnv(env, settingsEnv = {}) {
  for (const [name, value] of Object.entries(CLAUDE_LAUNCH_ENV)) {
    const own = settingsEnv[name];
    const key = keyOf(env, name);
    if (own != null) env[key] = String(own);
    else env[key] ??= value;
  }
  return env;
}
