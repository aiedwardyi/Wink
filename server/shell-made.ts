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

const PWD = /^\$(?:\{pwd\}|pwd|\(pwd\))(?=[\\/])/i;

// present: made, removed, or null when a command the replay cannot read names it
type DirectoryChange = [path: string, present: boolean | null];
type Mutation = { kind: "create" | "remove" | "move" | "rename"; paths: string[] };
type Walk = { here: string; stack?: string[]; literal?: boolean; asWritten?: boolean; changes: DirectoryChange[] };

const pathWord = (word: string) => word && !word.startsWith("-") && !/[*?]/.test(word) && !/^\w{2,}:\/\//.test(word) && !isNetworkPath(word);
const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const under = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
const presentAt = (walk: Walk, path: string) => walk.changes.findLast(([name, present]) => present === false ? under(path, name) : under(name, path))?.[1];

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
  return { kind: "remove", paths };
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
  let lead = "";
  // whether each open block always runs: a loop, try or finally body does, a branch or a function may not
  const blocks: boolean[] = [];
  const matches = [...command.matchAll(TOKEN)];
  const words = matches.slice(0, MAX_TOKENS).map((match) => {
    const gap = command.slice(end, match.index);
    const first = end === 0 || /[;&|\n]/.test(gap);
    end = match.index + match[0].length;
    const token = match[1] ?? match[2] ?? match[3]!;
    const chained = gap.includes("||");
    if (/^(?:\}|fi|done)$/.test(match[0])) blocks.pop();
    if (first || lead === "}") lead = match[0].toLowerCase();
    const sure = !chained && blocks.every(Boolean);
    if (/^(?:\{|then|do)$/.test(match[0])) blocks.push(!chained && match[0] !== "then" && (first || /^(?:do|try|finally|foreach|for|while)$/.test(lead)));
    return { token, first, sure };
  });
  const mutations = new Map<number, Mutation>();
  for (const [index, word] of words.entries()) {
    if (!word.first || !word.sure) continue;
    const next = words.findIndex((part, offset) => offset > index && part.first);
    const mutation = mutationOf(words.slice(index, next === -1 ? words.length : next).map((part) => part.token));
    if (mutation) mutations.set(index, mutation);
  }
  // A cd is taken as failed only when the disk and the command's own text agree; when unsure it is followed, as written.
  const follows = (walk: Walk, path: string, word: string, index: number) => {
    const stat = getStat(path);
    if (stat?.isFile()) return false;
    if (/^~|[$%]/.test(word)) return true;
    const key = pathKey(path);
    const before = presentAt(walk, key);
    if (stat || matches.length > MAX_TOKENS || (before !== undefined && before !== false)) return true;
    // missing now: left only if nothing later could have removed it
    const later: Walk = { here: path, stack: walk.stack && [...walk.stack], asWritten: true, changes: [] };
    replay([later], index + 1, true);
    return later.changes.some(([name]) => under(key, name));
  };
  const replay = (walks: Walk[], from: number, discover: boolean) => {
    let change = false;
    let push = false;
    let mutating = false;
    for (let index = from; index < words.length; index++) {
      const { token, first, sure } = words[index]!;
      const pop = first && POP_DIR.test(token);
      if (first) {
        const mutation = mutations.get(index);
        mutating = !!mutation;
        if (mutation) for (const walk of walks) recordMutation(walk, mutation, getStat);
        push = PUSH_DIR.test(token);
        change = push || CHANGE_DIR.test(token);
        if (change) {
          if (push) for (const walk of walks) walk.stack?.push(walk.here);
          continue;
        }
      }
      if (!pathWord(token)) continue;
      let resolved = false;
      for (const walk of walks) {
        // a pop in a branch may not run
        if (pop && walk.stack) {
          if (sure) walk.here = walk.stack.pop() ?? walk.here;
          continue;
        }
        const word = walk.literal ? token : token.replace(PWD, ".");
        const path = resolve(walk.here, word);
        if (isNetworkPath(path)) continue;
        resolved = true;
        const [key, here] = [pathKey(path), pathKey(walk.here)];
        if (change) {
          if (walk.asWritten || follows(walk, path, word, index)) walk.here = path;
          else if (push) walk.stack?.pop();
          // only the base walk lists a cd target, and only as the base resolver did
          if (!walk.literal) continue;
        } else if (!mutating && !first && !under(here, key)) walk.changes.push([key, null]);
        const mark = (change ? "cd " : "") + path;
        if (discover || scanned.has(mark)) continue;
        scanned.add(mark);
        const stat = getStat(path);
        if (stat?.isFile() && changed(stat, after)) made.add(path);
        if (stat?.isDirectory()) {
          try {
            // a new folder above the walk is as likely another writer's, so only base's flat listing is kept there
            for (const ref of listed(path, stat, after, !change && (key === here || !under(here, key)))) made.add(ref);
          } catch {}
        }
      }
      if (resolved) change = false;
    }
  };
  const walk = (stack?: string[]): Walk => ({ here: cwd, stack, changes: [] });
  // The first walk reads the command exactly as the base resolver did, so every name base gave is kept.
  replay([{ ...walk(), literal: true, asWritten: true }, walk([]), walk()], 0, false);
  return [...made];
}

function recordMutation(walk: Walk, mutation: Mutation, getStat: typeof statOf) {
  const paths = mutation.paths.map((path) => resolve(walk.here, path));
  if (paths.some(isNetworkPath)) return;
  const [from, to] = paths;
  if (!from) return;
  if (to && (mutation.kind === "move" || mutation.kind === "rename")) {
    const child = join(to, basename(from));
    const target = mutation.kind === "rename" ? resolve(dirname(from), mutation.paths[1]!) : getStat(child) ? child : to;
    // a file moved away leaves no folder behind
    if (presentAt(walk, pathKey(from)) || !getStat(target)?.isFile()) walk.changes.push([pathKey(target), true], [pathKey(from), false]);
  } else {
    for (const path of paths) walk.changes.push([pathKey(path), mutation.kind === "create"]);
  }
}

/** A named folder's changed files and new folders, read up to MAX_ENTRIES untouched entries; past MAX_ENTRIES entries also the folder itself, as base named it, so memory still points where the rest went. */
function listed(folder: string, stat: Stats, after: number, deep: boolean): string[] {
  const created = stat.birthtimeMs >= after;
  const made: string[] = [];
  let entries = 0;
  let untouched = 0;
  const dir = opendirSync(folder);
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      entries++;
      const path = join(folder, entry.name);
      // everything in a folder the command created is new, whatever times the copy kept
      const inner = created ? undefined : statOf(path);
      if (entry.isFile() && (created || (inner && changed(inner, after)))) made.push(path);
      else if (entry.isDirectory() && deep && (created || (inner && inner.birthtimeMs >= after))) made.push(...tree(path));
      else if (++untouched > MAX_ENTRIES) break;
    }
  } finally {
    dir.closeSync();
  }
  return entries > MAX_ENTRIES ? [...made, folder] : made;
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
