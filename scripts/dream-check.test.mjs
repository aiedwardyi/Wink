import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { fileableNotes, filingDue, planFiling } from "../server/memory-file.ts";
import { parseTidy, planTidy } from "../server/memory-sleep.ts";
import { testHome } from "../server/testing/test-home.ts";
import { isMemoryTopicName, loadedMemory } from "../server/workspace.ts";
import { nightSummarySchema } from "../server/memory-clean.ts";
import { sendsValue } from "../server/testing/secret-cases.ts";
import { lostFacts, madeUp, movedBlocks, parseQuestions, pointedTopics, scoreQuiz, TRAP_MEMORY, TRAP_REPLY } from "./dream-check.ts";

const SCRIPT = fileURLToPath(new URL("./dream-check.ts", import.meta.url));
const STUB = fileURLToPath(new URL("./testing/dream-stub-claude.mjs", import.meta.url));
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

  it("matches the whole path, not a longer one that starts or ends with it", () => {
    expect(pointedTopics("- Read memory/tools.md.bak before builds", ["tools.md"])).toEqual([]);
    expect(pointedTopics("- Read old/memory/tools.md before builds", ["tools.md"])).toEqual([]);
    expect(pointedTopics("- Read memory/tools.md/old before builds", ["tools.md"])).toEqual([]);
    for (const line of ["- Read memory/tools.md.", "- Read `memory/tools.md` before builds", "- Read ./memory/tools.md before builds", '- Before builds read "memory/tools.md"', "- 빌드 전에 memory/tools.md를 읽기"]) {
      expect(pointedTopics(`${line} before builds`, ["tools.md"])).toEqual(["tools.md"]);
    }
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
    expect(movedBlocks(before, after)).toEqual([{ path: "memory/tools.md", lines: ["- Allergic to peanuts", "- Uses pnpm"] }]);
  });

  it("quizzes a filed note even when its side file already held it", () => {
    const before = notes(memory(...NOTES), { "memory/tools.md": "- Uses pnpm\n" });
    const after = notes(memory(NOTES[0], NOTES[2], POINTER), { "memory/tools.md": "- Uses pnpm\n- Uses pnpm\n" });
    expect(movedBlocks(before, after)).toEqual(blocks);
    expect(madeUp(before, after)).toEqual([]);
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

describe("budget filing", () => {
  it("leaves every filed line reached, nothing made up, and a pointer the memory check reads as saying when", () => {
    const raw = memory("## Decisions", "- Ship Fridays", "", "## Notes", ...Array.from({ length: 110 }, (_, n) => `- Launch detail ${n} ${"y".repeat(170)}`));
    const picked = fileableNotes(raw).slice(0, 4).map(({ at }) => `L${at + 1}`);
    const plan = planFiling(raw, JSON.stringify({ files: [{ topic: "launch.md", about: "Launch details", when: "before planning a launch post", notes: picked }] }), []);
    const before = notes(raw);
    const after = notes(plan.memory, { "memory/launch.md": plan.topics["launch.md"] });
    expect(lostFacts(before, after, RULES)).toEqual([]);
    expect(madeUp(before, after)).toEqual([]);
    expect(movedBlocks(before, after)).toEqual([{ path: "memory/launch.md", lines: plan.filed[0].lines }]);
    expect(pointedTopics(plan.filed[0].pointer, ["launch.md"])).toEqual(["launch.md"]);
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
  const runIn = (tmp, extra, copy, ...args) => {
    const home = testHome();
    // run as a user would: outside Vitest's data guard, with its home and throwaway data dir in the test home
    const { VITEST: _vitest, ...env } = process.env;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, copy, ...args], {
      encoding: "utf8",
      env: { ...env, HOME: home, USERPROFILE: home, TMP: tmp, TEMP: tmp, TMPDIR: tmp, ...extra },
    });
    return { ...result, left: readdirSync(tmp) };
  };
  const runWith = (extra, copy, ...args) => runIn(mkdtempSync(join(testHome(), "tmp-")), extra, copy, ...args);
  const run = (copy, ...args) => runWith({}, copy, ...args);
  // a zero cap fails every model call before it starts: no claude process, no spend
  const capped = (copy, ...args) => runWith({ CLAUDE_CODE_OAUTH_TOKEN: "unused", CLAUDE_CLI: join(testHome(), "no-claude") }, copy, "--max-tokens", "0", ...args);
  const copyOf = (raw, setup = () => {}) => {
    const copy = mkdtempSync(join(testHome(), "orbit-copy-"));
    mkdirSync(join(copy, "workspaces", "bot-a"), { recursive: true });
    writeFileSync(join(copy, "bots.json"), JSON.stringify([{ id: "bot-a", name: "Alpha" }]));
    writeFileSync(join(copy, "workspaces", "bot-a", "MEMORY.md"), raw);
    setup(join(copy, "workspaces", "bot-a"));
    return copy;
  };
  const DUPES = memory("- Uses pnpm (noted 2026-11-01)", "- Lives in Seoul", "- Uses pnpm (noted 2026-11-20)");

  it("runs one real tidy on a copy and reports nothing lost", () => {
    const copy = mkdtempSync(join(testHome(), "orbit-copy-"));
    mkdirSync(join(copy, "workspaces", "bot-a"), { recursive: true });
    writeFileSync(join(copy, "bots.json"), JSON.stringify([{ id: "bot-a", name: "Alpha" }]));
    writeFileSync(join(copy, "workspaces", "bot-a", "MEMORY.md"), memory("- Uses pnpm (noted 2026-11-01)", "- Lives in Seoul", "- Uses pnpm (noted 2026-11-20)"));
    const json = join(copy, "out.json");
    const result = run(copy, "--no-model", "--detail", json);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const [row, trap] = JSON.parse(readFileSync(json, "utf8")).results;
    expect(row).toMatchObject({ name: "Alpha", result: "saved", moved: 1, linesBefore: 5, linesAfter: 4, lost: [], madeUp: [], quiz: { asked: 0, right: 0 }, undone: { asked: 0 }, conflicts: 0 });
    expect(trap).toMatchObject({ trap: true, proposed: 30, moved: 0, lost: [] });
    expect(readFileSync(join(copy, "workspaces", "bot-a", "MEMORY.md"), "utf8")).toContain("(noted 2026-11-01)");
  });

  it("refuses the live ~/.orbit", () => {
    const live = join(testHome(), ".orbit");
    mkdirSync(join(live, "workspaces"), { recursive: true });
    const result = run(live, "--no-model");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("is the live ~/.orbit; copy it first");
  });

  it("says to copy first when the copy is missing, not ENOENT", () => {
    const result = run(join(testHome(), "no-such-copy"), "--no-model");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not exist; copy ~/.orbit there first");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("never writes through a link in the copy to the folder it points at", () => {
    const outside = mkdtempSync(join(testHome(), "live-notes-"));
    writeFileSync(join(outside, "2026-10.md"), "# Memory history\n");
    const copy = copyOf(DUPES, (ws) => {
      symlinkSync(outside, join(ws, "memory-history"), "junction");
      symlinkSync(outside, join(ws, "memory"), "junction");
    });
    const json = join(copy, "out.json");
    const result = run(copy, "--no-model", "--detail", json);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(json, "utf8")).results[0]).toMatchObject({ result: "saved", moved: 1, lost: [] });
    expect(readdirSync(outside)).toEqual(["2026-10.md"]);
    expect(readFileSync(join(outside, "2026-10.md"), "utf8")).toBe("# Memory history\n");
  });

  it("fails the check when the tidy pass errors", () => {
    const copy = copyOf(DUPES);
    const json = join(copy, "out.json");
    const result = capped(copy, "--detail", json);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAILED Alpha night 1: tidy error");
    expect(JSON.parse(readFileSync(json, "utf8")).results[0]).toMatchObject({ name: "Alpha", result: "error", moved: 0 });
    expect(result.left).toEqual([]);
  });

  it("records a failed filing call, still writes the JSON and removes its temp folder", () => {
    const raw = memory("## Notes", ...Array.from({ length: 130 }, (_, n) => `- Launch detail ${n} ${"y".repeat(170)}`));
    expect(filingDue(raw)).toBe(true);
    const copy = copyOf(raw);
    const json = join(copy, "out.json");
    const result = capped(copy, "--detail", json);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAILED Alpha night 1: tidy error, model token cap reached");
    const [row] = JSON.parse(readFileSync(json, "utf8")).results;
    expect(row).toMatchObject({ result: "error", error: "model token cap reached", filed: 0, lost: [], madeUp: [] });
    expect(readFileSync(join(copy, "workspaces", "bot-a", "MEMORY.md"), "utf8")).toBe(raw);
    expect(result.left).toEqual([]);
  });

  it("removes its temp folder when the run throws", () => {
    // a MEMORY.md that cannot be read throws inside the run
    const copy = copyOf("", (ws) => {
      rmSync(join(ws, "MEMORY.md"));
      mkdirSync(join(ws, "MEMORY.md"));
    });
    const result = run(copy, "--no-model");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EISDIR");
    expect(result.left).toEqual([]);
  });

  it("loads server code only after OMB_DATA_DIR points at its throwaway root", () => {
    // a static import would read the live data dir in server/config.ts before main() sets it
    expect(readFileSync(SCRIPT, "utf8").split("\n").filter((line) => /^import (?!type ).* from "\.\.\/server\//.test(line))).toEqual([]);
  });

  it("writes counts, codes, bot ids and sha8s to --json, note text only to --detail", () => {
    const copy = copyOf(DUPES);
    const [json, detail] = [join(copy, "summary.json"), join(copy, "detail.json")];
    const result = run(copy, "--no-model", "--json", json, "--detail", detail, "--build", "9f2983532");
    expect(result.status).toBe(0);
    const summary = nightSummarySchema.parse(JSON.parse(readFileSync(json, "utf8")));
    expect(summary.bots[0]).toMatchObject({ bot: "bot-a", result: "saved", moved: 1, lost: [], madeUp: [], error: null });
    expect(readFileSync(json, "utf8")).not.toContain("Alpha");
    expect(JSON.parse(readFileSync(detail, "utf8")).results[0]).toMatchObject({ name: "Alpha", result: "saved" });
  });

  it("removes a killed night's temp root and leaves a running one", () => {
    const tmp = mkdtempSync(join(testHome(), "tmp-"));
    for (const name of ["wink-dream-killed", "wink-dream-running"]) mkdirSync(join(tmp, name, "data"), { recursive: true });
    const killed = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(join(tmp, "wink-dream-killed"), killed, killed);
    const result = runIn(tmp, {}, copyOf(DUPES), "--no-model");
    expect(result.status).toBe(0);
    expect(result.left).toEqual(["wink-dream-running"]);
  });

  it("never asserts a model that --no-model leaves null", () => {
    expect(readFileSync(SCRIPT, "utf8")).not.toMatch(/\b(?:generator|filer)!/);
  });
});

describe("topic night", () => {
  const worldOf = (bots = ["bot-a", "bot-b"]) => {
    const world = mkdtempSync(join(testHome(), "topic-"));
    const [copy, practice, tmp, home] = ["copy", "dream-practice", "tmp", "home"].map((name) => join(world, name));
    for (const dir of [practice, tmp, home]) mkdirSync(dir, { recursive: true });
    for (const id of bots) {
      mkdirSync(join(copy, "workspaces", id), { recursive: true });
      writeFileSync(join(copy, "workspaces", id, "MEMORY.md"), memory("## Notes", ...Array.from({ length: 130 }, (_, at) => `- Launch detail ${at} for ${id} ${"y".repeat(170)}`)));
    }
    writeFileSync(join(copy, "bots.json"), JSON.stringify(bots.map((id) => ({ id }))));
    const { VITEST: _vitest, ...env } = process.env;
    const night = (args = [], extra = {}) => spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, copy, "--topics", "1", "--practice", practice, "--json", join(world, "summary.json"), ...args], {
      encoding: "utf8",
      env: { ...env, HOME: home, USERPROFILE: home, TMP: tmp, TEMP: tmp, TMPDIR: tmp, CLAUDE_CONFIG_DIR: join(world, "login"), CLAUDE_CLI: STUB, ...extra },
    });
    const topics = () => readdirSync(practice, { recursive: true, encoding: "utf8" }).filter((name) => /topic-[0-9a-f]{8}$/.test(name)).map((name) => name.replaceAll("\\", "/")).sort();
    return { practice, night, topics };
  };

  it("leaves no practice topic for a move its quiz undid", () => {
    const w = worldOf(["bot-a"]);
    const result = w.night([], { DREAM_STUB_FAIL: "write 3 questions" });
    expect(result.status).toBe(1);
    expect(w.topics()).toEqual([]);
  });

  it("plans no topic a check already finished, and leaves the night's slot to another bot", () => {
    const w = worldOf();
    expect(w.night().status).toBe(0);
    const [first] = w.topics();
    expect(first).toMatch(/^bot-a\//);
    writeFileSync(join(w.practice, first, "done"), "");
    // the same copy gives bot-a the same plan, so the same topic
    expect(w.night().status).toBe(0);
    expect(w.topics().map((topic) => topic.split("/")[0])).toEqual(["bot-a", "bot-b"]);
    expect(readdirSync(join(w.practice, first))).toContain("done");
  });

  it("plans one topic each night of a --nights run", () => {
    const w = worldOf();
    expect(w.night(["--nights", "2"]).status).toBe(0);
    expect(w.topics().map((topic) => topic.split("/")[0])).toEqual(["bot-a", "bot-b"]);
  });

  it("plans one topic for one bot, writes plan.json, both copies and the history block, and plans no other while it is open", async () => {
    const { movePlanSchema } = await import("../server/memory-file.ts");
    const { parseHistory } = await import("../server/memory-clean.ts");
    const world = mkdtempSync(join(testHome(), "topic-"));
    const [copy, practice, tmp, home] = ["copy", "dream-practice", "tmp", "home"].map((name) => join(world, name));
    for (const dir of [practice, tmp, home]) mkdirSync(dir, { recursive: true });
    for (const id of ["bot-a", "bot-b"]) {
      mkdirSync(join(copy, "workspaces", id), { recursive: true });
      writeFileSync(join(copy, "workspaces", id, "MEMORY.md"), memory("## Notes", ...Array.from({ length: 130 }, (_, at) => `- Launch detail ${at} for ${id} ${"y".repeat(170)}`)));
    }
    writeFileSync(join(copy, "bots.json"), JSON.stringify([{ id: "bot-a", name: "Alpha" }, { id: "bot-b", name: "Beta" }]));
    const { VITEST: _vitest, ...env } = process.env;
    const night = () => spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, copy, "--topics", "1", "--practice", practice, "--json", join(world, "summary.json")], {
      encoding: "utf8",
      env: { ...env, HOME: home, USERPROFILE: home, TMP: tmp, TEMP: tmp, TMPDIR: tmp, CLAUDE_CONFIG_DIR: join(world, "login"), CLAUDE_CLI: STUB },
    });
    expect(night().status).toBe(0);
    const topics = readdirSync(practice, { recursive: true, encoding: "utf8" }).filter((name) => /topic-[0-9a-f]{8}$/.test(name));
    expect(topics).toHaveLength(1);
    const topic = join(practice, topics[0]);
    const plan = movePlanSchema.parse(JSON.parse(readFileSync(join(topic, "plan.json"), "utf8")));
    expect(readFileSync(join(topic, "plan.json"), "utf8")).not.toContain("Launch detail");
    expect(plan.notes.map(({ target }) => target)).toEqual(["memory/stub-notes.md", "memory/stub-notes.md"]);
    const [run] = parseHistory(readFileSync(join(topic, "history.md"), "utf8"));
    expect([run.moved, run.notes.map(({ sha8 }) => sha8)]).toEqual([2, plan.notes.map(({ sha256 }) => sha256.slice(0, 8))]);
    expect(readFileSync(join(topic, "after", "MEMORY.md"), "utf8")).toContain("read memory/stub-notes.md before stub work");
    expect(readFileSync(join(topic, "before", "MEMORY.md"), "utf8")).not.toContain("memory/stub-notes.md");
    // the history block sits in the copy's memory folder, never counted as a note
    const summary = nightSummarySchema.parse(JSON.parse(readFileSync(join(world, "summary.json"), "utf8")));
    expect(summary.bots.filter(({ trap }) => !trap).map(({ moved, filed, lost, madeUp }) => [moved > 0 || filed > 0, lost, madeUp])).toEqual([[true, [], []], [true, [], []]]);
    // the next night plans the other bot; the open topic keeps its bot from a second one
    const topicsNow = () => readdirSync(practice, { recursive: true, encoding: "utf8" }).filter((name) => /topic-[0-9a-f]{8}$/.test(name)).map((name) => name.replaceAll("\\", "/").split("/")[0]);
    expect(night().status).toBe(0);
    expect(topicsNow().sort()).toEqual(["bot-a", "bot-b"]);
    expect(night().status).toBe(0);
    expect(topicsNow().sort()).toEqual(["bot-a", "bot-b"]);
  });
});

describe("night canary", () => {
  const MARKER = "plumquartzhelix";
  const FAIL = "orchidfailnote";
  const files = (dir) => new Map(readdirSync(dir, { recursive: true, encoding: "utf8" }).map((name) => join(dir, name)).filter((path) => statSync(path).isFile()).map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));

  it("leaves no note text outside dream-practice, from an engine that echoes it into replies, errors, stderr and traces", () => {
    const world = mkdtempSync(join(testHome(), "night-"));
    const [copy, tmp, results, practice, login, home] = ["copy", "tmp", "results", "dream-practice", "login", "home"].map((name) => join(world, name));
    for (const dir of [tmp, results, practice, login, home]) mkdirSync(dir, { recursive: true });
    const filler = (n) => Array.from({ length: n }, (_, at) => `- Launch detail ${at} ${"y".repeat(170)}`);
    for (const [id, first] of [["bot-a", `- The ${MARKER} launch runs from the east studio`], ["bot-b", `- The ${MARKER} recap waits on ${FAIL}`]]) {
      mkdirSync(join(copy, "workspaces", id), { recursive: true });
      writeFileSync(join(copy, "workspaces", id, "MEMORY.md"), memory("## Notes", first, ...filler(130)));
    }
    writeFileSync(join(copy, "bots.json"), JSON.stringify([{ id: "bot-a", name: `Alpha ${MARKER}` }, { id: "bot-b", name: "Beta" }]));
    const before = files(world);
    const { VITEST: _vitest, ...env } = process.env;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, copy, "--json", join(results, "summary.json"), "--detail", join(practice, "detail.json"), "--build", "9f2983532"], {
      encoding: "utf8",
      env: { ...env, HOME: home, USERPROFILE: home, TMP: tmp, TEMP: tmp, TMPDIR: tmp, CLAUDE_CONFIG_DIR: login, CLAUDE_CLI: STUB, DREAM_STUB_MARKER: MARKER, DREAM_STUB_FAIL: FAIL },
    });
    // run.ps1 sends the check's stdout and stderr to dream-practice, never to results
    writeFileSync(join(practice, "run.log"), `${result.stdout}${result.stderr}`);
    const detail = readFileSync(join(practice, "detail.json"), "utf8");
    expect(JSON.parse(detail).results.map(({ filed, error }) => [filed > 0, Boolean(error)])).toEqual([[true, false], [false, true], [false, false]]);
    expect(detail).toContain(`stub claude failed on ${MARKER}`);
    expect(detail).toContain(`"disagree\\":[]} ${MARKER}`);

    const after = files(world);
    const changed = [...after].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => relative(world, path).replaceAll("\\", "/"));
    expect(changed.filter((path) => !path.startsWith("results/") && !path.startsWith("dream-practice/"))).toEqual([]);
    expect(changed.filter((path) => path.startsWith("results/"))).toEqual(["results/summary.json"]);
    expect(readdirSync(tmp)).toEqual([]);
    const leaks = [...after.keys()].filter((path) => !path.startsWith(practice) && !path.startsWith(copy) && sendsValue(readFileSync(path, "utf8"), MARKER));
    expect(leaks.map((path) => relative(world, path))).toEqual([]);
    const summary = nightSummarySchema.parse(JSON.parse(readFileSync(join(results, "summary.json"), "utf8")));
    expect(summary.bots.map(({ bot, error }) => [bot, error])).toEqual([["bot-a", null], ["bot-b", "engine"], ["dream-trap", null]]);
  });
});
