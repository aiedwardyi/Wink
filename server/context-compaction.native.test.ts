import { describe, expect, it, vi } from "vitest";

import { nativeCompactAt, nearNativeCompact, planCompaction, prepareModelContext } from "./context-compaction.ts";
import type { Message } from "./store.ts";

const message = (id: string, text: string, patch: Partial<Message> = {}): Message => ({
  id,
  at: 1_000,
  role: "user",
  kind: "text",
  text,
  ...patch,
});

// Over the 60 user-turn cap, so any budget plans a summary.
const longThread = () => Array.from({ length: 70 }, (_, index) => [
  message(`u${index}`, `request ${index}`),
  message(`b${index}`, `outcome ${index}`, { role: "bot" }),
]).flat();

describe("nativeCompactAt", () => {
  it.each([
    ["claudeAgent", "claude-opus-5-5", 1_000_000, {}, 967_000],
    ["claudeAgent", "claude-sonnet-5-5", 200_000, {}, null],
    ["claudeAgent", "ollama::small:latest", 1_000_000, {}, null],
    ["claudeAgent", "claude-opus-5-5", 1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" }, 100_000],
    ["claudeAgent", "claude-opus-5-5", 1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500k" }, 500_000],
    ["claudeAgent", "claude-opus-5-5", 1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200" }, 100_000],
    ["claudeAgent", "claude-opus-5-5", 1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "2000000" }, 1_000_000],
    ["codex", "gpt-5.5", 1_000_000, {}, null],
    ["antigravityAgent", "gemini-4-argon-high", 1_048_576, {}, null],
    ["grokAgent", "grok-build", 500_000, {}, null],
    ["museAgent", "muse-spark-1.3", 1_048_576, {}, null],
  ] as const)("%s %s at %i with %j", (driverKind, model, window, env, expected) => {
    expect(nativeCompactAt(driverKind, model, window, env)).toBe(expected);
  });
});

describe("native compaction plan", () => {
  it("plans Wink's summary at 0.9 of the native point with today's summary sizing", () => {
    const plan = planCompaction({ messages: longThread(), contextWindow: 1_000_000, nativeAt: 967_000 });
    expect(plan.needed).toBe(true);
    if (!plan.needed) return;
    expect(plan.budgetTokens).toBe(870_300);
    expect(plan.contextWindow).toBe(200_000);
  });

  it("queues the summary when the next turn would pass 0.9 of the native point", () => {
    expect(nearNativeCompact({ last: 805_000, growth: 70_000, nativeAt: 967_000 })).toBe(true);
    expect(nearNativeCompact({ last: 700_000, growth: 70_000, nativeAt: 967_000 })).toBe(false);
    expect(nearNativeCompact({ last: 900_000, growth: 70_000, nativeAt: null })).toBe(false);
  });

  it("resumes a native session with no inline summary; a reseed still compacts", async () => {
    const grace = {
      knownWindow: null,
      requestText: "next",
      fresh: false,
      rewound: false,
      recycle: false,
      local: false,
      nativeAt: 967_000,
      native: { instanceId: "claude", cursor: "s1", seed: { instanceId: "claude", cursor: "s1", compactionId: "older" }, prompt: undefined },
    };
    const input = { messages: longThread(), contextWindow: 1_000_000, nativeAt: 967_000, taskRecordText: "Goal: keep going" };
    const summarize = vi.fn(async () => "SUMMARY\ninline");
    expect(await prepareModelContext({ ...input, summaryGrace: grace, summarize })).toMatchObject({ status: "ready", compacted: false });
    expect(summarize).not.toHaveBeenCalled();
    await prepareModelContext({ ...input, summaryGrace: { ...grace, fresh: true }, summarize });
    expect(summarize).toHaveBeenCalledOnce();
  });
});
