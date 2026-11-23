import { describe, expect, it } from "vitest";

import { FILE_NIGHT_BYTES, fileableNotes, filingDue, filingPrompt, misrouted, planFiling, routePrompt } from "./memory-file.ts";

const note = (n: number, length = 190) => `- Detail ${n} ${"x".repeat(length - 12 - String(n).length)}`;
const memory = (...sections: Array<[string, string[]]>) => ["# Bot memory", "", ...sections.flatMap(([heading, lines]) => [heading, ...lines, ""])].join("\n");
const reply = (...files: Array<{ topic: string; about?: string; when?: string; notes: string[] }>) =>
  JSON.stringify({ files: files.map((each) => ({ about: "Launch details", when: "before planning a launch post", ...each })) });
const refs = (raw: string, from: number, to: number) => fileableNotes(raw).slice(from, to).map(({ at }) => `L${at + 1}`);
const big = (count: number) => memory(["## Decisions", ["- Ship Fridays"]], ["## Notes", Array.from({ length: count }, (_, n) => note(n))]);

describe("filingDue", () => {
  it("starts past 80% of the load budget and, once started, goes on down to 16 KB and 140 lines", () => {
    expect(filingDue("x".repeat(19_199))).toBe(false);
    expect(filingDue("x".repeat(19_200))).toBe(true);
    expect(filingDue("x\n".repeat(160))).toBe(true);
    expect(filingDue("x".repeat(17_000), true)).toBe(true);
    expect(filingDue("x".repeat(16_000), true)).toBe(false);
    expect(filingDue("x\n".repeat(150), true)).toBe(true);
  });
});

describe("fileableNotes", () => {
  it("files whole notes under a heading, never standing orders, labels, pointers or code", () => {
    const raw = [
      "# Bot memory",
      "- Header note",
      "## Decisions (settled)",
      "- Picked pnpm",
      "## Rules",
      "### Replies",
      "- Short replies",
      "## Pinned",
      "- Keep this",
      "## Goals",
      "- Launch by Friday",
      "## Project",
      "Launch steps:",
      "- Build the site",
      "  then deploy it",
      "- Video notes: read memory/video.md before a clip.",
      "```",
      "npm run build",
      "```",
      "Plain line\r",
      "### Machines\r",
      "- Home PC runs evals",
      "",
      "  an indented line after a blank",
    ].join("\n");
    expect(fileableNotes(raw).map(({ text, section }) => [text, section])).toEqual([
      ["- Build the site\n  then deploy it", "## Project"],
      ["Plain line\r", "## Project"],
    ]);
  });

  it("keeps a code block open until a fence of its own mark closes it", () => {
    const raw = ["# Bot memory", "## Project", "~~~~md", "```", "- inside the tildes", "~~~", "- still inside", "~~~~", "- after the block"].join("\n");
    expect(fileableNotes(raw).map(({ text }) => text)).toEqual(["- after the block"]);
  });

  it("sees code fences in a CRLF file", () => {
    const raw = ["# Bot memory", "## Project", "~~~~md", "```", "- inside the tildes", "~~~", "- still inside", "~~~~", "- after the block"].join("\r\n");
    expect(fileableNotes(raw).map(({ text }) => text)).toEqual(["- after the block"]);
  });
});

describe("planFiling", () => {
  it("moves the picked notes word for word into a new side file behind one pointer that says when", () => {
    const raw = big(110);
    const picked = refs(raw, 0, 3);
    const plan = planFiling(raw, reply({ topic: "launch.md", notes: picked }), [])!;
    const lines = raw.split("\n");
    expect(plan.filed).toMatchObject([{ topic: "launch.md", pointer: "- Launch details: read memory/launch.md before planning a launch post.", lines: [note(0), note(1), note(2)] }]);
    expect(plan.filed[0]!.notes).toEqual(picked.map((ref, n) => ({ ref, text: note(n) })));
    expect(plan.topics).toEqual({ "launch.md": `${note(0)}\n${note(1)}\n${note(2)}\n` });
    expect(plan.memory.split("\n")).toEqual(lines.flatMap((line, index) => (line === note(0) ? [plan.filed[0]!.pointer] : index === lines.indexOf(note(1)) || index === lines.indexOf(note(2)) ? [] : [line])));
    expect(plan.bytes).toBe([0, 1, 2].reduce((sum, n) => sum + note(n).length + 1, 0));
  });

  it("files at most 4,000 bytes a night and stops at 16 KB", () => {
    const raw = big(110);
    const plan = planFiling(raw, reply({ topic: "a.md", notes: refs(raw, 0, 40) }), [])!;
    expect(plan.bytes).toBeLessThanOrEqual(FILE_NIGHT_BYTES);
    expect(plan.bytes).toBeGreaterThan(FILE_NIGHT_BYTES - 191);
    const near = big(86);
    const last = planFiling(near, reply({ topic: "a.md", notes: refs(near, 0, 40) }), [])!;
    expect(Buffer.byteLength(last.memory)).toBeLessThanOrEqual(16_000);
    expect(Buffer.byteLength(last.memory)).toBeGreaterThan(16_000 - 191);
  });

  it("keeps a CRLF file's line endings", () => {
    const raw = big(110).replaceAll("\n", "\r\n");
    const plan = planFiling(raw, reply({ topic: "a.md", notes: refs(raw, 0, 2) }), [])!;
    expect(plan.memory).toContain("- Launch details: read memory/a.md before planning a launch post.\r\n");
    expect(plan.memory.split("\n").every((line, index, all) => index === all.length - 1 || line.endsWith("\r"))).toBe(true);
  });

  it("adds notes to a side file MEMORY.md already says when to read, with no new pointer", () => {
    const raw = big(110);
    const files = [{ name: "launch.md", line: "- Launch: read memory/launch.md before any launch post." }, { name: "old.md", line: "- Never act on memory/old.md." }];
    const plan = planFiling(raw, JSON.stringify({ files: [{ topic: "memory/Launch.md", notes: refs(raw, 0, 2) }, { topic: "old.md", notes: refs(raw, 2, 4) }] }), ["launch.md", "old.md"], { files })!;
    expect(plan.filed).toMatchObject([{ topic: "launch.md", pointer: null, lines: [note(0), note(1)] }]);
    expect(plan.memory).not.toContain("memory/");
    expect(plan.memory.split("\n")).toHaveLength(raw.split("\n").length - 2);
    expect(filingPrompt(fileableNotes(raw), 4000, files)).toContain("memory/launch.md: - Launch: read memory/launch.md before any launch post.");
    expect(filingPrompt(fileableNotes(raw), 4000, files)).not.toContain("memory/old.md");
  });

  it("files only the notes a fresh reader of MEMORY.md would look for in their file", () => {
    const raw = big(110);
    const picked = refs(raw, 0, 3);
    const reply1 = JSON.stringify({ files: [{ topic: "a.md", about: "Launch details", when: "before planning a launch post", notes: picked.slice(0, 2) }, { topic: "b.md", about: "Video notes", when: "before cutting a clip", notes: picked.slice(2) }] });
    const candidates = planFiling(raw, reply1, [], { nightBytes: Infinity })!;
    const prompt = routePrompt(candidates.memory, candidates.filed);
    expect(prompt).toContain(`N3: ${note(2)}`);
    expect(prompt).toContain("read memory/b.md before cutting a clip");
    const skip = misrouted('{"N1": "`memory\\\\A.md`", "N2": "MEMORY.md", "N3": "memory/b.md"}', candidates.filed);
    expect([...skip]).toEqual([picked[1]]);
    expect(planFiling(raw, reply1, [], { skip })!.filed.map(({ topic, lines }) => [topic, lines])).toEqual([["a.md", [note(0)]], ["b.md", [note(2)]]]);
    expect([...misrouted("no json", candidates.filed)]).toEqual(picked);
  });

  it("files nothing for a name that is taken, not ASCII, or a pointer that never says when", () => {
    const raw = big(110);
    const notes = refs(raw, 0, 2);
    expect(planFiling(raw, reply({ topic: "taken.md", notes }), ["Taken.md"])).toBeNull();
    expect(planFiling(raw, reply({ topic: "출시.md", notes }), [])).toBeNull();
    expect(planFiling(raw, reply({ topic: "../a.md", notes }), [])).toBeNull();
    expect(planFiling(raw, reply({ topic: "a.md", when: "launch posts", notes }), [])).toBeNull();
    expect(planFiling(raw, reply({ topic: "a.md", notes: ["L3", "L999"] }), [])).toBeNull();
    expect(planFiling(raw, "not json", [])).toBeNull();
  });
});
