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

  it("asks the proposer to let the newer of two conflicting values win", async () => {
    const input = fixture("- port 8443 (09-02)\n- port 9443 (10-14)\n");
    const prompts: string[] = [];
    await cleanFiles({ ...input, propose: async (prompt, opts) => { prompts.push(prompt); return input.propose(prompt, opts); } });
    expect(prompts[0]).toContain("Newer wins: when two lines give one subject different values");
    expect(prompts[0]).toContain("replace the older unprotected line with the newer");
    expect(prompts[0]).toContain("same date with different values means keep both");
    expect(prompts[0]).toContain("Korean lines count the same as English");
    expect(prompts[0]).toContain("A new person or owner for the same task is a new value");
    expect(prompts[0]).toContain("same facts in other words, same date or not: merge them");
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

  it("learns from a typed user line but refuses bot, pasted or secret-like text", async () => {
    const learn = (quote: string, text = `- ${quote}`) => ({ op: "learn", text, quote, lesson: false, reason: "User said it" });
    const check = (change: unknown, user: unknown[]) => validateChangeList({ file: "MEMORY.md", text: "- kept\n", typed: new Set(), user: user as never, list: { version: 1, file: "MEMORY.md", changes: [change] } });
    const typed = [{ text: "My sister Mina lives in Busan", at: 13, kind: "said" }];
    expect(check(learn("sister Mina lives in Busan", "- Sister Mina lives in Busan"), typed)).toMatchObject({ ok: true, text: "- kept\n- Sister Mina lives in Busan\n" });
    const { sleepInput } = await import("./memory-clean.ts");
    const rows = [
      { id: "1", role: "bot", kind: "text", text: "Your sister Jiwoo lives in Seoul", at: 10 },
      { id: "2", role: "user", kind: "text", text: "<pasted-text>My brother Tae lives in Daegu</pasted-text>", at: 11 },
      { id: "3", role: "user", kind: "text", text: "my password is hunter2 for the bank", at: 12 },
      { id: "4", role: "user", kind: "text", text: "My sister Mina lives in Busan", at: 13 },
      { id: "5", role: "user", kind: "text", text: "Jo lives in Ulsan", at: 14, from: { botId: "peer" } },
    ];
    const tonight = sleepInput(rows as never, 0, 20);
    expect(tonight).toEqual({ user: typed, through: 13 });
    for (const quote of ["Your sister Jiwoo lives in Seoul", "My brother Tae lives in Daegu", "Jo lives in Ulsan", "my password is hunter2"]) {
      expect(check(learn(quote), tonight.user)).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "not-quoted" })]) });
    }
    expect(check(learn("password is hunter2"), [{ text: "my password is hunter2", at: 1, kind: "said" }])).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "secret" })]) });
  });

  it("files detail lines into Knowledge only above 16 KB and never a protected line", () => {
    const detail = (i: number) => `- detail ${i} ${"x".repeat(280)}`;
    const big = ["- Never deploy on Fridays", "- deploy pending review", ...Array.from({ length: 58 }, (_, i) => detail(i))].join("\n") + "\n";
    const small = ["- Never deploy on Fridays", "- deploy pending review", ...Array.from({ length: 8 }, (_, i) => detail(i))].join("\n") + "\n";
    const file = (ids: number[], topic = "details") => ({ op: "file", ids, topic, pointer: `- memory/${topic}.md: early details`, reason: "Detail" });
    const check = (text: string, change: unknown) => validateChangeList({ file: "MEMORY.md", text, typed: new Set(), list: { version: 1, file: "MEMORY.md", changes: [change] } });
    const filed = check(big, file([3, 4]));
    expect(filed).toMatchObject({ ok: true, topics: [{ file: "memory/details.md", lines: [detail(0), detail(1)] }] });
    expect(filed.ok && filed.text.split("\n").slice(0, 4)).toEqual(["- Never deploy on Fridays", "- deploy pending review", "- memory/details.md: early details", detail(2)]);
    expect(check(small, file([3, 4]))).toMatchObject({ ok: false, errors: [{ reason: "op-not-allowed" }] });
    for (const id of [1, 2]) expect(check(big, file([id, 3]))).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "protected" })]) });
    expect(check(big, file([3], "memory-history"))).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "op-not-allowed" })]) });
  });
});
