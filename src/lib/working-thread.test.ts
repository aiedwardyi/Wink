import { describe, expect, it } from "vitest";

import {
  activeRunForRoutine,
  canDeleteWhileWorking,
  canSwitchWhileWorking,
  routineThreadReturn,
  routineWorkingElsewhere,
  runThread,
  workingThreadId,
} from "../../shared/working-thread";

const queued = {
  id: "run-q",
  routineId: "routine-1",
  routineName: "Morning brief",
  botId: "bot-1",
  status: "queued" as const,
  scheduledFor: 100,
};

const running = {
  ...queued,
  id: "run-r",
  status: "running" as const,
  threadId: "exec-thread",
};

describe("activeRunForRoutine", () => {
  it("returns the queued, running, or waiting run and ignores settled receipts", () => {
    const runs = [
      { ...queued, id: "done", status: "completed" as const },
      queued,
    ];
    expect(activeRunForRoutine(runs, "routine-1")?.id).toBe("run-q");
    expect(activeRunForRoutine(runs, "routine-other")).toBeUndefined();
  });
});

describe("workingThreadId", () => {
  it("uses the live routine thread when work is detached from the open chat", () => {
    expect(workingThreadId({
      busy: true,
      viewedThreadId: "chat-thread",
      liveRoutineThreadId: "exec-thread",
    })).toBe("exec-thread");
  });

  it("uses the open chat when the bot is busy with no detached routine", () => {
    expect(workingThreadId({
      busy: true,
      viewedThreadId: "chat-thread",
      liveRoutineThreadId: null,
    })).toBe("chat-thread");
  });

  it("is idle when nothing is working", () => {
    expect(workingThreadId({
      busy: false,
      viewedThreadId: "chat-thread",
      liveRoutineThreadId: null,
    })).toBeNull();
  });
});

describe("switch and delete while a routine is running", () => {
  it("allows aligning the open chat to the working thread, not leaving it", () => {
    expect(canSwitchWhileWorking("exec-thread", "exec-thread")).toBe(true);
    expect(canSwitchWhileWorking("chat-thread", "exec-thread")).toBe(false);
    expect(canSwitchWhileWorking("chat-thread", null)).toBe(true);
  });

  it("blocks deleting the working thread and allows deleting an unchecked idle thread", () => {
    expect(canDeleteWhileWorking("exec-thread", "exec-thread")).toBe(false);
    expect(canDeleteWhileWorking("chat-thread", "exec-thread")).toBe(true);
  });
});

describe("routineWorkingElsewhere", () => {
  it("names the routine that is queued or running on another thread of the same bot", () => {
    expect(routineWorkingElsewhere("chat-thread", running)).toEqual({
      name: "Morning brief",
      threadId: "exec-thread",
      status: "running",
    });
    expect(routineWorkingElsewhere("chat-thread", queued)).toEqual({
      name: "Morning brief",
      threadId: undefined,
      status: "queued",
    });
    expect(routineWorkingElsewhere("exec-thread", running)).toBeNull();
  });

  it("uses the source chat as the working thread of a chat run", () => {
    const chatRun = { ...queued, status: "running" as const, sourceThreadId: "chat-thread" };
    expect(runThread(chatRun)).toBe("chat-thread");
    expect(runThread({ ...running, sourceThreadId: "chat-thread" })).toBe("exec-thread");
    expect(routineWorkingElsewhere("chat-thread", chatRun)).toBeNull();
    expect(routineWorkingElsewhere("side-task", chatRun)).toEqual({
      name: "Morning brief",
      threadId: "chat-thread",
      status: "running",
    });
    expect(workingThreadId({ busy: true, viewedThreadId: "side-task", liveRoutineThreadId: runThread(chatRun) })).toBe("chat-thread");
  });
});

describe("routineThreadReturn", () => {
  const run = (patch: { status?: string; sourceThreadId?: string } = {}) => ({ ...running, status: "completed", ...patch });
  const tasks = [{ threadId: "exec-thread" }, { threadId: "side-task" }, { threadId: "chat-thread" }];
  const room = { id: "room-1", threadId: "room-thread", memberIds: ["bot-1"], tasks: [{ threadId: "room-old" }] };
  const input = (patch: Partial<Parameters<typeof routineThreadReturn>[0]> = {}) => ({
    botId: "bot-1",
    viewedThreadId: "exec-thread",
    tasks,
    runs: [run({ sourceThreadId: "chat-thread" })],
    groups: [room],
    ...patch,
  });

  it("stays away from a normal thread", () => {
    expect(routineThreadReturn(input({ viewedThreadId: "chat-thread" }))).toBeNull();
  });

  it("returns a run thread to the chat it reports to", () => {
    expect(routineThreadReturn(input())).toEqual({ name: "Morning brief", live: false, botThreadId: "chat-thread", group: null });
    expect(routineThreadReturn(input({ runs: [run({ status: "waiting", sourceThreadId: "chat-thread" })] }))?.live).toBe(true);
  });

  it("returns a room-origin run to its room and moves the bot to its newest non-routine task", () => {
    const runs = [run({ sourceThreadId: "room-old" }), { ...run(), id: "old", threadId: "side-task" }];
    expect(routineThreadReturn(input({ runs }))).toEqual({
      name: "Morning brief",
      live: false,
      botThreadId: "chat-thread",
      group: { id: "room-1", threadId: "room-old" },
    });
  });

  it("falls back to the newest non-routine task when the source is gone", () => {
    expect(routineThreadReturn(input({ runs: [run({ sourceThreadId: "deleted" })] }))?.botThreadId).toBe("side-task");
    expect(routineThreadReturn(input({ runs: [run()] }))?.botThreadId).toBe("side-task");
    expect(routineThreadReturn(input({ runs: [run({ sourceThreadId: "room-thread" })], groups: [{ ...room, memberIds: [] }] }))?.group).toBeNull();
  });
});
