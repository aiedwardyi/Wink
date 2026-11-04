import { describe, expect, it, vi } from "vitest";

import { cleanFiles } from "./memory-clean-engine.ts";
import type { Change, ChangeList, CleanFile, TextCall } from "./memory-clean-types.ts";
import { pointerLine, protectedLines, validateChangeList } from "./memory-clean-validate.ts";

const load = () => import("./memory-clean-recall.ts");
const retire = (id: number): Change => ({ op: "retire", id, reason: "Completed" });
const keys = Array.from({ length: 18 }, (_, i) => i < 16 ? `value ${i}` : null);
const questions = (key = keys) => key.map((answer, i) => ({ kind: i < 12 ? "changed" : i < 16 ? "protected" : "absent", question: `Fact ${i}?`, answer }));
const pairs = (prompt: string) => JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)) as unknown[];

function calls(lists: Partial<Record<CleanFile, Change[]>>, answers: unknown[] = keys, key = keys) {
  const propose = vi.fn<TextCall>(async (prompt) => {
    if (prompt.startsWith("[memory-clean:questions]")) return JSON.stringify(questions(key));
    if (prompt.startsWith("[memory-clean:grade]")) return JSON.stringify(pairs(prompt).map(() => true));
    const file = /"file":"([^"]+)"/.exec(prompt)![1] as CleanFile;
    return JSON.stringify({ version: 1, file, changes: lists[file] ?? [] });
  });
  const recall = vi.fn<TextCall>(async () => JSON.stringify(answers));
  const prompts = (tag: string) => [...propose.mock.calls, ...recall.mock.calls].map(([prompt]) => prompt).filter((prompt) => prompt.startsWith(`[memory-clean:${tag}]`));
  return { propose, recall, prompts };
}

const scoped = [
  "# Projects", "- alpha 2026-01-02", "", "- beta done", "- gamma one", "- gamma two", "- delta", "- filler a", "- filler b",
  "## Later", "- Never touch epsilon", "- zeta", "- beta done", "- eta", "", "- theta old", "- Always iota", "- kappa", "- theta new",
  "- Never lambda", "- Never mu", "- Never nu", "- Never xi",
].join("\n");
const scopedList: ChangeList = { version: 1, file: "MEMORY.md", changes: [
  { op: "merge", ids: [5, 6], text: "- gamma one two", reason: "Same subject" }, retire(4), { op: "replace", id: 16, newer: 19, reason: "Current" },
] };

describe("recall scope", () => {
  it("keeps changed, newer, exact twin, neighbors, heading and four protected lines, never blanks", async () => {
    const { recallScope } = await load();
    const ids = recallScope(scoped, scopedList, new Set());
    expect(ids).toEqual([1, 2, 4, 5, 6, 7, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 21]);
    const guarded = protectedLines(scoped, new Set());
    expect(ids.filter((id) => guarded.has(id))).toEqual([11, 17, 20, 21]);
  });

  it("marks skipped runs and shows the scope after the change", async () => {
    const { afterExcerpt, excerpt, recallScope } = await load();
    const ids = recallScope(scoped, scopedList, new Set());
    expect(excerpt(scoped, ids)).toBe([
      "# Projects", "- alpha 2026-01-02", "- beta done", "- gamma one", "- gamma two", "- delta", "…", "## Later", "- Never touch epsilon", "- zeta",
      "- beta done", "- eta", "- theta old", "- Always iota", "- kappa", "- theta new", "- Never lambda", "- Never mu", "…",
    ].join("\n"));
    const result = validateChangeList({ file: "MEMORY.md", text: scoped, list: scopedList, typed: new Set() });
    if (!result.ok) throw new Error("Fixture failed");
    expect(afterExcerpt(scoped, ids, result.entries)).toBe([
      "# Projects", "- alpha 2026-01-02", "- gamma one two", "- delta", "…", "## Later", "- Never touch epsilon", "- zeta",
      "- beta done", "- eta", "- Always iota", "- kappa", "- theta new", "- Never lambda", "- Never mu", "…",
    ].join("\n"));
  });

  it("keeps a side-file pair's recall prompts inside the scope and out of history", async () => {
    const { recallScope } = await load();
    const memory = ["# Memory", ...Array.from({ length: 180 }, (_, i) => `- ${(i + 2) % 30 ? "" : "Never "}m${String(i + 2).padStart(4, "0")} ${"memo ".repeat(23)}`)].join("\n") + "\n";
    const side = ["# Queue", ...Array.from({ length: 400 }, (_, i) => `- ${(i + 2) % 50 ? "" : "Never "}q${String(i + 2).padStart(4, "0")} ${"task ".repeat(39)}`)].join("\n") + "\n";
    expect([Math.round(Buffer.byteLength(memory) / 1000), Math.round(Buffer.byteLength(side) / 1000)]).toEqual([22, 82]);
    const lists = { "MEMORY.md": [{ op: "merge", ids: [109, 110], text: "- m0109 m0110 merged", reason: "Same subject" }], "memory/queued.md": [retire(24), retire(67), retire(138)] } satisfies Partial<Record<CleanFile, Change[]>>;
    const engine = calls(lists);
    const history = `HISTORY-MARKER ${"h".repeat(200_000)}`;
    expect(await cleanFiles({ memory, side: { file: "memory/queued.md", text: side }, history, typed: new Set(), ...engine })).toMatchObject({ ok: true });
    const outside = ([["MEMORY.md", memory], ["memory/queued.md", side]] as const).flatMap(([file, text]) => {
      const ids = new Set(recallScope(text, { version: 1, file, changes: lists[file] }, new Set()));
      return text.split("\n").filter((line, i) => line.trim() && !ids.has(i + 1));
    });
    for (const prompt of [...engine.prompts("questions"), ...engine.prompts("answers")]) {
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(20_000);
      expect(outside.filter((line) => prompt.includes(line))).toEqual([]);
    }
    expect(engine.prompts("answers")[0]).not.toContain("HISTORY-MARKER");
    expect(engine.prompts("answers")[0]).toContain("- m0109 m0110 merged");
  });
});

describe("recall grading", () => {
  const input = (engine: ReturnType<typeof calls>) => ({ memory: "- kept\n- old\n", history: null, typed: new Set<string>(), ...engine });

  it("grades exact and null pairs in code", async () => {
    const { gradeByCode } = await load();
    expect(gradeByCode(null, null)).toBe(true);
    expect(gradeByCode(null, "x")).toBe(false);
    expect(gradeByCode("x", null)).toBe(false);
    expect(gradeByCode('`Path` "C:\\repo" [main].', "path  c:\\repo main")).toBe(true);
    expect(gradeByCode("Eddie", "Eddie Yi")).toBeUndefined();
  });

  it("drops words the question already names from the key", async () => {
    const { gradeByCode } = await load();
    const question = "Which version is Tern on?";
    expect(gradeByCode("Tern 2.3", "2.3", question)).toBe(true);
    expect(gradeByCode("Tern 2.3", "2.4", question)).not.toBe(true);
    expect(gradeByCode("Tern 2.3", "Tern", question)).not.toBe(true);
    expect(gradeByCode(null, "2.3", question)).toBe(false);
    expect(gradeByCode("Tern, version", "", question)).not.toBe(true);
    expect(gradeByCode("Tern, version", "on", question)).not.toBe(true);
  });

  it("passes a key that repeats the question without a grade call", async () => {
    const key = ["Fact 0: 2.3", ...keys.slice(1)];
    const engine = calls({ "MEMORY.md": [retire(2)] }, ["2.3", ...keys.slice(1)], key);
    expect(await cleanFiles(input(engine))).toMatchObject({ ok: true });
    expect(engine.prompts("grade")).toEqual([]);
  });

  it("passes 18 exact answers without a grade call", async () => {
    const engine = calls({ "MEMORY.md": [retire(2)] });
    expect(await cleanFiles(input(engine))).toMatchObject({ ok: true, recall: { passed: 18 } });
    expect(engine.prompts("grade")).toEqual([]);
    expect(engine.prompts("answers")[0]).toContain("each just the asked value with no extra detail");
  });

  it("sends only an undecided paraphrase to the grade call", async () => {
    const engine = calls({ "MEMORY.md": [retire(2)] }, ["it is value 0", ...keys.slice(1)]);
    expect(await cleanFiles(input(engine))).toMatchObject({ ok: true });
    expect(engine.prompts("grade").map(pairs)).toEqual([[{ question: "Fact 0?", expected: "value 0", actual: "it is value 0" }]]);
  });

  it("fails a null answer to a keyed question without a grade call", async () => {
    const engine = calls({ "MEMORY.md": [retire(2)] }, [null, ...keys.slice(1)]);
    expect(await cleanFiles(input(engine))).toMatchObject({ ok: false, stage: "recall" });
    expect(engine.prompts("grade")).toEqual([]);
  });

  it("joins an array answer", async () => {
    const key = ["A, B", ...keys.slice(1)];
    const engine = calls({ "MEMORY.md": [retire(2)] }, [["A", "B"], ...keys.slice(1)], key);
    expect(await cleanFiles(input(engine))).toMatchObject({ ok: true });
    expect(engine.prompts("grade")).toEqual([]);
  });

  it("stops a 300 KB side file on budget before its propose call", async () => {
    const engine = calls({ "MEMORY.md": [retire(2)], "memory/queued.md": [retire(2)] });
    const side = { file: "memory/queued.md" as const, text: `- kept\n- old\n${"- task line\n".repeat(25_000)}` };
    expect(await cleanFiles({ ...input(engine), side })).toEqual({ ok: false, stage: "nothing", detail: "budget" });
    expect(engine.prompts("propose").map((prompt) => /"file":"([^"]+)"/.exec(prompt)?.[1])).toEqual(["MEMORY.md"]);
  });
});

describe("bare pointers", () => {
  it("protects a bare side-file name but not MEMORY.md", () => {
    const result = validateChangeList({ file: "MEMORY.md", text: "## memory/\n- queued.md: open tasks\n- kept", list: { version: 1, file: "MEMORY.md", changes: [retire(2)] }, typed: new Set() });
    expect(result).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.objectContaining({ reason: "protected" })]) });
    expect(pointerLine("- MEMORY.md holds the facts")).toBe(false);
  });
});
