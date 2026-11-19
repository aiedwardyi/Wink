import { opendirSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { isNetworkPath } from "./bot-cwd.ts";

const MAX_ENTRIES = 512;
const MAX_TOKENS = 64;
// coarse file systems stamp to the second or two
const CLOCK_SLACK_MS = 2_000;
const TOKEN = /"([^"\n]+)"|'([^'\n]+)'|([^\s"'|;&<>()]+)/g;
const CHANGE_DIR = /^(?:cd|chdir|sl|set-location)$/i;
const PUSH_DIR = /^(?:pushd|push-location)$/i;
const POP_DIR = /^(?:popd|pop-location)$/i;
const RECURSIVE = /^-(?:-?recursive|recurse|rec|rf?|fr)$/i;
const EXITING_POP = /(?:\bif\b[^{}\r\n]*\{|\|\|\s*\{|[;\n][ \t]*then\b)\s*((?:(?:popd|pop-location)\b[^;\r\n{}]*[;\r\n]\s*)+)exit(?:[ \t]+\d+)?\s*;?\s*(?:\}|fi\b)/dgi;

type DirectoryChange = [path: string, present: boolean];
type Mutation = { kind: "create" | "remove" | "move" | "rename"; paths: string[]; folder?: boolean };
type Walk = { here: string; stack?: string[]; followMissing: boolean; changes: DirectoryChange[]; removed: Map<string, number> };

const pathWord = (word: string) => word && !word.startsWith("-") && !/[*?]/.test(word) && !/^\w{2,}:\/\//.test(word) && !isNetworkPath(word);
const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const under = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
const presentAt = (walk: Walk, path: string) => walk.changes.findLast(([name, present]) => present ? under(name, path) : under(path, name))?.[1];

function mutationOf([name, ...args]: string[]): Mutation | undefined {
  const command = name?.toLowerCase();
  if (!/^(?:mkdir|md|new-item|rmdir|rm|remove-item|mv|move-item|rename-item)$/.test(command ?? "")) return;
  if (args.some((arg) => /^-whatif$/i.test(arg))) return;
  const paths: string[] = [];
  const moving = command === "mv" || command === "move-item" || command === "rename-item";
  let directory = command !== "new-item";
  let child: string | undefined;
  let source: string | undefined;
  let destination: string | undefined;
  for (const [index, arg] of args.entries()) {
    const previous = args[index - 1]?.toLowerCase();
    if (previous === "-itemtype" || previous === "-type") directory = arg.toLowerCase() === "directory";
    else if (previous === "-name" && command === "new-item" && !/[$%]/.test(arg)) child = arg;
    else if (previous !== "-erroraction" && pathWord(arg) && !/[$%]/.test(arg)) {
      if (moving && (previous === "-path" || previous === "-literalpath")) source = arg;
      else if (moving && (previous === "-destination" || previous === "-newname")) destination = arg;
      else paths.push(arg);
    }
  }
  if (moving) {
    const from = source ?? paths.shift();
    const to = destination ?? paths.shift();
    if (from && to && !paths.length) return { kind: command === "rename-item" ? "rename" : "move", paths: [from, to] };
    return;
  }
  if (child && pathWord(child)) paths[0] = join(paths[0] ?? ".", child);
  if (!paths.length || !directory) return;
  if (command === "mkdir" || command === "md" || command === "new-item") return { kind: "create", paths };
  return { kind: "remove", paths, folder: command === "rmdir" || args.some((arg) => RECURSIVE.test(arg)) };
}

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
  const seen = new Map<string, Stats | undefined>();
  const scanned = new Set<string>();
  const getStat = (path: string) => {
    if (!seen.has(path)) seen.set(path, statOf(path));
    return seen.get(path);
  };
  let end = 0;
  let depth = 0;
  const words = [...command.matchAll(TOKEN)].slice(0, MAX_TOKENS).map((match) => {
    const gap = command.slice(end, match.index);
    const first = end === 0 || /[;&|\n]/.test(gap);
    end = match.index + match[0].length;
    const token = match[1] ?? match[2] ?? match[3]!;
    if (/^(?:\}|fi|done)$/.test(match[0])) depth = Math.max(0, depth - 1);
    const linear = depth === 0 && !gap.includes("||");
    if (/^(?:\{|then|do)$/.test(match[0])) depth++;
    return { token, index: match.index, first, linear };
  });
  const mutations = new Map<number, Mutation>();
  for (const [index, word] of words.entries()) {
    if (!word.first || !word.linear) continue;
    const next = words.findIndex((part, offset) => offset > index && part.first);
    const mutation = mutationOf(words.slice(index, next === -1 ? words.length : next).map((part) => part.token));
    if (mutation) mutations.set(index, mutation);
  }
  // A pop in a branch that exits cannot affect the commands after that branch.
  const exiting = [...command.slice(0, end).matchAll(EXITING_POP)].map((match) => match.indices![1]!);

  const replay = (walks: Walk[], discover: boolean) => {
    let change = false;
    let push = false;
    for (const [index, { token, index: at, first }] of words.entries()) {
      const pop = first && POP_DIR.test(token);
      if (first) {
        const mutation = mutations.get(index);
        if (mutation) for (const walk of walks) recordMutation(walk, mutation, index, getStat, discover);
        push = PUSH_DIR.test(token);
        change = push || CHANGE_DIR.test(token);
        if (change) {
          if (push) for (const walk of walks) walk.stack?.push(walk.here);
          continue;
        }
      }
      if ((pop && exiting.some(([start, stop]) => at >= start && at < stop)) || !pathWord(token)) continue;
      let resolved = false;
      for (const walk of walks) {
        if (pop && walk.stack) {
          walk.here = walk.stack.pop() ?? walk.here;
          continue;
        }
        const path = resolve(walk.here, token);
        if (isNetworkPath(path)) continue;
        resolved = true;
        if (change) {
          const key = pathKey(path);
          const stat = getStat(path);
          const laterRemoval = !stat && (walk.removed.get(key) ?? -1) > index;
          const follow = discover || stat?.isDirectory() || laterRemoval || (presentAt(walk, key) ?? walk.followMissing);
          if (follow) walk.here = path;
          else if (push) walk.stack?.pop();
        }
        if (discover || scanned.has(path)) continue;
        scanned.add(path);
        const stat = getStat(path);
        if (stat?.isFile() && changed(stat, after)) made.add(path);
        if (stat?.isDirectory()) {
          try {
            for (const ref of listed(path, stat, after)) made.add(ref);
          } catch {}
        }
      }
      if (resolved) change = false;
    }
  };
  const walk = (pops: boolean, followMissing = true, removed = new Map<string, number>()): Walk =>
    ({ here: cwd, stack: pops ? [] : undefined, followMissing, changes: [], removed });
  // Project later removals along the paths reached when the cd succeeds.
  const [pops, noPops] = [walk(true), walk(false)];
  if (mutations.size) replay([pops, noPops], true);
  replay([walk(true, true, pops.removed), walk(false, true, noPops.removed), walk(true, false, pops.removed), walk(false, false, noPops.removed)], false);
  return [...made];
}

function recordMutation(walk: Walk, mutation: Mutation, index: number, getStat: typeof statOf, discover: boolean) {
  const paths = mutation.paths.map((path) => resolve(walk.here, path));
  if (paths.some(isNetworkPath)) return;
  const [from, to] = paths;
  if (!from) return;
  if (to && (mutation.kind === "move" || mutation.kind === "rename")) {
    const child = join(to, basename(from));
    const target = mutation.kind === "rename" ? resolve(dirname(from), mutation.paths[1]!) : getStat(child) ? child : to;
    const directory = presentAt(walk, pathKey(from)) || !getStat(target)?.isFile();
    if (directory) walk.changes.push([pathKey(target), true]);
    walk.changes.push([pathKey(from), false]);
    if (discover && directory) walk.removed.set(pathKey(from), index);
  } else {
    const created = mutation.kind === "create";
    for (const path of paths.map(pathKey)) {
      walk.changes.push([path, created]);
      if (discover && mutation.folder) walk.removed.set(path, index);
    }
  }
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
