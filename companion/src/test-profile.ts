import { createHash, randomBytes } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
}

interface TestHome extends DirectoryIdentity {
  home: string;
  canonical: string;
  nonce: string;
  registrations: DirectoryIdentity & { path: string };
}

interface TestRun extends TestHome {
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

function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

function markerMatches(home: string, nonce: string): boolean {
  const marker = join(home, ".wink-vitest-home");
  return lstatSync(marker, { throwIfNoEntry: false })?.isFile() === true &&
    readFileSync(marker, "utf8") === `${nonce}\n${home}\n`;
}

function allocateTestHome(parent: string, prefix: string, nonce: string, registrations?: TestHome["registrations"]): TestHome {
  if (!prefix || prefix !== basename(prefix) || prefix === "." || prefix === "..") throw new Error("Use a single directory prefix for createFixtureHome");
  const canonicalParent = realpathSync.native(parent);
  const home = mkdtempSync(join(parent, prefix));
  const canonical = realpathSync.native(home);
  if (relative(join(canonicalParent, basename(home)), canonical)) throw new Error("Use an unredirected parent directory for Vitest homes");
  writeFileSync(join(canonical, ".wink-vitest-home"), `${nonce}\n${canonical}\n`, { flag: "wx", mode: 0o600 });
  const { dev, ino } = lstatSync(canonical, { bigint: true });
  if (!registrations) {
    const path = mkdtempSync(join(canonical, ".wink-data-"));
    const { dev, ino } = lstatSync(path, { bigint: true });
    registrations = { path, dev, ino };
  }
  return { home, canonical, nonce, dev, ino, registrations };
}

export function startTestRun(temp = tmpdir()): string {
  if (state[key]?.run) throw new Error("Finish the current run with removeTestData before starting a new Vitest run");
  const profile = allocateTestHome(temp, "omb-test-home-", randomBytes(32).toString("hex"));
  const active = shareWithWorkers(profile);
  state[key] = { run: { ...profile, fixtures: new Map(), active } };
  return profile.home;
}

function verifiedHome(profile: TestHome): boolean {
  try {
    assertOwnedDir(profile.canonical, profile);
    assertOwnedDir(profile.registrations.path, profile.registrations);
    return !relative(profile.canonical, realpathSync.native(profile.home)) && markerMatches(profile.canonical, profile.nonce);
  } catch {
    return false;
  }
}

export function createFixtureHome(prefix: string): string {
  const run = state[key]?.run;
  if (!run || !verifiedHome(run)) throw new Error("Load server/testing/setup.ts before calling createFixtureHome");
  const profile = allocateTestHome(run.home, prefix, run.nonce, run.registrations);
  run.fixtures.set(profile.home, profile);
  return profile.home;
}

export function harnessTestHome(home: string | undefined): TestHome | undefined {
  const run = state[key]?.run;
  if (!run || !home || !verifiedHome(run)) return;
  const profile = home === run.home ? run : run.fixtures.get(home);
  if (profile && verifiedHome(profile)) {
    const { canonical, nonce, dev, ino, registrations } = profile;
    return { home, canonical, nonce, dev, ino, registrations };
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

function requireTestProfile(importer: string): TestHome {
  const active = state[key];
  const inherited = getEnvironmentData(workerKey) as { profile: TestHome; active: Int32Array } | undefined;
  const worker = !active && inherited && Atomics.load(inherited.active, 0) === 1 ? inherited.profile : undefined;
  const profile = active?.run ?? (process.connected ? active?.child : undefined) ?? worker;
  if (profile && profile.home === homedir() && verifiedHome(profile)) return profile;
  throw new Error(`load server/testing/setup.ts (vite.config.ts setupFiles) before importing ${importer}`);
}

export function requireTestHome(importer = "tests"): string {
  return requireTestProfile(importer).home;
}

function directoryKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function readRegistration(file: string): DirectoryIdentity & { path: string } {
  const [path, dev, ino] = JSON.parse(readFileSync(file, "utf8")) as [string, string, string];
  return { path, dev: BigInt(dev), ino: BigInt(ino) };
}

export function registerTestDataDir(dataDir: string, importer: string): boolean {
  const profile = requireTestProfile(importer);
  if (dataDir !== resolve(dataDir)) return false;
  const expected = expectedProfilePath(dataDir, profile.home, profile.canonical);
  if (!expected || relative(expected, resolvePath(dataDir)) || contains(profile.registrations.path, expected)) return false;
  const file = join(profile.registrations.path, createHash("sha256").update(directoryKey(expected)).digest("hex") + ".json");
  if (!directoryStat(file)) {
    mkdirSync(expected, { recursive: true, mode: 0o700 });
    const stat = lstatSync(expected, { bigint: true });
    assertOwnedDir(expected, stat);
    const temp = file + "." + randomBytes(8).toString("hex");
    writeFileSync(temp, JSON.stringify([expected, String(stat.dev), String(stat.ino)]), { flag: "wx", mode: 0o600 });
    // Publish a complete record without replacing an identity recorded by another worker.
    try { linkSync(temp, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { unlinkSync(temp); }
  }
  assertOwnedDir(expected, readRegistration(file));
  return true;
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

function assertOwnedDir(path: string, stat: DirectoryIdentity): void {
  const before = directoryStat(path);
  if (!before?.isDirectory() || before.dev !== stat.dev || before.ino !== stat.ino ||
      relative(path, realpathSync.native(path))) {
    throw new Error(`removeTestData found a changed directory: ${path}. Use an unredirected test fixture`);
  }
}

// Recheck each directory before descent and unlink links without following them.
function removeOwnedDir(path: string, stat: DirectoryIdentity, owned: Map<string, DirectoryIdentity>, keep = false): void {
  assertOwnedDir(path, stat);
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const entry = directoryStat(child);
    if (!entry) continue;
    const registered = owned.get(directoryKey(child));
    if (registered || entry.isDirectory()) removeOwnedDir(child, registered ?? entry, owned);
    else {
      assertOwnedDir(path, stat);
      if (entry.isSymbolicLink()) unlinkSync(child);
      else rmSync(child, { force: true });
    }
  }
  assertOwnedDir(path, stat);
  if (!keep) rmdirSync(path);
}

function directoryStat(path: string) {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

export function removeTestData(dir: string): void {
  const run = state[key]?.run;
  if (!run || !verifiedHome(run)) throw new Error("removeTestData requires the live run from server/testing/setup.ts");
  if (dir !== resolve(dir)) throw new Error("removeTestData requires an absolute, normalized path in the current test home");
  const target = resolvePath(dir);
  const osHome = userInfo().homedir;
  const claudeSiblings = directoryStat(osHome) ? readdirSync(osHome).filter((name) => directoryKey(name).startsWith(".claude")) : [];
  for (const name of new Set([".orbit", ".codex", ".openmausbot-companion", ".claude", ...claudeSiblings])) {
    const profile = join(osHome, name);
    for (const protectedPath of [profile, resolvePath(profile)]) {
      if (overlaps(target, protectedPath)) {
        throw new Error(`removeTestData refused a real profile path: ${dir}. Use the current test home from server/testing/setup.ts`);
      }
    }
  }
  const removingRoot = dir === run.home || dir === run.canonical;
  const expected = removingRoot ? run.canonical : expectedProfilePath(dir, run.home, run.canonical);
  if (!expected || relative(expected, target)) {
    throw new Error(`removeTestData refused an unowned or redirected path: ${dir}. Use the current test home from server/testing/setup.ts`);
  }
  const registrations = run.registrations.path;
  if (contains(registrations, target)) throw new Error(`removeTestData refused the run's ownership records: ${dir}`);
  const stat = directoryStat(target);
  if (!stat) return;
  if (!stat.isDirectory()) throw new Error(`removeTestData requires a test directory: ${dir}`);

  const owned = new Map<string, DirectoryIdentity>();
  for (const fixture of run.fixtures.values()) {
    if (overlaps(target, fixture.canonical) && directoryStat(fixture.canonical)) {
      assertOwnedDir(fixture.canonical, fixture);
      owned.set(directoryKey(fixture.canonical), fixture);
    }
  }
  const data = new Set<string>();
  for (const file of readdirSync(registrations)) {
    if (!file.endsWith(".json")) continue;
    const recorded = readRegistration(join(registrations, file));
    if (overlaps(target, recorded.path) && directoryStat(recorded.path)) {
      assertOwnedDir(recorded.path, recorded);
      const key = directoryKey(recorded.path);
      data.add(key);
      owned.set(key, recorded);
    }
  }
  const targetKey = directoryKey(target);
  try {
    // Tests reset imported profiles repeatedly while holding the same DATA_DIR.
    removeOwnedDir(target, removingRoot ? run : owned.get(targetKey) ?? stat, owned, data.has(targetKey));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (!removingRoot || process.platform !== "win32" || failure.code !== "EBUSY" || failure.syscall !== "rmdir" || failure.path !== target) throw error;
    console.warn(`removeTestData left a busy test home: ${dir}. Close any child processes using that home before test teardown`);
  } finally {
    if (removingRoot) {
      Atomics.store(run.active, 0, 0);
      setEnvironmentData(workerKey, undefined);
      delete state[key]?.run;
    }
  }
}
