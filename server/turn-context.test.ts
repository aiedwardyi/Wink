import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildResumeFallback,
  buildTurnContext,
  builtListPath,
  countLastTurnToolRounds,
  countSessionToolRounds,
  engineIsFresh,
  MAX_MEMORY_PLAN_BYTES,
  NATIVE_PROMPT_BUDGET_CAP,
  nativePromptBudget,
  nativeSessionTokenBudget,
  replayMessageText,
  PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT,
  PRE_COMPACT_TOOL_ROUND_LIMIT,
  chatMemory,
  memoryBlock,
  planFiles,
  resumeSessionUnseeded,
  sessionPromptFor,
  shouldRecycleProviderSession,
  systemTurnInput,
  TASK_RESUME_PROMPT,
  taskRecordBlock,
  TurnSeeds,
  turnSeedCompactionId,
  turnSeedsSession,
  withSystemChanges,
  withTaskRecord,
} from "./turn-context.ts";
import { isRecoveringPacket, unsettledRequest } from "./task-recovery-flush.ts";
import { recordTaskCompletion, recordTaskInstruction, seedTaskResumePacket, stampTaskResumePacket } from "./task-state-fold.ts";
import { deleteTaskResumePacket, writeTaskPlanSidecar, type TaskResumePacket } from "./task-state.ts";

const transcript = [
  { role: "user" as const, text: "my dog is named Biscuit" },
  { role: "assistant" as const, text: "Noted — Biscuit." },
];

describe("buildTurnContext", () => {
  it("passes text through untouched on a plain resumed turn", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: false, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: true });
  });

  it("replays inline on rewind, exactly like the existing behaviour", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: true, fresh: false, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("rewound this conversation");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("replays inline for a fresh engine with prior history — the model-switch fix", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: true, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("joining this conversation");
    expect(out.turnText).not.toContain("rewound"); // distinct marker, distinct preamble
    expect(out.turnText).toContain("Assistant: Noted — Biscuit.");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("never wraps for native-replay drivers — they get history via SendTurnInput.transcript", () => {
    for (const flags of [{ rewound: true, fresh: false }, { rewound: false, fresh: true }]) {
      const out = buildTurnContext({ text: "hi", transcript, ...flags, replaysNatively: true });
      expect(out.turnText).toBe("hi");
    }
  });

  it("does not wrap a fresh engine on an empty thread — nothing to replay", () => {
    const out = buildTurnContext({ text: "hi", transcript: [], rewound: false, fresh: true, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: false });
  });

  it("recycles the provider session when Wink compacted the transcript", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      recycled: true,
      recycleReason: "compaction",
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("Wink compacted this conversation");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
    expect(out.turnText).not.toContain("joining this conversation");
    expect(out.turnText).not.toContain("rewound this conversation");
    expect(out.turnText.endsWith("continue")).toBe(true);
  });

  it("keeps Stop recovery on an uncompacted thread as a native resume", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      recycled: false,
      replaysNatively: false,
      recovering: true,
      taskRecord: {
        goal: "Publish the weekly brief",
        plan: [{ step: "Verify citations", status: "active" as const }],
        completed: [],
        blockers: [],
        nextAction: "Verify citations",
      },
    });
    expect(out.resume).toBe(true);
    expect(out.turnText).toContain("Wink task record");
    expect(out.turnText).not.toContain("Goal: Publish the weekly brief");
    expect(out.turnText).not.toContain("Next action: Verify citations");
  });

  it("injects compacted history plus the task record after Stop on a compacted thread", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      recycled: true,
      recycleReason: "compaction",
      replaysNatively: false,
      recovering: true,
      taskRecord: {
        goal: "Publish the weekly brief",
        plan: [{ step: "Verify citations", status: "active" as const }],
        completed: [],
        blockers: [],
        nextAction: "Verify citations",
      },
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("Wink compacted this conversation");
    expect(out.turnText).toContain("Wink task record");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
  });

  it("keeps the recycle preamble on a later compacted turn after cursors were cleared", () => {
    const out = buildTurnContext({
      text: "next",
      transcript,
      rewound: false,
      fresh: true,
      recycled: true,
      recycleReason: "compaction",
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("Wink compacted this conversation");
    expect(out.turnText).not.toContain("joining this conversation");
    expect(out.turnText).not.toContain("rewound this conversation");
    expect(out.turnText.endsWith("next")).toBe(true);
  });

  it("lets a rewind preamble win over session recycle", () => {
    const out = buildTurnContext({
      text: "hi",
      transcript,
      rewound: true,
      fresh: false,
      recycled: true,
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("rewound this conversation");
    expect(out.turnText).not.toContain("Wink compacted this conversation");
  });

  it("uses a session-bound preamble when recycling before the first compact", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      recycled: true,
      recycleReason: "session-fat",
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("fresh provider session");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
    expect(out.turnText).not.toContain("Wink compacted this conversation");
    expect(out.turnText).not.toContain("joining this conversation");
    expect(out.turnText.endsWith("continue")).toBe(true);
  });

  it("does not claim compaction when recycled without a reason", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      recycled: true,
      replaysNatively: false,
    });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("fresh provider session");
    expect(out.turnText).not.toContain("Wink compacted this conversation");
  });

  it("says startup reads already ran after a bounded recycle, not after new instructions, a switch or a rewind", () => {
    const ran = "Session-start reads already ran in this chat";
    const base = { text: "hi", transcript, rewound: false, fresh: false, replaysNatively: false };
    for (const recycleReason of ["compaction", "session-fat"] as const) {
      expect(buildTurnContext({ ...base, recycled: true, recycleReason }).turnText).toContain(ran);
    }
    for (const flags of [{ recycled: true, recycleReason: "system" as const }, { fresh: true }, { rewound: true }]) {
      expect(buildTurnContext({ ...base, ...flags }).turnText).not.toContain(ran);
    }
  });

  it("injects the durable task record at recovery boundaries", () => {
    const taskRecord = {
      goal: "Publish the weekly brief",
      plan: [{ step: "Verify citations", status: "active" as const }],
      completed: [{ note: "Drafted five sections" }],
      blockers: [],
      nextAction: "Verify citations",
    };
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      replaysNatively: false,
      taskRecord,
      recovering: true,
    });

    expect(out.resume).toBe(true);
    expect(out.turnText).toContain("Wink task record");
    expect(out.turnText).toContain("Current request: my dog is named Biscuit");
    expect(out.turnText).toContain("Drafted five sections");
    expect(out.turnText).not.toContain("Goal: Publish the weekly brief");
    expect(out.turnText).not.toContain("Next action: Verify citations");
    expect(out.turnText).not.toMatch(/verify against/i);
    expect(out.turnText.endsWith("continue")).toBe(true);
  });

  it("aligns the Resume preamble with the latest user turn when the saved goal drifted", () => {
    const taskRecord = {
      goal: "Prepare a weekly competitor brief",
      plan: [
        { step: "Prepare a weekly competitor brief", status: "active" as const },
        { step: "Verify citations", status: "pending" as const },
      ],
      completed: [{ note: "Drafted five sections with citations." }],
      blockers: [],
      nextAction: "Verify citations",
    };
    const saved = taskRecordBlock(taskRecord);
    expect(saved).toContain("Goal: Prepare a weekly competitor brief");
    expect(saved).toContain("Next action: Verify citations");
    expect(saved).toMatch(/verify against/i);
    // the caller sizes and shapes the block; a Resume card answers the turn
    // the interruption cut short, not the synthetic resume prompt
    const prepared = taskRecordBlock(taskRecord, 6_000, {
      recovering: true,
      latestUserText: "Now add a pricing comparison",
    });

    const out = buildTurnContext({
      text: TASK_RESUME_PROMPT,
      transcript: [
        { role: "user", text: "Prepare a weekly competitor brief" },
        { role: "assistant", text: "Drafted five sections with citations." },
        { role: "user", text: "Now add a pricing comparison" },
      ],
      rewound: false,
      fresh: false,
      recycled: false,
      replaysNatively: false,
      recovering: true,
      taskRecord,
      taskRecordText: prepared,
    });

    expect(out.resume).toBe(true);
    expect(out.turnText).toContain("Wink task record");
    expect(out.turnText).toContain("Current request: Now add a pricing comparison");
    expect(out.turnText).toContain("Drafted five sections with citations.");
    expect(out.turnText).not.toContain("Goal: Prepare a weekly competitor brief");
    expect(out.turnText).not.toContain("Next action: Verify citations");
    expect(out.turnText).not.toMatch(/Plan:/);
    expect(out.turnText).not.toMatch(/verify against/i);
    expect(out.turnText).not.toContain("Continue the saved task from its recorded next action");
    expect(out.turnText.endsWith(TASK_RESUME_PROMPT)).toBe(true);
  });

  it("keeps the caller's prepared record instead of re-deriving it from the transcript", () => {
    const taskRecord = {
      goal: "Build A",
      plan: [{ step: "Build A", status: "done" as const }],
      completed: [{ note: "Built A." }],
      blockers: [],
      nextAction: "Build A",
    };
    const prepared = taskRecordBlock(taskRecord, 6_000, {
      recovering: true,
      latestUserText: "Build B",
    });
    const out = buildTurnContext({
      text: "Build B",
      transcript: [
        { role: "user", text: "Build A" },
        { role: "assistant", text: "Built A." },
      ],
      rewound: false,
      fresh: false,
      replaysNatively: false,
      recovering: true,
      taskRecord,
      taskRecordText: prepared,
    });

    expect(out.turnText).toContain("Current request: Build B");
    expect(out.turnText).not.toContain("Current request: Build A");
    expect(out.turnText.endsWith("Build B")).toBe(true);
  });

  it("builds the recovery record around the supplied current request", () => {
    const out = buildTurnContext({
      text: "Build B",
      transcript: [
        { role: "user", text: "Build A" },
        { role: "assistant", text: "Built A." },
      ],
      rewound: false,
      fresh: false,
      replaysNatively: false,
      recovering: true,
      currentRequestText: "Build B",
      taskRecord: {
        goal: "Build A",
        plan: [{ step: "Build A", status: "done" as const }],
        completed: [{ note: "Built A." }],
        blockers: [],
        nextAction: "Build A",
      },
    });

    expect(out.turnText).toContain("Current request: Build B");
    expect(out.turnText).not.toContain("Current request: Build A");
  });

  it("injects the task record when the replay tail is capped", () => {
    const out = buildTurnContext({
      text: "continue",
      transcript,
      rewound: false,
      fresh: false,
      replaysNatively: true,
      contextCapped: true,
      taskRecord: {
        goal: "Research competitors",
        plan: [],
        completed: [],
        blockers: [],
        nextAction: "Compare pricing",
      },
    });

    expect(out.resume).toBe(true);
    expect(out.turnText).toContain("Next action: Compare pricing");
  });

  it("builds a cursor-failure fallback from the task record, summary, and tail", () => {
    const text = buildResumeFallback({
      text: "continue",
      transcript: [
        { role: "assistant", text: "[Orbit durable context summary]\nEarlier evidence is report.json." },
        { role: "user", text: "The latest result is green." },
      ],
      taskRecord: {
        goal: "Ship the release",
        plan: [{ step: "Run smoke tests", status: "active" }],
        completed: [{ note: "Built the installer" }],
        evidence: [{ kind: "file", ref: "reports/smoke.json", note: "all checks passed" }],
        artifacts: [{ ref: "dist/orbit.exe", label: "Windows installer" }],
        blockers: [],
        nextAction: "Run smoke tests",
      },
    });

    expect(text).toContain("provider session could not be resumed");
    expect(text).toContain("Goal: Ship the release");
    expect(text).toContain("1. active: Run smoke tests");
    expect(text).toContain("reports/smoke.json");
    expect(text).toContain("dist/orbit.exe");
    expect(text).toContain("Earlier evidence is report.json");
    expect(text).toContain("The latest result is green.");
    expect(text.endsWith("continue")).toBe(true);
  });

  it("bounds the task record while retaining every continuity field", () => {
    const secret = `sk-${"q".repeat(32)}`;
    const text = taskRecordBlock({
      goal: `Ship the release ${"detail ".repeat(100)}`,
      plan: [{ step: "Run smoke tests", status: "active" }],
      completed: [{ note: "Built the installer" }],
      evidence: [{ kind: "file", ref: `reports/${secret}.json` }],
      artifacts: [{ ref: "dist/orbit.exe", label: "Windows installer" }],
      blockers: [{ note: "Signing approval" }],
      nextAction: `Use ${secret}`,
    }, 512);

    expect(Array.from(text).length).toBeLessThanOrEqual(512);
    for (const label of ["Goal:", "Plan:", "Next action:", "Done recently:", "Evidence:", "Artifacts:", "Blockers:"]) {
      expect(text).toContain(label);
    }
    expect(text).not.toContain(secret);
  });
});

describe("asks in the task record", () => {
  const now = new Date(2026, 10, 12, 9, 0).getTime();
  const old = now - 4 * 24 * 60 * 60 * 1000;
  const record = {
    goal: "Ship the release",
    plan: [],
    completed: [],
    blockers: [],
    nextAction: "Run smoke tests",
    asks: [
      { id: "A1", ask: "Review the model picker PR", status: "waiting-for-user" as const, at: old, changedAt: old },
      { id: "A2", ask: "Drop the old skin", status: "declined" as const, at: old, changedAt: old },
      { id: "A3", ask: "Fix the login redirect", status: "building" as const, at: now - 1_000, changedAt: now - 1_000 },
    ],
  };
  const lines = "- A1 waiting-for-user needs verdict 11-08: Review the model picker PR\n- A3 building 11-12: Fix the login redirect";
  const verdict = "[Wink asks list - 2 open, 1 needs a verdict: no ref and no change in 3+ days, so build, park or close it yourself, and ask the user about at most 3 at a time.";
  const stale = `${verdict}]\n${lines}`;
  const listed = `${verdict} Build any summary or status from this list.]\n${lines}`;
  const plain = { text: "thanks", transcript, rewound: false, fresh: false, replaysNatively: false };

  it.each([
    ["a compaction", { recycled: true, recycleReason: "compaction" as const }],
    ["a new session", { fresh: true }],
  ])("carries open asks across %s with the one needing a verdict flagged", (_, boundary) => {
    const out = buildTurnContext({ ...plain, ...boundary, taskRecordText: taskRecordBlock(record, 6_000, { now }) });
    expect(out.turnText).toContain(`Blockers: 0 total; none\n${stale}`);
    expect(out.turnText).not.toContain("Drop the old skin");
  });

  it("keeps the asks in the record after a stop", () => {
    const text = taskRecordBlock(record, 6_000, { now, recovering: true, latestUserText: "continue" });
    expect(text).toContain("The previous turn was interrupted");
    expect(text).toContain(stale);
  });

  it("puts the verdict nudge on a resumed turn that carries no record", () => {
    const out = buildTurnContext({ ...plain, taskRecordText: taskRecordBlock(record, 6_000, { now }), asksText: stale });
    expect(out).toEqual({ turnText: `${stale}\n\nthanks`, resume: true });
  });

  it("lists every open ask once when the record rides a status turn", () => {
    const out = buildTurnContext({
      ...plain,
      text: "status?",
      fresh: true,
      taskRecordText: taskRecordBlock(record, 6_000, { now, allAsks: true }),
      asksText: listed,
    });
    expect(out.turnText).toContain(listed);
    expect(out.turnText.split("[Wink asks list")).toHaveLength(2);
  });

  it("adds nothing for a record whose asks are all closed", () => {
    const bare = { goal: record.goal, plan: [], completed: [], blockers: [], nextAction: record.nextAction };
    expect(taskRecordBlock({ ...bare, asks: [record.asks[1]!] }, 6_000, { now })).toBe(taskRecordBlock(bare));
  });
});

describe("task record progress", () => {
  it("shows bot milestones after settled turns without reply copies", () => {
    let record = seedTaskResumePacket({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Prepare the report",
      messageId: "message-1",
      now: 100,
      turnsAtWrite: 0,
    });
    for (let index = 0; index < 3; index++) {
      record = recordTaskCompletion(record, {
        ok: true,
        reply: `Long assistant reply ${index}: ${"details ".repeat(80)}`,
        now: 200 + index,
      });
      if (index === 1) record.completed.push({ note: "Verified the final sources", at: 202 });
    }

    const text = taskRecordBlock(record);
    expect(text).toContain("Done recently: 1 total; Verified the final sources");
    expect(text).not.toContain("Long assistant reply");
  });
});

describe("continue after an unsettled request", () => {
  const file = '<attached-file path="C:/Users/dad/Wink/attachments/poki-1-3.txt" name="poki-1-3.txt" size="18204" />';
  const messages = [
    { id: "msg-a", role: "user", kind: "text", text: "Polish the 《천억짜리 하루》 script", at: 100 },
    { id: "reply-a", role: "bot", kind: "text", text: "Polished all three scenes.", at: 200 },
    { id: "msg-b", role: "user", kind: "text", text: "Review the 《열려라 포키》 1-3 script", at: 300 },
    { id: "msg-b-file", role: "user", kind: "text", text: file, steered: true, at: 324 },
  ];
  const replay = [
    { role: "user" as const, text: "Polish the 《천억짜리 하루》 script" },
    { role: "assistant" as const, text: "Polished all three scenes." },
    { role: "user" as const, text: "Review the 《열려라 포키》 1-3 script" },
    { role: "user" as const, text: file },
  ];
  const unfinished = `Review the 《열려라 포키》 1-3 script | ${file}`;

  // The record settles on A; B and its file reach only the transcript.
  const startedB = () => {
    const record = seedTaskResumePacket({
      botId: "bot-1",
      threadId: "thread-1",
      text: "Polish the 《천억짜리 하루》 script",
      messageId: "msg-a",
      now: 100,
      turnsAtWrite: 0,
    });
    record.goal = "Polish the 《천억짜리 하루》 script for the Friday read";
    delete record.instructionGoal;
    record.plan = [{ step: "Polish scenes 1-3", status: "done" }];
    delete record.instructionStep;
    record.completed.push({ note: "Polished scenes 1-3", at: 150 });
    record.artifacts.push({ ref: "scripts/cheonok-polished.md", label: "Polished 《천억짜리 하루》" });
    const settled = recordTaskCompletion(record, { ok: true, reply: "Polished all three scenes.", messageId: "reply-a", now: 200 });
    return recordTaskInstruction(settled, { text: "Review the 《열려라 포키》 1-3 script", messageId: "msg-b", now: 300 });
  };
  const stoppedB = () => recordTaskCompletion(stampTaskResumePacket(startedB(), "stop", { now: 780 }), {
    ok: false,
    reply: "",
    interrupted: true,
    now: 781,
  });

  // "continue", built the way startClaimedTurn builds it.
  const continuedRecord = (prior: TaskResumePacket, fresh = true) => {
    const current = recordTaskInstruction(prior, { text: "콘틴뉴", messageId: "msg-c", now: 900 });
    const recovering = isRecoveringPacket(prior);
    const out = buildTurnContext({
      text: "콘틴뉴",
      transcript: replay,
      rewound: false,
      fresh,
      replaysNatively: false,
      recovering,
      taskRecord: current,
      taskRecordText: taskRecordBlock(current, 6_000, { recovering, latestUserText: "콘틴뉴", unsettledRequest: unfinished }),
      currentRequestText: "콘틴뉴",
    });
    expect(out.resume).toBe(!fresh);
    expect(out.turnText.endsWith("콘틴뉴")).toBe(true);
    return out.turnText.split("\n\n")[0]!;
  };

  it("names the request a Stop cut short when continue switches engines", () => {
    const stopped = stoppedB();

    const record = continuedRecord(stopped);
    expect(record).toContain(`Unfinished request: ${unfinished}`);
    expect(record).toContain("Current request: 콘틴뉴");
    expect(record).not.toContain("Goal:");
    expect(unsettledRequest(stopped, messages)).toBe(unfinished);
  });

  it("names it on a same-engine resume and after a crash too", () => {
    // the boot stamp store.ts writes over a crashed turn's packet
    const crashed = { ...startedB(), flushReason: "crash" as const };
    for (const prior of [stoppedB(), crashed]) {
      expect(continuedRecord(prior, false)).toContain(`Unfinished request: ${unfinished}`);
      expect(unsettledRequest(prior, messages)).toBe(unfinished);
    }
  });

  it("drops the older goal when continue follows a turn that ended early", () => {
    const failed = recordTaskCompletion(startedB(), { ok: false, reply: "", now: 781 });

    const record = continuedRecord(failed);
    expect(record).not.toContain("Goal: Polish");
    expect(record).not.toContain("Next action:");
    expect(record).toContain(`Unfinished request: ${unfinished}`);
    expect(record).toContain("Current request: 콘틴뉴");
    expect(unsettledRequest(failed, messages)).toBe(unfinished);
  });

  it("leaves a settled record's block as it was", () => {
    const settled = recordTaskCompletion(startedB(), { ok: true, reply: "Reviewed scenes 1-3.", now: 781 });

    expect(taskRecordBlock(settled, 6_000, { unsettledRequest: "" })).toBe(taskRecordBlock(settled));
    expect(taskRecordBlock(settled, 6_000, { recovering: true, latestUserText: "next", unsettledRequest: "" }))
      .toBe(taskRecordBlock(settled, 6_000, { recovering: true, latestUserText: "next" }));
    expect(unsettledRequest(settled, messages)).toBe("");
  });
});

describe("shouldRecycleProviderSession", () => {
  it("recycles once Wink has a compacted projection and the branch is current", () => {
    expect(shouldRecycleProviderSession({ compacted: true, rewound: false })).toBe(true);
    expect(shouldRecycleProviderSession({ compacted: true })).toBe(true);
  });

  it("keeps a native engine's session through a Wink compaction", () => {
    expect(shouldRecycleProviderSession({ compacted: true, native: true })).toBe(false);
  });

  it("recycles at the prompt cap only when the reseed halves the prompt", () => {
    const sessionPrompt = { first: 40_000, last: 300_000, contextWindow: 1_000_000 };
    expect(shouldRecycleProviderSession({ compacted: false, sessionPrompt, native: true, reseedTokens: 117_000 })).toBe(true);
    expect(shouldRecycleProviderSession({ compacted: false, sessionPrompt, native: true, reseedTokens: 270_000 })).toBe(false);
  });

  it("leaves native resume in place before compaction and after a rewind", () => {
    expect(shouldRecycleProviderSession({ compacted: false, rewound: false })).toBe(false);
    expect(shouldRecycleProviderSession({ compacted: true, rewound: true })).toBe(false);
    expect(shouldRecycleProviderSession({ compacted: false, rewound: true })).toBe(false);
  });

  it("recycles a new user turn after a heavy tool soak, before the first compact", () => {
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnToolRounds: PRE_COMPACT_TOOL_ROUND_LIMIT,
    })).toBe(true);
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnToolRounds: PRE_COMPACT_TOOL_ROUND_LIMIT - 1,
    })).toBe(false);
  });

  it("recycles when settled tools since the last compact exceed the session budget", () => {
    expect(shouldRecycleProviderSession({
      compacted: false,
      sessionToolRounds: PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT,
    })).toBe(true);
    expect(shouldRecycleProviderSession({
      compacted: false,
      sessionToolRounds: PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT - 1,
    })).toBe(false);
  });

  it("recycles when the last turn's reported native input exceeds the session budget", () => {
    const nativeTokenBudget = nativeSessionTokenBudget(200_000);
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnInputTokens: nativeTokenBudget + 1,
      nativeTokenBudget,
    })).toBe(true);
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnInputTokens: nativeTokenBudget,
      nativeTokenBudget,
    })).toBe(false);
  });

  it("does not treat an unknown catalog window as an 8k native budget", () => {
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnInputTokens: 20_000,
      nativeTokenBudget: 0,
    })).toBe(false);
  });

  it("does not recycle Stop recovery on an uncompacted fat session", () => {
    expect(shouldRecycleProviderSession({
      compacted: false,
      recovering: true,
      lastTurnToolRounds: PRE_COMPACT_TOOL_ROUND_LIMIT + 8,
      sessionToolRounds: PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT + 8,
      lastTurnInputTokens: 200_000,
      nativeTokenBudget: 4_096,
    })).toBe(false);
  });

  it("still recycles Stop recovery after Wink compacted", () => {
    expect(shouldRecycleProviderSession({
      compacted: true,
      recovering: true,
      lastTurnToolRounds: PRE_COMPACT_TOOL_ROUND_LIMIT,
    })).toBe(true);
  });

  it("resumes a 30-tool turn whose native prompt is only 80k", () => {
    expect(shouldRecycleProviderSession({
      compacted: false,
      lastTurnToolRounds: 30,
      sessionToolRounds: 30,
      sessionPrompt: { first: 40_000, last: 80_000, contextWindow: 1_000_000 },
    })).toBe(false);
  });

  it("recycles a 260k native prompt unless the branch moved or Stop is recovering", () => {
    const sessionPrompt = { first: 45_000, last: 260_000, contextWindow: 1_000_000 };
    expect(shouldRecycleProviderSession({ compacted: false, sessionPrompt })).toBe(true);
    expect(shouldRecycleProviderSession({ compacted: false, sessionPrompt: { ...sessionPrompt, last: 250_000 } })).toBe(false);
    expect(shouldRecycleProviderSession({ compacted: false, rewound: true, sessionPrompt })).toBe(false);
    expect(shouldRecycleProviderSession({ compacted: false, recovering: true, sessionPrompt })).toBe(false);
  });

  it("keeps the 24/48 tool rules only for an engine that reports no prompt size", () => {
    const soak = { compacted: false, lastTurnToolRounds: PRE_COMPACT_TOOL_ROUND_LIMIT, sessionToolRounds: 0 };
    const session = { compacted: false, lastTurnToolRounds: 0, sessionToolRounds: PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT };
    expect(shouldRecycleProviderSession(soak)).toBe(true);
    expect(shouldRecycleProviderSession(session)).toBe(true);
    const sessionPrompt = { first: 40_000, last: 120_000, contextWindow: 1_000_000 };
    expect(shouldRecycleProviderSession({ ...soak, sessionPrompt })).toBe(false);
    expect(shouldRecycleProviderSession({ ...session, sessionPrompt })).toBe(false);
  });

  it("lets a session outgrow its own replay before recycling again", () => {
    // 200k window: the budget is 100k, and the replay alone opened the session past it
    const opened = { first: 110_000, contextWindow: 200_000 };
    expect(shouldRecycleProviderSession({ compacted: false, sessionPrompt: { ...opened, last: 110_000 } })).toBe(false);
    expect(shouldRecycleProviderSession({ compacted: false, sessionPrompt: { ...opened, last: 159_999 } })).toBe(false);
    expect(shouldRecycleProviderSession({ compacted: false, sessionPrompt: { ...opened, last: 160_000 } })).toBe(true);
  });
});

describe("nativePromptBudget", () => {
  it("is half the window, capped at 250k", () => {
    expect(nativePromptBudget(1_000_000)).toBe(NATIVE_PROMPT_BUDGET_CAP);
    expect(nativePromptBudget(258_400)).toBe(129_200);
    expect(nativePromptBudget(200_000)).toBe(100_000);
    expect(nativePromptBudget(0)).toBe(0);
  });
});

describe("sessionPromptFor", () => {
  const report = { cursor: "session-1", first: 40_000, last: 90_000, window: { model: "claude-opus-5-5", tokens: 1_000_000 } };

  it("uses the engine's window for the model that reported it", () => {
    expect(sessionPromptFor({ report, cursor: "session-1", model: "claude-opus-5-5", catalogWindow: 200_000 }))
      .toEqual({ first: 40_000, last: 90_000, contextWindow: 1_000_000 });
  });

  it("falls back to the catalog window after a model switch", () => {
    expect(sessionPromptFor({ report, cursor: "session-1", model: "claude-haiku-4-5", catalogWindow: 200_000 }))
      .toEqual({ first: 40_000, last: 90_000, contextWindow: 200_000 });
    expect(sessionPromptFor({ report, cursor: "session-1", model: "local-model", catalogWindow: null })).toBeUndefined();
  });

  it("ignores figures from any session but the one this send would resume", () => {
    expect(sessionPromptFor({ report, cursor: "session-2", model: "claude-opus-5-5", catalogWindow: 200_000 })).toBeUndefined();
    expect(sessionPromptFor({ report, cursor: undefined, model: "claude-opus-5-5", catalogWindow: 200_000 })).toBeUndefined();
    expect(sessionPromptFor({ report: undefined, cursor: "session-1", model: "claude-opus-5-5", catalogWindow: 200_000 })).toBeUndefined();
  });
});

describe("resumeSessionUnseeded", () => {
  const summaryTail = [
    { role: "assistant" as const, text: "Summary: Biscuit is the dog." },
    { role: "user" as const, text: "and the cat?" },
  ];
  const turnFor = (unseeded: boolean, recovering = false) => {
    const recycled = shouldRecycleProviderSession({ compacted: unseeded, recovering });
    return buildTurnContext({
      text: "what are their names?",
      transcript: summaryTail,
      rewound: false,
      fresh: false,
      recycled,
      recycleReason: recycled ? "compaction" : undefined,
      replaysNatively: false,
      contextCapped: true,
      recovering,
    });
  };

  const seeded = (compactionId: string | null, cursor = "session-1", instanceId = "claude") => ({ instanceId, cursor, compactionId });

  it("a native session stays seeded through a newer Wink summary", () => {
    const input = { instanceId: "claude", cursor: "session-1", seed: seeded("c1"), latestCompactionId: "c2" };
    expect(resumeSessionUnseeded(input)).toBe(true);
    expect(resumeSessionUnseeded({ ...input, native: true })).toBe(false);
    expect(resumeSessionUnseeded({ ...input, native: true, seed: seeded("c1", "session-0") })).toBe(true);
  });

  it("a native session seeded on a summary replays once its window grows", () => {
    const input = { instanceId: "claude", cursor: "session-1", latestCompactionId: "c1", native: true, expanded: true };
    expect(resumeSessionUnseeded({ ...input, seed: seeded("c1") })).toBe(true);
    expect(resumeSessionUnseeded({ ...input, seed: seeded(null) })).toBe(false);
  });

  it("resumes a session a successful turn seeded with the current summary", () => {
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: seeded("c1"), latestCompactionId: "c1" })).toBe(false);
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: seeded(null), latestCompactionId: null })).toBe(false);
    const { turnText, resume } = turnFor(false);
    expect(resume).toBe(true);
    expect(turnText).toBe("what are their names?");
  });

  it("replays summary and tail instead of resuming a session no prompt reached", () => {
    // the cursor moved to a session the seed never certified
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-2", seed: seeded("c1"), latestCompactionId: "c1" })).toBe(true);
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-2", seed: seeded(null), latestCompactionId: null })).toBe(true);
    const { turnText, resume } = turnFor(true);
    expect(resume).toBe(false);
    expect(turnText).toContain("Wink compacted this conversation");
    expect(turnText).toContain("Biscuit is the dog.");
    expect(turnText).toContain("User: and the cat?");
  });

  it("replays after restart when the thread has a newer summary than the session", () => {
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: seeded("c1"), latestCompactionId: "c2" })).toBe(true);
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: seeded(null), latestCompactionId: "c1" })).toBe(true);
    const { turnText, resume } = turnFor(true, true);
    expect(resume).toBe(false);
    expect(turnText).toContain("Biscuit is the dog.");
  });

  it("has nothing to recycle without a cursor", () => {
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: undefined, seed: undefined, latestCompactionId: "c1" })).toBe(false);
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: undefined, seed: seeded("c1"), latestCompactionId: "c1" })).toBe(false);
  });

  it("replays a cursor saved before seeds existed instead of trusting it", () => {
    // a pre-seed build saved sessions that failed before their prompt too
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: undefined, latestCompactionId: "c1" })).toBe(true);
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: undefined, latestCompactionId: null })).toBe(true);
  });

  it("never lets one instance's seed certify another instance's cursor", () => {
    // Codex -> Claude -> Codex: Claude certified c1, the switch-back's first
    // turn died before session.started, and Codex still holds its old thread
    const claude = seeded("c1", "session-1", "claude");
    expect(resumeSessionUnseeded({ instanceId: "codex", cursor: "thread-old", seed: claude, latestCompactionId: "c1" })).toBe(true);
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: claude, latestCompactionId: "c1" })).toBe(false);
  });

  it("recycles once when a grown window restores the history a summary stood for", () => {
    // seeded with the summary, now dispatched with the original history
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: seeded("c1"), latestCompactionId: "c1", expanded: true })).toBe(true);
    // the recycled session was seeded with that history: no summary at all
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: seeded(null), latestCompactionId: "c1", expanded: true })).toBe(false);
    // back on the small window the summary is what the session lacks
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: seeded(null), latestCompactionId: "c1" })).toBe(true);
  });

  it("keeps a session seeded on a fallback resumable once its repair lands", () => {
    const supersededIds = new Set(["fallback"]);
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: seeded("fallback"), latestCompactionId: "repair", supersededIds })).toBe(false);
    // a different summary, or a different session, still recycles
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: seeded("older"), latestCompactionId: "repair", supersededIds })).toBe(true);
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-2", seed: seeded("fallback"), latestCompactionId: "repair", supersededIds })).toBe(true);
    expect(resumeSessionUnseeded({ instanceId: "claude", cursor: "session-1", seed: seeded("fallback"), latestCompactionId: "repair", expanded: true, supersededIds })).toBe(true);
  });

  it("a resumed turn carries the fallback seed instead of certifying the repair", () => {
    expect(turnSeedCompactionId({
      replayed: false,
      instanceId: "claude",
      cursor: "session-1",
      seed: seeded("fallback"),
      sessionCompactionId: "repair",
      supersededIds: new Set(["fallback"]),
    })).toBe("fallback");
    expect(turnSeedCompactionId({
      replayed: false,
      instanceId: "claude",
      cursor: "session-1",
      seed: seeded("repair"),
      sessionCompactionId: "repair",
      supersededIds: new Set(["fallback"]),
    })).toBe("repair");
  });

  it("a replayed turn certifies the repaired summary", () => {
    expect(turnSeedCompactionId({
      replayed: true,
      instanceId: "claude",
      cursor: undefined,
      seed: seeded("fallback"),
      sessionCompactionId: "repair",
      supersededIds: new Set(["fallback"]),
    })).toBe("repair");
  });
});

describe("turnSeedsSession", () => {
  const seed = { instanceId: "claude", cursor: "session-b" };

  it("certifies only the cursor the successful turn ran on", () => {
    expect(turnSeedsSession({ ok: true, interrupted: false, seed, eventInstanceId: "claude", currentCursor: "session-b" })).toBe(true);
    // a stopped turn's late init moved the cursor to its own session
    expect(turnSeedsSession({ ok: true, interrupted: false, seed, eventInstanceId: "claude", currentCursor: "session-a" })).toBe(false);
    expect(turnSeedsSession({ ok: true, interrupted: false, seed, eventInstanceId: "codex", currentCursor: "session-b" })).toBe(false);
    expect(turnSeedsSession({ ok: true, interrupted: false, seed: { instanceId: "grok", cursor: undefined }, currentCursor: undefined })).toBe(false);
  });

  it("keeps a session resumable once the provider accepted the prompt, even if the turn did not finish", () => {
    expect(turnSeedsSession({ ok: false, interrupted: true, promptAccepted: true, seed, currentCursor: "session-b" })).toBe(true);
    expect(turnSeedsSession({ ok: false, interrupted: false, promptAccepted: true, seed, currentCursor: "session-b" })).toBe(true);
    expect(turnSeedsSession({ ok: false, interrupted: true, seed, currentCursor: "session-b" })).toBe(false);
    expect(turnSeedsSession({ ok: true, interrupted: true, seed, currentCursor: "session-b" })).toBe(false);
    expect(turnSeedsSession({ ok: false, interrupted: false, promptAccepted: false, seed, currentCursor: "session-b" })).toBe(false);
  });
});

describe("countLastTurnToolRounds", () => {
  it("counts settled tools after the previous user line, skipping the new send", () => {
    const messages = [
      { id: "u1", role: "user" as const, kind: "text" as const },
      { id: "t1", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "t2", kind: "activity" as const, tool: { name: "Bash", ok: true } },
      { id: "a1", role: "bot" as const, kind: "text" as const },
      { id: "u2", role: "user" as const, kind: "text" as const },
    ];
    expect(countLastTurnToolRounds(messages, new Set(["u2"]))).toBe(2);
  });

  it("ignores in-flight chips and tools from earlier turns", () => {
    const messages = [
      { id: "u0", role: "user" as const, kind: "text" as const },
      { id: "old", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "u1", role: "user" as const, kind: "text" as const },
      { id: "pending", kind: "activity" as const, tool: { name: "Read" } },
      { id: "t1", kind: "activity" as const, tool: { name: "Grep", ok: false } },
    ];
    expect(countLastTurnToolRounds(messages)).toBe(1);
  });

  it("stops at a recycle watermark when pane wakes added no user line", () => {
    const messages = [
      { id: "u1", role: "user" as const, kind: "text" as const },
      { id: "old", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "bound", role: "bot" as const, kind: "note" as const },
      { id: "t1", kind: "activity" as const, tool: { name: "Bash", ok: true } },
    ];
    expect(countLastTurnToolRounds(messages, undefined, "bound")).toBe(1);
  });
});

describe("countSessionToolRounds", () => {
  it("counts settled tools after the latest compaction marker", () => {
    const messages = [
      { id: "old", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "c1", kind: "compaction" as const },
      { id: "t1", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "t2", kind: "activity" as const, tool: { name: "Bash", ok: true } },
      { id: "u2", role: "user" as const, kind: "text" as const },
    ];
    expect(countSessionToolRounds(messages, new Set(["u2"]))).toBe(2);
  });

  it("counts the whole uncompacted thread when there is no marker", () => {
    const messages = [
      { id: "t1", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "t2", kind: "activity" as const, tool: { name: "Bash", ok: true } },
      { id: "skip", kind: "activity" as const, tool: { name: "Grep", ok: true } },
    ];
    expect(countSessionToolRounds(messages, new Set(["skip"]))).toBe(2);
  });

  it("restarts the session count after a recycle watermark", () => {
    const messages = [
      { id: "old", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "bound", role: "user" as const, kind: "text" as const },
      { id: "t1", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "next", role: "user" as const, kind: "text" as const },
    ];
    expect(countSessionToolRounds(messages, new Set(["next"]), "bound")).toBe(1);
  });

  it("lets a later compaction marker win over an earlier recycle watermark", () => {
    const messages = [
      { id: "old", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "bound", role: "user" as const, kind: "text" as const },
      { id: "mid", kind: "activity" as const, tool: { name: "Bash", ok: true } },
      { id: "c1", kind: "compaction" as const },
      { id: "t1", kind: "activity" as const, tool: { name: "Grep", ok: true } },
    ];
    expect(countSessionToolRounds(messages, undefined, "bound")).toBe(1);
  });

  it("countSessionToolRounds does not restart at a repair row", () => {
    const compaction = { v: 1, summary: "summary", coveredThroughId: "m1", firstKeptId: null, contextWindow: 200_000, estimatedTokensBefore: 900, sourceMessageCount: 1 };
    const messages = [
      { id: "old", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "fallback", kind: "compaction" as const, compaction },
      { id: "t1", kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "t2", kind: "activity" as const, tool: { name: "Bash", ok: true } },
      { id: "repair", kind: "compaction" as const, compaction: { ...compaction, summary: "repaired" } },
      { id: "t3", kind: "activity" as const, tool: { name: "Grep", ok: true } },
    ];
    expect(countSessionToolRounds(messages)).toBe(3);
  });
});

describe("nativeSessionTokenBudget", () => {
  it("returns zero for an unknown or invalid window instead of the 16k fallback", () => {
    expect(nativeSessionTokenBudget(0)).toBe(0);
    expect(nativeSessionTokenBudget(-1)).toBe(0);
    expect(nativeSessionTokenBudget(200_000)).toBe(100_000);
  });
});

describe("engineIsFresh", () => {
  const withUser = transcript;
  const greetingOnly = [{ role: "assistant" as const, text: "Hey — I'm Wren. Nice to meet you." }];

  it("is false when the same instance ran the last turn and has a cursor", () => {
    expect(engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: "claude", lastModel: "sonnet", sessionModelSwitch: "in-session", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
  });

  it("is true when the same instance ran last but there is no cursor to resume", () => {
    expect(engineIsFresh({ instanceId: "pi", model: "pi", lastInstanceId: "pi", lastModel: "pi", sessionModelSwitch: "in-session", resumeCursors: {}, transcript: withUser })).toBe(true);
  });

  it("starts fresh when an unsupported engine changes model", () => {
    expect(engineIsFresh({ instanceId: "codex", model: "gpt-5.2", lastInstanceId: "codex", lastModel: "gpt-5.1", sessionModelSwitch: "unsupported", resumeCursors: { codex: "thread-1" }, transcript: withUser })).toBe(true);
  });

  it("keeps the native session when its engine supports model changes", () => {
    expect(engineIsFresh({ instanceId: "claude", model: "opus", lastInstanceId: "claude", lastModel: "sonnet", sessionModelSwitch: "in-session", resumeCursors: { claude: "session-1" }, transcript: withUser })).toBe(false);
  });

  it("keeps legacy sessions whose last model was not recorded", () => {
    expect(engineIsFresh({ instanceId: "codex", model: "gpt-5.2", lastInstanceId: "codex", lastModel: undefined, sessionModelSwitch: "unsupported", resumeCursors: { codex: "thread-1" }, transcript: withUser })).toBe(false);
  });

  it("is true when another instance ran the last turn — even if this one has an older cursor", () => {
    // the user's bug: claude had a session from days ago, antigravity took the
    // latest turn, switching back to claude must NOT resume the stale session
    expect(
      engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: "antigravity", lastModel: "gemini", sessionModelSwitch: "in-session", resumeCursors: { claude: "old", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });

  it("keeps continuity through an A to B to A engine sequence", () => {
    const cursors = { a: "a-old", b: "b-current" };
    expect(engineIsFresh({ instanceId: "b", model: "b1", lastInstanceId: "a", lastModel: "a1", sessionModelSwitch: "unsupported", resumeCursors: cursors, transcript: withUser })).toBe(true);
    expect(engineIsFresh({ instanceId: "a", model: "a1", lastInstanceId: "b", lastModel: "b1", sessionModelSwitch: "in-session", resumeCursors: cursors, transcript: withUser })).toBe(true);
  });

  it("replays after compaction when the bounded tail contains only assistant entries", () => {
    expect(engineIsFresh({
      instanceId: "a",
      model: "a1",
      lastInstanceId: "b",
      lastModel: "b1",
      sessionModelSwitch: "in-session",
      resumeCursors: { a: "a-old", b: "b-current" },
      transcript: [{ role: "assistant", text: "summary and tool outcomes" }],
      hasPriorUserTurn: true,
    })).toBe(true);
  });

  it("is true for an instance that has never run this thread", () => {
    expect(engineIsFresh({ instanceId: "codex", model: "gpt-5.2", lastInstanceId: "claude", lastModel: "sonnet", sessionModelSwitch: "unsupported", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
  });

  it("is false on a brand-new bot: the seeded greeting alone is nothing to join", () => {
    expect(engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "in-session", resumeCursors: {}, transcript: greetingOnly })).toBe(false);
    expect(engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "in-session", resumeCursors: {}, transcript: [] })).toBe(false);
  });

  it("replays a stateless engine only after a prior user turn", () => {
    const stateless = {
      instanceId: "box",
      model: "box",
      lastInstanceId: "box",
      lastModel: "box",
      sessionModelSwitch: "in-session" as const,
      resumeCursors: { box: "ignored" },
      resumeCursor: false,
    };
    expect(engineIsFresh({ ...stateless, transcript: greetingOnly })).toBe(false);
    expect(engineIsFresh({ ...stateless, transcript: withUser })).toBe(true);
  });

  it("legacy task without lastInstanceId: trusts a lone cursor for this instance, replays otherwise", () => {
    // one cursor, ours — pre-upgrade single-engine thread, keep resuming
    expect(engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "in-session", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(false);
    // one cursor, someone else's — we never ran here
    expect(engineIsFresh({ instanceId: "codex", model: "gpt-5.2", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "unsupported", resumeCursors: { claude: "s1" }, transcript: withUser })).toBe(true);
    // two cursors — can't tell who ran last; replaying is the safe side
    expect(
      engineIsFresh({ instanceId: "claude", model: "sonnet", lastInstanceId: undefined, lastModel: undefined, sessionModelSwitch: "in-session", resumeCursors: { claude: "s1", antigravity: "s2" }, transcript: withUser }),
    ).toBe(true);
  });
});

describe("TurnSeeds", () => {
  const seed = { compactionId: "c1", instanceId: "claude", cursor: "session-a" };

  it("lets a stopped dispatch release only its own entry", () => {
    const seeds = new TurnSeeds();
    const stopped = seeds.set("t1", seed);
    const replacement = seeds.set("t1", seed);
    seeds.release("t1", stopped);
    expect(seeds.get("t1")).toBe(replacement);
    seeds.release("t1", replacement);
    expect(seeds.get("t1")).toBeUndefined();
  });

  it("hands the seed only to the completion of the turn that dispatched it", () => {
    const seeds = new TurnSeeds();
    const stopped = seeds.set("t1", seed);
    stopped.turnId = "turn-a";
    const replacement = seeds.set("t1", seed);
    // A's late completion lands while B is still dispatching
    expect(seeds.take("t1", "turn-a")).toBeUndefined();
    replacement.turnId = "turn-b";
    expect(seeds.take("t1", "turn-a")).toBeUndefined();
    expect(seeds.take("t1", undefined)).toBeUndefined();
    expect(seeds.take("t1", "turn-b")).toBe(replacement);
    expect(seeds.get("t1")).toBeUndefined();
  });
});

describe("withSystemChanges", () => {
  it("separates only the generated prefix from Codex user text", () => {
    const text = "<system-reminder>\n[Wink instructions update - user text]\n</system-reminder>\n\nhi";
    const system = "Reply in English.";
    expect(systemTurnInput(text, withSystemChanges(text, system, system)!, "codex")).toEqual({ text, systemUpdate: "" });
    const updated = withSystemChanges(text, system, "Reply in Korean.")!;
    expect(systemTurnInput(text, updated, "codex")).toEqual({ text, systemUpdate: withSystemChanges("", system, "Reply in Korean.") });
    expect(systemTurnInput(text, updated, "claudeAgent")).toEqual({ text: updated, systemUpdate: "" });
  });

  const reminder = (...lines: string[]) => [
    "<system-reminder>",
    "[Wink instructions update - your system prompt changed after this session started. Removed lines no longer apply; added lines are current and win over anything older.]",
    ...lines,
    "</system-reminder>",
  ];
  const withMemory = (...lines: string[]) =>
    `You are Testy, a personal bot in Wink. Role: Helper.\n\nYour memory (MEMORY.md):\n${lines.join("\n")}`;

  it("puts exactly the changed memory lines at the top of the turn", () => {
    const delivered = withMemory("- Pet: a cat named Mochi", "- City: Seoul", "- Drinks: tea");
    const system = withMemory("- Pet: a dog named Mochi", "- City: Seoul", "- Drinks: tea", "- Job: designer");
    expect(withSystemChanges("what pet do I have?", delivered, system)).toBe(
      [...reminder("[Removed:]", "- Pet: a cat named Mochi", "[Added:]", "- Pet: a dog named Mochi", "- Job: designer"), "", "what pet do I have?"].join("\n"),
    );
  });

  it("preserves project context when budgets move and the status changes", () => {
    const delivered = "## Project A\nBudget: 500 dollars.\n## Project B\nBudget: 740 dollars.\nStatus: draft.";
    const system = "## Project A\nBudget: 740 dollars.\n## Project B\nBudget: 500 dollars.\nStatus: final.";
    const update = [...reminder("[Removed:]", ...delivered.split("\n"), "[Added:]", ...system.split("\n")), "", "hi"].join("\n");
    expect(withSystemChanges("hi", delivered, system)).toBe(update);
    expect(withSystemChanges("hi", delivered, system, 0)).toBeNull();
    expect(withSystemChanges("hi", delivered, system, Infinity)).toBe(update);
  });

  it("sends nothing when the system text did not change", () => {
    const system = withMemory("- City: Seoul");
    expect(withSystemChanges("hi", system, system)).toBe("hi");
    expect(withSystemChanges("hi", `${system}\n\n`, system)).toBe("hi");
  });

  it("sends nothing for a session whose text is unknown, like a fresh one", () => {
    expect(withSystemChanges("hi", undefined, withMemory("- City: Seoul"))).toBe("hi");
  });

  it("names a removed line without inventing an added one", () => {
    expect(withSystemChanges("hi", withMemory("- City: Seoul", "- Drinks: tea"), withMemory("- City: Seoul"))).toBe(
      [...reminder("[Removed:]", "- Drinks: tea"), "", "hi"].join("\n"),
    );
  });

  it("sends one changed rule out of Wink's long guidance line, not the whole line", () => {
    const rules = Array.from({ length: 40 }, (_, i) => `Rule ${i} keeps the bot focused on the task the user gave it.`);
    const line = (changed: string) => [...rules.slice(0, 20), changed, ...rules.slice(20)].join(" ");
    const out = withSystemChanges("hi", line("Reply in English."), line("Reply in Korean."));
    expect(out).toBe([...reminder("[Removed:]", "Reply in English.", "[Added:]", "Reply in Korean."), "", "hi"].join("\n"));
  });

  it("returns null past the cap, so the session recycles instead", () => {
    const big = (word: string) => withMemory(...Array.from({ length: 200 }, (_, i) => `- ${word} note ${i} ${"x".repeat(40)}`));
    expect(withSystemChanges("hi", big("old"), big("new"))).toBeNull();
    expect(withSystemChanges("hi", big("old"), big("new"), Infinity)).toContain("- new note 199");
  });
});

describe("withTaskRecord", () => {
  it("puts the record on a turn that lacks it, once", () => {
    expect(withTaskRecord("hi", "Goal: ship")).toBe("Goal: ship\n\nhi");
    expect(withTaskRecord("Goal: ship\n\nhi", "Goal: ship")).toBe("Goal: ship\n\nhi");
    expect(withTaskRecord("hi", "")).toBe("hi");
  });
});

describe("replay engine provenance", () => {
  const replay = [
    { role: "user" as const, text: "Make a dog image" },
    { role: "assistant" as const, text: "Generated a dog image", engine: "antigravityAgent" },
    { role: "assistant" as const, text: "Current reply", engine: "museAgent" },
    { role: "assistant" as const, text: "Legacy reply" },
  ];

  it.each(["fresh", "rewound", "recycled"] as const)("names the earlier engine on a %s replay", (boundary) => {
    const out = buildTurnContext({ text: "Who made it?", transcript: replay, rewound: false, fresh: false, replaysNatively: false, driverKind: "museAgent", [boundary]: true });
    expect(out.turnText).toContain("Assistant (on Gemini): Generated a dog image");
    expect(out.turnText).toContain("Assistant: Current reply");
    expect(out.turnText).toContain("Assistant: Legacy reply");
  });

  it("names the earlier engine when resuming fails", () => {
    const text = buildResumeFallback({ text: "Who made it?", transcript: replay, driverKind: "museAgent" });
    expect(text).toContain("Assistant (on Gemini): Generated a dog image");
    expect(text).toContain("Assistant: Current reply");
    expect(text).toContain("Assistant: Legacy reply");
  });

  it("keeps a single-engine replay byte-identical", () => {
    const same = replay.map((message) => ({ ...message, engine: "museAgent" }));
    const plain = same.map(({ role, text }) => ({ role, text }));
    const input = { text: "Continue", rewound: false, fresh: true, replaysNatively: false, driverKind: "museAgent" };
    expect(buildTurnContext({ ...input, transcript: same })).toEqual(buildTurnContext({ ...input, transcript: plain }));
    expect(buildResumeFallback({ ...input, transcript: same })).toBe(buildResumeFallback({ ...input, transcript: plain }));
    expect(buildTurnContext({ ...input, fresh: false, transcript: replay })).toEqual({ turnText: "Continue", resume: true });
  });

  it.each(["claudeAgent", "codex", "antigravityAgent", "grokAgent", "museAgent", "boxAgent"])("leaves call lines untagged for %s", (driverKind) => {
    const messages = [
      { role: "user" as const, text: "What did we discuss?" },
      { role: "assistant" as const, text: "Spoken answer", engine: "geminiAgent" },
    ];
    const plain = messages.map(({ role, text }) => ({ role, text }));
    const input = { text: "Continue", driverKind, rewound: false, fresh: true, replaysNatively: false };
    expect(buildTurnContext({ ...input, transcript: messages })).toEqual(buildTurnContext({ ...input, transcript: plain }));
    expect(buildResumeFallback({ ...input, transcript: messages })).toBe(buildResumeFallback({ ...input, transcript: plain }));
    expect(replayMessageText(messages[1]!, driverKind)).toBe("Spoken answer");
  });

  it.each(["boxAgent", "localModel"])("never prints the unknown engine id %s", (engine) => {
    const message = { role: "assistant" as const, text: "Earlier answer", engine };
    const input = { text: "Continue", transcript: [message], driverKind: "museAgent", rewound: false, fresh: true, replaysNatively: false };
    expect(buildTurnContext(input).turnText).toContain("Assistant: Earlier answer");
    expect(buildResumeFallback(input)).toContain("Assistant: Earlier answer");
    expect(replayMessageText(message, "museAgent")).toBe(message.text);
  });

  it.each([
    ["claudeAgent", "Claude"],
    ["codex", "Codex"],
    ["antigravityAgent", "Gemini"],
    ["grokAgent", "Grok"],
    ["museAgent", "Muse"],
  ])("tags %s history for inline and native replay", (engine, label) => {
    const driverKind = engine === "museAgent" ? "codex" : "museAgent";
    const message = { role: "assistant" as const, text: "Generated a dog image", engine };
    const expected = `Assistant (on ${label}): Generated a dog image`;
    const input = { text: "Who made it?", transcript: [message], rewound: false, fresh: true, replaysNatively: false, driverKind };
    expect(buildTurnContext(input).turnText).toContain(expected);
    expect(buildResumeFallback(input)).toContain(expected);
    expect(replayMessageText(message, driverKind)).toBe(`(on ${label}) Generated a dog image`);
    expect(replayMessageText(message, engine)).toBe(message.text);
    expect(replayMessageText({ ...message, engine: undefined }, driverKind)).toBe(message.text);
    expect(replayMessageText({ ...message, role: "user" }, driverKind)).toBe(message.text);
  });
});

describe("fresh-session memory block", () => {
  const home = join(tmpdir(), "marketing");
  const cwd = join(home, "workspace");
  const shots = Array.from({ length: 11 }, (_, index) => join(home, "launch", "real-shots", `workers-${String(index + 1).padStart(2, "0")}.png`));
  const plan = join(home, "launch", "paste", "03-thursday.md");
  const tokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 3);

  it("names the plan first, then each folder with its count and newest files, newest folder first", () => {
    expect(memoryBlock({ files: [...shots, shots[0]!, "notes/a.md"], cwd, plans: [plan], builtList: join(home, "built.md"), work: "Your work: #12 merged" })).toBe([
      "[Wink memory - open these before answering about the plan or what is built or merged, or starting new work:]",
      `Read first, your plan: ${plan}`,
      `Built list: ${join(home, "built.md")}`,
      `Files, newest 4 folders: notes 1 (a.md); ${join(home, "launch", "real-shots")} 11 (workers-01.png, workers-11.png)`,
      "Your work: #12 merged",
    ].join("\n"));
    expect(memoryBlock({ files: [] })).toBe("");
    expect(memoryBlock({ files: ["notes/a.md"] })).toBe("");
    expect(memoryBlock({ files: ["MEMORY.md"], cwd })).toContain("Files, newest 4 folders: task folder 1 (MEMORY.md)");
  });

  it("lists four folders and counts the rest, keeping ordinary plan paths inline", () => {
    const files = Array.from({ length: 7 }, (_, index) => join(home, `dir-${index}`, "a.md")).concat(join(home, "dir-6", "b.md"));
    const plans = Array.from({ length: 6 }, (_, index) => join(home, "plans", `plan-${index}.md`));
    const text = memoryBlock({ files, plans });
    expect(text).toContain(`${join(home, "dir-6")} 2 (b.md, a.md); ${join(home, "dir-5")} 1`);
    expect(text).not.toContain("dir-2");
    expect(text).toContain("; +3 older folders (3 files)");
    for (const path of plans) expect(text).toContain(path);
  });

  it("keeps 1,000 full plan paths on disk and shows a bounded list with a pointer", () => {
    const dir = join(homedir(), "plan-state");
    const threadId = "large-plan";
    const paths = Array.from({ length: 1000 }, (_, index) => join(cwd, "계획".repeat(30), `release-${index}.md`));
    const sidecar = join(dir, `${threadId}.plans.jsonl`);
    const text = chatMemory({
      record: null, messages: [], cwd,
      overflow: paths.map((ref) => ({ ref, label: "Launch plan" })),
      savePlanSidecar: (refs) => writeTaskPlanSidecar(threadId, refs, { dir }),
    });
    const prefix = "Read first, your plan: ";
    const [, line = "", pointer] = text.split("\n");
    expect(line).toMatch(/^Read first, your plan: /);
    const shown = line.slice(prefix.length).split("; ");
    expect(shown).toEqual(paths.slice(0, shown.length));
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_MEMORY_PLAN_BYTES);
    expect(Buffer.byteLength(`${line}; ${paths[shown.length]}`)).toBeGreaterThan(MAX_MEMORY_PLAN_BYTES);
    expect(pointer).toBe(`+${paths.length - shown.length} more paths in ${sidecar}`);
    expect(text).not.toContain(paths.at(-1));
    expect(readFileSync(sidecar, "utf8").trimEnd().split("\n").map((row) => JSON.parse(row))).toEqual(paths);
    deleteTaskResumePacket(threadId, { dir });
    expect(existsSync(sidecar)).toBe(false);
  });

  it("stays small", () => {
    const someone = "C:\\Users\\someone";
    const real = `${someone}\\Desktop\\launch`;
    const typical = memoryBlock({
      files: [...shots.map((path) => path.replace(join(home, "launch"), real)), `${real}\\paste\\03-thursday.md`, `${real}\\paste\\02-wednesday.md`],
      plans: [`${real}\\paste\\03-thursday.md`],
      builtList: `${real}\\built.md`,
      home: someone,
      work: "Your work, newest 4: #1842 fix: show the plan (open PR); #1841 fix: name the shots (merged); fix/launch-post abc1234 (unfinished branch)",
    });
    expect(tokens(typical)).toBeLessThanOrEqual(180);
  });

  it("finds the plan from labeled artifacts and paths the goal or plan cite", () => {
    expect(planFiles({
      goal: "Post the Reddit launch from paste/03-thursday.md, see https://x.com/plan.md",
      plan: [{ step: `Follow ${join(home, "launch", "order.md")} and ${join(home, "RUNNER~1", "a.md")}`, status: "active" }],
      artifacts: [{ ref: shots[0]!, label: "Shot 1" }, { ref: join(home, "brief.md"), label: "Launch plan" }, { ref: "paste/03-thursday.md", label: "Thursday post" }],
    }, cwd)).toEqual([join(home, "brief.md"), join(cwd, "paste", "03-thursday.md"), join(home, "launch", "order.md"), join(home, "RUNNER~1", "a.md")]);
  });

  it("rides every turn it is given and names no chat search tool", () => {
    const memoryText = memoryBlock({ files: [], plans: [plan] });
    const transcript = [{ role: "user" as const, text: "plan it" }, { role: "assistant" as const, text: "done" }];
    const recycled = buildTurnContext({ text: "post it", transcript, rewound: false, fresh: false, recycled: true, recycleReason: "session-fat", replaysNatively: false, memoryText });
    expect(recycled.turnText).toContain("03-thursday.md");
    expect(recycled.turnText).not.toContain("search_my_chats");
    const resumed = buildTurnContext({ text: "post it", transcript, rewound: false, fresh: false, recycled: false, replaysNatively: false, memoryText });
    expect(resumed.turnText).toBe(`${memoryText}\n\npost it`);
    expect(buildTurnContext({ text: "post it", transcript, rewound: false, fresh: false, recycled: false, replaysNatively: false }).turnText).toBe("post it");
  });

  it("pins a quoted plan path that holds spaces", () => {
    const spaced = join(home, "task folder", "Launch Plan", "release.md");
    expect(planFiles({ goal: `Follow the plan at "${spaced}" and notes.md`, plan: [], artifacts: [] }, cwd)).toEqual([spaced, join(cwd, "notes.md")]);
  });

  it("pins a quoted plan file name that holds spaces", () => {
    expect(planFiles({ goal: `Follow "Launch Plan.md" step by step`, plan: [], artifacts: [] }, cwd)).toEqual([join(cwd, "Launch Plan.md")]);
  });

  it("pins unquoted Unicode paths from the goal and plan", () => {
    const document = join(home, "準備", "계획.md");
    const relative = join("資料", "発売.txt");
    expect(planFiles({
      goal: `Follow ${document} and ignore https://example.com/계획.md`,
      plan: [{ step: `Open ${relative}`, status: "active" }],
    }, cwd)).toEqual([document, join(cwd, relative)]);
  });

  it("expands home-relative plan files with or without a task folder", () => {
    const record = {
      goal: "Follow ~/plans/release.md",
      plan: [{ step: 'Open "~/More Plans/brief.txt"', status: "active" as const }],
      artifacts: [{ ref: "~/plans/checklist.txt", label: "Release plan" }],
    };
    const expected = [join(homedir(), "plans", "checklist.txt"), join(homedir(), "More Plans", "brief.txt"), join(homedir(), "plans", "release.md")];
    expect(planFiles(record, cwd)).toEqual(expected);
    expect(planFiles(record)).toEqual(expected);
  });

  it("pins a plan the record moved to its sidecar", () => {
    const shotsRecorded = shots.map((ref, index) => ({ ref, label: `Shot ${index + 1}` }));
    const text = chatMemory({
      record: { goal: "Ship the launch", plan: [], artifacts: shotsRecorded.slice(1) },
      overflow: [{ ref: plan, label: "Thursday launch plan" }, shotsRecorded[0]!],
      messages: [],
      cwd,
    });
    expect(text).toContain(`Read first, your plan: ${plan}`);
  });

  it("names files and the plan from synced rows when this PC has no record", () => {
    const recorded = [{ ref: plan, label: "Thursday launch plan" }, ...shots.map((ref, index) => ({ ref, label: `Shot ${index + 1}` }))];
    const text = chatMemory({ record: null, overflow: [], messages: [{ recorded }, { tool: { writes: [join(home, "notes.md")] } }], cwd });
    expect(text).toContain(`Read first, your plan: ${plan}`);
    expect(text).toContain(`${join(home, "launch", "real-shots")} 11 (workers-11.png, workers-10.png)`);
    expect(text).toContain(`${home} 1 (notes.md)`);
    expect(chatMemory({ record: null, overflow: [], messages: [], cwd })).toBe("");
  });

  it("names files a shell command made that no call recorded", () => {
    const text = chatMemory({ record: null, overflow: [], messages: [{ tool: { made: shots } }], cwd });
    expect(text).toContain(`${join(home, "launch", "real-shots")} 11 (workers-11.png, workers-10.png)`);
  });

  it("finds the built list path in the bot's notes, only when the file exists", () => {
    const built = join(home, "My Drive", "Orbit", "built.md");
    const notes = `- Feature list: ${built} (one line per feature)\n- other: built.md is in the vault`;
    expect(builtListPath(notes, (path) => path === built)).toBe(built);
    expect(builtListPath(notes, () => false)).toBeNull();
    expect(builtListPath("no list here", () => true)).toBeNull();
  });
});
