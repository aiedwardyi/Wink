import type { Message } from "@/state/store";

const NOTED = /\s+\(noted (\d{4})-(\d{2})-(\d{2})\)\s*$/;

export function memoryLineText(line: string): string {
  return line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(NOTED, "");
}

export function memorySaveTarget(summary: string, lines?: readonly string[]): string {
  const prefix = summary.replace(/\.\.\.$/, "").trim();
  return lines?.find((line) => memoryLineText(line).startsWith(prefix)) ?? lines?.[0] ?? summary;
}

export function memoryTargetLine(text: string, target: string, messages: readonly Message[] = []): string | undefined {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const exact = lines.find((line) => line === target.trimEnd());
  if (exact) return exact;
  if (messages.some((message) => message.tool?.lines?.some((line) => line.trimEnd() === target.trimEnd()))) return undefined;
  const prefix = target.replace(/\.\.\.$/, "").trim();
  return prefix ? lines.reverse().find((line) => memoryLineText(line).startsWith(prefix)) : undefined;
}

export function recentLines(text: string, messages: readonly Message[] = []): Array<{ line: string; fact: string; at: Date }> {
  const file = text.split("\n").map((line) => line.trimEnd());
  const rows = file.flatMap((line) => {
    const stamp = /^\s*[-*+]\s+/.test(line) ? NOTED.exec(line) : null;
    return stamp ? [{ line, fact: memoryLineText(line), at: new Date(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3])) }] : [];
  }).reverse();
  for (const message of messages) {
    const tool = message.tool;
    if (message.kind !== "activity" || tool?.name !== "memory.save" || tool.tidy || tool.ok === false) continue;
    const lines = tool.lines ?? (tool.spoken ? [memoryTargetLine(text, tool.spoken)].filter((line): line is string => Boolean(line)) : []);
    for (const line of lines) {
      const exact = file.find((candidate) => candidate === line.trimEnd());
      if (exact) rows.push({ line: exact, fact: memoryLineText(exact), at: new Date(message.at) });
    }
  }
  rows.sort((a, b) => b.at.getTime() - a.at.getTime());
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.line) && Boolean(seen.add(row.line)));
}
