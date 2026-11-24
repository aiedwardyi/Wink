import { describe, expect, it } from "vitest";

import { applyMove, FILE_NIGHT_BYTES, fileableNotes, filingDue, filingPrompt, misrouted, movePlan, movePlanSchema, parseFiling, planFiling, routePrompt } from "./memory-file.ts";

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

describe("secret skip", () => {
  const LABELLED = "- Router login for the upstairs box\n  sunflowerfield";
  const COST = "- Daily spend limit is $5 for research runs";
  const raw = memory(["## Decisions", ["- Ship Fridays"]], ["## Notes", [LABELLED, COST, ...Array.from({ length: 110 }, (_, n) => note(n))]]);
  const [labelled, cost] = fileableNotes(raw);

  it("keeps a label line and the value on its indented line out of the filer prompt and the filing, and still files a cost note", () => {
    expect([labelled!.text, cost!.text]).toEqual([LABELLED, COST]);
    const prompt = filingPrompt(fileableNotes(raw), 4_000);
    expect(prompt).not.toContain("sunflowerfield");
    expect(prompt).toContain(COST.slice(2));
    const plan = planFiling(raw, reply({ topic: "home.md", about: "Home and budget", when: "before planning a purchase", notes: [`L${labelled!.at + 1}`, `L${cost!.at + 1}`] }), []);
    expect(plan?.memory).toContain(LABELLED);
    expect(plan?.filed.flatMap(({ notes }) => notes.map(({ text }) => text))).toEqual([COST]);
  });
});

describe("one topic and a safe Move", () => {
  const raw = memory(["## Decisions", ["- Ship Fridays"]], ["## Notes", Array.from({ length: 120 }, (_, n) => note(n))]);
  const notes = fileableNotes(raw);
  const ref = (at: number) => `L${notes[at]!.at + 1}`;
  const launch = reply({ topic: "launch.md", about: "Launch work", when: "before launch work", notes: [ref(0), ref(1)] });
  const filing = planFiling(raw, launch, [])!;
  const plan = movePlan(raw, filing, "0a1b2c3d");

  it("plans one topic when the night allows one, in the prompt, the schema and the plan together", () => {
    const topics = (...names: string[]) => reply(...names.map((name, at) => ({ topic: `${name}.md`, about: `About ${name}`, when: `before ${name} work`, notes: [ref(at)] })));
    const [two, three] = [topics("alpha", "beta"), topics("alpha", "beta", "gamma")];
    expect(filingPrompt(notes, 4_000, [], 1)).toContain("in at most 1 topic, ");
    expect(filingPrompt(notes, 4_000)).toContain("in at most 3 topics, ");
    expect(planFiling(raw, two, [], { topics: 1 })?.filed.map(({ topic }) => topic)).toEqual(["alpha.md"]);
    expect(planFiling(raw, three, [])?.filed).toHaveLength(3);
    expect(parseFiling(three, 1)).toEqual({});
  });

  it("writes plan.json with shas, match counts, targets, one pointer and bytes, never note text", () => {
    expect(movePlanSchema.parse(plan)).toEqual(plan);
    expect(plan.notes.map(({ matches, target, pointer, bytes }) => [matches, target, pointer !== null, bytes])).toEqual([[1, "memory/launch.md", true, 188], [1, "memory/launch.md", false, 188]]);
    expect(JSON.stringify(plan)).not.toContain("Detail 0");
  });

  it("applies a plan as the filing it came from", () => {
    const moved = applyMove(raw, {}, plan);
    expect([moved.memory, moved.side, moved.skipped, moved.bytes]).toEqual([filing.memory, filing.topics, 0, 376]);
  });

  it("changes nothing on a second run, and a lost tie appends nothing again", () => {
    const once = applyMove(raw, {}, plan);
    const twice = applyMove(once.memory, once.side, plan);
    expect([twice.memory, twice.side, twice.moved, twice.skipped]).toEqual([once.memory, once.side, [], 2]);
    // the side file kept the notes while MEMORY.md lost the tie and still holds them
    const tie = applyMove(raw, once.side, plan);
    expect([tie.memory, tie.side]).toEqual([once.memory, once.side]);
  });

  it("skips a note changed or doubled since the plan", () => {
    const changed = applyMove(raw.replace(note(0), `${note(0)} edited`), {}, plan);
    expect([changed.skipped, changed.moved.map(({ sha8 }) => sha8)]).toEqual([1, [plan.notes[1]!.sha256.slice(0, 8)]]);
    expect(changed.side["launch.md"]).not.toContain("Detail 0 ");
    expect(applyMove(raw.replace(note(1), `${note(1)}\n${note(1)}`), {}, plan).skipped).toBe(1);
  });

  it("re-points an existing side file no line points at, appending to it", () => {
    expect(planFiling(raw, launch, ["launch.md"])).toBeNull();
    const repointed = planFiling(raw, launch, ["launch.md"], { repoint: ["launch.md"] })!;
    const moved = applyMove(raw, { "launch.md": "- Older launch note\n" }, movePlan(raw, repointed, "0a1b2c3d"));
    expect(moved.side["launch.md"]).toBe(`- Older launch note\n${note(0)}\n${note(1)}\n`);
    expect(moved.memory).toContain("- Launch work: read memory/launch.md before launch work.");
  });
});
