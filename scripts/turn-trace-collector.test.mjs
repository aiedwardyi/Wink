import { describe, expect, it, vi } from "vitest";

import { collectTurnTraces, traceNoteWait } from "./turn-trace-collector.mjs";

describe("turn trace collector", () => {
  const row = {
    version: 2, traceId: "trace", requests: [{ id: "r1", nested: false, usage: { input: 30, output: 2 } }],
    reconciliation: { result: { input: 30, output: 2 }, delta: null }, spans: [],
  };

  it("reconciles requests once without charging the invocation result again", () => {
    expect(collectTurnTraces([row, row])).toEqual([expect.objectContaining({ sum: { input: 30, output: 2 }, reconciled: true, incomplete: false })]);
  });

  it("reads a provider row without calling declared gaps or the untaken resume branch unknown", () => {
    const done = (phase, reason) => ({ phase, start: 1, end: 2, reason });
    const gap = (phase, reason) => ({ phase, start: null, end: null, reason });
    const spans = [done("prompt_build"), done("retirement_wait"), done("spawn", "cold"), done("initialize", "initialize"), done("start", "thread/start"), done("dispatch", "turn/start"), done("first_event"), done("completion"), gap("hooks", "CLI-owned/unobservable"), gap("resume", "unobserved"), gap("note_wait", "runner-owned/unobservable")];
    expect(collectTurnTraces([{ ...row, spans }])[0]).toMatchObject({ incomplete: false, unknownPhases: [] });
    expect(collectTurnTraces([{ ...row, spans: [...spans.slice(0, 4), gap("start", "unobserved"), ...spans.slice(5)] }])[0].unknownPhases).toEqual([{ phase: "start", reason: "unobserved" }, { phase: "resume", reason: "unobserved" }]);
  });

  it("keeps a resume that started and never ended as unknown beside a fallback start", () => {
    const spans = [{ phase: "resume", start: 1, end: null, reason: "thread/resume" }, { phase: "start", start: 3, end: 4, reason: "thread/start" }];
    expect(collectTurnTraces([{ ...row, spans }])[0].unknownPhases).toEqual([{ phase: "resume", reason: "thread/resume" }]);
  });

  it("leaves unattributed or unmetered helpers incomplete", () => {
    expect(collectTurnTraces([{ ...row, batchId: "batch", requests: [{ id: "helper", usage: null }] }])[0]).toMatchObject({ scope: "helper", sum: null, incomplete: true });
  });

  it.each(["drained", "timeout", "no-pending-ids"])("records the actual %s boundary wait", async (reason) => {
    let now = 10;
    const write = vi.fn();
    const result = await traceNoteWait({ sendId: "send" }, async () => { now = 25; return { reason }; }, { enabled: true, now: () => now, write });
    expect(result).toEqual({ reason });
    expect(write.mock.calls[0][0]).toMatchObject({ phase: "note_wait", start: 10, end: 25, reason, sendId: "send" });
  });

  it("preserves errors and never clocks or writes an off-mode wait", async () => {
    const now = vi.fn();
    const write = vi.fn();
    await expect(traceNoteWait({}, async () => { throw new Error("wait failed"); }, { now, write })).rejects.toThrow("wait failed");
    expect(now).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
