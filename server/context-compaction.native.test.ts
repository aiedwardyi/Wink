import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { codexResumeReplayRoom, contextWindowFor, nativeCompactAt, nativeReplayBudget, nearNativeCompact, NATIVE_SUMMARY_WINDOW, planCompaction, prepareModelContext, prepareNativeReplay } from "./context-compaction.ts";
import { ownerTopics } from "./one-mind.ts";
import type { Message } from "./store.ts";
import { buildTurnContext, reportedWindow } from "./turn-context.ts";
import { readContextCompaction } from "../shared/context-compaction.ts";

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

const savedSummary = (summary: string): Message[] => [
  message("covered", "Send the release handoff to covered-owner@example.test."),
  message("saved", "", {
    role: "bot", kind: "compaction", compaction: {
      v: 1, summary, coveredThroughId: "covered", firstKeptId: null,
      contextWindow: 128_000, estimatedTokensBefore: 30, sourceMessageCount: 1,
    },
  }),
];

const handoff = (contact: string, attachment: string): Message[] => [
  message("contact", `Please use ${contact} for the release handoff.`),
  message("4fb29a1e-df56-4371-b9ac-9dd33f02991e", `First long paste. <attached-image path="${attachment}" />\n` + "a long example line. ".repeat(5_500)),
  message("old-b", "Second long paste. " + "another example line. ".repeat(5_500)),
  message("recent", "The current milestone is violet telescope."),
];

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

  it("hands the background build the session it would resume, never a live prompt size", () => {
    const expression = background.match(/      cursor: (.*),/)![1];
    const read = (cursor: string) => new Function("task", "selection", `return ${expression};`)({ resumeCursors: { claude: cursor } }, { instanceId: "claude" });
    expect(read("s1")).toBe("s1");
    expect(read("s2")).toBe("s2");
    expect(background).not.toContain("nativePrompt:");
  });

  it("flushes notes from the growth the store recorded", () => {
    expect(source).toContain("flushNotes = nearNativeCompact({ ...recorded, nativeAt });");
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

  it("reads a record with no growth as none", () => {
    expect(nearNativeCompact({ last: 60_300, nativeAt: 67_000 })).toBe(true);
    expect(nearNativeCompact({ last: 60_299, nativeAt: 67_000 })).toBe(false);
  });

  describe("cut near the real prompt", () => {
    const turn = (id: string, text: string) => [message(`${id}-u`, text), message(`${id}-b`, "noted", { role: "bot" })];
    const harbor = (tokens: number) => "the harbor lights came on early and the tide was calm.\n".repeat(Math.ceil((tokens * 3) / 55));
    const native = { contextWindow: 100_000, nativeAt: 67_000 };
    const nativePrompt = { last: 58_114, growth: 24_373 };
    const messages = [...turn("a", harbor(9_000)), ...turn("b", harbor(9_000)), ...turn("c", harbor(9_000))];
    const ids = (units: Array<{ id: string }>) => units.map((unit) => unit.id);

    it("covers a sensible prefix when the estimate fits and the real prompt does not", () => {
      expect(planCompaction({ messages, ...native })).toMatchObject({ needed: false });
      const plan = planCompaction({ messages, ...native, nativePrompt });
      if (!plan.needed) throw new Error("expected a plan");
      expect(ids(plan.old)).toEqual(["a-u", "a-b", "b-u", "b-b"]);
      expect(ids(plan.tail)).toEqual(["c-u", "c-b"]);
    });

    it("keeps the last turn even when its share of the real prompt is smaller", () => {
      const plan = planCompaction({ messages: [...turn("plant", "remember"), ...turn("fill", harbor(22_800))], ...native, nativePrompt });
      if (!plan.needed) throw new Error("expected a plan");
      expect(ids(plan.old)).toEqual(["plant-u", "plant-b"]);
      expect(ids(plan.tail)).toEqual(["fill-u", "fill-b"]);
    });

    it("leaves only the turn cap once the cycle has its summary", () => {
      expect(planCompaction({ messages, ...native, nativePrompt, nativeCycleBuilt: true })).toMatchObject({ needed: false });
      expect(planCompaction({ messages: longThread(), ...native, nativePrompt, nativeCycleBuilt: true })).toMatchObject({ needed: true });
    });

    it("ignores the real prompt without a native point", () => {
      expect(planCompaction({ messages, contextWindow: 100_000, nativePrompt })).toEqual(planCompaction({ messages, contextWindow: 100_000 }));
    });
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

  it("keeps all planned history for a bounded Codex native replay", () => {
    const plan = planCompaction({ messages: [...savedSummary("The launch is approved for review."), ...longThread()], contextWindow: 128_000 });
    if (!plan.needed) throw new Error("expected a plan");
    const prepared = prepareNativeReplay(plan, nativeReplayBudget(128_000));
    expect(prepared).toMatchObject({ status: "ready", compactionId: "saved" });
    expect(prepared?.transcript.slice(1)).toEqual(plan.transcript.slice(1));
  });

  it.each([
    ["no saved summary", []],
    ["a fallback summary", savedSummary("Model summary unavailable; full transcript retained by Wink.\nReviewed the release notes.")],
  ])("writes a fresh summary instead of a native replay with %s", (_, rows) => {
    const messages = [...rows, ...longThread()];
    const plan = planCompaction({ messages, contextWindow: 128_000 });
    if (!plan.needed) throw new Error("expected a plan");
    expect(prepareNativeReplay(plan, nativeReplayBudget(128_000))).toBeUndefined();
    const resumeNativeReplay = { compactionId: plan.previous?.messageId ?? null, budgetTokens: 90_000 };
    expect(planCompaction({ messages, contextWindow: 128_000, resumeNativeReplay }).needed).toBe(true);
  });

  it("reserves room only for the same native replay session and model", () => {
    const task = {
      resumeCursors: { codex: "s1" },
      resumeSeed: { instanceId: "codex", cursor: "s1", compactionId: null, nativeReplay: true as const },
      nativePrompt: { cursor: "s1", first: 73_000, last: 80_000, growth: 10_000, window: { model: "gpt-6.2-sol", tokens: 128_000 } },
    };
    expect(codexResumeReplayRoom(task, "codex", "gpt-6.2-sol")).toBe(6_000);
    expect(codexResumeReplayRoom(task, "codex", "gpt-6.2-astra")).toBe(0);
    expect(codexResumeReplayRoom({ ...task, resumeCursors: { codex: "s2" } }, "codex", "gpt-6.2-sol")).toBe(0);
    expect(codexResumeReplayRoom({ ...task, nativePrompt: { ...task.nativePrompt, last: 100_000 } }, "codex", "gpt-6.2-sol")).toBe(0);
  });

  it("skips compaction planning when the same native replay session still fits", async () => {
    const input = { messages: [...savedSummary("The launch is approved for review."), ...longThread()], contextWindow: 128_000 };
    const plan = planCompaction({ ...input, resumeNativeReplay: { compactionId: "saved", budgetTokens: 90_000 } });
    expect(plan).toMatchObject({ needed: false, status: "fits", nativeReplay: true });
    expect(await prepareModelContext({ ...input, plan, taskRecordText: "Goal: keep going" })).toMatchObject({
      status: "ready", transcript: expect.arrayContaining([{ role: "user", text: "request 0", at: 1_000 }]),
    });
    expect(planCompaction({ ...input, resumeNativeReplay: { compactionId: "stale", budgetTokens: 90_000 } }).needed).toBe(true);
  });

  it("keeps the handoff contact and attachment beyond the inline compaction budget", () => {
    const contact = "launch-owner@example.test";
    const attachment = "15f8108e-edbf-43f1-a54f-36a8ac67304a.png";
    const messages = [
      ...savedSummary("The launch is approved for review."),
      ...handoff(contact, attachment),
    ];
    const input = { messages, contextWindow: 128_000 };
    const plan = planCompaction(input);
    if (!plan.needed) throw new Error("expected a plan");
    const prepared = prepareNativeReplay(plan, nativeReplayBudget(input.contextWindow));
    expect(prepared).toMatchObject({ status: "ready", compacted: true });
    if (!prepared) throw new Error("expected a native replay");
    expect(prepared.compaction).toBeUndefined();
    expect(plan.estimatedTokensBefore).toBeGreaterThan(plan.budgetTokens);
    expect(prepared.estimatedTokens).toBeLessThanOrEqual(prepared.budgetTokens);
    const { nativeReplayPrefix } = buildTurnContext({
      driverKind: "codex", text: "Who owns the release handoff?", transcript: prepared.transcript,
      fresh: true, rewound: false, replaysNatively: false, nativeReplay: true,
    });
    expect.soft(nativeReplayPrefix?.includes(contact), "handoff contact").toBe(true);
    expect.soft(nativeReplayPrefix?.includes(attachment), "attachment filename").toBe(true);
    expect(nativeReplayPrefix?.includes("The current milestone is violet telescope.")).toBe(true);
  });

  it("lands covered and later values in the reused summary's own field", () => {
    const later = "launch-owner@example.test";
    const messages = [...savedSummary("The launch is approved for review."), ...handoff(later, "notes.png")];
    const plan = planCompaction({ messages, contextWindow: 128_000 });
    if (!plan.needed) throw new Error("expected a plan");
    const patch = prepareNativeReplay(plan, nativeReplayBudget(128_000))?.replaySummary;
    if (!patch) throw new Error("expected a summary patch");
    expect(Object.keys(patch)).toEqual(["compaction"]);
    expect(readContextCompaction({ value: patch.compaction }).status).toBe("valid");
    const saved = messages.map((row) => row.id === "saved" ? { ...row, ...patch } : row);
    for (const contact of ["covered-owner@example.test", later]) {
      expect.soft(patch.compaction.summary, "older reader").toContain(contact);
      expect.soft(ownerTopics(saved, "Owner"), "room topics").toContain(contact);
    }
  });

  it("keeps typed values from already covered rows alongside the saved summary", async () => {
    const contact = "covered-owner@example.test";
    const summary = "The launch is approved for the next review.";
    const messages = [
      message("covered", `Send the release handoff to ${contact}.`),
      message("saved", "", {
        role: "bot", kind: "compaction", compaction: {
          v: 1, summary, coveredThroughId: "covered", firstKeptId: null,
          contextWindow: 128_000, estimatedTokensBefore: 30, sourceMessageCount: 1,
        },
      }),
      ...longThread(),
    ];
    const input = { messages, contextWindow: 128_000, taskRecordText: "Goal: keep going" };
    const plan = planCompaction(input);
    if (!plan.needed) throw new Error("expected a plan");
    const base = await prepareModelContext({ ...input, plan, summarize: async () => `SUMMARY\n${summary}` });
    expect(base.status === "ready" && base.compaction?.summary.includes(contact)).toBe(true);
    expect(prepareNativeReplay(plan, plan.estimatedTokensBefore)).toBeUndefined();
    const prepared = prepareNativeReplay(plan, nativeReplayBudget(input.contextWindow));
    expect(prepared).toMatchObject({ status: "ready", compactionId: "saved" });
    if (!prepared) throw new Error("expected a native replay");
    expect(prepared.transcript[0]?.text.startsWith(plan.transcript[0]!.text)).toBe(true);
    expect(prepared.transcript[0]?.text).toContain(contact);
    expect(planCompaction({ ...input, resumeNativeReplay: { compactionId: "saved", budgetTokens: plan.estimatedTokensBefore } }).needed).toBe(true);
  });

  it.each([31_770, 31_990, 32_000])("writes a fresh summary when a %i-character summary cannot also hold the values", async (length) => {
    const contacts = ["covered-owner@example.test", "covered-reviewer@example.test"];
    const summary = "Reviewed the release notes. ".repeat(1_200).slice(0, length - 20) + "Final decision: ship";
    const messages = [
      message("covered", `Send the handoff to ${contacts[0]}.\nShare the review with ${contacts[1]}.`),
      message("saved", "", {
        role: "bot", kind: "compaction", compaction: {
          v: 1, summary, coveredThroughId: "covered", firstKeptId: null,
          contextWindow: 128_000, estimatedTokensBefore: 30, sourceMessageCount: 1,
        },
      }),
      ...longThread(),
    ];
    const input = { messages, contextWindow: 128_000 };
    const plan = planCompaction(input);
    if (!plan.needed) throw new Error("expected a plan");
    const budgetTokens = nativeReplayBudget(input.contextWindow);
    expect(prepareNativeReplay(plan, budgetTokens)).toBeUndefined();
    expect(planCompaction({ ...input, resumeNativeReplay: { compactionId: "saved", budgetTokens } }).needed).toBe(true);
    const written = await prepareModelContext({ ...input, plan, taskRecordText: "", summarize: async () => "SUMMARY\nThe release review continues." });
    if (written.status !== "ready" || !written.compaction) throw new Error("expected a new summary");
    for (const contact of contacts) expect.soft(written.compaction.summary).toContain(contact);
  });

  it("writes a fresh summary when a full covered value list leaves no room for a newer value", async () => {
    const later = "launch-owner@example.test";
    const messages = [
      message("covered", Array.from({ length: 300 }, (_, index) => `Add archive-${index}@example.test to the list.`).join("\n\n")),
      message("saved", "", {
        role: "bot", kind: "compaction", compaction: {
          v: 1, summary: "The launch is approved for review.", coveredThroughId: "covered", firstKeptId: null,
          contextWindow: 128_000, estimatedTokensBefore: 30, sourceMessageCount: 1,
        },
      }),
      message("later", `Please use ${later} for the release handoff.`),
      ...longThread(),
    ];
    const input = { messages, contextWindow: 128_000 };
    const plan = planCompaction(input);
    if (!plan.needed) throw new Error("expected a plan");
    const budgetTokens = nativeReplayBudget(input.contextWindow);
    expect(prepareNativeReplay(plan, budgetTokens)).toBeUndefined();
    expect(planCompaction({ ...input, resumeNativeReplay: { compactionId: "saved", budgetTokens } }).needed).toBe(true);
    const written = await prepareModelContext({ ...input, plan, taskRecordText: "", summarize: async () => "SUMMARY\nThe release review continues." });
    if (written.status !== "ready" || !written.compaction) throw new Error("expected a new summary");
    expect(written.compaction.summary).toContain(later);
  });

  it("keeps covered values when a long visible tail also contains typed values", () => {
    const contact = "covered-owner@example.test";
    const messages = [
      message("covered", `Send the release handoff to ${contact}.`),
      message("saved", "", {
        role: "bot", kind: "compaction", compaction: {
          v: 1, summary: "The launch is approved for review.", coveredThroughId: "covered", firstKeptId: null,
          contextWindow: 128_000, estimatedTokensBefore: 30, sourceMessageCount: 1,
        },
      }),
      message("addresses", Array.from({ length: 100 }, (_, index) => `Add reviewer-${index}@example.test to the list.`).join("\n\n")),
      ...longThread(),
    ];
    const plan = planCompaction({ messages, contextWindow: 24_000 });
    if (!plan.needed) throw new Error("expected a plan");
    const prepared = prepareNativeReplay(plan, nativeReplayBudget(128_000));
    expect(prepared?.transcript[0]?.text).toContain(contact);
    expect(prepared?.replaySummary?.compaction.summary).toContain(contact);
    expect(prepared?.replaySummary?.compaction.summary).toContain("reviewer-99@example.test");
    expect(prepared?.transcript[1]?.text).toContain("reviewer-99@example.test");
  });
});
