import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Claude runs Code Mode only in its interactive terminal, so only panes get it; headless turns would ignore it.
export const CLAUDE_PANE_ENV = Object.freeze({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1" });
// Without these Claude asks before turning Code Mode on, and nobody answers in an unattended pane.
export const CODE_MODE_CAVEATS = Object.freeze(["codeModeCaveatsAcceptedV1", "codeModeAutoModeCaveatAcceptedV1"]);

// Windows env names are case-insensitive, so a user's own spelling must count as set.
const keyOf = (env, name) => Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase()) ?? name;

/** The global config file of the Claude this env starts, or null when the env names no home. */
export function claudeConfigFile(env, platform = process.platform) {
  const dir = env[keyOf(env, "CLAUDE_CONFIG_DIR")];
  const home = platform === "win32" ? env[keyOf(env, "USERPROFILE")] : env.HOME;
  return dir ? join(dir, ".claude.json") : home ? join(home, ".claude.json") : null;
}

async function acceptCodeModeCaveats(file) {
  let config;
  try {
    config = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return false;
  }
  if (Object.getPrototypeOf(config ?? 0) !== Object.prototype) return false;
  if (CODE_MODE_CAVEATS.every((name) => config[name] === true)) return true;
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ ...config, ...Object.fromEntries(CODE_MODE_CAVEATS.map((name) => [name, true])) }, null, 2));
    await rename(temp, file);
    return true;
  } catch {
    await rm(temp, { force: true });
    return false;
  }
}

/** Fills CLAUDE_PANE_ENV into a pane's `env` in place; an env value wins, and Code Mode stays off unless its caveats are saved. */
export async function withClaudePaneEnv(env, platform = process.platform) {
  const key = keyOf(env, "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE");
  if (env[key] !== undefined) return env;
  const file = claudeConfigFile(env, platform);
  if (file && (await acceptCodeModeCaveats(file))) env[key] = CLAUDE_PANE_ENV.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE;
  return env;
}
