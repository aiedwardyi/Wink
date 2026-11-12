import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { isCompletedTaskRecord } from "../shared/task-resume.ts";
import * as atomic from "./atomic.ts";
import {
  assignTaskNextAction,
  deleteTaskResumePacket,
  groundTaskArtifacts,
  readTaskResumePacket,
  settleTaskResumePacket,
  stageTaskResumePacket,
  TASK_STATE_MAX_BYTES,
  taskStateNotice,
  taskStateUpdateError,
  taskStateUpdateSchema,
  writeTaskResumePacket,
  type TaskResumePacket,
} from "./task-state.ts";
import { recordTaskCompletion, recordTaskInstruction, seedTaskResumePacket } from "./task-state-fold.ts";
import type { TaskAsk } from "./task-asks.ts";

const packet = (overrides: Partial<TaskResumePacket> = {}): TaskResumePacket => ({
  v: 1,
  threadId: "thread-1",
  botId: "bot-1",
  goal: "Prepare the weekly competitor brief",
  plan: [
    { step: "Research launches", status: "done" },
    { step: "Write the report", status: "active" },
  ],
  completed: [{ note: "Collected primary sources", at: 100 }],
  evidence: [{ kind: "url", ref: "https://example.com/source", note: "Launch notes" }],
  artifacts: [{ ref: "reports/weekly.md", label: "Draft report" }],
  blockers: [],
  nextAction: "Finish the comparison table",
  updatedAt: 200,
  updatedBy: "harness",
  flushReason: "turn-end",
  lastEventId: "event-1",
  turnsAtWrite: 3,
  ...overrides,
});
const asks: TaskAsk[] = [
  { id: "A1", ask: "Review the model picker PR", status: "waiting-for-user", ref: "PR #1348", at: 100, changedAt: 100 },
  { id: "A2", ask: "Drop the old skin", status: "declined", at: 110, changedAt: 150 },
];

describe("task resume packets", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orbit-task-state-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes and reads one packet per task", () => {
    const saved = writeTaskResumePacket(
      packet({ instructionAction: "Write the report", nextActionInstructionId: "message-1" }),
      { dir },
    );
    expect(saved.instructionAction).toBe("Write the report");
    expect(saved.nextActionInstructionId).toBe("message-1");

    expect(readTaskResumePacket("thread-1", { dir })).toEqual(saved);
    expect(JSON.parse(readFileSync(join(dir, "thread-1.json"), "utf8"))).toEqual(saved);
  });

  it("redacts secrets before they reach disk", () => {
    writeTaskResumePacket(packet({
      goal: "Use token=abcdefgh12345678 to prepare the brief",
      evidence: [{ kind: "tool", ref: "event-1", note: "Bearer abcdefghijklmnop" }],
    }), { dir });

    const raw = readFileSync(join(dir, "thread-1.json"), "utf8");
    expect(raw).not.toContain("abcdefgh12345678");
    expect(raw).not.toContain("abcdefghijklmnop");
    expect(raw).toContain("redacted");
  });

  it("keeps the newest bounded entries and never writes more than 16 KiB", () => {
    const completed = Array.from({ length: 80 }, (_, index) => ({
      note: `${index}:${"x".repeat(400)}`,
      at: index,
    }));
    const evidence = Array.from({ length: 80 }, (_, index) => ({
      kind: "tool" as const,
      ref: `event-${index}-${"y".repeat(600)}`,
      note: `${index}:${"z".repeat(400)}`,
    }));

    const saved = writeTaskResumePacket(packet({ completed, evidence }), { dir });
    const size = statSync(join(dir, "thread-1.json")).size;

    expect(size).toBeLessThanOrEqual(TASK_STATE_MAX_BYTES);
    expect(saved.completed.at(-1)?.at).toBe(79);
    expect(saved.evidence.at(-1)?.ref).toContain("event-79-");
    expect(saved.completed.length).toBeLessThanOrEqual(30);
    expect(saved.evidence.length).toBeLessThanOrEqual(30);
  });

  it("keeps bot milestones across more than 30 settled turns", () => {
    let current = seedTaskResumePacket({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Prepare the report",
      messageId: "message-1",
      now: 100,
      turnsAtWrite: 0,
    });
    for (let index = 0; index < 35; index++) {
      current.completed.push({ note: `Milestone ${index}`, at: index });
      current = recordTaskCompletion(current, {
        ok: true,
        reply: `Long reply ${index}: ${"details ".repeat(100)}`,
        now: 200 + index,
      });
    }

    const saved = writeTaskResumePacket(current, { dir });
    expect(saved.completed).toHaveLength(30);
    expect(saved.completed[0]?.note).toBe("Milestone 5");
    expect(saved.completed.at(-1)?.note).toBe("Milestone 34");
  });

  it("keeps every ask, closed ones included, across rewrites and new instructions", () => {
    const saved = writeTaskResumePacket(packet({ asks }), { dir });
    expect(saved.asks).toEqual(asks);
    const instructed = recordTaskInstruction(saved, { text: "Next task", messageId: "message-9", now: 300, turnsAtWrite: 4 });
    writeTaskResumePacket(instructed, { dir });
    expect(readTaskResumePacket("thread-1", { dir })?.asks).toEqual(asks);
    expect(writeTaskResumePacket(packet(), { dir })).not.toHaveProperty("asks");
  });

  it("drops closed asks first to fit 16 KiB and never an open one", () => {
    const many = Array.from({ length: 40 }, (_, index): TaskAsk => ({
      id: `A${index + 1}`,
      ask: `${index}:${"가".repeat(70)}`,
      status: index % 2 ? "open" : "done",
      ref: "r".repeat(80),
      at: index,
      changedAt: index,
    }));
    const completed = Array.from({ length: 30 }, (_, index) => ({ note: `${index}:${"x".repeat(250)}`, at: index }));

    const saved = writeTaskResumePacket(packet({ asks: many, completed }), { dir });

    expect(statSync(join(dir, "thread-1.json")).size).toBeLessThanOrEqual(TASK_STATE_MAX_BYTES);
    expect(saved.asks?.map((ask) => ask.id)).toEqual(many.filter((ask) => ask.status === "open").map((ask) => ask.id));
    expect(saved.completed.length).toBeGreaterThan(0);
  });

  it("replaces an old packet without leaving temporary files", () => {
    writeTaskResumePacket(packet(), { dir });
    writeTaskResumePacket(packet({ nextAction: "Publish after approval" }), { dir });

    expect(readTaskResumePacket("thread-1", { dir })?.nextAction).toBe("Publish after approval");
    writeTaskResumePacket(packet({ nextAction: "" }), { dir });
    expect(readTaskResumePacket("thread-1", { dir })?.nextAction).toBe("");
    expect(existsSync(join(dir, "thread-1.json"))).toBe(true);
    expect(readFileSync(join(dir, "thread-1.json"), "utf8")).not.toContain("Finish the comparison table");
  });

  it("stages a send's record with no fsync and reads it back", () => {
    const before = writeTaskResumePacket(packet(), { dir });
    const write = vi.spyOn(atomic, "writeFileAtomic");

    const staged = stageTaskResumePacket(packet({ instructionId: "message-2", updatedAt: 300 }), { dir });

    expect(write).not.toHaveBeenCalled();
    expect(readTaskResumePacket("thread-1", { dir })).toEqual(staged);
    expect(JSON.parse(readFileSync(join(dir, "thread-1.json"), "utf8"))).toEqual(before);
  });

  it("stages the same file text a direct write saves", () => {
    const next = packet({ goal: "Use token=abcdefgh12345678 to prepare the brief", updatedAt: 300 });
    const direct = mkdtempSync(join(tmpdir(), "orbit-task-state-"));
    try {
      expect(stageTaskResumePacket(next, { dir })).toEqual(writeTaskResumePacket(next, { dir: direct }));
      expect(readFileSync(join(dir, "thread-1.json.staged"), "utf8").slice(65)).toBe(readFileSync(join(direct, "thread-1.json"), "utf8"));
    } finally {
      rmSync(direct, { recursive: true, force: true });
    }
  });

  it("settles a staged record into the saved file once", () => {
    writeTaskResumePacket(packet(), { dir });
    const staged = stageTaskResumePacket(packet({ instructionId: "message-2", updatedAt: 300 }), { dir });
    const write = vi.spyOn(atomic, "writeFileAtomic");

    settleTaskResumePacket("thread-1", { dir });
    settleTaskResumePacket("thread-1", { dir });

    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(dir, "thread-1.json"), "utf8"))).toEqual(staged);
    expect(existsSync(join(dir, "thread-1.json.staged"))).toBe(false);
  });

  it("settles a staged record stamped before the saved one", () => {
    writeTaskResumePacket(packet({ updatedAt: 500 }), { dir });
    const staged = stageTaskResumePacket(packet({ instructionId: "message-2", updatedAt: 300 }), { dir });

    expect(readTaskResumePacket("thread-1", { dir })).toEqual(staged);
    settleTaskResumePacket("thread-1", { dir });
    expect(JSON.parse(readFileSync(join(dir, "thread-1.json"), "utf8"))).toEqual(staged);
  });

  it.each([
    ["torn", (text: string) => text.slice(0, 200)],
    ["one a later save could not remove", (text: string) => text],
  ])("keeps the saved record when the staged one is %s", (label, leftover) => {
    const path = join(dir, "thread-1.json.staged");
    let saved = writeTaskResumePacket(packet(), { dir });
    stageTaskResumePacket(packet({ nextAction: "staged", updatedAt: 900 }), { dir });
    const text = leftover(readFileSync(path, "utf8"));
    if (label !== "torn") saved = writeTaskResumePacket(packet({ nextAction: "written", updatedAt: 300 }), { dir });
    writeFileSync(path, text);

    expect(readTaskResumePacket("thread-1", { dir })).toEqual(saved);
    settleTaskResumePacket("thread-1", { dir });
    expect(JSON.parse(readFileSync(join(dir, "thread-1.json"), "utf8"))).toEqual(saved);
    expect(existsSync(path)).toBe(false);
  });

  it("drops a staged record on the next write and on delete", () => {
    stageTaskResumePacket(packet({ nextAction: "staged", updatedAt: 300 }), { dir });
    const saved = writeTaskResumePacket(packet({ nextAction: "written" }), { dir });
    expect(readTaskResumePacket("thread-1", { dir })).toEqual(saved);
    expect(existsSync(join(dir, "thread-1.json.staged"))).toBe(false);

    stageTaskResumePacket(packet({ nextAction: "staged", updatedAt: 300 }), { dir });
    expect(deleteTaskResumePacket("thread-1", { dir })).toBe(true);
    expect(readTaskResumePacket("thread-1", { dir })).toBeNull();
  });

  it("treats unknown versions and malformed files as absent without deleting them", () => {
    const path = join(dir, "thread-1.json");
    writeFileSync(path, JSON.stringify({ v: 2, threadId: "thread-1" }));
    const unknown = readFileSync(path, "utf8");

    expect(readTaskResumePacket("thread-1", { dir })).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(unknown);

    writeFileSync(path, "not json");
    expect(readTaskResumePacket("thread-1", { dir })).toBeNull();
    expect(readFileSync(path, "utf8")).toBe("not json");
  });

  it("ignores oversized and symbolic-link records", () => {
    const path = join(dir, "thread-1.json");
    writeFileSync(path, "x".repeat(TASK_STATE_MAX_BYTES + 1));
    expect(readTaskResumePacket("thread-1", { dir })).toBeNull();

    if (process.platform !== "win32") {
      const target = join(dir, "target.json");
      writeFileSync(target, JSON.stringify(packet()));
      rmSync(path);
      symlinkSync(target, path);
      expect(readTaskResumePacket("thread-1", { dir })).toBeNull();
    }
  });

  it("deletes only a valid task sidecar", () => {
    writeTaskResumePacket(packet(), { dir });

    expect(deleteTaskResumePacket("thread-1", { dir })).toBe(true);
    expect(deleteTaskResumePacket("thread-1", { dir })).toBe(false);
    expect(() => deleteTaskResumePacket("../outside", { dir })).toThrow("invalid task thread id");
  });

  it.skipIf(process.platform === "win32")("writes private file permissions", () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "thread-1.json");
    writeFileSync(path, "old");
    chmodSync(path, 0o644);

    writeTaskResumePacket(packet(), { dir });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("task state update", () => {
  it("clears a next action when the update sends an empty string", () => {
    const empty = taskStateUpdateSchema([]).safeParse({
      fromBotId: "bot-1",
      fromThreadId: "thread-1",
      next_action: "",
    });
    expect(empty.success).toBe(true);
    if (!empty.success) return;
    const settled = packet({
      instructionId: "message-2",
      settledInstructionId: "message-2",
      nextAction: "Run the full export",
      nextActionInstructionId: "message-1",
      flushReason: "turn-end",
    });
    assignTaskNextAction(settled, empty.data.next_action ?? "");
    expect(settled.nextAction).toBe("");
    expect(settled.nextActionInstructionId).toBeUndefined();
    expect(isCompletedTaskRecord(settled)).toBe(true);

    const spaces = taskStateUpdateSchema([]).safeParse({
      fromBotId: "bot-1",
      fromThreadId: "thread-1",
      next_action: "   ",
    });
    expect(spaces.success).toBe(false);

    const padded = taskStateUpdateSchema([]).safeParse({
      fromBotId: "bot-1",
      fromThreadId: "thread-1",
      next_action: "  Verify citations  ",
    });
    expect(padded.success).toBe(true);
    if (padded.success) expect(padded.data.next_action).toBe("Verify citations");
  });
});

describe("task state asks update", () => {
  const parse = (body: Record<string, unknown>, clipped: string[] = []) =>
    taskStateUpdateSchema(clipped).safeParse({ fromBotId: "bot-1", fromThreadId: "thread-1", ...body });

  it("accepts asks alone, trims refs and clips long words", () => {
    const clipped: string[] = [];
    const parsed = parse({
      asks: [
        { ask: `Review ${"the picker ".repeat(10)}`, status: "waiting-for-user", ref: " PR #1348 " },
        { id: "A2", status: "done" },
      ],
    }, clipped);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.asks?.[0]?.ask?.length).toBeLessThanOrEqual(80);
    expect(parsed.data.asks?.[0]?.ref).toBe("PR #1348");
    expect(parsed.data.asks?.[1]).toEqual({ id: "A2", status: "done" });
    expect(clipped).toEqual(["asks.0.ask (116 > 80)"]);
  });

  it("rejects an unknown status and names asks among the allowed fields", () => {
    const parsed = parse({ asks: [{ ask: "Fix login", status: "pending" }] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(taskStateUpdateError(parsed.error)).toContain("allowed: goal, plan, completed_note, next_action, blockers, artifacts, asks.");
  });
});

describe("taskStateUpdateError", () => {
  const schema = z.object({
    goal: z.string().optional(),
    plan: z.array(z.object({ step: z.string().min(1) }).strict()).optional(),
  }).strict();
  const error = (body: unknown) => {
    const parsed = schema.safeParse(body);
    if (parsed.success) throw new Error("expected a parse failure");
    return taskStateUpdateError(parsed.error);
  };

  it("names an unknown field and the allowed ones", () => {
    const text = error({ goal: "ship", notes: "x" });
    expect(text).toContain("unknown field notes");
    expect(text).toContain("allowed: goal, plan, completed_note, next_action, blockers, artifacts");
  });

  it("names the failing path", () => {
    expect(error({ plan: "step one" })).toMatch(/: plan: /);
    expect(error({ plan: [{ step: "" }] })).toMatch(/: plan\.0\.step: /);
  });

  it("bounds the detail length", () => {
    const text = error({ ["x".repeat(1000)]: 1 });
    expect(text.length).toBeLessThan(400);
  });

  it("names the field, its limit and the length sent", () => {
    const schema = z.object({
      goal: z.string().max(500).optional(),
      plan: z.array(z.object({ step: z.string().max(200) }).strict()).max(20).optional(),
    }).strict();
    const fail = (body: unknown) => {
      const parsed = schema.safeParse(body);
      if (parsed.success) throw new Error("expected a parse failure");
      return taskStateUpdateError(parsed.error, body);
    };
    const goal = "x".repeat(501);
    expect(fail({ goal })).toContain("goal: 501 characters, limit 500");
    const plan = Array.from({ length: 21 }, () => ({ step: "a" }));
    expect(fail({ plan })).toContain("plan: 21 items, limit 20");
    expect(fail({ plan: [{ step: "y".repeat(201) }] })).toContain("plan.0.step: 201 characters, limit 200");
  });

  it("does not count an inherited constructor or toString", () => {
    const schema = z.object({ goal: z.string().max(5) }).strict();
    const parsed = schema.safeParse({ goal: "123456" });
    if (parsed.success) throw new Error("expected a parse failure");
    const at = (key: string, body: object) => {
      const issue = parsed.error.issues[0];
      if (!issue) throw new Error("expected an issue");
      return taskStateUpdateError(new z.ZodError([{ ...issue, path: [key] }]), body);
    };
    const inherited: object = Object.create({ constructor: "c".repeat(40), toString: "t".repeat(30) });
    expect(at("constructor", inherited)).toContain("constructor: limit 5");
    expect(at("constructor", inherited)).not.toContain("40");
    expect(at("toString", inherited)).toContain("toString: limit 5");
    expect(at("toString", inherited)).not.toContain("30");
    expect(at("constructor", { constructor: "c".repeat(40) })).toContain("constructor: 40 characters, limit 5");
  });
});

describe("task state clipping", () => {
  let cwd: string;
  let outside: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "orbit-task-clip-"));
    cwd = join(root, "task");
    outside = join(root, "outside");
    mkdirSync(join(cwd, "repro"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(cwd, "brief.md"), "x");
    writeFileSync(join(outside, "notes.md"), "x");
  });

  afterEach(() => {
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  });

  type Fields = Omit<z.input<ReturnType<typeof taskStateUpdateSchema>>, "fromBotId" | "fromThreadId">;
  const sized = (length: number) => `${Array.from({ length }, (_, index) => `word${index}`).join(" ").slice(0, length - 1)}x`;

  const submit = (fields: Fields) => {
    const clipped: string[] = [];
    const parsed = taskStateUpdateSchema(clipped).safeParse({ fromBotId: "bot-1", fromThreadId: "thread-1", ...fields });
    if (!parsed.success) return { error: taskStateUpdateError(parsed.error), saved: undefined, clipped, kept: [], dropped: [] };
    return { saved: parsed.data, clipped, ...groundTaskArtifacts(parsed.data.artifacts ?? [], cwd) };
  };
  const rejection = (parsed: z.ZodSafeParseResult<unknown>) => (parsed.success ? "saved" : taskStateUpdateError(parsed.error));

  it("saves a plan step over 200 characters, clipped", () => {
    const plan = Array.from({ length: 13 }, (_, index) => ({ step: index === 12 ? sized(228) : `step ${index}`, status: "pending" as const }));
    const result = submit({ plan });
    expect(result).not.toHaveProperty("error");
    const step = result.saved?.plan?.[12]?.step ?? "";
    expect(step.length).toBeLessThanOrEqual(200);
    expect(step.endsWith("…")).toBe(true);
    expect(result.clipped).toEqual(["plan.12.step (228 > 200)"]);
  });

  it("saves a next action over 300 characters, clipped", () => {
    const result = submit({ next_action: sized(303) });
    expect(result).not.toHaveProperty("error");
    expect(result.saved?.next_action?.length).toBeLessThanOrEqual(300);
    expect(result.saved?.next_action?.endsWith("…")).toBe(true);
    expect(result.clipped).toEqual(["next_action (303 > 300)"]);
  });

  it("saves a completed note over 300 characters, clipped", () => {
    const result = submit({ completed_note: sized(354) });
    expect(result).not.toHaveProperty("error");
    expect(result.saved?.completed_note?.length).toBeLessThanOrEqual(300);
    expect(result.saved?.completed_note?.endsWith("…")).toBe(true);
    expect(result.clipped).toEqual(["completed_note (354 > 300)"]);
  });

  it("drops an artifact outside the task folder and keeps the rest", () => {
    const outsideFile = join(outside, "notes.md");
    const result = submit({
      artifacts: [
        { ref: "brief.md", label: "Brief" },
        { ref: outsideFile, label: "Notes" },
        { ref: join(cwd, "repro"), label: "Repro folder" },
      ],
    });
    expect(result).not.toHaveProperty("error");
    expect(result.kept).toEqual([{ ref: realpathSync(join(cwd, "brief.md")), label: "Brief" }]);
    expect(result.dropped).toEqual([outsideFile, join(cwd, "repro")]);
  });

  it("saves a mixed update and reports the clip and the drop in one line", () => {
    const outsideFile = join(outside, "notes.md");
    const result = submit({
      completed_note: "n".repeat(354),
      plan: [{ step: "a", status: "done" }, { step: "b".repeat(228), status: "active" }],
      artifacts: [{ ref: "brief.md", label: "Brief" }, { ref: outsideFile, label: "Notes" }],
    });
    expect(result).not.toHaveProperty("error");
    expect(result.kept).toHaveLength(1);
    expect(taskStateNotice(result.clipped, result.dropped, cwd)).toBe(
      `Clipped to fit: plan.1.step (228 > 200), completed_note (354 > 300). Dropped artifacts that are not files inside ${cwd}: ${outsideFile}.`,
    );
  });

  it("gives a clean save no notice", () => {
    const result = submit({ goal: "Ship", artifacts: [{ ref: "brief.md", label: "Brief" }] });
    expect(taskStateNotice(result.clipped, result.dropped, cwd)).toBe("");
  });

  it("clips every length-limited string", () => {
    const result = submit({
      goal: "g".repeat(501),
      blockers: [{ kind: "input", note: "b".repeat(301) }],
      artifacts: [{ ref: "brief.md", label: "l".repeat(201) }],
    });
    expect(result).not.toHaveProperty("error");
    expect(result.clipped).toEqual([
      "goal (501 > 500)",
      "blockers.0.note (301 > 300)",
      "artifacts.0.label (201 > 200)",
    ]);
  });

  it("cuts at a word boundary when one is near and hard when not", () => {
    expect(submit({ goal: `${"a".repeat(480)} ${"b".repeat(60)}` }).saved?.goal).toBe(`${"a".repeat(480)}…`);
    expect(submit({ goal: "c".repeat(900) }).saved?.goal).toBe(`${"c".repeat(499)}…`);
  });

  it("leaves a string at its limit alone and never splits a surrogate pair", () => {
    const exact = submit({ goal: "g".repeat(500) });
    expect(exact.saved?.goal).toBe("g".repeat(500));
    expect(exact.clipped).toEqual([]);
    expect(submit({ goal: `${"a".repeat(498)}😀😀` }).saved?.goal).toBe(`${"a".repeat(498)}…`);
  });

  it("cuts before a drive path instead of inside it", () => {
    const step = "Read C:\\work\\" + "release\\".repeat(23) + "report.md";
    expect(step.length).toBe(206);
    const result = submit({ plan: [{ step, status: "active" }] });
    expect(result.saved?.plan?.[0]?.step).toBe("Read…");
    expect(result.clipped).toEqual(["plan.0.step (206 > 200)"]);
  });

  it("keeps no part of a spaced Windows path cut anywhere inside", () => {
    const path = "C:\\Program Files\\Wink\\resources\\app.asar";
    for (const prefixLen of [160, 170, 180]) {
      const prefix = "p".repeat(prefixLen);
      const result = submit({ plan: [{ step: `${prefix} Open ${path} now`, status: "pending" }] });
      expect(result.saved?.plan?.[0]?.step).toBe(`${prefix} Open…`);
    }
  });

  it("keeps no part of a forward-slash path cut inside", () => {
    const path = "./src/components/" + "sub/".repeat(10) + "ChatView.tsx";
    const prefix = "q".repeat(150);
    const result = submit({ plan: [{ step: `${prefix} see ${path}`, status: "pending" }] });
    expect(result.saved?.plan?.[0]?.step).toBe(`${prefix} see…`);
  });

  it("keeps a path that fits whole before the cut", () => {
    const path = "C:\\Program Files\\Wink\\resources\\app.asar";
    const result = submit({ plan: [{ step: `Open ${path} ${"word ".repeat(50)}`, status: "pending" }] });
    const saved = result.saved?.plan?.[0]?.step ?? "";
    expect(saved).toContain(path);
    expect(saved.endsWith("…")).toBe(true);
  });

  it("clips Korean with no path at a word boundary", () => {
    const result = submit({ next_action: "확인 ".repeat(120) });
    const saved = result.saved?.next_action ?? "";
    expect(saved.length).toBeLessThanOrEqual(300);
    expect(saved.endsWith("…")).toBe(true);
    expect(saved).toContain("확인");
    expect(saved).not.toContain("  ");
  });

  it("drops an over-limit artifact ref whole", () => {
    const ref = "r".repeat(501);
    const result = submit({ artifacts: [{ ref, label: "Brief" }] });
    expect(result).not.toHaveProperty("error");
    expect(result.clipped).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([ref]);
    expect(taskStateNotice(result.clipped, result.dropped, cwd)).toBe(
      `Dropped artifacts that are not files inside ${cwd}: ${ref}.`,
    );
  });

  it("still rejects what clipping does not cover", () => {
    const schema = taskStateUpdateSchema([]);
    const ids = { fromBotId: "bot-1", fromThreadId: "thread-1" };
    expect(rejection(schema.safeParse({ ...ids, notes: "x" }))).toContain("unknown field notes");
    expect(rejection(schema.safeParse({ ...ids, plan: [{ step: "a", status: "active" }, { step: "b", status: "active" }] }))).toContain("at most one plan step may be active");
    expect(rejection(schema.safeParse({ ...ids, goal: "   " }))).toContain("goal");
    expect(rejection(schema.safeParse({ ...ids, plan: [{ step: "", status: "pending" }] }))).toContain("plan.0.step");
    expect(rejection(schema.safeParse({ ...ids, goal: 5 }))).toContain("goal");
    expect(rejection(schema.safeParse({ ...ids, plan: "step one" }))).toContain("plan");
    expect(rejection(schema.safeParse(ids))).toContain("at least one task field is required");
    expect(rejection(schema.safeParse({ ...ids, plan: Array.from({ length: 21 }, () => ({ step: "a", status: "pending" })) }))).toContain("limit 20");
  });
});
