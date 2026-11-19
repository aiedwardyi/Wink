import { opendirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { expect, it, vi } from "vitest";

import { isNetworkPath } from "./bot-cwd.ts";
import { shellMade } from "./shell-made.ts";

type Entry = { dir: boolean; birth: number; mtime: number };
type Copy = "ps" | "sh" | "robo";
type Op = [op: "mkdir" | "write" | "remove" | "move" | "moveAll" | "copy" | "cp" | "tree" | "robocopy", from: string, to?: string];
type Sequence = { name: string; cwd: string; command: string; setup: () => void; effects: (() => void)[]; secondWriter?: () => void };

const disk = vi.hoisted(() => ({ entries: new Map<string, Entry>(), kids: new Map<string, Set<string>>() }));

// oxlint-disable-next-line anti-slop/no-module-mocking -- an in-memory disk gives thousands of replays exact file times.
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const { basename: nameOf } = await import("node:path");
  const entry = (path: string) => {
    const found = disk.entries.get(path);
    if (!found) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return found;
  };
  return {
    ...fs,
    statSync: (path: string) => {
      const { dir, birth, mtime } = entry(path);
      return { isFile: () => !dir, isDirectory: () => dir, birthtimeMs: birth, mtimeMs: mtime };
    },
    opendirSync: (path: string) => {
      if (!entry(path).dir) throw Object.assign(new Error(`ENOTDIR: ${path}`), { code: "ENOTDIR" });
      const children = [...(disk.kids.get(path) ?? [])].sort();
      return {
        readSync: () => {
          const child = children.shift();
          if (child === undefined) return null;
          const { dir } = entry(child);
          return { name: nameOf(child), isFile: () => !dir, isDirectory: () => dir };
        },
        closeSync: () => {},
      };
    },
  };
});

const OLD = 1_500_000_000_000;
const SINCE = 1_700_000_000_000;
const LISTING_BOUND = 512;
const ROOT = join(tmpdir(), "shell-made-sequences");
const SHOTS = Array.from({ length: 11 }, (_, index) => `shot-${String(index + 1).padStart(3, "0")}.png`);
let clock = OLD;

const touch = (path: string) => {
  const entry = disk.entries.get(path);
  if (entry) entry.mtime = clock;
};
const kids = (folder: string) => [...(disk.kids.get(folder) ?? [])].sort();

function link(path: string, entry: Entry) {
  const parent = dirname(path);
  if (parent !== path) {
    mkdir(parent);
    disk.kids.set(parent, (disk.kids.get(parent) ?? new Set<string>()).add(path));
    touch(parent);
  }
  disk.entries.set(path, entry);
}

function mkdir(path: string) {
  if (!disk.entries.has(path)) link(path, { dir: true, birth: clock, mtime: clock });
}

function write(path: string) {
  const entry = disk.entries.get(path);
  if (entry) entry.mtime = clock;
  else link(path, { dir: false, birth: clock, mtime: clock });
}

function remove(path: string) {
  for (const key of disk.entries.keys()) {
    if (key !== path && !key.startsWith(path + sep)) continue;
    disk.entries.delete(key);
    disk.kids.delete(key);
  }
  disk.kids.get(dirname(path))?.delete(path);
  touch(dirname(path));
}

function move(from: string, to: string) {
  const moved = [...disk.entries].filter(([path]) => path === from || path.startsWith(from + sep));
  remove(from);
  for (const [path, entry] of moved) {
    const next = to + path.slice(from.length);
    if (path === from) link(next, entry);
    else {
      disk.entries.set(next, entry);
      disk.kids.set(dirname(next), (disk.kids.get(dirname(next)) ?? new Set<string>()).add(next));
    }
  }
}

// Copy-Item keeps the source's write time and cp stamps a new one; robocopy keeps the creation time too
function copy(from: string, to: string, how: Copy) {
  const source = disk.entries.get(from)!;
  const mtime = how === "sh" ? clock : source.mtime;
  const old = disk.entries.get(to);
  if (old) old.mtime = mtime;
  else link(to, { dir: false, birth: how === "robo" ? source.birth : clock, mtime });
}

function copyAll(from: string, to: string, how: Copy) {
  mkdir(to);
  for (const path of kids(from)) if (!disk.entries.get(path)!.dir) copy(path, join(to, basename(path)), how);
}

function copyTree(from: string, into: string, how: Copy) {
  const to = join(into, basename(from));
  mkdir(to);
  for (const path of kids(from)) {
    if (disk.entries.get(path)!.dir) copyTree(path, to, how);
    else copy(path, join(to, basename(path)), how);
  }
}

// "inputs/shot-*11" is shot-001.png to shot-011.png in inputs
function expand(work: string, spec: string) {
  const [, folder = "", prefix = "", count = "0"] = /^(.+)\/([^/]*)\*(\d+)$/.exec(spec) ?? [];
  if (!folder) return [resolve(work, spec)];
  return Array.from({ length: Number(count) }, (_, index) => join(work, folder, `${prefix}${String(index + 1).padStart(3, "0")}.png`));
}

function apply(work: string, [op, from, to = ""]: Op) {
  const [source, target] = [resolve(work, from), resolve(work, to)];
  if (op === "mkdir") mkdir(source);
  else if (op === "write") for (const path of expand(work, from)) write(path);
  else if (op === "remove") remove(source);
  else if (op === "move") move(source, target);
  else if (op === "moveAll") for (const path of kids(source)) move(path, join(target, basename(path)));
  else if (op === "tree") copyTree(source, target, "ps");
  else copyAll(source, target, op === "cp" ? "sh" : op === "robocopy" ? "robo" : "ps");
}

// the resolver this branch started from (ec12c9d69), frozen: head may not lose a file it named
const BASE_TOKEN = /"([^"\n]+)"|'([^'\n]+)'|([^\s"'|;&<>()]+)/g;
const BASE_CHANGE_DIR = /^(?:cd|chdir|pushd|sl|set-location|push-location)$/i;

const baseChanged = (path: string, since: number): boolean => {
  const stat = statSync(path);
  return stat.isFile() && Math.max(stat.mtimeMs, stat.birthtimeMs) >= since - 2_000;
};

function baseMade(command: string, cwd: string, since: number): string[] {
  const made = new Set<string>();
  let here = cwd;
  let changingDir = false;
  let end = 0;
  for (const match of [...command.matchAll(BASE_TOKEN)].slice(0, 64)) {
    const token = match[1] ?? match[2] ?? match[3]!;
    const first = end === 0 || /[;&|\n]/.test(command.slice(end, match.index));
    end = match.index + match[0].length;
    if (first) changingDir = BASE_CHANGE_DIR.test(token);
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
        if (baseChanged(path, since)) made.add(path);
        continue;
      }
      const dir = opendirSync(path);
      try {
        for (let entry = dir.readSync(), seen = 0; entry; entry = dir.readSync(), seen++) {
          if (seen === LISTING_BOUND) {
            made.add(path);
            break;
          }
          if (entry.isFile() && baseChanged(join(path, entry.name), since)) made.add(join(path, entry.name));
        }
      } finally {
        dir.closeSync();
      }
    } catch {}
  }
  return [...made];
}

// what predates the command (a trailing slash is a folder), the command ({w} is the work folder), what it did
const TABLE: [string, string[], string, Op[]][] = [
  ["left-renamed-ps", ["inputs/shot-*11"], "New-Item -ItemType Directory -Path 'staging' | Out-Null; Set-Location -Path 'staging'; Copy-Item -Path '{w}/inputs/*.png' -Destination '.'; Set-Location -Path '..'; Rename-Item -Path 'staging' -NewName 'real-shots'", [["mkdir", "staging"], ["copy", "inputs", "staging"], ["move", "staging", "real-shots"]]],
  ["left-renamed-bash", ["inputs/shot-*11"], "mkdir -p staging && cd staging && cp {w}/inputs/*.png . && cd .. && mv staging real-shots", [["mkdir", "staging"], ["cp", "inputs", "staging"], ["move", "staging", "real-shots"]]],
  ["left-removed-ps", ["inputs/shot-*11", "real-shots/"], "New-Item -ItemType Directory -Path 'tmp-render' | Out-Null; Set-Location -Path 'tmp-render'; Copy-Item -Path '{w}/inputs/*.png' -Destination '.'; Set-Location -Path '..'; Copy-Item -Path 'tmp-render/*.png' -Destination 'real-shots'; Remove-Item -LiteralPath 'tmp-render' -Recurse -Force", [["mkdir", "tmp-render"], ["copy", "inputs", "tmp-render"], ["copy", "tmp-render", "real-shots"], ["remove", "tmp-render"]]],
  ["left-removed-bash", ["inputs/shot-*11", "real-shots/"], "mkdir -p tmp-render && cd tmp-render && cp {w}/inputs/*.png . && cd .. && cp tmp-render/*.png real-shots/ && rm -rf tmp-render", [["mkdir", "tmp-render"], ["cp", "inputs", "tmp-render"], ["cp", "tmp-render", "real-shots"], ["remove", "tmp-render"]]],
  ["left-existing-renamed-ps", ["inputs/shot-*11", "draft-shots/"], "Set-Location -Path 'draft-shots'; Copy-Item -Path '{w}/inputs/*.png' -Destination '.'; Set-Location -Path '..'; Rename-Item -Path 'draft-shots' -NewName 'real-shots'", [["copy", "inputs", "draft-shots"], ["move", "draft-shots", "real-shots"]]],
  ["variable-then-up-ps", ["inputs/shot-*11", "phase-a/real-shots/", "summary/"], "$phase = 'phase-a'; Set-Location -Path $phase; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'; Set-Location -Path '..'; Copy-Item -Path '{w}/inputs/*.png' -Destination 'summary'", [["copy", "inputs", "phase-a/real-shots"], ["copy", "inputs", "summary"]]],
  ["variable-then-up-bash", ["inputs/shot-*11", "phase-a/real-shots/", "summary/"], 'out=phase-a; cd "$out" && cp {w}/inputs/*.png real-shots/ && cd .. && cp {w}/inputs/*.png summary/', [["cp", "inputs", "phase-a/real-shots"], ["cp", "inputs", "summary"]]],
  ["removed-then-sibling-ps", ["inputs/shot-*11", "phase-b/real-shots/", "tmp-build/"], "Set-Location -Path 'tmp-build'; Copy-Item -Path '{w}/inputs/*.png' -Destination '.'; Set-Location -Path '../phase-b'; Copy-Item -Path '../tmp-build/*.png' -Destination 'real-shots'; Remove-Item -LiteralPath '../tmp-build' -Recurse -Force", [["copy", "inputs", "tmp-build"], ["copy", "tmp-build", "phase-b/real-shots"], ["remove", "tmp-build"]]],
  ["left-moved-out-bash", ["inputs/shot-*11", "real-shots/", "render/"], "cd render && cp {w}/inputs/*.png . && cd .. && mv render/*.png real-shots/ && rmdir render", [["cp", "inputs", "render"], ["moveAll", "render", "real-shots"], ["remove", "render"]]],
  ["pushed-then-removed-ps", ["inputs/shot-*11", "real-shots/", "phase-b/real-shots/"], "Set-Location -Path 'phase-b'; New-Item -ItemType Directory -Path 'tmp-render' | Out-Null; Set-Location -Path 'tmp-render'; Copy-Item -Path '{w}/inputs/*.png' -Destination '.'; Set-Location -Path '..'; Copy-Item -Path 'tmp-render/*.png' -Destination 'real-shots'; Remove-Item -LiteralPath 'tmp-render' -Recurse -Force; Set-Location -Path '..'; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'", [["mkdir", "phase-b/tmp-render"], ["copy", "inputs", "phase-b/tmp-render"], ["copy", "phase-b/tmp-render", "phase-b/real-shots"], ["remove", "phase-b/tmp-render"], ["copy", "inputs", "real-shots"]]],
  ["control-left-kept-ps", ["inputs/shot-*11", "real-shots/", "tmp-render/"], "Set-Location -Path 'tmp-render'; Copy-Item -Path '{w}/inputs/*.png' -Destination '.'; Set-Location -Path '..'; Copy-Item -Path 'tmp-render/*.png' -Destination 'real-shots'", [["copy", "inputs", "tmp-render"], ["copy", "tmp-render", "real-shots"]]],
  ["big-folder-new-sorts-first", ["real-shots/z-old-*513", "inputs/a-new-*11"], "Copy-Item -Path '{w}/inputs/*.png' -Destination '{w}/real-shots'", [["copy", "inputs", "real-shots"]]],
  ["big-folder-rewrite-in-place", ["real-shots/a-old-*513", "real-shots/z-shot-*11"], "Get-ChildItem -LiteralPath 'real-shots' -Filter 'z-shot-*' | ForEach-Object { Set-Content -LiteralPath $_.FullName -Value 'rendered again' }", [["write", "real-shots/z-shot-*11"]]],
  ["nested-push-pop", ["inputs/shot-*11", "review/real-shots/", "review/draft/real-shots/"], "Push-Location -Path '{w}/review'; Push-Location -Path 'draft'; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'; Pop-Location; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'; Pop-Location", [["copy", "inputs", "review/draft/real-shots"], ["copy", "inputs", "review/real-shots"]]],
  ["set-location-revisit", ["inputs/shot-*11", "phase-a/real-shots/", "phase-b/real-shots/"], "Set-Location -Path '{w}/phase-a'; Set-Location -Path '{w}/phase-b'; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'; Set-Location -Path '{w}/phase-a'; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'", [["copy", "inputs", "phase-b/real-shots"], ["copy", "inputs", "phase-a/real-shots"]]],
  ["set-location-revisit-relative", ["inputs/shot-*11", "phase-a/real-shots/", "phase-b/real-shots/"], "Set-Location -Path 'phase-a'; Set-Location -Path '../phase-b'; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'; Set-Location -Path '../phase-a'; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'", [["copy", "inputs", "phase-b/real-shots"], ["copy", "inputs", "phase-a/real-shots"]]],
  ["inspect-previous-export-after-location", ["inputs/shot-*11", "phase-a/real-shots/", "phase-b/real-shots/"], "Set-Location -Path '{w}/phase-a'; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'; Set-Location -Path '{w}/phase-b'; Get-ChildItem -LiteralPath '{w}/phase-a' | Out-Null; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'", [["copy", "inputs", "phase-a/real-shots"], ["copy", "inputs", "phase-b/real-shots"]]],
  ["recursive-existing-subtree", ["source/album/day-one/shot-*11", "export/album/day-one/"], "Copy-Item -Path '{w}/source/album' -Recurse -Force -Destination '{w}/export'", [["tree", "source/album", "export"]]],
  ["recursive-new-subtree", ["source/album/day-one/shot-*11", "real-shots/"], "Copy-Item -Path '{w}/source/album' -Recurse -Destination '{w}/real-shots'", [["tree", "source/album", "real-shots"]]],
  ["git-mv-new-path", ["staged/day-one/shot-*11"], "git -c core.hooksPath=NUL -c core.autocrlf=false mv -- staged shipped; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }", [["move", "staged", "shipped"]]],
  ["git-checkout-flat-513", ["outside-checkout/shot-*513"], "git -c core.hooksPath=NUL -c core.autocrlf=false checkout -- 'release output'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }", [["write", "release output/shot-*513"]]],
  ["git-checkout-nested-513", ["outside-checkout/day-one/shot-*513"], "git -c core.hooksPath=NUL -c core.autocrlf=false checkout -- 'release output'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }", [["write", "release output/day-one/shot-*513"]]],
  ["existing-513-plus-11", ["real-shots/a-old-*513", "inputs/z-new-*11"], "Copy-Item -Path '{w}/inputs/*.png' -Destination '{w}/real-shots'", [["copy", "inputs", "real-shots"]]],
  ["robocopy-existing-empty", ["inputs/shot-*11", "existing/"], "robocopy '{w}/inputs' '{w}/existing' /E /R:0 /W:0 /NJH /NJS /NP /NFL /NDL; if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }; exit 0", [["robocopy", "inputs", "existing"]]],
  ["robocopy-new", ["inputs/shot-*11"], "robocopy '{w}/inputs' '{w}/first-export' /E /R:0 /W:0 /NJH /NJS /NP /NFL /NDL; if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }; exit 0", [["robocopy", "inputs", "first-export"]]],
  ["robocopy-existing-populated", ["inputs/shot-*11", "inputs/new-shot-*11", "existing/shot-*11"], "robocopy '{w}/inputs' '{w}/existing' /E /R:0 /W:0 /NJH /NJS /NP /NFL /NDL; if ($LASTEXITCODE -ge 8) { exit $LASTEXITCODE }; exit 0", [["robocopy", "inputs", "existing"]]],
  ["push-pop", ["source/shot-*11", "phase-a/", "real-shots/"], "Push-Location -LiteralPath '{w}/phase-a'; Pop-Location; Copy-Item -Path '{w}/source/*.png' -Destination 'real-shots'", [["copy", "source", "real-shots"]]],
  ["flat-copy-513", ["source/shot-*513", "real-shots/"], "Copy-Item -Path '{w}/source/*.png' -Destination '{w}/real-shots'", [["copy", "source", "real-shots"]]],
  ["simple-relative", ["source/shot-*11", "real-shots/"], "Set-Location -LiteralPath '{w}/real-shots'; Copy-Item -Path '{w}/source/*.png' -Destination '.'", [["copy", "source", "real-shots"]]],
  ["rebuild-ps", ["inputs/shot-*11", "real-shots/", "stage/"], "Remove-Item -LiteralPath 'stage' -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item -Path '{w}/inputs' -Destination 'stage' -Recurse; Set-Location -Path 'stage'; Copy-Item -Path '*.png' -Destination '../real-shots'", [["remove", "stage"], ["copy", "inputs", "stage"], ["copy", "stage", "real-shots"]]],
  ["rebuild-fresh-ps", ["inputs/shot-*11", "real-shots/"], "Remove-Item -LiteralPath 'stage' -Recurse -Force -ErrorAction SilentlyContinue; Copy-Item -Path '{w}/inputs' -Destination 'stage' -Recurse; Set-Location -Path 'stage'; Copy-Item -Path '*.png' -Destination '../real-shots'", [["copy", "inputs", "stage"], ["copy", "stage", "real-shots"]]],
  ["rebuild-git-init-bash", ["inputs/shot-*11", "real-shots/", "stage/"], "rm -rf stage; git init -q stage; cd stage; cp {w}/inputs/*.png ../real-shots/", [["remove", "stage"], ["mkdir", "stage/.git"], ["cp", "inputs", "real-shots"]]],
  ["clean-assign-ps", ["inputs/shot-*11", "real-shots/", "out/"], "Remove-Item 'out' -Recurse -Force -ErrorAction SilentlyContinue\n$null = New-Item -ItemType Directory -Path 'out'\nSet-Location 'out'\nCopy-Item -Path '{w}/inputs/*.png' -Destination '../real-shots'", [["remove", "out"], ["mkdir", "out"], ["copy", "inputs", "real-shots"]]],
  ["remove-absolute-ps", ["inputs/shot-*11", "real-shots/", "phase-a/"], "Remove-Item '{w}/phase-a' -Recurse -Force; Copy-Item -Path '{w}/inputs' -Destination '{w}/phase-a' -Recurse; Set-Location 'phase-a'; Copy-Item -Path '*.png' -Destination '../real-shots'", [["remove", "phase-a"], ["copy", "inputs", "phase-a"], ["copy", "phase-a", "real-shots"]]],
  ["remove-not-run-bash", ["inputs/shot-*11", "stage/real-shots/"], "[ -f stage/.stale ] && rm -rf stage\ncd stage\ncp {w}/inputs/*.png real-shots/", [["cp", "inputs", "stage/real-shots"]]],
  ["case-arm-not-taken-bash", ["inputs/shot-*11", "phase-a/real-shots/"], 'case "$1" in\n  clean)\n    rm -rf phase-a\n    ;;\nesac\ncd phase-a\ncp {w}/inputs/*.png real-shots/', [["cp", "inputs", "phase-a/real-shots"]]],
  ["remove-include-ps", ["inputs/shot-*11", "stage/real-shots/"], "Remove-Item -Path 'stage' -Include *.tmp -Recurse; Set-Location -Path 'stage'; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'", [["copy", "inputs", "stage/real-shots"]]],
  ["rmdir-not-empty-bash", ["inputs/shot-*11", "stage/real-shots/"], "rmdir stage 2> /dev/null; cd stage; cp {w}/inputs/*.png real-shots/", [["cp", "inputs", "stage/real-shots"]]],
  ["rename-fails-ps", ["inputs/shot-*11", "stage/real-shots/", "phase-b/"], "Rename-Item -Path 'stage' -NewName 'phase-b' -ErrorAction SilentlyContinue; Set-Location -Path 'stage'; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'", [["copy", "inputs", "stage/real-shots"]]],
];

function row([name, old, command, ops]: (typeof TABLE)[number]): Sequence {
  const work = join(ROOT, name, "work");
  const setup = () => {
    mkdir(work);
    for (const spec of old) for (const path of expand(work, spec)) (spec.endsWith("/") ? mkdir : write)(path);
  };
  return { name, cwd: work, command: command.replaceAll("{w}", work.replaceAll(sep, "/")), setup, effects: ops.map((op) => () => apply(work, op)) };
}

// random sequences of the moves that broke this resolver before: cd, push/pop, listings, reads, copies, renames, removals, variable targets
function generate(seed: number, count: number): Sequence[] {
  let state = seed >>> 0;
  const rnd = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const chance = (odds: number) => rnd() < odds;

  const sequence = (name: string, ps: boolean): Sequence => {
    const family = pick(["plain", "plain", "plain", "plain", "plain", "plain", "plain", "git", "big", "big"]);
    const work = join(ROOT, name, "work");
    const outside = join(ROOT, name, "launch outside");
    const folders = [work, join(work, "phase-a"), join(work, "phase-b"), join(work, "phase-a", "draft"), outside, join(outside, "phase-c")];
    const inputs = join(work, "inputs");
    const album = join(work, "album");
    const staged = family === "git" ? join(work, "staged") : undefined;
    const archive = family === "big" ? join(work, "archive") : undefined;
    const prefix = archive && (chance(0.5) ? "a-old-" : "z-old-");
    const setup = () => {
      for (const folder of folders) mkdir(join(folder, "real-shots"));
      for (const shot of SHOTS) for (const folder of [inputs, join(album, "day-one"), ...(staged ? [join(staged, "day-one")] : [])]) write(join(folder, shot));
      write(join(work, "notes.md"));
      write(join(outside, "notes.md"));
      if (archive) for (let index = 0; index < 520; index++) write(join(archive, `${prefix}${String(index).padStart(3, "0")}.png`));
    };
    const dirs = new Set([...folders, ...folders.map((folder) => join(folder, "real-shots")), inputs, album]);
    const shotsLike = new Set(folders.map((folder) => join(folder, "real-shots")));
    if (archive) {
      dirs.add(archive);
      shotsLike.add(archive);
    }
    const madeDirs: string[] = [];
    const stack: string[] = [];
    const steps: string[] = [];
    const effects: (() => void)[] = [];
    let cwd = work;
    let previous: string | undefined;
    let moved = false;
    let serial = 0;
    const add = (step: string, effect?: () => void) => {
      steps.push(step);
      if (effect) effects.push(effect);
    };
    const q = (text: string) => {
      if (!/[\s']/.test(text) && chance(0.35)) return text;
      if (ps) return chance(0.75) ? `'${text}'` : `"${text}"`;
      return chance(0.6) ? `"${text}"` : `'${text}'`;
    };
    const spell = (target: string, rel?: boolean) => {
      let text = target;
      if (rel === true || (rel !== false && chance(0.55))) {
        text = relative(cwd, target) || ".";
        if (!text.startsWith("..") && text !== "." && chance(0.2)) text = "." + sep + text;
      }
      if (!ps || chance(0.2)) text = text.replaceAll("\\", "/");
      if (text !== "." && !text.endsWith("..") && chance(0.08)) text += ps ? sep : "/";
      return text;
    };
    const ref = (target: string, rel?: boolean) => q(spell(target, rel));
    const glob = (target: string) => {
      const text = spell(target);
      const slash = text.includes("/") && !text.includes("\\") ? "/" : ps ? sep : "/";
      return q(text.replace(/[\\/]$/, "") + slash + "*.png");
    };
    const within = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
    // a remake the replay cannot read, and a remove or rename it reads that leaves the folder in place
    const remake = (target: string): [string, () => void] => {
      const to = ref(target);
      const made = () => mkdir(target);
      const copied = () => copyAll(inputs, target, ps ? "ps" : "sh");
      const git = () => mkdir(join(target, ".git"));
      return pick<[string, () => void]>(ps
        ? [[`Copy-Item -Path ${ref(inputs)} -Destination ${to} -Recurse`, copied], [`git init -q ${to} | Out-Null`, git], [`$null = New-Item -ItemType Directory -Path ${to}`, made], [`ni -ItemType Directory ${to} | Out-Null`, made], [`if (-not (Test-Path ${to})) { New-Item -ItemType Directory -Path ${to} | Out-Null }`, made], [`foreach ($d in ${to}) { mkdir $d | Out-Null }`, made]]
        : [[`cp -r ${ref(inputs)} ${to}`, copied], [`git init -q ${to}`, git], [`if [ ! -d ${to} ]; then mkdir -p ${to}; fi`, made], [`for d in ${to}; do mkdir -p "$d"; done`, made]]);
    };
    const kept = (target: string) => {
      const to = ref(target);
      return pick(ps
        ? [`Remove-Item -Path ${to} -Include *.tmp -Recurse`, `Rename-Item -Path ${to} -NewName notes.md -ErrorAction SilentlyContinue`, `if (Test-Path ${ref(join(target, ".stale"))}) { Remove-Item ${to} -Recurse -Force }`]
        : [`[ -f ${ref(join(target, ".stale"))} ] && rm -rf ${to} || true`, `rmdir ${to} 2> /dev/null || true`, `mv ${to} ${ref(join(dirname(target), "notes.md"))} 2> /dev/null || true`, `case "$1" in\n  clean)\n    rm -rf ${to}\n    ;;\nesac`]);
    };
    const enter = (target: string) => {
      add((ps ? "Set-Location " : "cd ") + ref(target));
      previous = cwd;
      cwd = target;
    };
    const free = (dir: string) => !within(dir, cwd) && !stack.some((location) => within(dir, location));
    const targets = () => [...dirs].filter((dir) => dir !== cwd && dir !== inputs && dir !== album);
    const live = (set: Set<string>) => [...set].filter((dir) => dirs.has(dir));
    const length = 2 + Math.floor(rnd() * 8);
    for (let index = 0; index < length; index++) {
      const roll = rnd();
      if (staged && !moved && chance(0.3)) {
        moved = true;
        const to = join(pick([work, work, cwd]), "shipped");
        add(pick(["git mv -- ", "git mv "]) + ref(staged) + " " + ref(to), () => move(staged, to));
        continue;
      }
      if (roll < 0.015 && previous && dirs.has(previous)) {
        add(ps ? "Set-Location -" : "cd - > /dev/null");
        [cwd, previous] = [previous, cwd];
      } else if (roll < 0.03 && ps) {
        add("Push-Location");
        stack.push(cwd);
      } else if (roll < 0.2) {
        previous = cwd;
        const target = pick(targets());
        add((ps ? pick(["Set-Location", "Set-Location -Path", "Set-Location -LiteralPath", "cd", "sl", "chdir"]) : "cd") + " " + ref(target));
        cwd = target;
      } else if (roll < 0.3) {
        const target = pick(targets());
        add((ps ? pick(["Push-Location", "Push-Location -Path", "Push-Location -LiteralPath", "pushd"]) : "pushd") + " " + ref(target) + (ps ? "" : " > /dev/null"));
        stack.push(cwd);
        cwd = target;
      } else if (roll < 0.4) {
        if (!stack.length && !chance(0.1)) {
          index--;
          continue;
        }
        add(ps ? pick(["Pop-Location", "popd"]) : "popd > /dev/null");
        cwd = stack.pop() ?? cwd;
      } else if (roll < 0.52) {
        const target = pick([...dirs]);
        add(ps ? pick(["Get-ChildItem -LiteralPath", "Get-ChildItem -Path", "Get-ChildItem", "ls", "dir", "Get-ChildItem -Recurse"]) + " " + ref(target) + " | Out-Null" : pick(["ls", "ls -la", "find"]) + " " + ref(target) + " > /dev/null");
      } else if (roll < 0.57) {
        const target = pick([join(work, "notes.md"), join(outside, "notes.md"), join(inputs, SHOTS[0]!)]);
        add(ps ? pick(["Get-Content", "Get-Content -LiteralPath", "Test-Path"]) + " " + ref(target) + " | Out-Null" : pick(["cat", "head -1", "test -f"]) + " " + ref(target) + " > /dev/null");
      } else if (roll < 0.72) {
        const local = join(cwd, "real-shots");
        let dest: string;
        if (shotsLike.has(cwd) && chance(0.5)) dest = cwd;
        else if (dirs.has(local) && chance(0.65)) dest = local;
        else dest = pick(live(shotsLike));
        const to = dest === cwd ? q(".") : ref(dest, dest === local ? chance(0.85) : undefined);
        const copied = () => copyAll(inputs, dest, ps ? "ps" : "sh");
        if (ps) add(pick([`Copy-Item -Path ${glob(inputs)} -Destination ${to}`, `Copy-Item ${glob(inputs)} ${to}`, `Copy-Item -Destination ${to} -Path ${glob(inputs)}`, `cp ${glob(inputs)} ${to}`]), copied);
        else add(`cp ${spell(inputs).replace(/\/$/, "").replace(/ /g, "\\ ")}/*.png ${to}`, copied);
      } else if (roll < 0.75) {
        const reused = madeDirs.filter((dir) => dirs.has(dir) && free(dir));
        const target = reused.length && chance(0.5) ? pick(reused) : join(cwd, `stage-${++serial}`);
        add(ps ? `Remove-Item -LiteralPath ${ref(target)} -Recurse -Force -ErrorAction SilentlyContinue` : `rm -rf ${ref(target)}`, () => remove(target));
        for (const set of [dirs, shotsLike]) for (const dir of set) if (within(target, dir)) set.delete(dir);
        add(...remake(target));
        for (const set of [dirs, shotsLike]) set.add(target);
        madeDirs.push(target);
        enter(target);
      } else if (roll < 0.78) {
        const target = pick([join(work, "phase-a"), join(work, "phase-b"), join(outside, "phase-c")]);
        add(kept(target));
        enter(target);
      } else if (roll < 0.84) {
        const dest = pick(live(shotsLike));
        add(ps ? `Copy-Item -Path ${ref(album)} -Recurse -Destination ${ref(dest)}` : `cp -r ${ref(album)} ${ref(dest)}`, () => copyTree(album, dest, ps ? "ps" : "sh"));
      } else if (roll < 0.89) {
        const parent = pick([cwd, cwd, pick(folders)]);
        if (!dirs.has(parent)) {
          index--;
          continue;
        }
        const made = join(parent, `export-${++serial}`);
        add(ps ? pick([`New-Item -ItemType Directory -Path ${ref(made)} | Out-Null`, `mkdir ${ref(made)} | Out-Null`]) : `mkdir -p ${ref(made)}`, () => mkdir(made));
        dirs.add(made);
        shotsLike.add(made);
        madeDirs.push(made);
      } else if (roll < 0.93) {
        const made = join(pick([cwd, pick([...dirs])]), `note-${++serial}.md`);
        add(ps ? pick([`Set-Content -Path ${ref(made)} -Value 'x'`, `'x' | Out-File ${ref(made)}`]) : `echo x > ${ref(made)}`, () => write(made));
      } else if (roll < 0.965) {
        const movable = madeDirs.filter((dir) => dirs.has(dir) && free(dir));
        if (!movable.length) {
          index--;
          if (steps.length > 12) break;
          continue;
        }
        const from = pick(movable);
        const to = join(dirname(from), `final-${++serial}`);
        const renamed = () => move(from, to);
        if (!ps) add(`mv ${ref(from)} ${ref(to)}`, renamed);
        else add(chance(0.5) ? `Rename-Item ${ref(from)} ${q(`final-${serial}`)}` : `Move-Item ${ref(from)} ${ref(to)}`, renamed);
        for (const set of [dirs, shotsLike]) {
          for (const dir of set) {
            if (!within(from, dir)) continue;
            set.delete(dir);
            set.add(to + dir.slice(from.length));
          }
        }
        madeDirs.push(to);
      } else if (roll < 0.972) {
        const gone = madeDirs.filter((dir) => dirs.has(dir) && free(dir));
        if (!gone.length) {
          index--;
          if (steps.length > 12) break;
          continue;
        }
        const target = pick(gone);
        add(ps ? `Remove-Item -LiteralPath ${ref(target)} -Recurse -Force` : `rm -rf ${ref(target)}`, () => remove(target));
        for (const set of [dirs, shotsLike]) for (const dir of set) if (within(target, dir)) set.delete(dir);
      } else if (roll < 0.985) {
        const target = pick(targets());
        add(ps ? `$d = '${target}'; Set-Location $d` : `d='${target.replaceAll("\\", "/")}'; cd "$d"`);
        cwd = target;
      } else {
        if (!ps) {
          index--;
          continue;
        }
        const dest = pick(live(shotsLike));
        add(`robocopy ${ref(inputs)} ${ref(dest)} /E /R:0 /W:0 /NJH /NJS /NP /NFL /NDL | Out-Null`, () => copyAll(inputs, dest, "robo"));
      }
    }
    const joiner = ps ? pick(["; ", "; ", "\n"]) : pick(["; ", " && ", "\n"]);
    // another bot writes beside the command; pops and variable cds keep a second walk that may list its files
    const traced = !steps.some((step) => /^(?:push|pop|\$d |d=|cd - |set-location -$)/i.test(step));
    const secondWriter = () => {
      write(join(dirname(work), "their-notes.md"));
      write(join(dirname(work), "other-bot-out", "their-001.png"));
      write(join(dirname(work), "real-shots", "their-001.png"));
      for (const folder of folders.flatMap((folder) => [folder, join(folder, "real-shots")])) write(join(folder, "their-002.png"));
    };
    return { name, cwd: work, command: steps.join(joiner), setup, effects, secondWriter: traced ? secondWriter : undefined };
  };
  return Array.from({ length: count }, (_, index) => sequence(`s${seed}-${String(index).padStart(4, "0")}`, index % 3 !== 2));
}

function generateControlFlow(): Sequence[] {
  return Array.from({ length: 120 }, (_, index) => {
    const ps = index % 2 === 0;
    const scenario = Math.floor(index / 2) % 3;
    const phase = `phase-${index}`;
    const other = `other-${index}`;
    const copy = (to: string) => ps
      ? `Copy-Item -Path '{w}/inputs/*.png' -Destination '${to}'`
      : `cp '{w}/inputs/'*.png '${to}'`;
    const push = (to: string) => ps ? `Push-Location '${to}'` : `pushd '${to}' > /dev/null`;
    const pop = ps ? "Pop-Location" : "popd > /dev/null";
    const guard = index % 4 < 2 ? (ps ? "if ($false) {" : "if false; then")
      : (ps ? "if ($LASTEXITCODE -ne 0) {" : "command -v git > /dev/null || {");
    const endGuard = ps || guard.endsWith("{") ? "}" : "fi";
    const inputs = ["inputs/shot-*11", `${phase}/real-shots/`, `${other}/real-shots/`];
    const op = (to: string): Op => [ps ? "copy" : "cp", "inputs", to];
    const check = ps ? "git --version | Out-Null" : "command -v git > /dev/null";

    if (scenario === 0) {
      const steps = [push(phase), check, guard, pop, "exit 1", endGuard, copy("real-shots"), pop];
      return row([`skipped-pop-${index}`, inputs, steps.join("\n"), [op(`${phase}/real-shots`)]]);
    }
    if (scenario === 1) {
      const fail = ps ? "Set-Location 'missing' -ErrorAction SilentlyContinue" : "cd missing 2> /dev/null";
      const steps = [ps ? `Set-Location '${phase}'` : `cd '${phase}'`, fail, push(`{w}/${other}`), copy("real-shots"), pop, copy(`../${phase}/real-shots`)];
      return row([`failed-cd-${index}`, inputs, steps.join("\n"), [op(`${other}/real-shots`), op(`${phase}/real-shots`)]]);
    }
    const loop = ps ? "foreach ($i in 1, 2) {" : "for i in 1 2; do";
    const steps = [loop, push(phase), check, guard, pop, "exit 1", endGuard, copy("real-shots"), pop, ps ? "}" : "done"];
    return row([`loop-${index}`, inputs, steps.join("\n"), [op(`${phase}/real-shots`), op(`${phase}/real-shots`)]]);
  });
}

const files = () => new Map([...disk.entries].filter(([, entry]) => !entry.dir).map(([path, entry]) => [path, `${entry.birth}:${entry.mtime}`]));

// a folder too big to list is named itself, never with a short count
const tooBig = (refs: Set<string>, path: string) =>
  [...refs].some((folder) => path.startsWith(folder + sep) && [...disk.entries.keys()].filter((key) => key.startsWith(folder + sep)).length > LISTING_BOUND);

function replay({ name, cwd, command, setup, effects, secondWriter }: Sequence) {
  disk.entries.clear();
  disk.kids.clear();
  clock = OLD;
  setup();
  const before = files();
  clock = SINCE + 1_000;
  for (const effect of effects) effect();
  const made = new Set([...files()].filter(([path, stamp]) => before.get(path) !== stamp).map(([path]) => path));
  secondWriter?.();
  const base = new Set(baseMade(command, cwd, SINCE));
  const head = new Set(shellMade(command, cwd, SINCE));
  const kept = [...made].filter((path) => base.has(path));
  const extra = [...head].filter((path) => disk.entries.get(path)?.dir === false && !base.has(path) && !made.has(path));
  return { name, command, kept: kept.length, lost: kept.filter((path) => !head.has(path) && !tooBig(head, path)), missing: [...made].filter((path) => !head.has(path)), extra };
}

const SECOND_WRITER = [
  ...["left-removed-ps", "left-existing-renamed-ps", "left-removed-bash"].map((name) => {
    const sequence = row(TABLE.find(([id]) => id === name)!);
    return { ...sequence, name: `second-writer-${name}`, secondWriter: () => {
      for (let index = 0; index < 6; index++) write(join(dirname(sequence.cwd), `other-${index}.log`));
    } };
  }),
  ...[true, false].map((ps) => {
    const sequence = row([
      `guard-pop-second-writer-${ps ? "ps" : "bash"}`,
      ["inputs/shot-*11", "phase/real-shots/", "real-shots/"],
      ps
        ? "Push-Location 'phase'\ngit --version | Out-Null\nif ($LASTEXITCODE -ne 0) {\n  Pop-Location\n  exit 1\n}\nCopy-Item '{w}/inputs/*.png' 'real-shots'\nPop-Location"
        : "pushd phase > /dev/null\ncommand -v git > /dev/null || {\n  popd > /dev/null\n  exit 1\n}\ncp ../inputs/*.png real-shots\npopd > /dev/null",
      [[ps ? "copy" : "cp", "inputs", "phase/real-shots"]],
    ]);
    return { ...sequence, secondWriter: () => write(join(sequence.cwd, "real-shots", "their-output.png")) };
  }),
];

const CONTROL_FLOW = generateControlFlow();
const GROUPS: [string, Sequence[]][] = [["the gate's cases", TABLE.map(row)], ...[11, 12, 13, 14, 21, 22, 23].map((seed): [string, Sequence[]] => [`seed ${seed}`, generate(seed, 600)]), ["control flow", CONTROL_FLOW], ["second writers", SECOND_WRITER]];

it("replays 4364 sequences", () => {
  expect(GROUPS.flatMap(([, sequences]) => sequences)).toHaveLength(4364);
});

it.each(GROUPS)("keeps base files and excludes extra files the command never touched in %s", (_, sequences) => {
  const runs = sequences.map(replay);
  // a replay the mock missed would name nothing on either side and pass
  expect(runs.reduce((sum, run) => sum + run.kept, 0)).toBeGreaterThan(0);
  expect(runs.filter((run) => run.lost.length).map(({ name, command, lost }) => ({ name, command, lost }))).toEqual([]);
  expect(runs.filter((run) => run.extra.length).map(({ name, command, extra }) => ({ name, command, extra }))).toEqual([]);
});

it.each([
  ["removed", "mkdir scratch; rmdir scratch; cd scratch 2>/dev/null; cp inputs/*.png .", [["mkdir", "scratch"], ["remove", "scratch"], ["cp", "inputs", "."]]],
  ["renamed", "mkdir scratch; mv scratch moved; cd scratch 2>/dev/null; cp inputs/*.png .", [["mkdir", "scratch"], ["move", "scratch", "moved"], ["cp", "inputs", "."]]],
  ["renamed using named arguments", "New-Item -ItemType Directory scratch; Rename-Item -NewName moved -LiteralPath scratch; Set-Location scratch -ErrorAction SilentlyContinue; Copy-Item inputs/*.png .", [["mkdir", "scratch"], ["move", "scratch", "moved"], ["copy", "inputs", "."]]],
] satisfies [string, string, Op[]][])("stays put when the cd target was already %s", (name, command, ops) => {
  const run = replay(row([name, ["inputs/shot-*11"], command, ops]));
  expect(run.missing).toEqual([]);
});

it("keeps outputs after a failed cd to a file that is later renamed", () => {
  const run = replay(row([
    "file-later-renamed",
    ["inputs/shot-*11", "old.txt"],
    "cd old.txt 2>/dev/null; cp inputs/*.png .; echo changed > '{w}/old.txt'; mv '{w}/old.txt' '{w}/new.txt'",
    [["cp", "inputs", "."], ["write", "old.txt"], ["move", "old.txt", "new.txt"]],
  ]));
  expect(run.missing).toEqual([]);
});

it("keeps every file made after a skipped pop or a failed cd in control flow", () => {
  const missing = CONTROL_FLOW.map(replay).filter((run) => run.missing.length);
  expect(missing.map(({ name, missing }) => ({ name, missing: missing.length }))).toEqual([]);
});

it.each(["missing", "notes.md"])("keeps the current location when cd to %s may have failed", (target) => {
  const run = replay(row([
    `failed-location-${target}`,
    ["inputs/shot-*11", "real-shots/", "notes.md"],
    `Set-Location '${target}' -ErrorAction SilentlyContinue; Copy-Item -Path '{w}/inputs/*.png' -Destination 'real-shots'`,
    [["copy", "inputs", "real-shots"]],
  ]));
  expect(run.missing).toEqual([]);
});
