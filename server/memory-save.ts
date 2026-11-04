import { memoryFileRaw } from "./workspace.ts";

export const MEMORY_SAVE_TOOL = "memory.save";

const snapshots = new Map<string, string>();

function factLines(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const trimmed = line.trim().replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
    if (!trimmed || trimmed.startsWith("#")) return [];
    return [trimmed];
  });
}

export function memorySaveSummary(before: string, after: string): string | null {
  const previous = new Set(factLines(before));
  const added = factLines(after).filter((line) => !previous.has(line));
  const picked = added.at(-1);
  if (!picked) return null;
  return picked.slice(0, 80);
}

export function addedMemoryLines(before: string, after: string): string[] | undefined {
  const previous = new Set(before.split("\n").map((line) => line.replace(/\r$/, "")));
  const lines = after.split("\n").map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() && !line.startsWith("#") && line.length <= 1000 && !previous.has(line)).slice(0, 20);
  return lines.length ? lines : undefined;
}

export function peekMemory(botId: string): void {
  snapshots.set(botId, memoryFileRaw(botId));
}

export function rememberMemoryWrite(botId: string): { spoken: string; lines?: string[] } | null {
  const next = memoryFileRaw(botId);
  const prev = snapshots.get(botId);
  if (prev === undefined) {
    snapshots.set(botId, next);
    return null;
  }
  snapshots.set(botId, next);
  const spoken = memorySaveSummary(prev, next);
  const lines = addedMemoryLines(prev, next);
  return spoken ? { spoken, ...(lines ? { lines } : {}) } : null;
}

export function resetMemorySnapshots(): void {
  snapshots.clear();
}
