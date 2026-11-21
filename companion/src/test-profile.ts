import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";

interface TestHome {
  home: string;
  canonical: string;
  nonce: string;
}

interface TestRun extends TestHome {
  device: bigint;
  inode: bigint;
  fixtures: Map<string, TestHome>;
  active: Int32Array;
}

// Vitest's resetModules() must retain the ownership recorded by setupFiles.
const key = Symbol.for("wink.test-profile");
const workerKey = "wink.test-profile";
const state = globalThis as typeof globalThis & { [key]?: { run?: TestRun; child?: TestHome } };

function isChildPath(path: string): boolean {
  return !!path && !isAbsolute(path) && path.split(sep)[0] !== "..";
}

function contains(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return !fromRoot || isChildPath(fromRoot);
}

function markerMatches(home: string, nonce: string): boolean {
  const marker = join(home, ".wink-vitest-home");
  return lstatSync(marker, { throwIfNoEntry: false })?.isFile() === true &&
    readFileSync(marker, "utf8") === `${nonce}\n${home}\n`;
}

function allocateTestHome(parent: string, prefix: string, nonce: string): TestHome {
  if (!prefix || prefix !== basename(prefix) || prefix === "." || prefix === "..") throw new Error("Use a single directory prefix for createFixtureHome");
  const canonicalParent = realpathSync.native(parent);
  const home = mkdtempSync(join(parent, prefix));
  const canonical = realpathSync.native(home);
  if (relative(join(canonicalParent, basename(home)), canonical)) throw new Error("Use an unredirected parent directory for Vitest homes");
  writeFileSync(join(canonical, ".wink-vitest-home"), `${nonce}\n${canonical}\n`, { flag: "wx", mode: 0o600 });
  return { home, canonical, nonce };
}

export function startTestRun(temp = tmpdir()): string {
  if (state[key]?.run) throw new Error("Finish the current run with removeTestData before starting a new Vitest run");
  const profile = allocateTestHome(temp, "omb-test-home-", randomBytes(32).toString("hex"));
  const stat = lstatSync(profile.canonical, { bigint: true });
  const active = shareWithWorkers(profile);
  state[key] = { run: { ...profile, device: stat.dev, inode: stat.ino, fixtures: new Map(), active } };
  return profile.home;
}

function verifiedHome(profile: TestHome): boolean {
  try {
    return !relative(profile.canonical, realpathSync.native(profile.home)) && markerMatches(profile.canonical, profile.nonce);
  } catch {
    return false;
  }
}

function ownsRun(run: TestRun): boolean {
  const stat = lstatSync(run.canonical, { bigint: true, throwIfNoEntry: false });
  return !!stat?.isDirectory() && stat.dev === run.device && stat.ino === run.inode && verifiedHome(run);
}

export function createFixtureHome(prefix: string): string {
  const run = state[key]?.run;
  if (!run || !ownsRun(run)) throw new Error("Load server/testing/setup.ts before calling createFixtureHome");
  const profile = allocateTestHome(run.home, prefix, run.nonce);
  run.fixtures.set(profile.home, profile);
  return profile.home;
}

export function harnessTestHome(home: string | undefined): TestHome | undefined {
  const run = state[key]?.run;
  if (!run || !home || !ownsRun(run)) return;
  const profile = home === run.home ? run : run.fixtures.get(home);
  if (profile && verifiedHome(profile)) {
    const { canonical, nonce } = profile;
    return { home, canonical, nonce };
  }
}

export function attachHarnessTestHome(profile: TestHome): void {
  if (state[key] || !process.connected || profile.home !== homedir() || !verifiedHome(profile)) return;
  state[key] = { child: profile };
  const active = shareWithWorkers(profile);
  process.once("disconnect", () => Atomics.store(active, 0, 0));
  process.channel?.unref();
}

function shareWithWorkers(profile: TestHome): Int32Array {
  const active = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.store(active, 0, 1);
  setEnvironmentData(workerKey, { profile, active });
  return active;
}

export function requireTestHome(importer = "tests"): string {
  const active = state[key];
  const inherited = getEnvironmentData(workerKey) as { profile: TestHome; active: Int32Array } | undefined;
  const worker = !active && inherited && Atomics.load(inherited.active, 0) === 1 ? inherited.profile : undefined;
  const profile = active?.run ?? (process.connected ? active?.child : undefined) ?? worker;
  if (profile && profile.home === homedir() && (active?.run ? ownsRun(active.run) : verifiedHome(profile))) return profile.home;
  throw new Error(`load server/testing/setup.ts (vite.config.ts setupFiles) before importing ${importer}`);
}

export function isTestProfilePath(dataDir: string, root: string): boolean {
  if (dataDir !== resolve(dataDir)) return false;
  const canonicalRoot = realpathSync.native(root);
  const expected = expectedProfilePath(dataDir, root, canonicalRoot);
  return !!expected && !relative(expected, resolvePath(dataDir));
}

function expectedProfilePath(dataDir: string, root: string, canonicalRoot: string): string | undefined {
  const lexicalPath = relative(root, dataDir);
  const path = isChildPath(lexicalPath) ? lexicalPath : relative(canonicalRoot, dataDir);
  if (isChildPath(path)) return join(canonicalRoot, path);
}

function resolvePath(path: string): string {
  let existing = path;
  while (dirname(existing) !== existing && !lstatSync(existing, { throwIfNoEntry: false })) existing = dirname(existing);
  return resolve(realpathSync.native(existing), relative(existing, path));
}

function assertOwnedDir(path: string, stat: NonNullable<ReturnType<typeof directoryStat>>): void {
  const before = directoryStat(path);
  if (!before?.isDirectory() || before.dev !== stat.dev || before.ino !== stat.ino ||
      relative(path, realpathSync.native(path))) {
    throw new Error(`removeTestData found a changed directory: ${path}. Use an unredirected test fixture`);
  }
}

// Recheck each directory before descent and unlink links without following them.
function removeOwnedDir(path: string, stat: NonNullable<ReturnType<typeof directoryStat>>): void {
  assertOwnedDir(path, stat);
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const entry = directoryStat(child);
    if (!entry) continue;
    if (entry.isDirectory()) removeOwnedDir(child, entry);
    else {
      assertOwnedDir(path, stat);
      if (entry.isSymbolicLink()) unlinkSync(child);
      else rmSync(child, { force: true });
    }
  }
  assertOwnedDir(path, stat);
  rmdirSync(path);
}

function directoryStat(path: string) {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

export function removeTestData(dir: string): void {
  const run = state[key]?.run;
  if (!run || !ownsRun(run)) throw new Error("removeTestData requires the live run from server/testing/setup.ts");
  if (dir !== resolve(dir)) throw new Error("removeTestData requires an absolute, normalized path in the current test home");
  const target = resolvePath(dir);
  const osHome = userInfo().homedir;
  for (const name of [".orbit", ".codex", ".openmausbot-companion"]) {
    const profile = join(osHome, name);
    for (const protectedPath of [profile, resolvePath(profile)]) {
      if (contains(target, protectedPath) || contains(protectedPath, target)) {
        throw new Error(`removeTestData refused a real profile path: ${dir}. Use the current test home from server/testing/setup.ts`);
      }
    }
  }
  const removingRoot = dir === run.home || dir === run.canonical;
  const expected = removingRoot ? run.canonical : expectedProfilePath(dir, run.home, run.canonical);
  if (!expected || relative(expected, target)) {
    throw new Error(`removeTestData refused an unowned or redirected path: ${dir}. Use the current test home from server/testing/setup.ts`);
  }
  const stat = directoryStat(target);
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error(`removeTestData requires a test directory: ${dir}`);

  try {
    removeOwnedDir(target, stat);
  } finally {
    if (removingRoot) {
      Atomics.store(run.active, 0, 0);
      setEnvironmentData(workerKey, undefined);
      delete state[key]?.run;
    }
  }
}
