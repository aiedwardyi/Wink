import { opendirSync, statSync, type Stats } from "node:fs";
import { basename, join, resolve } from "node:path";

import { isNetworkPath } from "./bot-cwd.ts";

const MAX_ENTRIES = 512;
const MAX_TOKENS = 64;
// coarse file systems stamp to the second or two
const CLOCK_SLACK_MS = 2_000;
const TOKEN = /"([^"\n]+)"|'([^'\n]+)'|([^\s"'|;&<>()]+)/g;
const CHANGE_DIR = /^(?:cd|chdir|sl|set-location)$/i;
const PUSH_DIR = /^(?:pushd|push-location)$/i;
const POP_DIR = /^(?:popd|pop-location)$/i;

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
  const seen = new Set<string>();
  const locations: string[] = [];
  let here = cwd;
  let change: "set" | "push" | undefined;
  let end = 0;
  for (const match of [...command.matchAll(TOKEN)].slice(0, MAX_TOKENS)) {
    const first = end === 0 || /[;&|\n]/.test(command.slice(end, match.index));
    end = match.index + match[0].length;
    const token = match[1] ?? match[2] ?? match[3]!;
    if (first) {
      change = undefined;
      if (POP_DIR.test(token)) {
        here = locations.pop() ?? here;
        continue;
      }
      if (CHANGE_DIR.test(token) || PUSH_DIR.test(token)) {
        change = PUSH_DIR.test(token) ? "push" : "set";
        continue;
      }
    }
    if (!token || token.startsWith("-") || /[*?]/.test(token) || /^\w{2,}:\/\//.test(token) || isNetworkPath(token)) continue;
    const path = resolve(here, token);
    if (isNetworkPath(path)) continue;
    if (!change && seen.has(path)) continue;
    const stat = statOf(path);
    if (change) {
      if (stat?.isDirectory()) {
        if (change === "push") locations.push(here);
        here = path;
      }
      change = undefined;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    if (stat?.isFile() && changed(stat, after)) made.add(path);
    if (stat?.isDirectory()) {
      try {
        for (const ref of listed(path, stat, after)) made.add(ref);
      } catch {}
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
