import { archiveBlock, appendBlock, hashText, historyPointer, HISTORY_FILE, loadedPrefix } from "./memory-clean-format.ts";
import type { ArchiveEntry, Change, ChangeList, CleanFile, CleanInput, RunHeader, SleepLine } from "./memory-clean-types.ts";
import { contentWords, measureChanges, prepareChangeList, protectedLines, rememberCovered } from "./memory-clean-validate.ts";

export type CleanSource = { file: CleanFile; text: string };
export type WorkPacket = { file: CleanFile; ids: number[] };
export const changeIds = (change: Change): number[] => change.op === "merge" || change.op === "file" ? change.ids : change.op === "learn" ? [] : change.op === "replace" ? [change.id, change.newer] : [change.id];

export function workPackets(sources: CleanSource[], typed: ReadonlySet<string>, user: readonly SleepLine[] = []): WorkPacket[] {
  const packets: WorkPacket[] = [];
  for (const source of sources) {
    if (packets.length === 2) break;
    const lines = source.text.split("\n");
    const hard = protectedLines(source.text, typed, true, false);
    const ids = lines.flatMap((line, i) => line.trim() && !/^#/.test(line) ? [i + 1] : []);
    if (ids.length <= 24 && sources.length === 1) {
      for (let start = 0; start < ids.length; start += 12) packets.push({ file: source.file, ids: ids.slice(start, start + 12) });
      continue;
    }
    if (ids.length <= 12) { packets.push({ file: source.file, ids }); continue; }
    const groups = new Map<string, number[]>();
    const copies = new Map<string, number>();
    for (const id of ids) copies.set(lines[id - 1]!, (copies.get(lines[id - 1]!) ?? 0) + 1);
    const duplicates = new Set(ids.filter((id) => copies.get(lines[id - 1]!)! > 1));
    for (const id of ids) {
      const line = lines[id - 1]!;
      if (hard.has(id) && !duplicates.has(id)) continue;
      const key = duplicates.has(id) ? "duplicate" : [...contentWords(line)][0] ?? line.trim().split(/\s+/)[1] ?? "detail";
      const group = groups.get(key) ?? [];
      group.push(id);
      groups.set(key, group);
    }
    const light = Buffer.byteLength(source.text) <= 16000 && lines.length <= 140;
    const priority = (key: string, ids: number[]) => key === "duplicate" ? 3 : light && ids.some((id) => /\b(?:done|completed|ended)\b/.test(lines[id - 1]!)) ? 1 :
      light && ids.some((id) => ids.some((other) => id !== other && lines[other - 1]!.startsWith(lines[id - 1]!.trimEnd() + " "))) ? 2 : 0;
    const ranked = [...groups].sort(([a, x], [b, y]) => priority(b, y) - priority(a, x) ||
      Math.max(...y.map((id) => Buffer.byteLength(lines[id - 1]!))) - Math.max(...x.map((id) => Buffer.byteLength(lines[id - 1]!))) || x[0]! - y[0]!);
    const limit = source.file === "MEMORY.md" && sources.length > 1 ? 1 : 2 - packets.length;
    const remembered = source.file === "MEMORY.md" ? ids.filter((id) => user.some((line) => line.kind === "remember" && rememberCovered(line.text, lines[id - 1]!))) : [];
    const selected = [...new Set([...remembered, ...ranked.flatMap(([, group]) => group)])].slice(0, limit * 12);
    for (let start = 0; start < selected.length; start += 12) packets.push({ file: source.file, ids: selected.slice(start, start + 12) });
  }
  return packets;
}

export function stagedCandidate(input: CleanInput, sources: CleanSource[], lists: Map<CleanFile, unknown>, runId: string, at: number, reserve = false) {
  const entries: ArchiveEntry[] = [];
  const raw = new Map<CleanFile, string>();
  const filed = new Map<CleanFile, { lines: string[]; reason: string }>();
  const parsed = new Map<CleanFile, ChangeList>();
  for (const source of sources) {
    const list = lists.get(source.file) ?? { version: 1, file: source.file, changes: [] };
    const result = prepareChangeList({ file: source.file, text: source.text, list, typed: input.typed, user: input.user, side: input.side?.file });
    if (!result.ok) return { ok: false as const, file: source.file, errors: result.errors, budgets: [] };
    parsed.set(source.file, (typeof list === "string" ? JSON.parse(list) : list) as ChangeList);
    raw.set(source.file, result.text);
    entries.push(...result.entries);
    for (const topic of result.topics) {
      const known = filed.get(topic.file) ?? { lines: [], reason: topic.reason };
      known.lines.push(...topic.lines);
      filed.set(topic.file, known);
    }
  }
  const topics = [...filed].map(([file, item]) => {
    const before = input.topic?.(file) ?? null;
    const base = before ?? "";
    const cr = base.includes("\r\n") ? "\r" : "";
    const wrote = item.lines.map((line) => line + cr);
    const head = base === "" ? 0 : base.split("\n").length - (base.endsWith("\n") ? 1 : 0);
    const text = `${base}${base && !base.endsWith("\n") ? `${cr}\n` : ""}${wrote.join("\n")}\n`;
    entries.push({ header: { file, op: "file", at: [], prev: [], wrote, after: head }, reason: item.reason, lines: [] });
    return { file, before, text };
  });
  const sum = (...ops: string[]) => entries.filter((entry) => ops.includes(entry.header.op)).reduce((n, entry) => n + entry.header.at.length, 0);
  const counts = { merged: sum("merge"), forgot: sum("retire", "replace"), learned: entries.filter((entry) => entry.header.op === "learn" || (entry.header.op === "own" && entry.header.after !== undefined)).length, filed: sum("file") };
  const old = sources.reduce((n, source) => n + source.text.split("\n").filter((line) => line.trim()).length, 0);
  let target = /memory\/memory-history(?:-\d+)?\.md/.exec(input.memory)?.[0] ?? HISTORY_FILE;
  const build = () => {
    const after = new Map(raw);
    after.set("MEMORY.md", entries.length || reserve ? historyPointer(raw.get("MEMORY.md")!, target) : raw.get("MEMORY.md")!);
    const header: RunHeader = { v: 2, runId, at, through: input.through ?? at, files: {}, counts: { kept: old - counts.merged - counts.forgot, ...counts } };
    for (const [file, before, text] of [...sources.map((source) => [source.file, source.text, after.get(source.file)!] as const), ...topics.map((topic) => [topic.file, topic.before ?? "", topic.text] as const)]) {
      header.files[file] = { beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(text), beforeHash: hashText(before), afterHash: hashText(text) };
    }
    return { after, header, block: archiveBlock(header, entries) };
  };
  let built = build();
  if (Buffer.byteLength(appendBlock(input.history ?? "", built.block)) > 240 * 1024) {
    const number = Number(/-(\d+)\.md$/.exec(target)?.[1] ?? 1) + 1;
    target = `memory/memory-history-${number}.md`;
    built = build();
  }
  const budgets = sources.map((source) => ({ file: source.file, ...measureChanges(source.file, source.text, raw.get(source.file)!, entries, entries.length || reserve ? target : undefined) }));
  const errors = budgets.flatMap((item) => item.errors);
  const touched = budgets.reduce((n, item) => n + item.budget.touchedLines, 0);
  const chars = budgets.reduce((n, item) => n + item.budget.changedChars, 0);
  if (touched > 40 && !errors.some((error) => error.reason === "cap-lines")) errors.push({ reason: "cap-lines", over: touched - 40 });
  if (chars > 8000 && !errors.some((error) => error.reason === "cap-chars")) errors.push({ reason: "cap-chars", over: chars - 8000 });
  const memory = built.after.get("MEMORY.md")!;
  const prefix = loadedPrefix(memory);
  for (const entry of entries.filter((entry) => entry.header.file === "MEMORY.md" && entry.header.op === "file")) {
    if (entry.header.wrote.some((line) => !prefix.includes(line.replace(/\r$/, "")))) errors.push({ reason: "pointer" });
    if (entry.header.topic) {
      const topic = topics.find((item) => item.file === entry.header.topic);
      if (!topic || entry.lines.some((line) => !topic.text.split("\n").some((row) => row.replace(/\r$/, "") === line.replace(/\r$/, "")))) errors.push({ reason: "pointer" });
    }
  }
  if (errors.length) return { ok: false as const, file: budgets.find((item) => item.errors.length)?.file ?? sources.at(-1)!.file, errors, budgets: budgets.map(({ file, budget }) => ({ file, ...budget })) };
  return { ok: true as const, memory, ...built, entries, topics, parsed, budgets: budgets.map(({ file, budget }) => ({ file, ...budget })) };
}
