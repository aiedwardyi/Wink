import { execFile } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { MapDiff, MapDiffLine, MapFile } from "../shared/map-pane.ts";

const LIMIT = 512 * 1024;
export const MAP_LINE_LIMIT = 500;

export function mapGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", ["--literal-pathspecs", "-C", cwd, ...args], {
      windowsHide: true, timeout: 5_000, maxBuffer: LIMIT,
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

export async function mapFiles(cwd: string, base: string): Promise<MapFile[]> {
  const [numstat, untracked] = await Promise.all([
    mapGit(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--numstat", "-z", base, "--"]),
    mapGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const files: MapFile[] = [];
  for (const line of numstat.split("\0").filter(Boolean)) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(line);
    if (match) {
      const file: MapFile = { path: match[3], added: Number(match[1]) || 0, removed: Number(match[2]) || 0 };
      if (match[1] === "-") file.binary = true;
      files.push(file);
    }
  }
  for (const path of untracked.split("\0").filter(Boolean)) {
    try {
      files.push(await addedFile(cwd, path));
    } catch {}
  }
  return files;
}

export async function mapRepoFiles(cwd: string): Promise<string[]> {
  return [...new Set((await mapGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean))];
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

export function mapDiffLines(patch: string, totalLines?: number): MapDiff {
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
      if (count > 0) lines.push({ kind: "fold", text: "", count });
      oldLine = start;
      newLine = Number(header[2]);
      hunk = true;
      continue;
    }
    if (!hunk || !/^[ +-]/.test(text)) continue;
    if (lines.length >= MAP_LINE_LIMIT) { capped = true; break; }
    const kind = text[0] === "+" ? "add" : text[0] === "-" ? "remove" : "context";
    lines.push({ kind, text: text.slice(1, 2001), line: kind === "remove" ? oldLine : newLine });
    if (text.length > 2001) capped = true;
    if (kind !== "add") oldLine++;
    if (kind !== "remove") newLine++;
  }
  if (!capped && totalLines !== undefined && totalLines >= newLine) lines.push({ kind: "fold", text: "", count: totalLines - newLine + 1 });
  return { lines, capped, binary: /^(?:Binary files |GIT binary patch)/m.test(patch) };
}

export async function mapFileDiff(cwd: string, base: string, file: MapFile): Promise<MapDiff> {
  if (file.binary) return { lines: [], binary: true };
  const tracked = (await mapGit(cwd, ["ls-files", "--error-unmatch", "--", file.path]).catch(() => "")).length > 0;
  // A removed tracked file is absent from the index after git rm.
  const existed = tracked || (await mapGit(cwd, ["ls-tree", "-z", base, "--", file.path])).length > 0;
  if (existed) {
    try {
      const [patch, total] = await Promise.all([
        mapGit(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", base, "--", file.path]),
        addedFile(cwd, file.path).then(file => file.added, () => undefined),
      ]);
      // A deleted file's pathspec also matches its replacement directory.
      return mapDiffLines(patch.split("\ndiff --git ", 1)[0], total);
    } catch (error) {
      const partial = z.object({ code: z.literal("ERR_CHILD_PROCESS_STDIO_MAXBUFFER"), stdout: z.string() }).safeParse(error);
      if (partial.success) return { ...mapDiffLines(partial.data.stdout.split("\ndiff --git ", 1)[0]), capped: true };
      throw error;
    }
  }
  const added = await fileText(cwd, file.path);
  const lines = added.text.replace(/\n$/, "").split("\n");
  return { binary: added.binary, capped: added.capped || lines.length > MAP_LINE_LIMIT || lines.some(line => line.length > 2000),
    lines: added.binary || !added.text ? [] : lines.slice(0, MAP_LINE_LIMIT).map((text, index) => ({ kind: "add", text: text.slice(0, 2000), line: index + 1 })) };
}
