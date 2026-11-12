import { hashText, lineHash, POINTER_LINES, HISTORY_FILE } from "./memory-clean-format.ts";
import type { ArchiveEntry, CleanFile, HistoryRun } from "./memory-clean-types.ts";

function pointerBefore(text: string, run: HistoryRun, entries: ArchiveEntry[]): string {
  const info = run.header.files["MEMORY.md"];
  if (!info) return text;
  const delta = entries.reduce((n, entry) => n + entry.header.wrote.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0) - entry.lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0), 0);
  const pointerDelta = info.afterBytes - info.beforeBytes - delta;
  const lines = text.split("\n");
  const index = lines.findIndex((line) => /memory\/memory-history(?:-\d+)?\.md/.test(line));
  if (index < 0) return text;
  const target = /memory\/memory-history(?:-\d+)?\.md/.exec(lines[index]!)![0];
  if (pointerDelta > 80 && POINTER_LINES.some((line) => lines[index]!.replace(/\r$/, "") === line.replace(HISTORY_FILE, target))) lines.splice(index, 1);
  else if (pointerDelta !== 0) {
    const number = Number(/memory-history-(\d+)\.md/.exec(lines[index]!)?.[1]);
    if (number >= 2) lines[index] = lines[index]!.replace(`memory-history-${number}.md`, number === 2 ? "memory-history.md" : `memory-history-${number - 1}.md`);
  }
  return lines.join("\n");
}

function exactInverse(text: string, entries: ArchiveEntry[]): string {
  const lines = text.split("\n");
  const sources = new Map<number, { line: string; skip: number }>();
  const inserted = new Map<number, number>();
  for (const entry of entries) {
    entry.header.at.forEach((at, i) => sources.set(at, { line: entry.lines[i]!, skip: i === 0 ? entry.header.wrote.length : 0 }));
    if (entry.header.after !== undefined) inserted.set(entry.header.after, (inserted.get(entry.header.after) ?? 0) + entry.header.wrote.length);
  }
  const last = Math.max(0, ...sources.keys(), ...inserted.keys());
  const restored: string[] = [];
  let cursor = inserted.get(0) ?? 0;
  for (let at = 1; at <= last || cursor < lines.length; at++) {
    const source = sources.get(at);
    if (source) { restored.push(source.line); cursor += source.skip; }
    else if (cursor < lines.length) restored.push(lines[cursor++]!);
    cursor += inserted.get(at) ?? 0;
  }
  return restored.join("\n");
}

export function undoText(file: CleanFile, text: string, run: HistoryRun): { text: string; restored: number; skipped: number } {
  const entries = run.entries.filter((entry) => entry.header.file === file).sort((a, b) => (a.header.at[0] ?? Infinity) - (b.header.at[0] ?? Infinity));
  const total = entries.reduce((n, entry) => n + entry.lines.length, 0);
  const base = file === "MEMORY.md" ? pointerBefore(text, run, entries) : text;
  const info = run.header.files[file]!;
  if (hashText(text) === info.afterHash) {
    const candidate = exactInverse(base, entries);
    for (const restored of [candidate, candidate.replace(/\r?\n$/, ""), `${candidate}\n`, `${candidate}\r\n`]) {
      if (hashText(restored) === info.beforeHash) return { text: restored, restored: total, skipped: 0 };
    }
    throw new Error("Archive cannot reconstruct original file");
  }
  const lines = base.split("\n");
  let restored = 0;
  let skipped = 0;
  const sources: Array<{ line: string; at: number; prev: string }> = [];
  const find = (wrote: string[]) => lines.findLastIndex((_, at) => wrote.every((line, i) => lines[at + i] === line));
  for (const entry of entries.filter((item) => item.header.after !== undefined)) {
    const wrote = entry.header.wrote;
    const whole = find(wrote);
    const line = whole < 0 ? find(wrote.slice(-1)) : -1;
    if (whole >= 0) lines.splice(whole, wrote.length);
    else if (line >= 0) lines.splice(line, 1);
    else skipped++;
  }
  for (const entry of entries.filter((item) => item.header.at.length)) {
    const wrote = entry.header.wrote;
    if (wrote.length) {
      const prev = entry.header.prev[0]!;
      const originalAt = entry.header.at[0]!;
      const removedBefore = entries.reduce((n, item) => n + item.header.at.filter((at) => at < originalAt).length, 0);
      const wroteBefore = entries.filter((item) => item.header.at[0]! < originalAt).reduce((n, item) => n + item.header.wrote.length, 0);
      const expected = originalAt - 1 - removedBefore + wroteBefore;
      const anchors = lines.flatMap((line, at) => line.trim() && lineHash(line) === prev ? [at + 1] : []);
      const candidates = anchors.length ? anchors : [prev ? expected : 0];
      const found = candidates.map((candidate) => {
        let at = candidate;
        while (at < lines.length && !lines[at]!.trim()) at++;
        return at;
      }).find((at) => wrote.every((line, i) => lines[at + i] === line)) ?? -1;
      if (found < 0) { skipped += entry.lines.length; continue; }
      lines.splice(found, wrote.length);
    }
    entry.lines.forEach((line, i) => sources.push({ line, at: entry.header.at[i]!, prev: entry.header.prev[i]! }));
  }
  for (const source of sources.sort((a, b) => a.at - b.at)) {
    if (lines.some((line) => line.replace(/\r$/, "") === source.line.replace(/\r$/, ""))) { skipped++; continue; }
    const anchors = lines.flatMap((value, at) => value.trim() && lineHash(value) === source.prev ? [at] : []);
    const expected = source.at - 2;
    const anchor = anchors.sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected))[0];
    const at = !source.prev ? 0 : anchor === undefined ? Math.min(source.at - 1, lines.length) : anchor + 1;
    lines.splice(at, 0, source.line);
    restored++;
  }
  return { text: lines.join("\n"), restored, skipped };
}
