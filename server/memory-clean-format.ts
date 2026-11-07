import { createHash } from "node:crypto";
import { z } from "zod";

import type { ArchiveEntry, CleanFile, HistoryRun, MergeParkedInput, RunHeader, SleepItem, UndoRecord } from "./memory-clean-types.ts";

export const HISTORY_FILE = "memory/memory-history.md";
export const POINTER_LINE = "- memory/memory-history.md: lines Sleep retired; search it only for history questions.";
export const POINTER_LINES = [POINTER_LINE, "- memory/memory-history.md: lines memory cleanup retired; search it only for history questions."];
export const hashText = (text: string) => createHash("sha256").update(text).digest("hex");
export const lineHash = (line: string) => hashText(line.trim()).slice(0, 16);
export const isHistory = (file: string) => /^memory\/memory-history(?:-[2-9]\d*|-1\d+)?\.md$/.test(file);
export const cleanFileSchema = z.string().refine((file): file is CleanFile => file === "MEMORY.md" || /^memory\/[\w][\w .-]{0,199}\.md$/.test(file));
const time = z.number().finite().nonnegative();
const runBase = {
  runId: z.string().regex(/^mc-\d{8}-[0-9a-f]{8}$/), at: time,
  files: z.record(cleanFileSchema, z.object({ beforeBytes: time, afterBytes: time, beforeHash: z.string(), afterHash: z.string() })),
};
const runSchema = z.union([
  z.object({ v: z.literal(1), ...runBase, merged: time, replaced: time, moved: time }),
  z.object({ v: z.literal(2), ...runBase, through: time, counts: z.object({ kept: time, merged: time, forgot: time, learned: time, filed: time }) }),
]);
const entrySchema = z.object({
  file: cleanFileSchema, op: z.enum(["merge", "replace", "retire", "split", "remind", "learn", "own", "file"]),
  at: z.array(z.number().int().positive()).max(40), prev: z.array(z.string()), wrote: z.array(z.string()),
  after: z.number().int().nonnegative().optional(), quote: z.string().optional(), lesson: z.boolean().optional(),
  topic: cleanFileSchema.optional(), owned: z.array(z.string().regex(/^[0-9a-f]{16}$/)).optional(),
}).refine((entry) => entry.at.length === entry.prev.length && (entry.at.length > 0 || ["learn", "own", "file"].includes(entry.op)));
const undoSchema = z.object({ v: z.literal(1), runId: z.string(), at: time, restored: time, skipped: time });

function marker(line: string, kind: string): unknown {
  const prefix = `<!-- mc-${kind} `;
  if (!line.startsWith(prefix) || !line.endsWith(" -->")) return null;
  try { return JSON.parse(line.slice(prefix.length, -4)); } catch { return null; }
}

export function parseHistory(text: string): HistoryRun[] {
  const runs: HistoryRun[] = [];
  const lines = text.split("\n");
  let current: HistoryRun | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (line.startsWith("<!-- mc-run ")) {
      const parsed = runSchema.safeParse(marker(line, "run"));
      current = undefined;
      if (parsed.success) {
        current = runs.find((run) => run.header.runId === parsed.data.runId);
        if (!current) { current = { header: parsed.data as RunHeader, entries: [], undo: null }; runs.push(current); }
      }
    } else if (line.startsWith("<!-- mc-entry ")) {
      const parsed = entrySchema.safeParse(marker(line, "entry"));
      if (!current || !parsed.success) continue;
      const count = parsed.data.at.length;
      if (i + count + 2 >= lines.length || lines[i + count + 2]!.trim() !== "") continue;
      current.entries.push({ header: parsed.data as ArchiveEntry["header"], reason: lines[i + 1]!, lines: lines.slice(i + 2, i + 2 + count) });
      i += count + 2;
    } else if (line.startsWith("<!-- mc-undo ")) {
      const parsed = undoSchema.safeParse(marker(line, "undo"));
      const run = parsed.success && runs.find((run) => run.header.runId === parsed.data.runId);
      if (run && parsed.success) run.undo = parsed.data;
    }
  }
  return runs.sort((a, b) => a.header.at - b.header.at || a.header.runId.localeCompare(b.header.runId));
}

export function archiveBlock(header: RunHeader, entries: ArchiveEntry[]): string {
  const sizes = Object.entries(header.files).flatMap(([file, info]) => info ? [`${file} ${info.beforeBytes} to ${info.afterBytes} bytes`] : []).join(", ");
  return [
    `<!-- mc-run ${JSON.stringify(header)} -->`,
    `## ${header.v === 2 ? "Sleep" : "Memory cleanup"} ${new Date(header.at).toISOString().slice(0, 10)} (${header.runId}): ${sizes}`, "",
    ...entries.flatMap((entry) => [`<!-- mc-entry ${JSON.stringify(entry.header)} -->`, entry.reason, ...entry.lines, ""]), "",
  ].join("\n");
}

// the topic side of a file move repeats the MEMORY.md entry, so items skip it
export function runItems(run: HistoryRun): SleepItem[] {
  const plain = (line: string) => line.replace(/\r$/, "");
  return run.entries.filter((entry) => !(entry.header.op === "file" && !entry.header.at.length)).map(({ header, reason, lines }) => {
    const wrote = header.wrote.map(plain).filter((line) => line.trim() && !/^#{1,6}\s/.test(line));
    return { op: header.op, file: header.file, old: lines.map(plain), new: wrote.at(-1) ?? null, reason, ...(header.quote ? { quote: header.quote } : {}) };
  });
}

export function legacyCounts(run: HistoryRun): { merged: number; replaced: number; moved: number } {
  if (run.header.v === 1) return run.header;
  const lines = (...ops: string[]) => run.entries.filter((entry) => ops.includes(entry.header.op));
  return {
    merged: lines("merge").reduce((n, entry) => n + entry.lines.length, 0),
    replaced: lines("replace").length,
    moved: lines("retire", "split", "remind").length,
  };
}

export function undoBlock(record: UndoRecord): string {
  return `<!-- mc-undo ${JSON.stringify(record)} -->\n## Memory cleanup undone ${new Date(record.at).toISOString().slice(0, 10)} (${record.runId})\n\n`;
}

export function appendBlock(text: string, block: string): string {
  return text + (text && !text.endsWith("\n") ? "\n" : "") + block;
}

function historyBlocks(text: string): string[] {
  const lines = text.split("\n");
  let offset = 0;
  const positions = lines.map((line) => { const at = offset; offset += line.length + 1; return at; });
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, "");
    if (runSchema.safeParse(marker(line, "run")).success) starts.push(positions[i]!);
    const entry = entrySchema.safeParse(marker(line, "entry"));
    if (entry.success && lines[i + entry.data.at.length + 2]?.trim() === "") i += entry.data.at.length + 2;
  }
  return starts.map((start, i) => text.slice(start, starts[i + 1]));
}

export function mergeParkedCopy({ file, kept, parked, history }: MergeParkedInput): string | null {
  if (isHistory(file)) {
    const known = new Set(parseHistory(kept).map((run) => run.header.runId));
    const blocks = historyBlocks(parked);
    let result = kept;
    for (const block of blocks) {
      const run = parseHistory(block)[0];
      if (!run) continue;
      if (!known.has(run.header.runId)) { result = appendBlock(result, block); known.add(run.header.runId); }
    }
    const existing = new Map(parseHistory(result).map((run) => [run.header.runId, run]));
    for (const run of parseHistory(parked)) if (run.undo && !existing.get(run.header.runId)?.undo) result = appendBlock(result, undoBlock(run.undo));
    return result;
  }
  if (!history) return null;
  const archived = new Set(parseHistory(history).flatMap((run) => run.entries.filter((entry) => entry.header.file === file).flatMap((entry) => entry.lines)));
  const present = new Set(kept.split("\n"));
  const lines = parked.split("\n");
  if (!lines.some((line) => line.trim() && archived.has(line) && !present.has(line))) return null;
  let result = kept;
  for (const line of lines) {
    if (present.has(line) || archived.has(line)) continue;
    result = appendBlock(result, `${line}\n`);
    present.add(line);
  }
  return result;
}
