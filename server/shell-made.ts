import { opendirSync, statSync, type Stats } from "node:fs";
import { basename, join, resolve } from "node:path";

import { isNetworkPath } from "./bot-cwd.ts";

const MAX_ENTRIES = 512;
const MAX_TOKENS = 64;
// coarse file systems stamp to the second or two
const CLOCK_SLACK_MS = 2_000;
const TOKEN = /"([^"\n]+)"|'([^'\n]+)'|([^\s"'|;&<>()]+)/g;

const statOf = (path: string): Stats | undefined => {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
};

// a Windows copy keeps the source's mtime and gets a new birthtime
const changed = (stat: Stats, after: number) => Math.max(stat.mtimeMs, stat.birthtimeMs) >= after;

/** Files a shell command named, or made in a folder it named: changed files, and everything in folders it created. */
export function shellMade(command: string, cwd: string, since: number): string[] {
  const after = since - CLOCK_SLACK_MS;
  const made = new Set<string>();
  // cd, pushd and popd are not replayed: a path is read against the newest folder named before it, then older ones, and kept at the first place something changed
  const bases = [cwd];
  const found = new Map<string, boolean>();
  for (const match of [...command.matchAll(TOKEN)].slice(0, MAX_TOKENS)) {
    const token = match[1] ?? match[2] ?? match[3]!;
    if (!token || token.startsWith("-") || /[*?]/.test(token) || /^\w{2,}:\/\//.test(token) || isNetworkPath(token)) continue;
    for (const path of new Set(bases.map((base) => resolve(base, token)).reverse())) {
      if (isNetworkPath(path)) continue;
      if (!found.has(path)) {
        const stat = statOf(path);
        let refs: string[] = [];
        if (stat?.isFile() && changed(stat, after)) refs = [path];
        if (stat?.isDirectory()) {
          if (bases.length <= MAX_TOKENS) bases.push(path);
          try {
            refs = listed(path, stat, after);
          } catch {}
        }
        for (const ref of refs) made.add(ref);
        found.set(path, refs.length > 0);
      }
      if (found.get(path)) break;
    }
  }
  return [...made];
}

/** A named folder's changed files and new folders; past MAX_ENTRIES untouched entries, the folder itself if anything in it changed, never a short list. */
function listed(folder: string, stat: Stats, after: number): string[] {
  const created = stat.birthtimeMs >= after;
  const made: string[] = [];
  let untouched = 0;
  const dir = opendirSync(folder);
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      const path = join(folder, entry.name);
      // everything in a folder the command created is new, whatever times the copy kept
      const inner = created ? undefined : statOf(path);
      if (entry.isFile() && (created || (inner && changed(inner, after)))) made.push(path);
      else if (entry.isDirectory() && (created || (inner && inner.birthtimeMs >= after))) made.push(...tree(path));
      else if (++untouched > MAX_ENTRIES) return made.length || changed(stat, after) ? [folder] : [];
    }
  } finally {
    dir.closeSync();
  }
  return made;
}

/** Every file under a folder the command created, or the folder itself for hidden tool state (.git, .venv) or a tree past MAX_ENTRIES (an install, a clone). */
function tree(folder: string): string[] {
  if (basename(folder).startsWith(".")) return [folder];
  const made: string[] = [];
  const folders = [folder];
  try {
    for (let entries = 0, next = folders.pop(); next !== undefined; next = folders.pop()) {
      const dir = opendirSync(next);
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (++entries > MAX_ENTRIES) return [folder];
          const path = join(next, entry.name);
          if (entry.isFile() || (entry.isDirectory() && entry.name.startsWith("."))) made.push(path);
          else if (entry.isDirectory()) folders.push(path);
        }
      } finally {
        dir.closeSync();
      }
    }
  } catch {
    return [folder];
  }
  return made;
}
