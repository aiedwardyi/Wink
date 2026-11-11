import { describe, expect, it } from "vitest";

import { cleanFiles, lineHash, mergeParkedCopy, parseHistory, POINTER_LINE, sleepInput, validateChangeList, type Change, type CleanFile, type CleanInput } from "./memory-clean.ts";
import { factParts } from "./memory-clean-coverage.ts";
import { undoText } from "./memory-clean-undo.ts";
import { day } from "./memory-pass.ts";
import { sleepReply } from "./testing/sleep-verdicts.ts";
import { loadMemory, writeMemoryFile } from "./workspace.ts";

const retire = (id: number): Change => ({ op: "retire", id, reason: "Completed" });

function fixture(memory: string, changes: Change[] = [retire(2)], side?: { text: string; changes: Change[] }): CleanInput {
  const questions = Array.from({ length: 18 }, (_, i) => ({ kind: i < 12 ? "changed" : i < 16 ? "protected" : "absent", question: `Fact ${i}?`, answer: i < 16 ? `value ${i}` : null }));
  return {
    memory, side: side ? { file: "memory/topic.md", text: side.text } : undefined, history: null, typed: new Set(), now: Date.UTC(2026, 10, 4),
    propose: async (prompt) => {
      const staged = sleepReply(prompt);
      if (staged !== null) return staged;
      if (prompt.startsWith("[memory-clean:questions]")) {
        const topic = /"filedTo":"([^"]+)"/.exec(prompt)?.[1];
        return JSON.stringify(questions.map((question, i) => i === 0 && topic ? { ...question, file: topic, answer: topic } : question));
      }
      if (prompt.startsWith("[memory-clean:grade]")) return JSON.stringify(JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)).map(() => true));
      const file: CleanFile = prompt.includes('"file":"memory/topic.md"') ? "memory/topic.md" : "MEMORY.md";
      return JSON.stringify({ version: 1, file, changes: file === "MEMORY.md" ? changes : side?.changes ?? [] });
    },
    recall: async (prompt) => {
      const staged = sleepReply(prompt);
      if (staged !== null) return staged;
      const topic = /^- (memory\/(?!memory-history)[\w-]+\.md):/m.exec(prompt)?.[1];
      return JSON.stringify(questions.map((q, i) => i === 0 && topic ? topic : q.answer));
    },
  };
}

describe("memory cleanup edges", () => {
  it.each([230, 26, 1])("D1 reports the final byte excess including history: %s", (over) => {
    const removed = `- completed ${"x".repeat(120)}`;
    const text = `${removed}\n- ${"z".repeat(25_000)}\n`;
    const bytes = Buffer.byteLength(removed) + over - Buffer.byteLength(POINTER_LINE) - 1;
    const remember = `Remember ${"a".repeat(bytes - 12)}`;
    expect(validateChangeList({
      file: "MEMORY.md", text, typed: new Set(), user: [{ text: remember, kind: "remember", at: 1 }],
      list: { version: 1, file: "MEMORY.md", changes: [retire(1)] },
    })).toMatchObject({ ok: false, errors: expect.arrayContaining([{ reason: "budget", over }]) });
  });

  it.each([40, 46])("D1 includes the generated pointer in %s touched lines", (count) => {
    const text = Array.from({ length: count + 1 }, (_, i) => `- completed ${i}`).join("\n");
    expect(validateChangeList({ file: "MEMORY.md", text, typed: new Set(), list: {
      version: 1, file: "MEMORY.md", changes: Array.from({ length: count }, (_, i) => retire(i + 1)),
    } })).toMatchObject({ ok: false, errors: expect.arrayContaining([{ reason: "cap-lines", over: count + 1 - 40 }]) });
  });

  it("D4 rejects a 13-subject pointer missing each subject's second relation", () => {
    const details = Array.from({ length: 13 }, (_, i) => `- User${i} locker code ${100 + i}; User${i} diet excludes nuts.`);
    const pointer = `- memory/details.md: locker codes ${details.map((_, i) => `User${i} ${100 + i}`).join(", ")}`;
    const text = details.join("\n") + `\n- ${"z".repeat(17_000)}\n`;
    expect(Buffer.byteLength(pointer)).toBeLessThanOrEqual(300);
    expect(validateChangeList({ file: "MEMORY.md", text, typed: new Set(), list: {
      version: 1, file: "MEMORY.md", changes: [{ op: "file", ids: details.map((_, i) => i + 1), topic: "details", pointer, reason: "File details" }],
    } })).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "pointer" })]) });
  });

  it("D1 repairs a candidate that grows only after its history pointer is rendered", async () => {
    const memory = ["- done", "- done", ...Array.from({ length: 86 }, (_, i) => `- detail ${i} ${"z".repeat(280)}`)].join("\n") + "\n";
    const input = fixture(memory, []);
    let attempts = 0;
    const result = await cleanFiles({ ...input, propose: async (prompt, opts) => {
      const staged = sleepReply(prompt);
      if (staged !== null) return staged;
      if (!prompt.startsWith("[memory-clean:propose]")) return input.propose(prompt, opts);
      return JSON.stringify({ version: 1, file: "MEMORY.md", changes: ++attempts === 1 ? [retire(2)] : [retire(2), retire(3)] });
    } });
    expect(result).toMatchObject({ ok: true });
    expect(attempts).toBe(2);
    if (result.ok) expect(Buffer.byteLength(result.memory)).toBeLessThan(Buffer.byteLength(memory));
  });

  it("counts mandatory remembers in the 1,000-byte nightly growth cap", () => {
    const user = Array.from({ length: 4 }, (_, i) => ({ text: `Remember route ${i} ${"along the river ".repeat(18)}`, kind: "remember" as const, at: i }));
    expect(validateChangeList({ file: "MEMORY.md", text: "- kept\n", typed: new Set(), user, list: { version: 1, file: "MEMORY.md", changes: [] } }))
      .toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "cap-growth" })]) });
  });

  it("keeps negation when every positive content word survives a merge", () => {
    expect(validateChangeList({ file: "MEMORY.md", text: "- tea is not allowed\n- coffee is allowed\n", typed: new Set(), list: {
      version: 1, file: "MEMORY.md", changes: [{ op: "merge", ids: [1, 2], text: "- tea and coffee are allowed", reason: "Drinks" }],
    } })).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "fact-lost" })]) });
  });

  it("does not cover a mandatory remember with swapped attributions", () => {
    const text = "- Ada owns 3 dogs; Bob owns 2 cats\n";
    const remember = "Remember Ada owns 2 cats; Bob owns 3 dogs";
    const result = validateChangeList({ file: "MEMORY.md", text, typed: new Set(), user: [{ text: remember, kind: "remember", at: 1 }], list: { version: 1, file: "MEMORY.md", changes: [] } });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.text).toContain(`- ${remember}\n`);
  });

  it.each(["\n", "\r\n"])("routes all 26 assertions beyond the loaded prefix and undoes %j bytes", async (newline) => {
    const prefix = Array.from({ length: 86 }, (_, i) => `- pinned ${i} ${"z".repeat(280)}`);
    const details = Array.from({ length: 13 }, (_, i) => `- User${i} locker code ${100 + i} ${"x".repeat(140)}; User${i} diet excludes nuts.`);
    const memory = [...prefix, ...details].join(newline) + newline;
    const pointer = `- memory/details.md: ${details.map((_, i) => `User${i} locker code ${100 + i}; User${i} diet excludes nuts`).join("; ")}`;
    const input = fixture(memory, [{ op: "file", ids: details.map((_, i) => prefix.length + i + 1), topic: "details", pointer, reason: "Details" }]);
    const prompts: string[] = [];
    const result = await cleanFiles({ ...input, typed: new Set(prefix.map(lineHash)), propose: async (prompt, opts) => {
      prompts.push(prompt);
      if (prompt.startsWith("[memory-clean:route-questions]")) {
        const sources = JSON.parse(/^Sources: (.*)$/m.exec(prompt)![1]!) as Array<{ id: number; text: string }>;
        return JSON.stringify(sources.flatMap(({ id, text }) => factParts(text).map((fact, part) => {
          const user = /User\d+/.exec(fact)![0];
          const relation = part === 0 ? "locker code" : "diet excludes";
          return { id, fact: fact.trim(), label: `${user} ${relation}`, question: `Which file lists ${user} ${relation}?`, valueQuestion: `What is ${user} ${relation}?`, answer: part === 0 ? /code (\d+)/.exec(fact)![1] : "nuts" };
        })));
      }
      if (prompt.startsWith("[memory-clean:grade]")) {
        const pairs = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)) as Array<{ expected: string; actual: string }>;
        return JSON.stringify(pairs.map((pair) => pair.expected === pair.actual));
      }
      return input.propose(prompt, opts);
    }, recall: async (prompt, opts) => {
      prompts.push(prompt);
      if (prompt.startsWith("[memory-clean:routes]")) {
        const questions = JSON.parse(/^Questions: (.*)$/m.exec(prompt)![1]!) as string[];
        const index = prompt.slice(prompt.indexOf("MEMORY.md:\n"));
        return JSON.stringify(questions.map((question) => index.includes(/User\d+ (?:locker code|diet excludes)/.exec(question)![0]) ? "memory/details.md" : null));
      }
      if (prompt.startsWith("[memory-clean:values]")) {
        const questions = JSON.parse(/^Questions: (.*)$/m.exec(prompt)![1]!) as Array<{ file: string; question: string }>;
        const reads = JSON.parse(/^Reads: (.*)$/m.exec(prompt)![1]!) as Array<{ file: string; text: string }>;
        return JSON.stringify(questions.map(({ file, question }) => {
          const user = /User\d+/.exec(question)![0];
          const line = reads.find((read) => read.file === file)!.text.split("\n").find((line) => line.startsWith(`- ${user} `))!;
          return question.includes("locker") ? /code (\d+)/.exec(line)![1] : /excludes (\w+)/.exec(line)![1];
        }));
      }
      return input.recall(prompt, opts);
    } });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.routeReads).toHaveLength(26);
    expect(Buffer.byteLength(result.memory)).toBeLessThan(Buffer.byteLength(memory));
    const pointers = result.memory.split("\n").filter((line) => line.includes("memory/details.md"));
    expect(pointers.length).toBeGreaterThan(1);
    expect(pointers.every((line) => Buffer.byteLength(line.replace(/\r$/, "")) <= 300)).toBe(true);
    writeMemoryFile("sleep-r4-pointer-fixture", result.memory);
    const loaded = loadMemory("sleep-r4-pointer-fixture")!.text;
    for (let i = 0; i < 13; i++) {
      expect(loaded).toContain(`User${i} locker code`);
      expect(loaded).toContain(`User${i} diet excludes`);
    }
    const run = parseHistory(result.block)[0]!;
    expect(undoText("MEMORY.md", result.memory, run).text).toBe(memory);
    expect(undoText("memory/details.md", result.topics[0]!.text, run).text).toBe("");
    const asked = prompts.find((prompt) => prompt.startsWith("[memory-clean:route-questions]"))!;
    expect(asked).not.toContain("memory/details.md");
    expect(asked).not.toContain(pointer);
    expect(prompts.find((prompt) => prompt.startsWith("[memory-clean:values]"))).toContain('Reads: [{"file":"memory/details.md"');
  });

  it.each(["merge", "replace", "retire"])("requires independent source coverage for %s", async (op) => {
    const memory = "- Ada owns 2 cats\n- Bob owns 3 dogs\n- user Ada lives in Seoul\n- user Ada works in Busan\n";
    const changes: Change[] = op === "merge" ? [{ op, ids: [1, 2], text: "- Ada owns 3 dogs; Bob owns 2 cats", reason: "Pets" }]
      : op === "replace" ? [{ op, id: 3, newer: 4, reason: "Current" }] : [retire(1)];
    const input = fixture(memory, changes);
    const seen: string[] = [];
    const result = await cleanFiles({ ...input, recall: async (prompt, opts) => {
      seen.push(prompt);
      return prompt.startsWith("[memory-clean:organize]") ? JSON.stringify({ verdicts: [false], corrections: [] }) : input.recall(prompt, opts);
    } });
    expect(result).toMatchObject({ ok: false, stage: "validate", detail: "source-coverage" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('"sources":');
    expect(seen[0]).toContain("same entity AND relation");
  });

  it("does not advance through unprocessed user messages at the input cap", () => {
    const paragraph = "The morning meeting discussed the garden route. ".repeat(6);
    const rows = ["Remember Mina lives in Seoul", Array(100).fill(paragraph).join("\n\n"), "Remember Jun lives in Jeju"].map((text, i) => ({ id: String(i), role: "user", kind: "text", text, at: i + 1 }));
    const result = sleepInput(rows as never, 0, 10);
    expect(result.through).toBe(1);
    expect(result.user.map((line) => line.text)).toEqual([rows[0]!.text]);
  });

  it("reserves the rotated history pointer before proposing", async () => {
    const input = fixture(`- kept\n${POINTER_LINE}\n`, []);
    let proposal = "";
    const result = await cleanFiles({ ...input, history: "한".repeat(82_000), user: [{ text: "Remember Mina lives in Seoul", at: 1, kind: "remember" }], propose: async (prompt, opts) => {
      if (prompt.startsWith("[memory-clean:propose]")) proposal = prompt;
      return input.propose(prompt, opts);
    } });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const reserved = JSON.parse(/Reserved complete candidate: (\{.*?\})\./.exec(proposal)![1]!);
    expect(result.memory).toContain("memory/memory-history-2.md");
    expect(reserved.finalBytes).toBe(Buffer.byteLength(result.memory));
    expect(reserved).toMatchObject(result.budgets[0]!);
  });

  it.each(["remembers", "protected"])("names infeasible %s without returning a candidate", async (kind) => {
    const memory = kind === "protected" ? Array.from({ length: 100 }, (_, i) => `- owned ${i} ${"x".repeat(250)}`).join("\n") : "- kept\n";
    const input = fixture(memory, []);
    const result = await cleanFiles({ ...input, typed: new Set(memory.split("\n").map(lineHash)), user: kind === "remembers" ? [{ text: `Remember ${"river ".repeat(55)}`, at: 1, kind: "remember" }] : [] });
    expect(result).toMatchObject({ ok: false, stage: "validate", detail: expect.stringContaining(`infeasible-${kind}:`) });
    expect(result).not.toHaveProperty("memory");
    expect(result).not.toHaveProperty("header");
  });

  it.each([false, true])("revalidates one organizer correction and rejects a second: %s", async (twice) => {
    const input = fixture("- Ada owns 2 cats\n- Bob owns 3 dogs\n", [{ op: "merge", ids: [1, 2], text: "- Ada owns 3 dogs; Bob owns 2 cats", reason: "Pets" }]);
    let organized = 0;
    const result = await cleanFiles({ ...input, recall: async (prompt, opts) => {
      if (!prompt.startsWith("[memory-clean:organize]")) return input.recall(prompt, opts);
      return JSON.stringify({ verdicts: [++organized > 1], corrections: organized === 1 || twice ? [{ version: 1, file: "MEMORY.md", changes: [{ op: "merge", ids: [1, 2], text: "- Ada owns 2 cats; Bob owns 3 dogs", reason: "Pets" }] }] : [] });
    } });
    expect(organized).toBe(2);
    expect(result).toMatchObject(twice ? { ok: false, stage: "validate", detail: "source-coverage" } : { ok: true });
    if (result.ok) expect(result.memory).toContain("- Ada owns 2 cats; Bob owns 3 dogs");
  });

  it.each(["questions", "route", "value"])("rejects a missing filed-fact %s", async (missing) => {
    const kept = Array.from({ length: 148 }, (_, i) => `- kept ${i}`);
    const memory = [`- Alice locker code 4417 ${"x".repeat(200)}`, `- Bob garage code 5531 ${"y".repeat(200)}`, ...kept].join("\n") + "\n";
    const input = fixture(memory, [{ op: "file", ids: [1, 2], topic: "details", pointer: "- memory/details.md: Alice locker code 4417; Bob garage code 5531", reason: "Details" }]);
    const result = await cleanFiles({ ...input, typed: new Set(kept.map(lineHash)), propose: async (prompt, opts) => {
      if (missing === "questions" && prompt.startsWith("[memory-clean:route-questions]")) return JSON.stringify(JSON.parse(sleepReply(prompt)!).slice(0, 1));
      return input.propose(prompt, opts);
    }, recall: async (prompt, opts) => {
      if (prompt.startsWith(missing === "route" ? "[memory-clean:routes]" : missing === "value" ? "[memory-clean:values]" : "[unused]")) {
        const answers = JSON.parse(sleepReply(prompt)!);
        answers[1] = null;
        return JSON.stringify(answers);
      }
      return input.recall(prompt, opts);
    } });
    expect(result).toMatchObject({ ok: false, stage: "recall", detail: missing === "questions" ? "route-coverage" : `${missing}-miss` });
  });

  it("counts both files toward the character cap and the pointer toward the line cap", async () => {
    expect(await cleanFiles(fixture(`- kept\n- ${"a".repeat(4100)}\n`, [retire(2)], { text: `- kept\n- ${"b".repeat(4100)}\n`, changes: [retire(2)] }))).toMatchObject({ ok: false, stage: "validate", detail: "cap-chars" });
    const text = Array.from({ length: 21 }, (_, i) => `- old ${i}`).join("\n");
    expect(await cleanFiles(fixture(text, Array.from({ length: 20 }, (_, i) => retire(i + 1)), { text, changes: Array.from({ length: 20 }, (_, i) => retire(i + 1)) }))).toMatchObject({ ok: false, stage: "validate", detail: "cap-lines" });
  });

  it("allows forty touched lines when the history pointer already exists", () => {
    const text = Array.from({ length: 41 }, (_, i) => `- old ${i}`).join("\n");
    expect(validateChangeList({ file: "MEMORY.md", text: `${text}\n${POINTER_LINE}`, typed: new Set(), list: {
      version: 1, file: "MEMORY.md", changes: Array.from({ length: 40 }, (_, i) => retire(i + 1)),
    } })).toMatchObject({ ok: true });
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
    const result = validateChangeList({ file: "MEMORY.md", text: `- port 9443 ${date}\n- port 8443 2026-10-01`, list: { version: 1, file: "MEMORY.md", changes: [{ op: "replace", id: 2, newer: 1, reason: "Current" }] }, typed: new Set() });
    expect(result).toMatchObject({ ok: true });
  });

  it("asks the proposer to let the newer of two conflicting values win", async () => {
    const input = fixture("- port 8443 (09-02)\n- port 9443 (10-14)\n");
    const prompts: string[] = [];
    await cleanFiles({ ...input, propose: async (prompt, opts) => {
      prompts.push(prompt);
      return input.propose(prompt, opts);
    } });
    expect(prompts[0]).toContain("Newer wins only for the same entity AND relation");
    expect(prompts[0]).toContain("only if it has no other current fact");
    expect(prompts[0]).toContain("Same date with different values means keep both");
    expect(prompts[0]).toContain("Korean lines have the same protections");
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
    expect(check(learn("sister Mina lives in Busan", "- Sister Mina lives in Busan"), typed)).toMatchObject({ ok: true, text: `- kept\n- Sister Mina lives in Busan (noted ${day(13)})\n` });
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
    const file = (ids: number[], topic = "details") => ({ op: "file", ids, topic, pointer: `- memory/${topic}.md: early details 0 and 1`, reason: "Detail" });
    const check = (text: string, change: unknown) => validateChangeList({ file: "MEMORY.md", text, typed: new Set(), list: { version: 1, file: "MEMORY.md", changes: [change] } });
    const filed = check(big, file([3, 4]));
    expect(filed).toMatchObject({ ok: true, topics: [{ file: "memory/details.md", lines: [detail(0), detail(1)] }] });
    expect(filed.ok && filed.text.split("\n").slice(0, 4)).toEqual(["- memory/details.md: early details 0 and 1", "- Never deploy on Fridays", "- deploy pending review", detail(2)]);
    expect(check(small, file([3, 4]))).toMatchObject({ ok: false, errors: [{ reason: "op-not-allowed" }] });
    for (const id of [1, 2]) expect(check(big, file([id, 3]))).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "protected" })]) });
    expect(check(big, file([3], "memory-history"))).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "op-not-allowed" })]) });
  });
});
