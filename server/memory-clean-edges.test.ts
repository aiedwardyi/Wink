import { describe, expect, it } from "vitest";

import { cleanFiles, mergeParkedCopy, parseHistory, POINTER_LINE, validateChangeList, type Change, type CleanFile, type CleanInput } from "./memory-clean.ts";
import { undoText } from "./memory-clean-undo.ts";

const retire = (id: number): Change => ({ op: "retire", id, reason: "Completed" });

function fixture(memory: string, changes: Change[] = [retire(2)], side?: { text: string; changes: Change[] }): CleanInput {
  const questions = Array.from({ length: 18 }, (_, i) => ({ kind: i < 12 ? "changed" : i < 16 ? "protected" : "absent", question: `Fact ${i}?`, answer: i < 16 ? `value ${i}` : null }));
  return {
    memory, side: side ? { file: "memory/topic.md", text: side.text } : undefined, history: null, typed: new Set(), now: Date.UTC(2026, 10, 4),
    propose: async (prompt) => {
      if (prompt.startsWith("[memory-clean:questions]")) return JSON.stringify(questions);
      if (prompt.startsWith("[memory-clean:grade]")) return JSON.stringify(Array(18).fill(true));
      const file: CleanFile = prompt.includes('"file":"memory/topic.md"') ? "memory/topic.md" : "MEMORY.md";
      return JSON.stringify({ version: 1, file, changes: file === "MEMORY.md" ? changes : side?.changes ?? [] });
    },
    recall: async () => JSON.stringify(questions.map((q) => q.answer)),
  };
}

describe("memory cleanup edges", () => {
  it("counts both files toward the character cap and the pointer toward the line cap", async () => {
    expect(await cleanFiles(fixture(`- kept\n- ${"a".repeat(4100)}\n`, [retire(2)], { text: `- kept\n- ${"b".repeat(4100)}\n`, changes: [retire(2)] }))).toMatchObject({ ok: false, stage: "validate", detail: "cap-chars" });
    const text = Array.from({ length: 21 }, (_, i) => `- old ${i}`).join("\n");
    expect(await cleanFiles(fixture(text, Array.from({ length: 20 }, (_, i) => retire(i + 1)), { text, changes: Array.from({ length: 20 }, (_, i) => retire(i + 1)) }))).toMatchObject({ ok: false, stage: "validate", detail: "cap-lines" });
  });

  it("allows forty touched lines when the history pointer already exists", async () => {
    const text = Array.from({ length: 21 }, (_, i) => `- old ${i}`).join("\n");
    expect(await cleanFiles(fixture(`${text}\n${POINTER_LINE}`, Array.from({ length: 20 }, (_, i) => retire(i + 1)), { text, changes: Array.from({ length: 20 }, (_, i) => retire(i + 1)) }))).toMatchObject({ ok: true });
  });

  it.each([
    [{ op: "split", id: 2, keep: ["red", "blue"], reason: "Done" }, "- before\r\n- red green blue\r\n- after\r\n"],
    [{ op: "remind", id: 2, text: "- Declined: blue", reason: "Reminder" }, "- before\n- Declined: blue panels with red trim\n- after"],
  ] as Array<[Change, string]>)("undo recovers side-file bytes for %s", async (change, text) => {
    const result = await cleanFiles(fixture("- kept\n", [], { text, changes: [change] }));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(undoText("memory/topic.md", result.side!.text, parseHistory(result.block)[0]!).text).toBe(text);
  });

  it("preserves a custom history pointer without replacing its facts", async () => {
    const pointer = "- memory/memory-history.md: Eddie's 2026 archive and current links (pinned)";
    const result = await cleanFiles(fixture(`- kept\n- old\n${pointer}\n`));
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.memory).toContain(pointer);
  });

  it("restores a removed line when its old neighbor was edited", async () => {
    const result = await cleanFiles(fixture("- before\n- old\n- after\n"));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const restored = undoText("MEMORY.md", result.memory.replace("- before", "- user edited before"), parseHistory(result.block)[0]!);
    expect(restored).toMatchObject({ text: "- user edited before\n- old\n- after\n", restored: 1, skipped: 0 });
  });

  it("keeps an unchanged merge when its edited neighbor prevents restoration", async () => {
    const result = await cleanFiles(fixture("- before\n- red\n- blue\n- after\n", [{ op: "merge", ids: [2, 3], text: "- red blue", reason: "Same subject" }]));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const restored = undoText("MEMORY.md", result.memory.replace("- before", "- user edited before"), parseHistory(result.block)[0]!);
    expect(restored.text).toContain("- user edited before");
    expect(restored.text).toContain("- red");
    expect(restored.text).toContain("- blue");
    expect(restored.restored + restored.skipped).toBe(2);
  });

  it.each(["November 4, 2026", "2026/11/04", "2026년 11월 4일"])("uses explicit dates before position: %s", (date) => {
    const result = validateChangeList({ file: "MEMORY.md", text: `- new ${date}\n- old 2026-10-01`, list: { version: 1, file: "MEMORY.md", changes: [{ op: "replace", id: 2, newer: 1, reason: "Current" }] }, typed: new Set() });
    expect(result).toMatchObject({ ok: true });
  });

  it("keeps a marker-looking archived source inside its whole history block", async () => {
    const second = await cleanFiles(fixture("- kept\n- old\n"));
    if (!second.ok) throw new Error("Fixture failed");
    const inner = `<!-- mc-run ${JSON.stringify(second.header)} -->`;
    const first = await cleanFiles(fixture(`- kept\n${inner}\n`));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const merged = mergeParkedCopy({ file: "memory/memory-history.md", kept: second.block, parked: first.block, history: second.block });
    expect(parseHistory(merged ?? "").map((run) => run.header.runId)).toEqual([second.runId, first.runId].sort((a, b) => a.localeCompare(b)));
    expect(parseHistory(merged ?? "").find((run) => run.header.runId === first.runId)?.entries[0]?.lines).toEqual([inner]);
  });

  it("merges undo records even when they follow a later run", async () => {
    const first = await cleanFiles(fixture("- kept\n- old\n"));
    const second = await cleanFiles(fixture("- kept\n- other\n"));
    if (!first.ok || !second.ok) throw new Error("Fixture failed");
    const undo = `<!-- mc-undo ${JSON.stringify({ v: 1, runId: first.runId, at: Date.now(), restored: 1, skipped: 0 })} -->\n`;
    const merged = mergeParkedCopy({ file: "memory/memory-history.md", kept: first.block + second.block, parked: first.block + second.block + undo, history: first.block });
    expect(parseHistory(merged ?? "").find((run) => run.header.runId === first.runId)?.undo).toMatchObject({ restored: 1 });
  });

  it("retires an exact duplicate pointer while leaving its protected copy", () => {
    const pointer = "- memory/topic.md: details";
    expect(validateChangeList({ file: "MEMORY.md", text: `${pointer}\n${pointer}\n`, list: { version: 1, file: "MEMORY.md", changes: [retire(1)] }, typed: new Set() })).toMatchObject({ ok: true, text: `${pointer}\n` });
  });

  it("never removes a pre-existing duplicate of a replacement edited since", async () => {
    const result = await cleanFiles(fixture("- before\n- red\n- blue\n- after\n- red blue\n", [{ op: "merge", ids: [2, 3], text: "- red blue", reason: "Same subject" }]));
    if (!result.ok) throw new Error("Fixture failed");
    const current = result.memory.replace("- red blue", "- user edit");
    expect(undoText("MEMORY.md", current, parseHistory(result.block)[0]!)).toMatchObject({ text: "- before\n- user edit\n- after\n- red blue\n", restored: 0, skipped: 2 });
  });
});
