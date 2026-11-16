// npm's `codex` is node running bin/codex.js, whose only job on Windows is to
// spawn the platform package's codex.exe. Starting that exe directly drops a
// Node process from every Codex launch.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ResolvedSpawn } from "../env-path.ts";

const TARGETS: Record<string, string> = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const isFile = (file: string) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** codex.js's detectPackageManager, reduced to "npm or not": pnpm, Vite+ and bun installs keep the shim. */
function npmOwned(root: string, script: string, env: NodeJS.ProcessEnv): boolean {
  for (const start of new Set([root, dirname(script)])) {
    for (let dir = start; ; dir = dirname(dir)) {
      if (existsSync(join(dir, "node_modules", ".modules.yaml"))) return false;
      if (basename(dir) === "packages" && existsSync(join(dir, "@openai", "codex.json"))) return false;
      if (dirname(dir) === dir) break;
    }
  }
  return !/\bbun\//.test(env.npm_config_user_agent ?? "") && !(env.npm_execpath ?? "").includes("bun") && !/\.bun[\\/]install[\\/]global/.test(root);
}

/** Mirrors `@openai/codex/bin/codex.js` on Windows: the platform package's
 * codex.exe, the shim's args and the env it adds. Null on any layout the shim
 * would treat differently, so the shim runs instead. */
export function codexDirect(launch: ResolvedSpawn, env: NodeJS.ProcessEnv): (ResolvedSpawn & { env: NodeJS.ProcessEnv }) | null {
  if (process.platform !== "win32") return null;
  const target = TARGETS[process.arch];
  const [script, ...args] = launch.args;
  if (!target || !script || basename(launch.command).toLowerCase() !== "node.exe" || basename(script).toLowerCase() !== "codex.js") return null;
  let root: string;
  try {
    root = realpathSync(join(dirname(script), ".."));
  } catch {
    return null;
  }
  const main = readJson(join(root, "package.json"));
  if (main?.name !== "@openai/codex" || typeof main.version !== "string") return null;
  // require.resolve from bin/: each ancestor's node_modules, nearest first.
  let vendor: string | null = null;
  for (let dir = join(root, "bin"); !vendor; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "@openai", `codex-win32-${process.arch}`);
    if (basename(dir) !== "node_modules" && existsSync(join(candidate, "package.json"))) {
      const found = readJson(join(candidate, "package.json"));
      if (found?.version !== `${main.version}-win32-${process.arch}` || found.exports !== undefined) return null;
      vendor = join(candidate, "vendor");
    } else if (dirname(dir) === dir) {
      return null;
    }
  }
  const exe = join(vendor, target, "bin", "codex.exe");
  if (!isFile(exe) || !npmOwned(root, script, env)) return null;
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!/^CODEX_MANAGED_BY_/i.test(key)) out[key] = value;
  return { command: exe, args, env: { ...out, CODEX_MANAGED_PACKAGE_ROOT: root, CODEX_MANAGED_BY_NPM: "1" } };
}
