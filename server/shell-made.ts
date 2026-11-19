import { opendirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { isNetworkPath } from "./bot-cwd.ts";

const MAX_FILES = 32;
const MAX_ENTRIES = 512;
const MAX_TOKENS = 64;
// coarse file systems stamp to the second or two
const CLOCK_SLACK_MS = 2_000;
const TOKEN = /"([^"\n]+)"|'([^'\n]+)'|([^\s"'|;&<>()]+)/g;

const changedSince = (path: string, since: number): boolean => {
  const stat = statSync(path);
  // a Windows copy keeps the source's mtime and gets a new birthtime
  return stat.isFile() && Math.max(stat.mtimeMs, stat.birthtimeMs) >= since - CLOCK_SLACK_MS;
};

/** Files a shell command named, or that sit in a folder it named, created or changed since it started. */
export function shellMade(command: string, cwd: string, since: number): string[] {
  const made = new Set<string>();
  for (const match of [...command.matchAll(TOKEN)].slice(0, MAX_TOKENS)) {
    const token = match[1] ?? match[2] ?? match[3]!;
    if (!token || token.startsWith("-") || /[*?]/.test(token) || /^\w{2,}:\/\//.test(token) || isNetworkPath(token)) continue;
    const path = resolve(cwd, token);
    if (isNetworkPath(path)) continue;
    try {
      if (!statSync(path).isDirectory()) {
        if (changedSince(path, since)) made.add(path);
        continue;
      }
      const dir = opendirSync(path);
      try {
        for (let entry = dir.readSync(), seen = 0; entry && seen < MAX_ENTRIES && made.size < MAX_FILES; entry = dir.readSync(), seen++) {
          if (entry.isFile() && changedSince(join(path, entry.name), since)) made.add(join(path, entry.name));
        }
      } finally {
        dir.closeSync();
      }
    } catch {}
    if (made.size >= MAX_FILES) break;
  }
  return [...made].slice(0, MAX_FILES);
}
