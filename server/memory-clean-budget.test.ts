import { describe, expect, it, vi } from "vitest";

import { callTokens, cleanFiles, NIGHT_TOKENS } from "./memory-clean-engine.ts";
import type { TextCall } from "./memory-clean-types.ts";
import { sleepReply } from "./testing/sleep-verdicts.ts";

const lines = Array.from({ length: 139 }, (_, i) => `- task ${i} ${"memo ".repeat(20)}`);
const memory = lines.join("\n").padEnd(15_999, "x") + "\n";
const questions = Array.from({ length: 18 }, (_, i) => ({
  kind: i < 12 ? "changed" : i < 16 ? "protected" : "absent", question: `Fact ${i}?`, answer: i === 0 ? "five" : i === 1 ? "6 days" : i < 16 ? `value ${i}` : null,
}));
const list = JSON.stringify({ version: 1, file: "MEMORY.md", changes: Array.from({ length: 24 }, (_, i) => ({ op: "retire", id: i + 1, reason: "Completed" })) });
const used = [18_908, 5_000, 17_184, 9_717, 12_280];

function run(tokens: Array<number | undefined> = used, grade = true, legacy = false, exact = false) {
  let calls = 0;
  const call = vi.fn<TextCall>(async (prompt) => {
    const at = calls++;
    const text = sleepReply(prompt) ?? (prompt.startsWith("[memory-clean:questions]") ? JSON.stringify(questions)
      : prompt.startsWith("[memory-clean:answers]") ? JSON.stringify(questions.map((q, i) => exact ? q.answer : i === 0 ? "5" : i === 1 ? "6" : q.answer))
      : prompt.startsWith("[memory-clean:grade]") ? JSON.stringify([grade, grade]) : list);
    return legacy ? text : { text, tokens: tokens[at] };
  });
  return { call, result: cleanFiles({ memory, history: null, typed: new Set(), propose: call, recall: call }) };
}

describe("memory cleanup usage budget", () => {
  it("counts organization and grading in the nightly ledger", async () => {
    const engine = run();
    expect(await engine.result).toMatchObject({ ok: true, tokens: used.reduce((a, b) => a + b, 0) });
    expect(engine.call).toHaveBeenCalledTimes(5);
    expect(engine.call.mock.calls[1]![0]).toContain("[memory-clean:organize]");
    expect(Buffer.byteLength(engine.call.mock.calls[4]![0])).toBeLessThan(1024);
  });

  it("reserves output before starting the next call", async () => {
    const engine = run([NIGHT_TOKENS - 1]);
    expect(await engine.result).toMatchObject({ ok: false, stage: "recall", detail: "budget" });
    expect(engine.call).toHaveBeenCalledTimes(1);
  });

  it("admits the final projected call exactly at the cap, but not one token beyond", async () => {
    const probe = run();
    expect(await probe.result).toMatchObject({ ok: true });
    const bound = callTokens(probe.call.mock.calls[4]![0], 0) + 4096;
    for (const extra of [0, 1]) {
      const engine = run([1000, 1000, 1000, NIGHT_TOKENS - bound - 3000 + extra, 1000]);
      expect(await engine.result).toMatchObject(extra ? { ok: false, stage: "recall", detail: "budget" } : { ok: true });
      expect(engine.call).toHaveBeenCalledTimes(extra ? 4 : 5);
    }
  });

  it.each([false, true])("rejects an actual overrun on the final call, exact %s", async (exact) => {
    const prior = exact ? used.slice(0, 3) : used.slice(0, 4);
    const engine = run([...prior, NIGHT_TOKENS - prior.reduce((a, b) => a + b, 0) + 1], true, false, exact);
    expect(await engine.result).toMatchObject({ ok: false, stage: "recall", detail: "budget" });
    expect(engine.call).toHaveBeenCalledTimes(exact ? 4 : 5);
  });

  it.each([false, true])("keeps no-change calls inside the hard cap, side %s", async (side) => {
    const call = vi.fn<TextCall>(async (prompt) => ({ text: JSON.stringify({ version: 1, file: /"file":"([^"]+)"/.exec(prompt)![1], changes: [] }), tokens: NIGHT_TOKENS + 1 }));
    expect(await cleanFiles({ memory: "- kept\n", side: side ? { file: "memory/topic.md", text: "- topic\n" } : undefined, history: null, typed: new Set(), propose: call, recall: call }))
      .toMatchObject({ ok: false, stage: "propose", detail: "budget" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 0, -1, NaN, Infinity, 0.5])("uses conservative estimates for unusable usage %s", async (tokens) => {
    const engine = run(Array(5).fill(tokens));
    const result = await engine.result;
    expect(result).toMatchObject({ ok: true });
    expect(result.tokens).toBeGreaterThan(engine.call.mock.calls.reduce((n, [prompt]) => n + callTokens(prompt), 0));
    expect(result.tokens).toBeLessThanOrEqual(NIGHT_TOKENS);
  });

  it("keeps text-only engines bounded", async () => {
    const engine = run([], true, true);
    const result = await engine.result;
    expect(result).toMatchObject({ ok: true });
    expect(result.tokens).toBeLessThanOrEqual(NIGHT_TOKENS);
  });

  it("rejects a response larger than its reserved output", async () => {
    const call = vi.fn<TextCall>(async () => ({ text: "x".repeat(12_289), tokens: 10 }));
    expect(await cleanFiles({ memory: "- kept\n", history: null, typed: new Set(), propose: call, recall: call }))
      .toMatchObject({ ok: false, stage: "propose", detail: "budget" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("still rejects a bad grade after admitting the call", async () => {
    expect(await run(used, false).result).toMatchObject({ ok: false, stage: "recall", detail: "Recall 16/18; wrong 2" });
  });

  it("does not reset the token ledger for a repair", async () => {
    const call = vi.fn<TextCall>(async () => ({ text: "{}", tokens: NIGHT_TOKENS - 1 }));
    expect(await cleanFiles({ memory: "- kept\n", history: null, typed: new Set(), propose: call, recall: call }))
      .toMatchObject({ ok: false, stage: "propose", detail: "budget" });
    expect(call).toHaveBeenCalledTimes(1);
  });
});
