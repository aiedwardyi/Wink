import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { contextWindowFor, nativeCompactAt, nearNativeCompact, NATIVE_SUMMARY_WINDOW, planCompaction, prepareModelContext } from "./context-compaction.ts";
import type { Message } from "./store.ts";
import { reportedWindow } from "./turn-context.ts";

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

describe("native compaction wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const background = source.slice(source.indexOf("const summaryBuild ="), source.indexOf("const memoryPass ="));
  const dispatch = source.slice(source.indexOf("  const modelContextWindow ="), source.indexOf("  const messagesBeforeSummary ="));
  const room = source.slice(source.indexOf("  const catalogWindow = contextWindowFor", source.indexOf("const selectedInstance = registry.get(selection.instanceId);")), source.indexOf("  const recovering = isRecoveringPacket(taskRecord);", source.indexOf("const selectedInstance = registry.get(selection.instanceId);")));
  const settled = source.slice(source.indexOf("              const nativeAt = nativeCompactAt"), source.indexOf("              flushNotes = nearNativeCompact"));

  function run(path: string, window: number) {
    const model = "claude-opus-5-5";
    const task = { nativePrompt: { cursor: "s1", first: 10, last: 20, window: { model, tokens: window } } };
    const instance = { driverKind: "claudeAgent", models: { options: [{ id: model, contextWindow: 1_000_000 }] } };
    const nativeAt = vi.fn(nativeCompactAt);
    const scope = {
      instance, settled: instance, model, task, selection: { model, instanceId: "claude" }, instanceId: "claude",
      event: { contextWindow: window, providerInstanceId: "claude" }, bot: { id: "bot" }, threadId: "thread",
      store: { taskByThread: () => task }, cfg: {}, accounts: { snapshot: [] }, process: { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500000" } },
      instanceConfigs: () => ({ claude: { environment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" } } }),
      contextWindowFor, reportedWindow, nativeCompactAt: nativeAt, NATIVE_SUMMARY_WINDOW,
    };
    const code = path === "dispatch" ? `${dispatch}\nreturn modelContextWindow;`
      : path === "room" ? `${room}\nreturn modelContextWindow;`
      : path === "settled" ? `${settled}\nreturn 0;`
      : `${background.slice(background.indexOf("    const contextWindow ="), background.indexOf("    const record ="))}\n${background.match(/      nativeAt: (.*),/)![1]};\nreturn contextWindow;`;
    const contextWindow = new Function("scope", `with (scope) { ${code} }`)(scope) as number;
    return { contextWindow, nativeAt: nativeAt.mock.results[0]?.value };
  }

  it.each([
    ["dispatch", 200_000, 100_000],
    ["background", 200_000, 100_000],
    ["room", 200_000, 100_000],
    ["room", 100_000, 50_000],
  ] as const)("bounds the %s replay plan at %i reported tokens", (path, window, budgetTokens) => {
    const { contextWindow } = run(path, window);
    expect(planCompaction({ messages: longThread(), contextWindow })).toMatchObject({ budgetTokens });
  });

  it.each(["dispatch", "background", "room", "settled"])("uses the instance compaction override in %s", (path) => {
    expect(run(path, 1_000_000).nativeAt).toBe(67_000);
  });

  it("bounds the grace window by Claude's reported window", () => {
    const expression = source.match(/    knownWindow: (.*),/)![1];
    expect(new Function("catalogWindow", "modelContextWindow", `return ${expression};`)(1_000_000, 200_000)).toBe(200_000);
  });
});

describe("nativeCompactAt", () => {
  it.each([
    ["claudeAgent", "claude-opus-5-5", 1_000_000, {}, 967_000],
    ["claudeAgent", "claude-sonnet-5-5", 200_000, {}, null],
    ["claudeAgent", "ollama::small:latest", 1_000_000, {}, null],
    ["claudeAgent", "claude-opus-5-5", 1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" }, 67_000],
    ["claudeAgent", "claude-opus-5-5", 1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500k" }, 467_000],
    ["claudeAgent", "claude-opus-5-5", 1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200k" }, 167_000],
    ["claudeAgent", "claude-sonnet-5-5", 200_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200k" }, 167_000],
    ["claudeAgent", "claude-sonnet-5-5", 200_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "500k" }, 167_000],
    ["claudeAgent", "claude-opus-5-5", 1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200" }, 67_000],
    ["claudeAgent", "claude-opus-5-5", 1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "2000000" }, 967_000],
    ["claudeAgent", "claude-opus-5-5", 50_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" }, 25_000],
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

  it("queues the summary before Claude compacts under a 100k override", () => {
    const nativeAt = nativeCompactAt("claudeAgent", "claude-opus-5-5", 1_000_000, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" });
    expect(nearNativeCompact({ last: 58_047, growth: 24_000, nativeAt })).toBe(true);
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
