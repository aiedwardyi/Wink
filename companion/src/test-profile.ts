import { lstatSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isChildPath(path: string): boolean {
  return !!path && !isAbsolute(path) && path.split(sep)[0] !== "..";
}

function canonicalTestHome(home: string, temp = tmpdir()): string | undefined {
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

function markerMatches(home: string, nonce: string): boolean {
  const marker = join(home, ".wink-vitest-home");
  return lstatSync(marker, { throwIfNoEntry: false })?.isFile() === true &&
    readFileSync(marker, "utf8") === `${nonce}\n${home}\n`;
}

export function allocateTestHome(prefix: string, nonce: string, temp = tmpdir()): string {
  const home = mkdtempSync(join(temp, prefix));
  const canonical = canonicalTestHome(home, temp);
  if (!canonical) throw new Error("Vitest home must be a directory under the OS temp directory");
  writeFileSync(join(canonical, ".wink-vitest-home"), `${nonce}\n${canonical}\n`, { flag: "wx", mode: 0o600 });
  return home;
}

export function isMarkedTestHome(home: string, nonce: string): boolean {
  const canonical = canonicalTestHome(home);
  return !!canonical && markerMatches(canonical, nonce);
}

export function requireTestHome(importer = "tests"): string {
  const { WINK_VITEST_HOME: home, WINK_VITEST_HOME_NONCE: nonce } = process.env;
  if (home && home === homedir() && nonce && isMarkedTestHome(home, nonce)) return home;
  throw new Error(`load server/testing/setup.ts (vite.config.ts setupFiles) before importing ${importer}`);
}

export function isTestProfilePath(dataDir: string, root: string): boolean {
  if (dataDir !== resolve(dataDir)) return false;
  const canonicalRoot = realpathSync.native(root);
  const lexicalPath = relative(root, dataDir);
  const path = isChildPath(lexicalPath) ? lexicalPath : relative(canonicalRoot, dataDir);
  if (!isChildPath(path)) return false;
  let existing = dataDir;
  while (dirname(existing) !== existing && !lstatSync(existing, { throwIfNoEntry: false })) existing = dirname(existing);
  const target = resolve(realpathSync.native(existing), relative(existing, dataDir));
  return !relative(join(canonicalRoot, path), target);
}
