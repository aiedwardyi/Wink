import { describe, expect, it, vi } from "vitest";

import { appendBlock } from "./memory-clean-format.ts";
import { cleanFiles, lineHash, parseHistory, sleepInput, type CleanFile, type CleanInput, type SleepLine, type TextCall } from "./memory-clean.ts";
import { undoText } from "./memory-clean-undo.ts";

const FLOOR = 16 * 1024;
const quiz = Array.from({ length: 18 }, (_, i) => ({ kind: i < 12 ? "changed" : i < 16 ? "protected" : "absent", question: `Fact ${i}?`, answer: i < 16 ? `value ${i}` : null }));
const proposer = (changes: () => unknown[]) => vi.fn<TextCall>(async (prompt) => {
  if (prompt.startsWith("[memory-clean:questions]")) {
    const topic = /"filedTo":"([^"]+)"/.exec(prompt)?.[1];
    return JSON.stringify(quiz.map((q, i) => i === 0 && topic ? { ...q, file: topic, answer: topic } : q));
  }
  if (prompt.startsWith("[memory-clean:grade]")) return JSON.stringify(JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)).map(() => true));
  return JSON.stringify({ version: 1, file: "MEMORY.md", changes: changes() });
});
const answerer = () => vi.fn<TextCall>(async (prompt) => {
  const topic = /^- (memory\/(?!memory-history)[a-z0-9-]+\.md):/m.exec(prompt)?.[1];
  return JSON.stringify(quiz.map((q, i) => i === 0 && topic ? topic : q.answer));
});
const detail = (i: number) => `- detail ${i} ${"y".repeat(260)}`;
const planted = [
  "## Pinned", "- pinned: the car is the blue Kia", "", "# Memory", "- Correction: the gym is on 5th St, not 4th", "- Never share the Wi-Fi name",
  "- tax form pending signature", "- typed by hand in the editor", "- Mom's birthday is March 3",
];

describe("sleep soak", () => {
  it("keeps every planted line through seven nights with exact undo and the size rule", async () => {
    let memory = [...planted, ...Array.from({ length: 14 }, (_, k) => `- stale ${k} done`), ...Array.from({ length: 7 }, (_, k) => [`- dup ${k} alpha`, `- dup ${k} alpha beta`]).flat(),
      ...Array.from({ length: 60 }, (_, i) => detail(i))].join("\n") + "\n";
    let history = "";
    const typed = new Set([lineHash("- typed by hand in the editor"), lineHash("- Mom's birthday is March 3")]);
    const topics = new Map<CleanFile, string>();
    const kept = [...planted.filter(Boolean)];
    const tokens: number[] = [];
    const ids = (text: string, match: (line: string) => boolean) => text.split("\n").flatMap((line, i) => match(line.replace(/\r$/, "")) ? [i + 1] : []);
    for (let night = 1; night <= 7; night++) {
      const user: SleepLine[] = [{ text: `Jun likes route ${night}`, at: night, kind: "said" }];
      if (night === 2) user.push({ text: "No, the dentist is on Tuesday", at: night, kind: "correction", context: "The dentist is on Monday." });
      if (night === 3) user.push({ text: "Remember that the plumber is named Dae", at: night, kind: "remember" });
      const text = memory;
      const changes = () => [
        ...[2 * night - 2, 2 * night - 1].map((k) => ({ op: "retire", id: ids(text, (line) => line === `- stale ${k} done`)[0], reason: "Done" })),
        { op: "merge", ids: ids(text, (line) => line.startsWith(`- dup ${night - 1} alpha`)), text: `- dup ${night - 1} alpha beta`, reason: "Same subject" },
        { op: "learn", text: `- Jun likes route ${night}`, quote: `Jun likes route ${night}`, lesson: false, reason: "User said it" },
        ...(night === 2 ? [{ op: "learn", text: "- Dentist is on Tuesday", quote: "the dentist is on Tuesday", lesson: true, reason: "Correction" }] : []),
        ...(Buffer.byteLength(text) > FLOOR ? [{ op: "file", ids: ids(text, (line) => line.startsWith("- detail ")).slice(0, 6), topic: "details", pointer: "- memory/details.md: older detail lines", reason: "Detail" }] : []),
      ];
      const input: CleanInput = { memory, history, typed, user, through: night, topic: (file) => topics.get(file) ?? null, propose: proposer(changes), recall: answerer(), now: Date.UTC(2026, 10, night) };
      const result = await cleanFiles(input);
      if (!result.ok) throw new Error(`night ${night}: ${result.stage} ${result.detail}`);
      tokens.push(result.tokens);
      const after = result.memory.split("\n").map((line) => line.replace(/\r$/, ""));
      kept.push(`- Jun likes route ${night}`, ...(night === 2 ? ["## Lessons", "- Dentist is on Tuesday"] : []), ...(night === 3 ? ["- Remember that the plumber is named Dae"] : []));
      expect(kept.filter((line) => !after.includes(line))).toEqual([]);
      const nextHistory = appendBlock(history, result.block);
      const run = parseHistory(nextHistory).at(-1)!;
      const archived = run.entries.flatMap((entry) => entry.lines);
      expect(memory.split("\n").filter((line) => line.trim() && !after.includes(line) && !archived.includes(line))).toEqual([]);
      expect(undoText("MEMORY.md", result.memory, run).text).toBe(memory);
      for (const topic of result.topics) expect(undoText(topic.file, topic.text, run).text).toBe(topic.before ?? "");
      expect(Buffer.byteLength(result.memory)).toBeLessThanOrEqual(Math.max(Buffer.byteLength(memory), FLOOR));
      if (result.header.v !== 2) throw new Error("v1 header");
      const { counts } = result.header;
      expect(counts.kept + counts.merged + counts.forgot).toBe(memory.split("\n").filter((line) => line.trim()).length);
      expect(result.owned.every((hash) => !typed.has(hash))).toBe(true);
      result.owned.forEach((hash) => typed.add(hash));
      result.topics.forEach((topic) => topics.set(topic.file, topic.text));
      memory = result.memory;
      history = nextHistory;
    }
    expect(Buffer.byteLength(memory)).toBeLessThanOrEqual(FLOOR);
    const details = [...memory.split("\n"), ...(topics.get("memory/details.md") ?? "").split("\n")].filter((line) => line.startsWith("- detail "));
    expect(details.sort()).toEqual(Array.from({ length: 60 }, (_, i) => detail(i)).sort());
    expect(Math.max(...tokens)).toBeLessThan(150_000);
    console.info(`[soak] tokens per night ${tokens.join(" ")}`);
  });

  it("keeps the 22 KB heavy fixture under 65k tokens for the MEMORY.md pass", async () => {
    const memory = [...planted, ...Array.from({ length: 80 }, (_, i) => detail(i)), "- stale 0 done"].join("\n") + "\n";
    expect(Buffer.byteLength(memory)).toBeGreaterThan(22_000);
    const user = Array.from({ length: 40 }, (_, i): SleepLine => ({ text: `I moved the standup to slot ${i} this week`, at: i, kind: "said" }));
    const result = await cleanFiles({ memory, history: null, typed: new Set(), user, propose: proposer(() => [
      { op: "retire", id: memory.split("\n").indexOf("- stale 0 done") + 1, reason: "Done" },
      { op: "file", ids: [10, 11, 12, 13], topic: "details", pointer: "- memory/details.md: detail lines", reason: "Detail" },
    ]), recall: answerer() });
    expect(result).toMatchObject({ ok: true });
    expect(result.tokens).toBeLessThan(65_000);
    console.info(`[heavy] tokens ${result.tokens}`);
  });
});

describe("sleep sabotage", () => {
  const memory = ["- kept", "- Eddie has 9 cats", "- Eddie has 2 dogs", "- headcount 9 (noted 2026-11-04)", "- headcount 8 (noted 2026-10-01)", "- owned line typed", "- Never deploy on Fridays",
    ...Array.from({ length: 60 }, (_, i) => detail(i))].join("\n") + "\n";
  const typed = new Set([lineHash("- owned line typed")]);
  const bot = sleepInput([{ id: "1", role: "bot", kind: "text", text: "Jun likes coffee", at: 5 }, { id: "2", role: "user", kind: "text", text: "thanks", at: 6 }] as never, 0, 10).user;
  it.each([
    ["learn without a quote", { op: "learn", text: "- Jun likes tea", lesson: false, reason: "Guess" }, [], "shape"],
    ["learn from bot text", { op: "learn", text: "- Jun likes coffee", quote: "Jun likes coffee", lesson: false, reason: "Bot said" }, bot, "not-quoted"],
    ["secret-like learn", { op: "learn", text: "- api key sk-abcdefghijklmnop", quote: "sk-abcdefghijklmnop", lesson: false, reason: "Key" }, [{ text: "my api key is sk-abcdefghijklmnop", at: 1, kind: "said" }], "secret"],
    ["filing a protected line", { op: "file", ids: [7, 8], topic: "rules", pointer: "- memory/rules.md: rules", reason: "Detail" }, [], "protected"],
    ["retiring an owned line", { op: "retire", id: 6, reason: "Old" }, [], "protected"],
    ["a merge that drops a number", { op: "merge", ids: [2, 3], text: "- Eddie has cats and dogs", reason: "Pets" }, [], "fact-lost"],
    ["a replace that is not newer", { op: "replace", id: 4, newer: 5, reason: "Newer" }, [], "not-newer"],
  ])("rejects %s after one repair retry and writes nothing", async (_, change, user, reason) => {
    const propose = proposer(() => [change]);
    const result = await cleanFiles({ memory, history: null, typed, user: user as SleepLine[], propose, recall: answerer() });
    expect(result).toMatchObject({ ok: false, stage: "validate" });
    expect(!result.ok && result.detail).toContain(reason);
    expect(propose).toHaveBeenCalledTimes(2);
    expect(propose.mock.calls[1]![0]).toContain(`"reason":"${reason}"`);
  });
});
