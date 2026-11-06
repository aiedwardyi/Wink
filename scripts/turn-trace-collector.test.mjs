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
