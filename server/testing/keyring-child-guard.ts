// A node child that runs Wink's server code picks the user's real OS credential store (Windows Credential Manager,
// macOS keychain) unless it knows it is a test: VITEST in its env, or the harness-profile preload that
// spawnTestNode adds (server/testing/harness-auth.ts). A test that starts one any other way puts the real store one
// request away, so the start fails instead, however it is made: spawn, fork, exec or their sync forms.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// From the path, not new URL(): under jsdom the global URL is not Node's, and fileURLToPath refuses it.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Only the server loads the keyring code (server/drivers/os-keyring.ts); the companion and the fakes and fixtures
// under server/testing run as their own scripts and never do.
const SERVER = resolve(ROOT, "server");
const FAKES = resolve(SERVER, "testing");
const PRELOAD = "harness-profile";

type Env = NodeJS.ProcessEnv | undefined;

function isNode(command: string): boolean {
  return command === process.execPath || /^node(?:\.exe)?$/i.test(basename(command.replace(/^"|"$/g, "")));
}

/** A script of Wink's server, by path: a .ts file under server/, outside the test fakes. */
function winkScript(arg: string): boolean {
  const path = arg.replace(/^"|"$/g, "").replace(/^file:\/\/\/?/, "");
  if (!/\.(?:[cm]?ts|tsx)$/i.test(path)) return false;
  const full = isAbsolute(path) ? resolve(path) : resolve(ROOT, path);
  const inside = (dir: string) => {
    const rel = relative(dir, full);
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  return inside(SERVER) && !inside(FAKES);
}

/** Whether a node child started with these would use the OS credential store. */
export function childUsesOsKeyring(command: string, args: readonly string[], env: Env): boolean {
  if (!isNode(command) || !args.some(winkScript)) return false;
  const childEnv = env ?? process.env;
  if (childEnv.VITEST !== undefined) return false;
  return !args.some((arg) => arg.includes(PRELOAD)) && !(childEnv.NODE_OPTIONS ?? "").includes(PRELOAD);
}

function refuse(command: string, args: readonly string[]): never {
  throw new Error(`A test started ${[basename(command), ...args.map((arg) => basename(arg))].join(" ")} with no test home: it would use the real OS credential store. Start it with spawnTestNode, spawnHarness or runTestNode (server/testing/harness-auth.ts) and a createFixtureHome home.`);
}

const options = (value: unknown): { env?: Env; execArgv?: string[] } | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value : undefined;

/** Wraps child_process so every start above is checked first. Call once per test process, before tests import it. */
export function guardKeyringChildren(): void {
  // SAFETY: each name below is a child_process function whose first argument is the program, module or command
  // line; the wrappers read only that, the args array and the options, and pass everything on untouched.
  const cp = childProcess as unknown as Record<string, (first: string, ...rest: unknown[]) => unknown>;
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"] as const) {
    const original = cp[name];
    cp[name] = (file: string, ...rest: unknown[]) => {
      const args = Array.isArray(rest[0]) ? rest[0].map(String) : [];
      const opts = options(Array.isArray(rest[0]) ? rest[1] : rest[0]);
      if (childUsesOsKeyring(String(file), args, opts?.env)) refuse(String(file), args);
      return original(file, ...rest);
    };
  }
  const fork = cp.fork;
  cp.fork = (modulePath: string, ...rest: unknown[]) => {
    const args = Array.isArray(rest[0]) ? rest[0].map(String) : [];
    const opts = options(Array.isArray(rest[0]) ? rest[1] : rest[0]);
    const all = [...(opts?.execArgv ?? process.execArgv), String(modulePath), ...args];
    if (childUsesOsKeyring(process.execPath, all, opts?.env)) refuse(process.execPath, all);
    return fork(modulePath, ...rest);
  };
  for (const name of ["exec", "execSync"] as const) {
    const original = cp[name];
    cp[name] = (command: string, ...rest: unknown[]) => {
      const words = String(command).match(/"[^"]*"|\S+/g) ?? [];
      const at = words.findIndex((word) => isNode(word));
      if (at !== -1 && childUsesOsKeyring(words[at]!.replace(/^"|"$/g, ""), words.slice(at + 1), options(rest[0])?.env)) refuse(words[at]!, words.slice(at + 1));
      return original(command, ...rest);
    };
  }
  syncBuiltinESMExports();
}
