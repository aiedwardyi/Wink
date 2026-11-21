import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBoard } from "./board.ts";
import { createForumLessons, lessonRequest } from "./forum-lessons.ts";

const project = join(tmpdir(), "first", "site");
const other = join(tmpdir(), "second", "site");
const source = { botId: "fixer", threadId: "fix-thread", model: "model-a", project };
const before = { runId: "before-run", page: "index.html", revision: "before", checks: { "NAV/phone": "missed" } } as const;
const after = { runId: "after-run", page: "index.html", revision: "after", checks: { "NAV/phone": "passed" } } as const;
const prediction = {
  beforeRunId: before.runId, check: "NAV/phone", problem: "Two links disappear at 392 px",
  change: "Add a working menu toggle", why: "Reveal the hidden links", expected: "The phone navigation check passes",
};
const matching = { botId: "new-bot", model: "model-a", project, text: "Fix the broken mobile menu in index.html", room: false };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "forum-lessons-"));
  dirs.push(dir);
  const open = () => createBoard({ dir, pcId: () => "pc-1" });
  const board = open();
  const build = () => createForumLessons(open(), () => "pc-1");
  const lessons = createForumLessons(board, () => "pc-1");
  const start = (run: string = before.runId, afterRun: string = after.runId) => {
    lessons.observe(source, { ...before, runId: run });
    return lessons.begin(source, { ...prediction, beforeRunId: run }, afterRun);
  };
  return { board, build, lessons, open, start };
}

describe("Forum lessons", () => {
  it("saves a prediction before the after check and records only measured outcomes", () => {
    const { board, lessons, start } = setup();
    const pending = start()!;
    expect(board.get(pending)?.lesson).toMatchObject({ ...prediction, page: "index.html", model: "model-a", afterRunId: after.runId, outcome: "pending" });
    expect(lessons.take(matching)).toBeUndefined();
    lessons.finish(pending, after);
    expect(board.get(pending)?.lesson).toMatchObject({ outcome: "fixed" });
    expect(board.search({ query: "Two links disappear" })).toEqual([]);
  });

  it.each([
    [{ ...after, checks: { "NAV/phone": "missed" as const } }, "missed"],
    [{ ...after, checks: {} }, "skipped"],
    [{ ...after, revision: before.revision }, "skipped"],
    [{ ...after, page: "another.html" }, "skipped"],
  ])("retains the %j outcome as %s", (result, outcome) => {
    const { board, lessons, start } = setup();
    const id = start()!;
    lessons.finish(id, result);
    expect(board.get(id)?.lesson?.outcome).toBe(outcome);
    expect(lessons.take(matching)).toBeUndefined();
  });

  it("captures other fully checked rules", () => {
    const { board, lessons } = setup();
    lessons.observe(source, { ...before, checks: { "FIT/phone": "missed" } });
    const id = lessons.begin(source, { ...prediction, check: "FIT/phone" }, after.runId)!;
    lessons.finish(id, { ...after, checks: { "FIT/phone": "passed" } });
    expect(board.get(id)?.lesson?.outcome).toBe("fixed");
  });

  it("does not use another source's run or an incompletely checked run", () => {
    const { lessons } = setup();
    lessons.observe(source, before);
    expect(lessons.begin({ ...source, threadId: "other" }, prediction, after.runId)).toBeUndefined();
    lessons.observe(source, { ...before, runId: "no-coverage", checks: {} });
    expect(lessons.begin(source, { ...prediction, beforeRunId: "no-coverage" }, after.runId)).toBeUndefined();
  });

  it("offers once per bot and model, including across reload and failed dispatch", () => {
    const { build, lessons, start } = setup();
    const id = start()!;
    lessons.finish(id, after);
    const first = lessons.take(matching)!;
    expect(first.text).toContain(id);
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(112);
    expect(lessons.take(matching)).toBeUndefined();
    first.release();
    lessons.take(matching)!.accept();
    expect(build().take(matching)).toBeUndefined();
    expect(lessons.take({ ...matching, botId: source.botId })).toBeUndefined();
    expect(lessons.take({ ...matching, botId: source.botId, model: "model-b" })).toBeDefined();
  });

  it.each([
    { project: other }, { project: undefined }, { room: true }, { text: "Fix the footer in index.html" },
    { text: "Fix the mobile menu in about.html" }, { text: "How is the project going?" },
    { text: "Fix the footer in index.html; leave the mobile menu alone" },
    { text: "Do not fix the mobile menu in index.html" },
  ])("adds no lesson for %j", (overrides) => {
    const { lessons, start } = setup();
    lessons.finish(start()!, after);
    expect(lessons.take({ ...matching, ...overrides })).toBeUndefined();
  });

  it("invalidates deleted and superseded lessons without reviving the predecessor", () => {
    const { board, build, lessons, start } = setup();
    const id = start()!;
    lessons.finish(id, after);
    expect(lessons.take(matching)).toBeDefined();
    const next = start("another-before", "next-after-run")!;
    expect(next).not.toBe(id);
    expect(board.get(id)?.lesson?.superseded).toBe(true);
    expect(lessons.take({ ...matching, botId: "other" })).toBeUndefined();
    lessons.finish(next, { ...after, runId: "next-after-run" });
    expect(lessons.take({ ...matching, botId: "other" })?.text).toContain(next);
    board.remove(next);
    expect(build().take(matching)).toBeUndefined();
    board.remove(id);
    expect(lessons.take(matching)).toBeUndefined();
  });

  it("keeps an interrupted prediction as skipped after a restart", () => {
    const { open, build, start } = setup();
    const id = start()!;
    build().recover();
    expect(open().get(id)?.lesson?.outcome).toBe("skipped");
  });

  it("accepts predictions in the recheck's entry without changing ordinary calls", () => {
    expect(lessonRequest("index.html")).toEqual({ entry: "index.html" });
    expect(lessonRequest(`index.html\n${JSON.stringify(prediction)}`)).toEqual({ entry: "index.html", prediction });
  });
});
