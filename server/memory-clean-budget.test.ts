import { describe, expect, it, vi } from "vitest";

import { callTokens, cleanFiles } from "./memory-clean-engine.ts";
import type { TextCall } from "./memory-clean-types.ts";

const lines = Array.from({ length: 175 }, (_, i) => `- task ${i} ${"memo ".repeat(23)}`);
const memory = lines.join("\n").padEnd(22_899, "x") + "\n";
const questions = Array.from({ length: 18 }, (_, i) => ({
  kind: i < 12 ? "changed" : i < 16 ? "protected" : "absent", question: `Fact ${i}?`, answer: i === 0 ? "five" : i === 1 ? "6 days" : i < 16 ? `value ${i}` : null,
}));
const list = JSON.stringify({ version: 1, file: "MEMORY.md", changes: Array.from({ length: 30 }, (_, i) => ({ op: "retire", id: i + 1, reason: "Completed" })) });
const used = [18_908, 17_184, 9_717, 12_280];

function run(tokens: Array<number | undefined> = used, grade = true, legacy = false, exact = false) {
  const replies = [list, JSON.stringify(questions), JSON.stringify(questions.map((q, i) => exact ? q.answer : i === 0 ? "5" : i === 1 ? "6" : q.answer)), JSON.stringify([grade, grade])];
  let calls = 0;
  const call = vi.fn<TextCall>(async () => {
    const at = calls++;
    return legacy ? replies[at]! : { text: replies[at]!, tokens: tokens[at] };
  });
  return { call, result: cleanFiles({ memory, history: null, typed: new Set(), propose: call, recall: call }) };
}

describe("memory cleanup usage budget", () => {
  it("reaches a sub-1 KB grade after the CLEAN-PARSE smoke's 45,809 actual tokens", async () => {
    const engine = run();
    expect(await engine.result).toMatchObject({ ok: true });
    expect(engine.call).toHaveBeenCalledTimes(4);
    const prompts = engine.call.mock.calls.map(([prompt]) => prompt);
    expect(Buffer.byteLength(memory)).toBe(22_900);
    expect(Buffer.byteLength(prompts[3]!)).toBeLessThan(1024);
    expect(used.slice(0, 3).reduce((a, b) => a + b, 0)).toBe(45_809);
    expect(45_809 + callTokens(prompts[3]!)).toBeLessThanOrEqual(60_000);
    expect(prompts.reduce((sum, prompt) => sum + callTokens(prompt), 0)).toBeGreaterThan(60_000);
  });

  it("stops before the next call when actual usage plus its bound exceeds the cap", async () => {
    const engine = run([59_000]);
    expect(await engine.result).toMatchObject({ ok: false, stage: "nothing", detail: "budget" });
    expect(engine.call).toHaveBeenCalledTimes(1);
  });

  it("admits a call exactly at the cap and stops one token beyond it", async () => {
    const probe = run();
    expect(await probe.result).toMatchObject({ ok: true });
    const bound = callTokens(probe.call.mock.calls[3]![0]);
    for (const extra of [0, 1]) {
      const engine = run([18_908, 17_184, 60_000 - bound - 36_092 + extra, bound]);
      expect(await engine.result).toMatchObject(extra ? { ok: false, stage: "nothing", detail: "budget" } : { ok: true });
      expect(engine.call).toHaveBeenCalledTimes(extra ? 3 : 4);
    }
  });

  it.each([false, true])("rejects an actual overrun on the final call, exact answers %s", async (exact) => {
    const engine = run(exact ? [18_908, 17_184, 30_000] : [18_908, 17_184, 9_717, 14_192], true, false, exact);
    expect(await engine.result).toMatchObject({ ok: false, stage: "nothing", detail: "budget" });
    expect(engine.call).toHaveBeenCalledTimes(exact ? 3 : 4);
  });

  it.each([false, true])("enforces the unchanged hard cap on a no-change reply, side %s", async (side) => {
    const call = vi.fn<TextCall>(async (prompt) => ({ text: JSON.stringify({ version: 1, file: /"file":"([^"]+)"/.exec(prompt)![1], changes: [] }), tokens: (side ? 120_000 : 60_000) + 1 }));
    expect(await cleanFiles({ memory: "- kept\n", side: side ? { file: "memory/topic.md", text: "- topic\n" } : undefined, history: null, typed: new Set(), propose: call, recall: call })).toMatchObject({ ok: false, stage: "nothing", detail: "budget" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 0, -1, NaN, Infinity, 0.5])("falls back to the existing estimate for unusable usage %s", async (tokens) => {
    const engine = run(Array(4).fill(tokens));
    expect(await engine.result).toMatchObject({ ok: false, stage: "nothing", detail: "budget" });
    expect(engine.call).toHaveBeenCalledTimes(3);
    expect(engine.call.mock.calls.reduce((sum, [prompt]) => sum + callTokens(prompt), 0)).toBeLessThanOrEqual(60_000);
  });

  it("keeps text-only engines bounded", async () => {
    const engine = run([], true, true);
    expect(await engine.result).toMatchObject({ ok: false, stage: "nothing", detail: "budget" });
    expect(engine.call).toHaveBeenCalledTimes(3);
  });

  it("still rejects a bad grade after admitting the call", async () => {
    const engine = run(used, false);
    expect(await engine.result).toMatchObject({ ok: false, stage: "recall", detail: "Recall 16/18; wrong 2" });
    expect(engine.call).toHaveBeenCalledTimes(4);
  });
});
