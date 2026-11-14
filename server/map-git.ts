import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { MapDiff, MapDiffLine, MapFile } from "../shared/map-pane.ts";

const LIMIT = 512 * 1024;
export const MAP_LINE_LIMIT = 500;
const WHOLE_LIMIT = 5_000;
const WALK_LIMIT = 5_000;
const RANGE_LIMIT = 64;

export function mapGit(cwd: string, args: string[], limit = LIMIT): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", ["--literal-pathspecs", "-C", cwd, ...args], {
      windowsHide: true, timeout: 5_000, maxBuffer: limit,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    }, (error, stdout) => error ? fail(Object.assign(error, { stdout })) : done(stdout));
  });
}

export async function mapHead(cwd: string): Promise<string | null> {
  try {
    const head = (await mapGit(cwd, ["rev-parse", "HEAD"])).trim();
    return /^[a-f0-9]{40,64}$/.test(head) ? head : null;
  } catch { return null; }
}

async function fileText(cwd: string, path: string): Promise<{ text: string; capped: boolean; binary: boolean }> {
  const root = await realpath(cwd);
  const file = await realpath(resolve(cwd, path));
  const inside = relative(root, file);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("File is outside the working folder");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, LIMIT, 0);
    const size = (await handle.stat()).size;
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), capped: size > bytesRead, binary: buffer.subarray(0, bytesRead).includes(0) };
  } finally { await handle.close(); }
}

async function addedFile(cwd: string, path: string): Promise<MapFile> {
  const root = await realpath(cwd);
  const file = await realpath(resolve(cwd, path));
  const inside = relative(root, file);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("File is outside the working folder");
  let added = 0;
  let binary = false;
  let last = -1;
  for await (const buffer of createReadStream(file)) {
    if (buffer.includes(0)) { binary = true; break; }
    for (const byte of buffer) if (byte === 10) added++;
    if (buffer.length) last = buffer[buffer.length - 1];
  }
  if (last !== -1 && last !== 10) added++;
  const result: MapFile = { path, added: binary ? 0 : added, removed: 0 };
  if (binary) result.binary = true;
  return result;
}

export async function mapFiles(cwd: string, base: string, common?: string): Promise<MapFile[]> {
  const [numstat, untracked, { ranges }] = await Promise.all([
    mapGit(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", base, "--"]),
    mapGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
    mapRanges(cwd, [base], RANGE_LIMIT),
  ]);
  // Workers launched at different commits compare on one: each range moves onto the common launch commit's lines.
  const shift = common && common !== base && ranges.size ? await mapRanges(cwd, [common, base], Infinity, [...ranges.keys()]) : undefined;
  const files: MapFile[] = [];
  for (const line of numstat.split("\0").filter(Boolean)) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(line);
    if (match) {
      const file: MapFile = { path: match[3], added: Number(match[1]) || 0, removed: Number(match[2]) || 0 };
      if (match[1] === "-") file.binary = true;
      const lines = ranges.get(file.path)?.map(launch);
      const moved = shift?.ranges.get(file.path);
      // A failed or cut-off move would publish launch lines as common ones.
      if (lines && !file.binary && shift?.complete !== false) file.ranges = moved ? lines.map(([start, end]) => [onto(start, moved, false), onto(end, moved, true)]) : lines;
      files.push(file);
    }
  }
  for (const path of untracked.split("\0").filter(Boolean)) {
    try {
      const file = await addedFile(cwd, path);
      if (!file.binary) file.ranges = [[1, Math.max(1, file.added)]];
      files.push(file);
    } catch {}
  }
  return files;
}

type Hunk = [start: number, count: number, at: number, length: number];

const launch = ([start, count]: Hunk): [number, number] => [start, count ? start + count - 1 : start];

function onto(line: number, hunks: Hunk[], end: boolean) {
  let shift = 0;
  for (const [start, count, at, length] of hunks) {
    if (line < (length ? at : at + 1)) break;
    if (line < at + length) return end && count ? start + count - 1 : start;
    shift += count - length;
  }
  return line + shift;
}

async function mapRanges(cwd: string, revs: string[], limit: number, paths: string[] = []): Promise<{ ranges: Map<string, Hunk[]>; complete: boolean }> {
  let patch = "";
  let complete = true;
  try { patch = await mapGit(cwd, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--unified=0", ...revs, "--", ...paths]); }
  catch (error) {
    complete = false;
    const partial = z.object({ code: z.literal("ERR_CHILD_PROCESS_STDIO_MAXBUFFER"), stdout: z.string() }).safeParse(error);
    if (partial.success) patch = partial.data.stdout;
  }
  const ranges = new Map<string, Hunk[]>();
  let file: Hunk[] | undefined;
  let old = "";
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { file = undefined; old = ""; continue; }
    if (line.startsWith("--- ")) { old = line.slice(4).replace(/\t$/, ""); continue; }
    if (line.startsWith("+++ ")) {
      const path = (line.slice(4) === "/dev/null" ? old : line.slice(4)).replace(/\t$/, "");
      file = /^[ab]\//.test(path) ? [] : undefined;
      if (file) ranges.set(path.slice(2), file);
      continue;
    }
    // Launch-side lines, so two workers off one base compare; a pure insert sits after its line.
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? /.exec(line);
    if (hunk && file && file.length < limit) file.push([Number(hunk[1]), hunk[2] === undefined ? 1 : Number(hunk[2]), Number(hunk[3]), hunk[4] === undefined ? 1 : Number(hunk[4])]);
  }
  return { ranges, complete };
}

export async function mapWalkFiles(cwd: string, limit = WALK_LIMIT): Promise<string[]> {
  const paths: string[] = [];
  const queue = [""];
  let seen = 0;
  while (queue.length && seen < limit) {
    const dir = queue.shift()!;
    const entries = (await readdir(resolve(cwd, dir), { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (++seen > limit) break;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
      else if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") queue.push(path);
    }
  }
  return paths;
}

export async function mapRepoFiles(cwd: string): Promise<string[]> {
  return [...new Set((await mapGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], 32 * 1024 * 1024)).split("\0").filter(Boolean))];
}

interface MapLatest { path?: string; at: number }

export async function latestMapFile(cwd: string, files: readonly MapFile[]): Promise<MapLatest> {
  let latest: MapLatest = { at: 0 };
  for (const file of files) {
    const at = await stat(resolve(cwd, file.path)).then(value => value.mtimeMs, () => 0);
    if (!latest.path || at > latest.at) latest = { path: file.path, at };
  }
  return latest;
}

export function mapDiffLines(patch: string, totalLines?: number, limit = MAP_LINE_LIMIT): MapDiff {
  const lines: MapDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let hunk = false;
  let capped = false;
  for (const text of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      const start = Number(header[1]);
      const count = start - oldLine;
      if (count > 0) lines.push({ kind: "fold", text: "", count, line: newLine });
      oldLine = start;
      newLine = Number(header[2]);
      hunk = true;
      continue;
    }
    if (!hunk || !/^[ +-]/.test(text)) continue;
    if (lines.length >= limit) { capped = true; break; }
    const kind = text[0] === "+" ? "add" : text[0] === "-" ? "remove" : "context";
    lines.push({ kind, text: text.slice(1, 2001), line: kind === "remove" ? oldLine : newLine });
    if (text.length > 2001) capped = true;
    if (kind !== "add") oldLine++;
    if (kind !== "remove") newLine++;
  }
  if (!capped && totalLines !== undefined && totalLines >= newLine) lines.push({ kind: "fold", text: "", count: totalLines - newLine + 1, line: newLine });
  return { lines, capped, binary: /^(?:Binary files |GIT binary patch)/m.test(patch) };
}

export async function mapFileDiff(cwd: string, base: string, file: MapFile, whole = false): Promise<MapDiff> {
  const limit = whole ? WHOLE_LIMIT : MAP_LINE_LIMIT;
  if (file.binary) return { lines: [], binary: true };
  const tracked = (await mapGit(cwd, ["ls-files", "--error-unmatch", "--", file.path]).catch(() => "")).length > 0;
  // A removed tracked file is absent from the index after git rm.
  const existed = tracked || (await mapGit(cwd, ["ls-tree", "-z", base, "--", file.path])).length > 0;
  if (existed) {
    try {
      const [patch, total] = await Promise.all([
        mapGit(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", whole ? "--unified=1000000" : "--unified=3", base, "--", file.path]),
        addedFile(cwd, file.path).then(file => file.added, () => undefined),
      ]);
      // A deleted file's pathspec also matches its replacement directory.
      const own = patch.split("\ndiff --git ", 1)[0];
      // A mode-only change has no hunks, so the whole file is read below.
      if (!whole || total === undefined || /^@@ /m.test(own)) return mapDiffLines(own, total, limit);
    } catch (error) {
      const partial = z.object({ code: z.literal("ERR_CHILD_PROCESS_STDIO_MAXBUFFER"), stdout: z.string() }).safeParse(error);
      if (partial.success) return { ...mapDiffLines(partial.data.stdout.split("\ndiff --git ", 1)[0], undefined, limit), capped: true };
      throw error;
    }
  }
  const added = await fileText(cwd, file.path);
  const lines = added.text.replace(/\n$/, "").split("\n");
  return { binary: added.binary, capped: added.capped || lines.length > limit || lines.some(line => line.length > 2000),
    lines: added.binary || !added.text ? [] : lines.slice(0, limit).map((text, index) => ({ kind: existed ? "context" : "add", text: text.slice(0, 2000), line: index + 1 })) };
}
