import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseTidy, planTidy } from "../server/memory-sleep.ts";
import { isMemoryTopicName, loadedMemory } from "../server/workspace.ts";
import { lostFacts, madeUp, movedBlocks, parseQuestions, pointedTopics, scoreQuiz, TRAP_MEMORY, TRAP_REPLY } from "./dream-check.ts";

const SCRIPT = fileURLToPath(new URL("./dream-check.ts", import.meta.url));
const memory = (...lines) => `# Memory\n\n${lines.join("\n")}\n`;
const NOTES = ["- Lives in Seoul (noted 2026-11-01)", "- Uses pnpm", "- Allergic to peanuts"];
const history = (...entries) => `# Memory history\n\n## 2026-11-23 03:00\n${entries.join("\n")}\n`;
const RULES = { loaded: (raw) => loadedMemory(raw).text, synced: isMemoryTopicName };
const notes = (text, side = {}) => ({ memory: text, side });
const BEFORE = notes(memory(...NOTES));
const POINTER = "- Tools: read memory/tools.md before running a build.";

describe("lostFacts", () => {
  it("finds the line a tidy dropped", () => {
    expect(lostFacts(BEFORE, notes(memory(NOTES[0], NOTES[2])), RULES)).toEqual(["Uses pnpm"]);
  });

  it("keeps a line merged into its newer stamped twin", () => {
    expect(lostFacts(BEFORE, notes(memory("- Lives in Seoul. (noted 2026-11-20)", NOTES[1], NOTES[2])), RULES)).toEqual([]);
  });

  it("counts a line only the history holds as lost", () => {
    const after = notes(memory(NOTES[0], NOTES[2]), { "memory-history/2026-11.md": history('- "Uses pnpm" replaced by "Uses pnpm 9", 2026-11-23 (duplicate)') });
    expect(lostFacts(BEFORE, after, RULES)).toEqual(["Uses pnpm"]);
  });

  it("keeps a line in a side file only when a loaded line says when to read it", () => {
    const side = { "memory/tools.md": "# Tools\n\n* Uses  pnpm\n" };
    expect(lostFacts(BEFORE, notes(memory(NOTES[0], NOTES[2], POINTER), side), RULES)).toEqual([]);
    expect(lostFacts(BEFORE, notes(memory(NOTES[0], NOTES[2], "- Tools: read memory\\tools.md. Read it before any build"), side), RULES)).toEqual([]);
    expect(lostFacts(BEFORE, notes(memory(NOTES[0], NOTES[2], "- memory/tools.md"), side), RULES)).toEqual(["Uses pnpm"]);
    expect(lostFacts(BEFORE, notes(memory(NOTES[0], NOTES[2], "- Tools: memory/tools.md"), side), RULES)).toEqual(["Uses pnpm"]);
    expect(lostFacts(BEFORE, notes(memory(NOTES[0], NOTES[2], "- Read imported.md before a build"), { "imported.md": "- Uses pnpm\n" }), RULES)).toEqual(["Uses pnpm"]);
    const cut = memory(NOTES[0], NOTES[2], ...Array.from({ length: 200 }, (_, n) => `- Filler ${n}`), POINTER);
    expect(lostFacts(BEFORE, notes(cut, side), RULES)).toEqual(["Uses pnpm"]);
  });
});

describe("pointedTopics", () => {
  it("names the side files a sentence says when to read", () => {
    const text = ["- Video rules: read memory/video.md before making a clip.", "- memory/bare.md", "- Launch notes in memory/launch.md. Read them when planning a post."].join("\n");
    expect(pointedTopics(text, ["video.md", "bare.md", "launch.md", "other.md"])).toEqual(["video.md", "launch.md"]);
  });
});

describe("madeUp", () => {
  it("finds a line the tidy added", () => {
    expect(madeUp(BEFORE, notes(memory(...NOTES, "- Uses yarn")))).toEqual(["Uses yarn"]);
  });

  it("allows only a pointer that says when to read a side file that took lines from MEMORY.md", () => {
    const side = { "memory/tools.md": "- Uses pnpm\n" };
    expect(madeUp(BEFORE, notes(memory(NOTES[0], NOTES[2], POINTER), side))).toEqual([]);
    expect(madeUp(BEFORE, notes(memory(NOTES[0], NOTES[2], "- See memory/tools.md"), side))).toEqual(["See memory/tools.md"]);
    expect(madeUp(BEFORE, notes(memory(...NOTES, POINTER), { "memory/tools.md": "" }))).toEqual([POINTER.slice(2).replace(/\.$/, "")]);
    expect(madeUp(BEFORE, notes(memory(NOTES[0], NOTES[2], POINTER), { "memory/tools.md": "- Uses pnpm\n- Uses yarn\n" }))).toEqual(["Uses yarn"]);
  });
});

describe("blind quiz", () => {
  const blocks = [{ path: "memory/tools.md", lines: ["- Uses pnpm"] }];

  it("finds the lines each side file took from MEMORY.md", () => {
    const before = notes(memory(...NOTES), { "memory/tools.md": "- Allergic to peanuts\n" });
    const after = notes(memory(NOTES[0], POINTER), { "memory/tools.md": "- Allergic to peanuts\n- Uses pnpm\n- Allergic to peanuts\n", "imported.md": "- Uses pnpm\n" });
    expect(movedBlocks(before, after)).toEqual(blocks);
  });

  it("passes a question only when the answerer names the block's side file", () => {
    const questions = parseQuestions('Sure: {"B1": ["Which package manager?", "What runs installs?", "About to install a dependency: which tool?", "extra"]}', blocks);
    expect(questions).toEqual([["Which package manager?", "What runs installs?", "About to install a dependency: which tool?"]]);
    expect(scoreQuiz(blocks, questions, '{"Q1": "memory/tools.md", "Q2": "`memory\\\\Tools.md`", "Q3": "MEMORY.md"}')).toEqual({
      asked: 3,
      right: 2,
      misses: [{ path: "memory/tools.md", question: "About to install a dependency: which tool?", answer: "MEMORY.md" }],
    });
  });

  it("fails a block the writer gave too few questions", () => {
    const questions = parseQuestions("not json", blocks);
    expect(scoreQuiz(blocks, questions, "{}")).toMatchObject({ asked: 3, right: 0 });
    expect(scoreQuiz(blocks, questions, "{}").misses).toHaveLength(3);
  });
});

describe("trap pairs", () => {
  it("moves none of the pairs that both hold, even when the model proposes every one", () => {
    const { duplicates, disagree } = parseTidy(TRAP_REPLY);
    expect([duplicates?.length, disagree?.length]).toEqual([20, 10]);
    expect(planTidy(TRAP_MEMORY, TRAP_REPLY)).toEqual([]);
  });
});

describe("dream-check script", () => {
  const run = (copy, ...args) => {
    const tmp = mkdtempSync(join(homedir(), "tmp-"));
    // run as a user would: outside Vitest's data guard, with its throwaway data dir under the test home
    const { VITEST: _vitest, ...env } = process.env;
    return spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, copy, ...args], { encoding: "utf8", env: { ...env, TMP: tmp, TEMP: tmp, TMPDIR: tmp } });
  };

  it("runs one real tidy on a copy and reports nothing lost", () => {
    const copy = mkdtempSync(join(homedir(), "orbit-copy-"));
    mkdirSync(join(copy, "workspaces", "bot-a"), { recursive: true });
    writeFileSync(join(copy, "bots.json"), JSON.stringify([{ id: "bot-a", name: "Alpha" }]));
    writeFileSync(join(copy, "workspaces", "bot-a", "MEMORY.md"), memory("- Uses pnpm (noted 2026-11-01)", "- Lives in Seoul", "- Uses pnpm (noted 2026-11-20)"));
    const json = join(copy, "out.json");
    const result = run(copy, "--no-model", "--json", json);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const [row, trap] = JSON.parse(readFileSync(json, "utf8")).results;
    expect(row).toMatchObject({ name: "Alpha", result: "saved", moved: 1, linesBefore: 5, linesAfter: 4, lost: [], madeUp: [], quiz: { asked: 0, right: 0 }, conflicts: 0 });
    expect(trap).toMatchObject({ trap: true, proposed: 30, moved: 0, lost: [] });
    expect(readFileSync(join(copy, "workspaces", "bot-a", "MEMORY.md"), "utf8")).toContain("(noted 2026-11-01)");
  });

  it("refuses the live ~/.orbit", () => {
    const live = join(homedir(), ".orbit");
    mkdirSync(join(live, "workspaces"), { recursive: true });
    const result = run(live, "--no-model");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is the live ~/.orbit; copy it first");
  });
});
