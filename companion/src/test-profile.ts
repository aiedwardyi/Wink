import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isChildPath(path: string): boolean {
  return !!path && !isAbsolute(path) && path.split(sep)[0] !== "..";
}

function canonicalTestHome(home: string): string | undefined {
  const temp = tmpdir();
  if (home !== resolve(home)) return;
  try {
    const canonicalTemp = realpathSync.native(temp);
    const tempPath = relative(temp, home);
    // Windows can report the temp root with an 8.3 name.
    const path = isChildPath(tempPath) ? tempPath : relative(canonicalTemp, home);
    if (!isChildPath(path)) return;
    const canonical = realpathSync.native(home);
    if (!relative(join(canonicalTemp, path), canonical) && lstatSync(canonical).isDirectory()) return canonical;
  } catch {
    return undefined;
  }
}

function markerMatches(home: string, token: string): boolean {
  const marker = join(home, ".wink-vitest-home");
  return lstatSync(marker, { throwIfNoEntry: false })?.isFile() === true &&
    readFileSync(marker, "utf8") === `${token}\n${home}\n`;
}

export function markTestHome(home: string, token: string): void {
  const canonical = canonicalTestHome(home);
  if (!canonical) throw new Error("Vitest home must be a directory under the OS temp directory");
  if (!markerMatches(canonical, token)) {
    writeFileSync(join(canonical, ".wink-vitest-home"), `${token}\n${canonical}\n`, { flag: "wx", mode: 0o600 });
  }
}

export function requireTestHome(importer = "tests"): string {
  const { WINK_VITEST_HOME: home, WINK_VITEST_HOME_TOKEN: token } = process.env;
  const canonical = home && home === homedir() && canonicalTestHome(home);
  if (home && canonical && token && markerMatches(canonical, token)) return home;
  throw new Error(`load server/testing/setup.ts (vite.config.ts setupFiles) before importing ${importer}`);
}

export function isTestProfilePath(dataDir: string, root: string): boolean {
  if (dataDir !== resolve(dataDir)) return false;
  let existing = dataDir;
  while (dirname(existing) !== existing && !lstatSync(existing, { throwIfNoEntry: false })) existing = dirname(existing);
  const target = resolve(realpathSync.native(existing), relative(existing, dataDir));
  return isChildPath(relative(realpathSync.native(root), target));
}
