import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as compaction from "./context-compaction.ts";
import { composeUserTurnPrompt } from "./replies.ts";
import type { Message } from "./store.ts";
import { createSummaryBuild, inlineDeadlineMs, inlineSummarizer, type SummaryBuild } from "./summary-build.ts";
import { summaryInstance } from "./summary-instance.ts";
import * as turnContext from "./turn-context.ts";
import type { NativePrompt, ResumeSeed } from "./turn-context.ts";
import type { ContextCompactionV1 } from "../shared/context-compaction.ts";

// Execute the production send path without booting the server.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("  const modelContextWindow =");
const body = source.slice(start, source.indexOf("  ensureChatLatency({ sendId: latencySendId", start));
const javascript = ts.transpileModule(`async function run(scope) { with (scope) { ${body}\nreturn { prepared, summarySkipped, summaryWaitMs, prepareContext }; } }`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
}).outputText;
const runSend = new Function(`${javascript}\nreturn run;`)() as (scope: object) => Promise<any>;

const MODEL = "claude-opus-5-5";
const THREAD = "thread";
const message = (id: string, text: string, patch: Partial<Message> = {}): Message => ({ id, at: 1_000, role: "user", kind: "text", text, ...patch });
const turn = (id: string, text: string) => [message(`${id}-u`, text), message(`${id}-b`, "noted", { role: "bot" })];
const harbor = (tokens: number) => "the harbor lights came on early and the tide was calm.\n".repeat(Math.ceil((tokens * 3) / 55));
const fillers = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => turn(`fill${from + index}`, harbor(63_000))).flat();

const builds: SummaryBuild[] = [];

function setup({ messages, nativePrompt, driverKind = "claudeAgent", model = MODEL, catalog = 1_000_000, env = {} }: {
  messages: Message[];
  nativePrompt?: NativePrompt;
  driverKind?: string;
  model?: string;
  catalog?: number;
  env?: Record<string, string>;
}) {
  const rows = [...messages];
  const appended: Message[] = [];
  const generateText = vi.fn(async (): Promise<string> => "SUMMARY\nthe harbor decisions");
  const store = {
    taskByThread: () => task as never,
    activePath: () => [...rows],
    activeLeaf: () => rows.at(-1)?.id ?? null,
    messagesFor: () => rows,
    appendMessage: (_threadId: string, row: Omit<Message, "id" | "at">) => {
      const saved = { ...row, id: `m${rows.length}`, at: 1_000 };
      rows.push(saved);
      return saved;
    },
    appendCompaction: (_threadId: string, value: ContextCompactionV1) => {
      const saved: Message = { id: `summary-${appended.length}`, at: 1_000, role: "bot", kind: "compaction", compaction: value };
      rows.push(saved);
      appended.push(saved);
      return saved;
    },
  };
  const task: { nativePrompt?: NativePrompt; resumeCursors: Record<string, unknown>; resumeSeed?: ResumeSeed; lastInstanceId: string; lastModel: string } = {
    nativePrompt,
    resumeCursors: { claude: "s1" },
    resumeSeed: { instanceId: "claude", cursor: "s1", compactionId: null },
    lastInstanceId: "claude",
    lastModel: model,
  };
  const instance = {
    driverKind,
    models: { options: [{ id: model, contextWindow: catalog }] },
    generateText,
    textModel: "claude-haiku-5-5",
    textTimeoutMs: 90_000,
    adapter: { capabilities: { sessionModelSwitch: "in-session", resumeCursor: true }, hasBackgroundWork: () => false },
  };
  const build = createSummaryBuild({
    store,
    sendInputs: async () => {
      const contextWindow = compaction.contextWindowFor(instance.models as never, model, turnContext.reportedWindow(task, model));
      return {
        instance: instance as never,
        contextWindow,
        taskRecordText: "Goal: hold the line",
        nativeAt: compaction.nativeCompactAt(driverKind, model, contextWindow, env),
        cursor: task.resumeCursors.claude,
      };
    },
    busy: () => false,
    userName: () => "User",
  });
  builds.push(build);
  const bot = { id: "bot", threadId: THREAD, rewound: false };
  const send = async () => {
    const userMessage = store.appendMessage(THREAD, { role: "user", kind: "text", text: "next request" });
    const skipTranscript = new Set([userMessage.id]);
    const result = await runSend({
      ...compaction, ...turnContext, composeUserTurnPrompt, inlineDeadlineMs, inlineSummarizer, summaryInstance,
      store, task, instance, model, instanceId: "claude", threadId: THREAD, bot, summaryBuild: build,
      cfg: {}, accounts: { snapshot: [] }, process: { env: {} }, instanceConfigs: () => ({ claude: { environment: env } }),
      text: "next request", userMessage, skipTranscript, opts: {}, holdNotes: undefined, routineTurn: false, recovering: false, priorTaskPacket: undefined,
      latencySendId: "send", taskPacketForWrite: () => undefined, persistTaskPacket: () => undefined, stampTaskResumePacket: () => undefined,
      unsettledRequest: () => "", lastUserInstruction: () => undefined, decodeInjectId: () => null, logSummaryCall: () => {}, startedTurn: () => ({}),
    });
    return { ...result, skipTranscript };
  };
  return { rows, appended, generateText, store, task, bot, build, send };
}
type Harness = ReturnType<typeof setup>;

// CMP: Wink's row lands at fill12, Claude compacts during fill14, then the settle prompt.
async function afterClaudeCompacted() {
  const window = { model: MODEL, tokens: 1_000_000 };
  const h = setup({ messages: [...turn("plant", "remember the code word"), ...fillers(1, 12)], nativePrompt: { cursor: "s1", first: 11_254, last: 832_054, growth: 68_400, window } });
  h.build.onSettled("bot", THREAD);
  await h.build.idle();
  expect(h.appended).toHaveLength(1);
  h.rows.push(...fillers(13, 15));
  h.task.nativePrompt = { cursor: "s1", first: 11_254, last: 118_622, growth: 68_400, window };
  h.generateText.mockClear();
  return h;
}

// C10n: a 100k override, and the next turn would pass Wink's point.
const nearPoint = () => setup({
  messages: [...turn("plant", "remember"), ...turn("fill", harbor(22_800))],
  env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" },
  nativePrompt: { cursor: "s1", first: 33_741, last: 58_114, growth: 24_373, window: { model: MODEL, tokens: 100_000 } },
});

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  for (const build of builds.splice(0)) build.dispose();
  vi.restoreAllMocks();
});

describe("native send path", () => {
  it("does not summarize or wait on the first send after Claude compacted", async () => {
    const h = await afterClaudeCompacted();
    expect(compaction.planCompaction({ messages: h.store.activePath(), contextWindow: 1_000_000, nativeAt: 967_000 })).toMatchObject({ needed: true, budgetTokens: 870_300 });
    const { prepared, summaryWaitMs } = await h.send();
    expect(prepared).toMatchObject({ status: "ready", compacted: true, compactionId: "summary-0" });
    expect(prepared.compaction).toBeUndefined();
    expect(summaryWaitMs).toBe(0);
    expect(h.generateText).not.toHaveBeenCalled();
    expect(h.appended).toHaveLength(1);
  });

  it("keeps what a rejected resume would replay inside the budget", async () => {
    const h = await afterClaudeCompacted();
    const { prepared } = await h.send();
    expect(compaction.estimateContextTokens(prepared.transcript)).toBeLessThanOrEqual(870_300);
    expect(prepared.transcript[0].text).toContain("the harbor decisions");
    expect(prepared.transcript.at(-2).text).toContain("the harbor lights");
    expect(prepared.transcript.at(-1).text).toBe("noted");
  });

  it("goes back to the estimate when a late recycle drops the session", async () => {
    const h = await afterClaudeCompacted();
    const { prepareContext } = await h.send();
    const late = await prepareContext(h.store.activePath(), 0);
    expect(late.compaction).toBeDefined();
    expect(h.generateText).toHaveBeenCalled();
  });

  it("still lets a near session's build land while the send skips it", async () => {
    const h = nearPoint();
    let finish!: (text: string) => void;
    h.generateText.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    h.build.onSettled("bot", THREAD);
    await vi.waitFor(() => expect(h.generateText).toHaveBeenCalledOnce());
    const { prepared, summarySkipped, summaryWaitMs } = await h.send();
    expect(summarySkipped).toBe(true);
    expect(summaryWaitMs).toBe(0);
    expect(prepared.compaction).toBeUndefined();
    expect(h.generateText).toHaveBeenCalledOnce();
    finish("SUMMARY\nk10a");
    await h.build.idle();
    expect(h.appended).toHaveLength(1);
  });

  it("waits for the running build when the send cannot resume, so one call covers the history", async () => {
    const h = setup({
      messages: Array.from({ length: 70 }, (_, index) => turn(`t${index}`, `request ${index}`)).flat(),
      nativePrompt: { cursor: "s1", first: 11_254, last: 118_622, growth: 68_400, window: { model: MODEL, tokens: 1_000_000 } },
    });
    let finish!: (text: string) => void;
    h.generateText.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    h.build.onSettled("bot", THREAD);
    await vi.waitFor(() => expect(h.generateText).toHaveBeenCalledOnce());
    h.task.resumeSeed = undefined;
    const sending = h.send();
    await Promise.resolve();
    finish("SUMMARY\nthe harbor decisions");
    const { prepared, summarySkipped } = await sending;
    expect(summarySkipped).toBe(false);
    expect(prepared).toMatchObject({ status: "ready", compactionId: "summary-0" });
    expect(prepared.compaction).toBeUndefined();
    expect(h.generateText).toHaveBeenCalledOnce();
    expect(h.appended).toHaveLength(1);
  });

  it("summarizes first on a near session with no build under way", async () => {
    const h = nearPoint();
    const { prepared, summarySkipped } = await h.send();
    expect(summarySkipped).toBe(false);
    expect(h.generateText).toHaveBeenCalled();
    expect(prepared.compaction).toMatchObject({ coveredThroughId: "plant-b" });
    expect(h.appended).toHaveLength(1);
  });

  it("counts a landed build as the cycle's one summary, through Claude's boundary", async () => {
    const h = nearPoint();
    h.build.onSettled("bot", THREAD);
    await h.build.idle();
    expect(h.appended).toHaveLength(1);
    h.generateText.mockClear();
    expect((await h.send()).prepared.compaction).toBeUndefined();
    h.task.nativePrompt = { ...h.task.nativePrompt!, last: 12_000, growth: -46_114 };
    expect((await h.send()).prepared.compaction).toBeUndefined();
    expect(h.generateText).not.toHaveBeenCalled();
    expect(h.appended).toHaveLength(1);
  });

  it("counts an inline summary as the cycle's one summary", async () => {
    const h = nearPoint();
    await h.send();
    expect(h.appended).toHaveLength(1);
    h.rows.push(message("reply", "noted", { role: "bot" }));
    h.generateText.mockClear();
    h.build.onSettled("bot", THREAD);
    await h.build.idle();
    expect((await h.send()).prepared.compaction).toBeUndefined();
    expect(h.generateText).not.toHaveBeenCalled();
    expect(h.appended).toHaveLength(1);
  });

  it("still builds over the turn cap", async () => {
    const h = setup({
      messages: Array.from({ length: 70 }, (_, index) => turn(`t${index}`, `request ${index}`)).flat(),
      nativePrompt: { cursor: "s1", first: 11_254, last: 118_622, growth: 68_400, window: { model: MODEL, tokens: 1_000_000 } },
    });
    const { prepared, summarySkipped } = await h.send();
    expect(summarySkipped).toBe(false);
    expect(prepared.compaction).toBeDefined();
  });

  describe.each<[string, (h: Harness) => void]>([
    ["the session moved on", (h) => { h.task.resumeCursors.claude = "s2"; h.task.resumeSeed = { instanceId: "claude", cursor: "s2", compactionId: null }; }],
    ["no size was reported", (h) => { h.task.nativePrompt = undefined; }],
    ["there is no session", (h) => { h.task.resumeCursors = {}; h.task.resumeSeed = undefined; }],
    ["the branch was rewound", (h) => { h.bot.rewound = true; }],
    ["the session was never seeded", (h) => { h.task.resumeSeed = undefined; }],
    ["the model changed", (h) => { h.task.lastModel = "claude-sonnet-5-5"; }],
  ])("when %s", (_name, change) => {
    const window = { model: MODEL, tokens: 1_000_000 };

    it("summarizes an estimate over budget, however small the real size", async () => {
      const h = setup({ messages: fillers(1, 14), nativePrompt: { cursor: "s1", first: 11_254, last: 118_622, growth: 68_400, window } });
      change(h);
      const { prepared, summarySkipped } = await h.send();
      expect(summarySkipped).toBe(false);
      expect(prepared.status).toBe("ready");
      expect(prepared.compaction.summary).toContain("the harbor decisions");
      expect(compaction.estimateContextTokens(prepared.transcript)).toBeLessThanOrEqual(870_300);
    });

    it("leaves an estimate under budget alone, however near the real size", async () => {
      const h = setup({ messages: turn("small", "hello"), nativePrompt: { cursor: "s1", first: 11_254, last: 900_000, growth: 68_400, window } });
      change(h);
      const { prepared } = await h.send();
      expect(prepared).toMatchObject({ status: "ready", compacted: false });
      expect(prepared.compaction).toBeUndefined();
      expect(h.generateText).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ["codex", "gpt-5.5"],
    ["claudeAgent", "claude-sonnet-5-5"],
  ])("with no native point on %s %s", (driverKind, model) => {
    const window = { model, tokens: 200_000 };
    const engine = { driverKind, model, catalog: 200_000 };

    it("summarizes an estimate over budget", async () => {
      const h = setup({ ...engine, messages: Array.from({ length: 12 }, (_, index) => turn(`t${index}`, harbor(20_000))).flat(), nativePrompt: { cursor: "s1", first: 1_000, last: 2_000, growth: 1_000, window } });
      const { prepared, summarySkipped } = await h.send();
      expect(summarySkipped).toBe(false);
      expect(prepared.compaction).toBeDefined();
      expect(h.generateText).toHaveBeenCalled();
    });

    it("leaves an estimate under budget alone", async () => {
      const h = setup({ ...engine, messages: turn("small", "hello"), nativePrompt: { cursor: "s1", first: 1_000, last: 190_000, growth: 1_000, window } });
      const { prepared, summarySkipped } = await h.send();
      expect(summarySkipped).toBe(false);
      expect(prepared).toMatchObject({ status: "ready", compacted: false });
      expect(h.generateText).not.toHaveBeenCalled();
    });
  });
});
