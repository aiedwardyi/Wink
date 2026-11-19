import { opendirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { isNetworkPath } from "./bot-cwd.ts";

const MAX_ENTRIES = 512;
const MAX_TOKENS = 64;
// coarse file systems stamp to the second or two
const CLOCK_SLACK_MS = 2_000;
const TOKEN = /"([^"\n]+)"|'([^'\n]+)'|([^\s"'|;&<>()]+)/g;
const CHANGE_DIR = /^(?:cd|chdir|pushd|sl|set-location|push-location)$/i;

const changedSince = (path: string, since: number): boolean => {
  const stat = statSync(path);
  // a Windows copy keeps the source's mtime and gets a new birthtime
  return stat.isFile() && Math.max(stat.mtimeMs, stat.birthtimeMs) >= since - CLOCK_SLACK_MS;
};

/** Files a shell command named, or that sit in a folder it named, created or changed since it started. */
export function shellMade(command: string, cwd: string, since: number): string[] {
  const made = new Set<string>();
  let here = cwd;
  let changingDir = false;
  let end = 0;
  for (const match of [...command.matchAll(TOKEN)].slice(0, MAX_TOKENS)) {
    const token = match[1] ?? match[2] ?? match[3]!;
    const first = end === 0 || /[;&|\n]/.test(command.slice(end, match.index));
    end = match.index + match[0].length;
    if (first) changingDir = CHANGE_DIR.test(token);
    if (first && changingDir) continue;
    if (!token || token.startsWith("-") || /[*?]/.test(token) || /^\w{2,}:\/\//.test(token) || isNetworkPath(token)) continue;
    const path = resolve(here, token);
    if (isNetworkPath(path)) continue;
    if (changingDir) {
      here = path;
      changingDir = false;
    }
    try {
      if (!statSync(path).isDirectory()) {
        if (changedSince(path, since)) made.add(path);
        continue;
      }
      const dir = opendirSync(path);
      try {
        for (let entry = dir.readSync(), seen = 0; entry; entry = dir.readSync(), seen++) {
          // past the bound the folder itself is kept, so memory still names where the rest went
          if (seen === MAX_ENTRIES) {
            made.add(path);
            break;
          }
          if (entry.isFile() && changedSince(join(path, entry.name), since)) made.add(join(path, entry.name));
        }
      } finally {
        dir.closeSync();
      }
    } catch {}
  }
  return [...made];
}
