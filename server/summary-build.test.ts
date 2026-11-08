import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isFallbackSummary, planCompaction, prepareModelContext } from "./context-compaction.ts";
import type { Message } from "./store.ts";
import { createSummaryBuild, inlineDeadlineMs, inlineSummarizer } from "./summary-build.ts";
import type { ContextCompactionV1 } from "../shared/context-compaction.ts";

const MINUTE = 60_000;
const WINDOW = 200_000;

const message = (id: string, text: string, patch: Partial<Message> = {}): Message => ({
  id,
  at: 1_000,
  role: "user",
  kind: "text",
  text,
  ...patch,
});

// Over the 60 user-turn cap, under the token budget: the summary input fits one batch.
function overBudgetThread(prefix: string, turns = 70): Message[] {
  return Array.from({ length: turns }, (_, index) => [
    message(`${prefix}u${index}`, `request ${index}`),
    message(`${prefix}b${index}`, `outcome ${index}`, { role: "bot" }),
  ]).flat();
}

function setup(generateText?: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<string>) {
  const threads = new Map<string, Message[]>();
  const appended: Array<{ threadId: string; id: string; compaction: ContextCompactionV1 }> = [];
  const state = { busy: false, generateText, window: WINDOW, nativeAt: undefined as number | null | undefined, nativePrompt: undefined as { last: number; growth: number } | undefined, cursor: "session" };
  const store = {
    taskByThread: () => ({ nativePrompt: state.nativePrompt && { cursor: "session", first: 1_000, ...state.nativePrompt } }) as never,
    activePath: (threadId: string) => [...(threads.get(threadId) ?? [])],
    activeLeaf: (threadId: string) => threads.get(threadId)?.at(-1)?.id ?? null,
    messagesFor: (threadId: string) => threads.get(threadId) ?? [],
    appendCompaction: (threadId: string, value: ContextCompactionV1) => {
      const added: Message = { id: `build-${appended.length}`, at: 10_000, role: "bot", kind: "compaction", compaction: value };
      threads.get(threadId)!.push(added);
      appended.push({ threadId, id: added.id, compaction: value });
      return added;
    },
  };
  const build = createSummaryBuild({
    store,
    sendInputs: async () => ({
      instance: { driverKind: "claude", generateText: state.generateText, textModel: "claude-haiku-5-5", textTimeoutMs: 90_000 },
      contextWindow: state.window,
      taskRecordText: "Goal: build",
      nativeAt: state.nativeAt,
      cursor: state.cursor,
    }),
    busy: () => state.busy,
    userName: () => "User",
  });
  const sendPrepares = (threadId: string, userId: string, inline?: { summarize: ((prompt: string) => Promise<string>) | undefined; summaryGrace?: typeof grace }) => {
    const summarize = inline ? inline.summarize : vi.fn(async () => "SUMMARY\ninline");
    return prepareModelContext({
      messages: store.activePath(threadId),
      contextWindow: WINDOW,
      taskRecordText: "Goal: build",
      excludeIds: new Set([userId]),
      summarize,
      summaryGrace: inline?.summaryGrace,
    }).then((prepared) => ({ prepared, summarize }));
  };
  return { threads, appended, state, build, store, sendPrepares };
}

function deferred() {
  const calls: Array<{ prompt: string; signal?: AbortSignal; resolve: (text: string) => void; reject: (error: Error) => void }> = [];
  const generateText = (prompt: string, opts?: { signal?: AbortSignal }) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ prompt, signal: opts?.signal, resolve, reject });
    });
  return { calls, generateText };
}

const tick = () => vi.advanceTimersByTimeAsync(0);
const claudeSend = { generateText: async () => "SUMMARY\ninline", textTimeoutMs: 90_000 };
const grace = {
  knownWindow: WINDOW,
  requestText: "next question",
  fresh: false,
  rewound: false,
  recycle: false,
  local: false,
  native: {
    instanceId: "claude",
    cursor: "session",
    seed: { instanceId: "claude", cursor: "session", compactionId: null as string | null },
    prompt: { first: 25_000, last: 35_000, contextWindow: WINDOW },
  },
};
const graceInputs = (messages: Message[]) => ({
  plan: planCompaction({ messages, contextWindow: WINDOW }),
  taskRecordText: "Goal: build",
  grace,
});
const nativeTurn = (id: string, text: string) => [message(`${id}-u`, text), message(`${id}-b`, "noted", { role: "bot" })];
const harbor = (tokens: number) => "the harbor lights came on early and the tide was calm.\n".repeat(Math.ceil((tokens * 3) / 55));
const gate = { window: 100_000, nativeAt: 67_000 };

describe("summary build after settle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds after settle when over budget", async () => {
    const generateText = vi.fn(async () => "SUMMARY\nbuilt");
    const { threads, appended, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await build.idle();

    expect(generateText).toHaveBeenCalledOnce();
    expect(appended).toHaveLength(1);
    expect(appended[0]!.compaction).toMatchObject({ summary: "built", contextWindow: WINDOW });
    const lines = vi.mocked(console.info).mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[summary] "));
    expect(JSON.parse(lines[0]!.slice("[summary] ".length))).toMatchObject({ botId: "bot", threadId: "t", phase: "build", run: 1, deadlineMs: 240_000, result: "ok" });

    threads.get("t")!.push(message("next", "next question"));
    const { prepared, summarize } = await sendPrepares("t", "next");
    expect(summarize).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({ status: "ready", compactionId: appended[0]!.id });
  });

  it("lands an oversized build trimmed to fit", async () => {
    const generateText = vi.fn(async () => `SUMMARY\n${Array.from({ length: 2_500 }, (_, index) => `built line ${index}`).join("\n")}`);
    const { threads, appended, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await build.idle();

    expect(appended).toHaveLength(1);
    expect(appended[0]!.compaction.summary).toMatch(/^built line 0\n[\s\S]*\nbuilt line \d+\n\[summary trimmed to fit\]$/);
    const lines = vi.mocked(console.warn).mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[summary] "));
    expect(JSON.parse(lines[0]!.slice("[summary] ".length))).toMatchObject({ phase: "build", result: "trimmed" });
  });

  it("no call under budget", async () => {
    const generateText = vi.fn(async () => "SUMMARY\nnever");
    const { threads, appended, build } = setup(generateText);
    threads.set("t", overBudgetThread("a", 6));

    build.onSettled("bot", "t");
    await build.idle();

    expect(generateText).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  it("leaves a fallback chain to the repair", async () => {
    const generateText = vi.fn(async () => "SUMMARY\nbuilt");
    const { threads, appended, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));
    threads.get("t")!.push(message("send", "next question"));
    const { prepared } = await sendPrepares("t", "send", { summarize: undefined });
    expect(prepared.status === "ready" && isFallbackSummary(prepared.compaction!.summary)).toBe(true);
    if (prepared.status !== "ready") return;
    threads.get("t")!.push(
      { id: "fallback", at: 2_000, role: "bot", kind: "compaction", compaction: prepared.compaction! },
      ...overBudgetThread("b"),
    );

    build.onSettled("bot", "t");
    await build.idle();

    expect(generateText).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  it("lands nothing when the leaf moved", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(1);
    threads.get("t")!.push(message("note", "[pane 1] worker output", { kind: "note" }));
    calls[0]!.resolve("SUMMARY\nbuilt");
    await build.idle();

    expect(appended).toEqual([]);
    const dropped = vi.mocked(console.info).mock.calls.map((call) => String(call[0])).find((line) => line.startsWith("[summary-build] dropped "));
    expect(JSON.parse(dropped!.slice("[summary-build] dropped ".length))).toEqual({ botId: "bot", threadId: "t", reason: "leaf-moved" });
  });

  it("holds while busy and lands at the next settle", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));
    state.busy = true;

    build.onSettled("bot", "t");
    await build.idle();
    expect(calls).toHaveLength(0);

    state.busy = false;
    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(1);
    state.busy = true;
    calls[0]!.resolve("SUMMARY\nbuilt");
    await build.idle();
    expect(appended).toEqual([]);

    build.onSettled("bot", "t");
    expect(appended).toEqual([]);
    state.busy = false;
    build.onSettled("bot", "t");
    await build.idle();

    expect(calls).toHaveLength(1);
    expect(appended.map((item) => item.compaction.summary)).toEqual(["built"]);
  });

  it("send during build waits then reuses the row without a second summarize call", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(1);
    state.busy = true;
    threads.get("t")!.push(message("send", "next question"));
    let waited = false;
    const settled = build.settle("t", claudeSend, 90_000, () => true).then(() => {
      waited = true;
    });
    await tick();
    expect(waited).toBe(false);
    calls[0]!.resolve("SUMMARY\nbuilt");
    await settled;

    expect(appended).toHaveLength(1);
    const { prepared, summarize } = await sendPrepares("t", "send");
    expect(summarize).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({ status: "ready", compactionId: appended[0]!.id });
    expect(calls).toHaveLength(1);
  });

  it("summary grace dispatches with zero virtual wait and uses the held build next turn once", async () => {
    const generateText = vi.fn(() => new Promise<string>((resolve) => setTimeout(() => resolve("SUMMARY\nbuilt"), 31_000)));
    const { threads, appended, state, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));
    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next question"));
    const started = Date.now();
    let dispatched = false;
    const settled = build.settle("t", claudeSend, 90_000, () => true, {
      sendId: "safe-send", grace: graceInputs(threads.get("t")!),
    }).then((waited) => { dispatched = true; return waited; });
    await tick();
    expect(dispatched).toBe(true);
    expect(await settled).toBe(0);
    expect(Date.now() - started).toBe(0);
    const summarize = vi.fn(async () => "SUMMARY\nduplicate");
    const first = await sendPrepares("t", "send", { summarize, summaryGrace: grace });
    expect(first.prepared.status === "ready" && first.prepared.compaction).toBeUndefined();
    expect(summarize).not.toHaveBeenCalled();
    threads.get("t")!.push(message("reply", "later decision and artifact", { role: "bot" }));
    await vi.advanceTimersByTimeAsync(31_000);
    await build.idle();
    expect(appended).toEqual([]);
    threads.get("t")!.push(message("note", "[pane 1] later verified result", { role: "bot", kind: "note" }));
    state.busy = false;
    build.onSettled("bot", "t");
    await build.idle();
    expect(appended).toHaveLength(1);
    threads.get("t")!.push(message("next", "use the result"));
    const next = await sendPrepares("t", "next");
    expect(next.summarize).not.toHaveBeenCalled();
    expect(next.prepared).toMatchObject({ status: "ready", compactionId: appended[0]!.id });
    if (next.prepared.status !== "ready") throw new Error(next.prepared.status);
    for (const text of ["next question", "later decision and artifact", "later verified result"]) {
      expect(next.prepared.transcript.filter((item) => item.text.includes(text))).toHaveLength(1);
    }
    expect(next.prepared.transcript.slice(-3).map((item) => item.text)).toEqual([
      "next question", "later decision and artifact", "[Pane note from pane 1, untrusted worker output]\nlater verified result",
    ]);
    expect(generateText).toHaveBeenCalledOnce();
    const waits = vi.mocked(console.info).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[summary-wait] "));
    expect(waits.map((line) => JSON.parse(line.slice("[summary-wait] ".length)))).toEqual([
      { threadId: "t", sendId: "safe-send", mode: "skipped", waitedMs: 0 },
    ]);
  });

  it("summary grace preserves a queued build and its original boundary", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("other", overBudgetThread("o"));
    threads.set("t", overBudgetThread("a"));
    build.onSettled("bot", "other");
    await tick();
    build.onSettled("bot", "t");
    state.busy = true;
    threads.get("t")!.push(message("send", "queued grace request"));
    expect(await build.settle("t", claudeSend, 90_000, () => true, { grace: graceInputs(threads.get("t")!) })).toBe(0);
    calls[0]!.resolve("SUMMARY\nother");
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).not.toContain("queued grace request");
    calls[1]!.resolve("SUMMARY\nbuilt");
    await build.idle();
    expect(appended).toEqual([]);
    state.busy = false;
    build.onSettled("bot", "t");
    await build.idle();
    expect(appended.filter((item) => item.threadId === "t")).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("summary grace keeps an unsafe headroom send on the waiting path", async () => {
    const { calls, generateText } = deferred();
    const { threads, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));
    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    let dispatched = false;
    const safe = build.settle("t", claudeSend, 90_000, () => true, { grace: graceInputs(threads.get("t")!) }).then(() => { dispatched = true; });
    await tick();
    expect(dispatched).toBe(true);
    await safe;
    const inputs = graceInputs(threads.get("t")!);
    let waited = false;
    const unsafe = build.settle("t", claudeSend, 90_000, () => true, {
      sendId: "unsafe-send", grace: { ...inputs, grace: { ...grace, requestText: "large request ".repeat(50_000) } },
    }).then((ms) => { waited = true; return ms; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(waited).toBe(false);
    expect(calls[0]!.signal?.aborted).toBe(false);
    calls[0]!.resolve("SUMMARY\nbuilt");
    expect(await unsafe).toBe(5_000);
    const lines = vi.mocked(console.info).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[summary-wait] "));
    expect(JSON.parse(lines.at(-1)!.slice("[summary-wait] ".length))).toEqual({
      threadId: "t", sendId: "unsafe-send", mode: "waited", waitedMs: 5_000, reason: "headroom",
    });
    expect(lines.join("\n")).not.toContain("large request");
  });

  it("a native engine's resumed send skips the build and lets it finish", async () => {
    const { calls, generateText } = deferred();
    const { threads, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));
    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    const inputs = graceInputs(threads.get("t")!);
    let waited: number | undefined;
    void build.settle("t", claudeSend, 90_000, () => true, { grace: { ...inputs, grace: { ...grace, nativeAt: 967_000 } } })
      .then((ms) => { waited = ms; });
    await tick();
    expect(waited).toBe(0);
    expect(calls[0]!.signal?.aborted).toBe(false);
    calls[0]!.resolve("SUMMARY\nbuilt");
    await build.idle();
    const lines = vi.mocked(console.info).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[summary-wait] "));
    expect(lines.join("\n")).not.toContain("\"mode\":\"waited\"");
  });

  it.each([
    ["fresh", { fresh: true }, "session-recycle"],
    ["unseeded", { native: { ...grace.native, seed: undefined } }, "unseeded"],
  ])("a native engine's %s send waits on the running build, so one call covers the history", async (_label, patch, reason) => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));
    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next request"));
    const inline = vi.fn(async () => "SUMMARY\ninline");
    const inputs = graceInputs(threads.get("t")!);
    const sent = build.settle("t", claudeSend, 90_000, () => true, { grace: { ...inputs, grace: { ...grace, ...patch, nativeAt: 967_000 } } })
      .then(() => sendPrepares("t", "send", { summarize: inline }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls[0]!.signal?.aborted).toBe(false);
    calls[0]!.resolve("SUMMARY\nbuilt");
    const { prepared } = await sent;
    expect(calls.length + inline.mock.calls.length).toBe(1);
    expect(appended).toHaveLength(1);
    expect(prepared).toMatchObject({ status: "ready", compactionId: appended[0]!.id });
    const lines = vi.mocked(console.info).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[summary-wait] "));
    expect(JSON.parse(lines.at(-1)!.slice("[summary-wait] ".length))).toMatchObject({ mode: "waited", reason });
  });

  it("a native engine's fresh send drops its queued build, so its inline summary is the only call", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, build, sendPrepares } = setup(generateText);
    threads.set("other", overBudgetThread("o"));
    threads.set("t", overBudgetThread("a"));
    build.onSettled("bot", "other");
    await tick();
    build.onSettled("bot", "t");
    threads.get("t")!.push(message("send", "next request"));
    const inline = vi.fn(async () => "SUMMARY\ninline");
    const inputs = graceInputs(threads.get("t")!);
    expect(await build.settle("t", claudeSend, 90_000, () => true, { grace: { ...inputs, grace: { ...grace, fresh: true, nativeAt: 967_000 } } })).toBe(0);
    await sendPrepares("t", "send", { summarize: inline });
    calls[0]!.resolve("SUMMARY\nother");
    await build.idle();
    expect(calls).toHaveLength(1);
    expect(inline).toHaveBeenCalledOnce();
    expect(appended.map((row) => row.threadId)).toEqual(["other"]);
  });

  it.each(["rewind", "covered edit", "prior compaction"])("summary grace drops a build after %s", async (change) => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));
    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    let dispatched = false;
    const settled = build.settle("t", claudeSend, 90_000, () => true, { grace: graceInputs(threads.get("t")!) }).then(() => { dispatched = true; });
    await tick();
    expect(dispatched).toBe(true);
    await settled;
    if (change === "rewind") threads.set("t", threads.get("t")!.slice(0, 80));
    else if (change === "covered edit") threads.get("t")![0]!.text = "corrected covered request";
    else threads.get("t")!.push(message("competing", "", { role: "bot", kind: "compaction", compaction: {
      v: 1, summary: "different prior summary", coveredThroughId: "au0", firstKeptId: "ab0",
      contextWindow: WINDOW, estimatedTokensBefore: 1_000, sourceMessageCount: 1,
    } }));
    calls[0]!.resolve("SUMMARY\nstale");
    await build.idle();
    state.generateText = undefined;
    state.busy = false;
    build.onSettled("bot", "t");
    await build.idle();
    expect(appended).toEqual([]);
    const dropped = vi.mocked(console.info).mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[summary-build] dropped "));
    expect(dropped).toHaveLength(1);
    expect(JSON.parse(dropped[0]!.slice("[summary-build] dropped ".length)).reason).toBe(
      change === "rewind" ? "leaf-moved" : change === "covered edit" ? "prefix-changed" : "compaction-changed",
    );
  });

  it("ignores pruned screen pixels while retaining reactions and card answers in the prefix", async () => {
    for (const change of ["pixels", "reaction", "card answer"]) {
      const { calls, generateText } = deferred();
      const { threads, appended, build } = setup(generateText);
      const rows = overBudgetThread("a");
      const screen = message("screen", "", { role: "bot", kind: "screen", png: "pixels" });
      const card = message("card", "", { role: "bot", kind: "options", card: {
        title: "Choose a target", subtitle: "", options: ["desktop", "phone"], answered: "answer", answerText: "desktop",
      } });
      rows.splice(2, 0, screen, card);
      threads.set("t", rows);
      try {
        build.onSettled("bot", "t");
        await tick();
        screen.png = undefined;
        if (change === "reaction") rows[1]!.reactions = [{ emoji: "👍", by: "user" }];
        if (change === "card answer") card.card!.answerText = "phone";
        calls[0]!.resolve("SUMMARY\nbuilt");
        await build.idle();
        expect(appended).toHaveLength(change === "pixels" ? 1 : 0);
        if (change !== "pixels") expect(vi.mocked(console.info).mock.calls.at(-1)?.[0]).toContain('"reason":"prefix-changed"');
      } finally {
        build.dispose();
      }
    }
  });

  it("a switch to an engine without generateText mid-build waits 0", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next on Codex"));
    const summarizes = vi.fn(() => true);
    const settled = build.settle("t", { generateText: undefined, textTimeoutMs: undefined }, 90_000, summarizes);

    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(await settled).toBe(0);
    expect(summarizes).not.toHaveBeenCalled();
    calls[0]!.resolve("SUMMARY\nlate");
    await build.idle();
    expect(appended).toEqual([]);
  });

  it("an engine without textTimeoutMs waits 0", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next on agy"));
    const settled = build.settle("t", { generateText: async () => "SUMMARY\nagy", textTimeoutMs: undefined }, 90_000, () => true);

    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(await settled).toBe(0);
    await build.idle();
    expect(appended).toEqual([]);
  });

  it("a send whose context fits waits 0 and lands nothing", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next on a bigger window"));
    const settled = build.settle("t", claudeSend, 90_000, () => false);

    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(await settled).toBe(0);
    await build.idle();
    expect(appended).toEqual([]);
  });

  it("cap aborts the build and the send falls back inline", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next question"));
    const settled = build.settle("t", claudeSend, 90_000, () => true);
    await vi.advanceTimersByTimeAsync(90_000);
    const waited = await settled;

    expect(waited).toBe(90_000);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(appended).toEqual([]);
    // The wait used the whole 90 s summary deadline: no second call, today's deterministic fallback at once.
    const instance = { generateText: vi.fn(async () => "SUMMARY\nsecond"), textTimeoutMs: 90_000 };
    const summarize = inlineSummarizer(instance, waited);
    expect(summarize).toBeUndefined();
    const { prepared } = await sendPrepares("t", "send", { summarize });
    expect(instance.generateText).not.toHaveBeenCalled();
    expect(prepared.status).toBe("ready");
    expect(prepared.status === "ready" && isFallbackSummary(prepared.compaction!.summary)).toBe(true);

    calls[0]!.resolve("SUMMARY\nlate");
    await build.idle();
    expect(appended).toEqual([]);
  });

  it("failure lands no row", async () => {
    const generateText = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const { threads, appended, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await build.idle();
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(appended).toEqual([]);

    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    build.onSettled("bot", "t");
    await build.idle();
    expect(generateText).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MINUTE);
    await build.idle();
    expect(generateText).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    build.onSettled("bot", "t");
    await build.idle();
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(appended).toEqual([]);
  });

  it("dispose aborts", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(1);
    build.dispose();
    await build.idle();

    expect(calls[0]!.signal?.aborted).toBe(true);
    calls[0]!.resolve("SUMMARY\nlate");
    await tick();
    expect(appended).toEqual([]);
    build.onSettled("bot", "t");
    await build.idle();
    expect(calls).toHaveLength(1);
  });

  it("send-after queued at settle reuses the build", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build, sendPrepares } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    // The drain subscriber runs right after the main fold: it appends the held
    // line and claims the bot before the build's first await returns.
    build.onSettled("bot", "t");
    const drained = message("drained", "DRAINED-LINE ".repeat(25_000));
    threads.get("t")!.push(drained);
    state.busy = true;
    const settled = build.settle("t", claudeSend, 90_000, () => true);
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).not.toContain("DRAINED-LINE");
    calls[0]!.resolve("SUMMARY\nbuilt");
    await settled;

    expect(appended).toHaveLength(1);
    expect(appended[0]!.compaction.coveredThroughId).not.toBe("drained");
    const { prepared, summarize } = await sendPrepares("t", "drained");
    expect(summarize).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({ status: "ready", compactionId: appended[0]!.id });
  });

  it("builds from the real prompt and saves the row before the engine's next turn compacts", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    Object.assign(state, gate, { nativePrompt: { last: 33_741, growth: 0 } });
    threads.set("t", nativeTurn("plant", "remember BISON-5861"));
    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(0);

    threads.get("t")!.push(...nativeTurn("fill1", harbor(22_800)));
    state.nativePrompt = { last: 58_114, growth: 24_373 };
    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("BISON-5861");
    expect(calls[0]!.prompt).not.toContain("harbor lights");

    state.busy = true;
    threads.get("t")!.push(message("fill2-u", harbor(22_800)));
    calls[0]!.resolve("SUMMARY\nBISON-5861 kept");
    await build.idle();

    expect(appended).toHaveLength(1);
    expect(appended[0]!.compaction).toMatchObject({ summary: "BISON-5861 kept", coveredThroughId: "plant-b", firstKeptId: "fill1-u" });
    expect(threads.get("t")!.map((row) => row.id)).toEqual(["plant-u", "plant-b", "fill1-u", "fill1-b", "fill2-u", "build-0"]);
  });

  it.each([
    ["normal text", { last: 900_000, growth: 20_000 }],
    ["dense text", { last: 960_000, growth: 5_000 }],
  ])("lands first near the default point on %s", async (_label, nativePrompt) => {
    let onCall = () => {};
    const { threads, appended, state, build } = setup(async () => {
      onCall();
      return "SUMMARY\nbuilt";
    });
    onCall = () => {
      state.busy = true;
    };
    const messages = Array.from({ length: 40 }, (_, index) => nativeTurn(`t${index}`, harbor(20_000))).flat();
    expect(planCompaction({ messages, contextWindow: 1_000_000, nativeAt: 967_000 })).toMatchObject({ needed: false });
    Object.assign(state, { window: 1_000_000, nativeAt: 967_000, nativePrompt });
    threads.set("t", messages);

    build.onSettled("bot", "t");
    await build.idle();

    expect(state.busy).toBe(true);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.compaction).toMatchObject({ coveredThroughId: "t15-b", firstKeptId: "t16-u" });
  });

  it("builds once per native cycle until a boundary or real new growth", async () => {
    const { threads, appended, state, build } = setup(async () => "SUMMARY\nbuilt");
    Object.assign(state, gate);
    threads.set("t", nativeTurn("a", harbor(9_000)));
    const settle = async (id: string, last: number, growth: number) => {
      threads.get("t")!.push(...nativeTurn(id, harbor(9_000)));
      state.nativePrompt = { last, growth };
      build.onSettled("bot", "t");
      await build.idle();
      return appended.length;
    };

    expect(await settle("b", 58_114, 24_373)).toBe(1);
    expect(await settle("c", 59_500, 1_386)).toBe(1);
    expect(await settle("d", 60_900, 1_400)).toBe(1);
    expect(await settle("e", 20_245, -40_655)).toBe(1);
    expect(await settle("f", 60_000, 39_755)).toBe(2);
    expect(await settle("g", 61_000, 1_000)).toBe(2);
    expect(await settle("h", 66_800, 5_800)).toBe(3);
  });

  it("never builds a no-op near the engine's point", async () => {
    const generateText = vi.fn(async () => "SUMMARY\nbuilt");
    const { threads, appended, state, build } = setup(generateText);
    Object.assign(state, gate, { nativePrompt: { last: 58_114, growth: 24_373 } });
    threads.set("t", nativeTurn("a", harbor(9_000)));
    build.onSettled("bot", "t");
    await build.idle();
    expect(generateText).not.toHaveBeenCalled();

    threads.get("t")!.push(...nativeTurn("b", harbor(9_000)));
    build.onSettled("bot", "t");
    await build.idle();
    expect(appended).toHaveLength(1);
    expect(appended[0]!.compaction).toMatchObject({ coveredThroughId: "a-b", firstKeptId: "b-u" });

    generateText.mockClear();
    state.nativePrompt = { last: 20_245, growth: -37_869 };
    build.onSettled("bot", "t");
    await build.idle();
    state.nativePrompt = { last: 59_000, growth: 38_755 };
    build.onSettled("bot", "t");
    await build.idle();
    expect(generateText).not.toHaveBeenCalled();
    expect(appended).toHaveLength(1);
  });

  describe("a build queued behind another bot", () => {
    // The turn after the snapshot compacts: the send resumes, then settles on a small prompt.
    const queuedThenCompacted = async (history: Message[]) => {
      const { calls, generateText } = deferred();
      const harness = setup(generateText);
      const { threads, state, build } = harness;
      threads.set("other", overBudgetThread("o"));
      build.onSettled("bot", "other");
      await tick();
      Object.assign(state, gate, { nativePrompt: { last: 58_114, growth: 24_373 } });
      threads.set("t", history);
      build.onSettled("bot", "t");
      threads.get("t")!.push(message("next-u", "next request"));
      const inputs = { plan: planCompaction({ messages: threads.get("t")!, contextWindow: gate.window, nativeAt: gate.nativeAt }), taskRecordText: "Goal: build" };
      expect(await build.settle("t", claudeSend, 90_000, () => false, { grace: { ...inputs, grace: { ...grace, nativeAt: gate.nativeAt } } })).toBe(0);
      threads.get("t")!.push(message("next-b", "noted", { role: "bot" }));
      state.nativePrompt = { last: 12_000, growth: -46_114 };
      build.onSettled("bot", "t");
      return { ...harness, calls };
    };
    const near = () => [...nativeTurn("a", harbor(9_000)), ...nativeTurn("b", harbor(9_000))];

    it("still builds its checkpoint after the engine compacts", async () => {
      const { calls, appended, build } = await queuedThenCompacted(near());
      calls[0]!.resolve("SUMMARY\nother");
      await tick();
      expect(calls).toHaveLength(2);
      calls[1]!.resolve("SUMMARY\nkept");
      await build.idle();
      expect(appended.filter((row) => row.threadId === "t").map((row) => row.compaction)).toMatchObject([{ summary: "kept", coveredThroughId: "a-b", firstKeptId: "b-u" }]);
    });

    it("does not reuse a replaced session's reading", async () => {
      const { calls, appended, state, build } = await queuedThenCompacted(near());
      state.cursor = "replaced";
      calls[0]!.resolve("SUMMARY\nother");
      await build.idle();
      expect(calls).toHaveLength(1);
      expect(appended.map((row) => row.threadId)).toEqual(["other"]);
    });

    it("goes by the estimate once its session is replaced", async () => {
      const { calls, appended, state, build } = await queuedThenCompacted([...nativeTurn("a", harbor(9_000)), ...nativeTurn("b", harbor(70_000))]);
      const estimated = vi.fn(async () => "SUMMARY\nestimated");
      Object.assign(state, { cursor: "replaced", generateText: estimated });
      calls[0]!.resolve("SUMMARY\nother");
      await build.idle();
      expect(estimated).toHaveBeenCalled();
      expect(appended.filter((row) => row.threadId === "t")).toHaveLength(1);
    });
  });

  it("keeps the per-leaf budget when near builds fail", async () => {
    const generateText = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const { threads, appended, state, build } = setup(generateText);
    Object.assign(state, gate, { nativePrompt: { last: 58_114, growth: 24_373 } });
    threads.set("t", [...nativeTurn("a", harbor(9_000)), ...nativeTurn("b", harbor(9_000))]);

    build.onSettled("bot", "t");
    await build.idle();
    expect(generateText).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await build.idle();
    expect(generateText).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    build.onSettled("bot", "t");
    await build.idle();
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(appended).toEqual([]);
  });

  it("drops a native build whose leaf was rewound mid-turn", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    Object.assign(state, gate, { nativePrompt: { last: 58_114, growth: 24_373 } });
    threads.set("t", [...nativeTurn("a", harbor(9_000)), ...nativeTurn("b", harbor(9_000))]);
    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(1);

    state.busy = true;
    threads.set("t", [...nativeTurn("a", harbor(9_000)), message("edit", "edited")]);
    calls[0]!.resolve("SUMMARY\nbuilt");
    await build.idle();
    expect(appended).toEqual([]);
  });

  it("ignores the real prompt on an engine with no native point", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    Object.assign(state, { nativeAt: null, nativePrompt: { last: 900_000, growth: 50_000 } });
    threads.set("t", [...nativeTurn("a", harbor(100)), ...nativeTurn("b", harbor(100))]);
    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(0);

    threads.set("t", overBudgetThread("c"));
    build.onSettled("bot", "t");
    await tick();
    expect(calls).toHaveLength(1);
    state.busy = true;
    calls[0]!.resolve("SUMMARY\nbuilt");
    await build.idle();
    expect(appended).toEqual([]);
  });

  it("falls back to the estimate when a native engine has reported no size", async () => {
    const generateText = vi.fn(async () => "SUMMARY\nbuilt");
    const { threads, appended, state, build } = setup(generateText);
    Object.assign(state, gate);
    threads.set("t", [...nativeTurn("a", harbor(9_000)), ...nativeTurn("b", harbor(9_000))]);
    build.onSettled("bot", "t");
    await build.idle();
    expect(generateText).not.toHaveBeenCalled();

    threads.get("t")!.push(...nativeTurn("c", harbor(50_000)));
    build.onSettled("bot", "t");
    await build.idle();
    expect(appended).toHaveLength(1);
  });
});

describe("inline summarizer after a build wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("settle returns the wait", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));
    expect(await build.settle("t", claudeSend, 90_000, () => true)).toBe(0);

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next question"));
    const settled = build.settle("t", claudeSend, 90_000, () => true);
    await vi.advanceTimersByTimeAsync(5_000);
    calls[0]!.resolve("SUMMARY\nbuilt");

    expect(await settled).toBe(5_000);
    expect(appended).toHaveLength(1);
    expect(await build.settle("t", claudeSend, 90_000, () => true)).toBe(0);
  });

  it("budget used up means no summarize call and the fallback path", async () => {
    const { threads, sendPrepares } = setup();
    threads.set("t", overBudgetThread("a"));
    threads.get("t")!.push(message("send", "next question"));
    const instance = { generateText: vi.fn(async () => "SUMMARY\nsecond"), textTimeoutMs: 90_000 };

    const summarize = inlineSummarizer(instance, 90_000);
    expect(summarize).toBeUndefined();
    expect(inlineSummarizer(instance, 120_000)).toBeUndefined();
    const { prepared } = await sendPrepares("t", "send", { summarize });

    expect(instance.generateText).not.toHaveBeenCalled();
    expect(prepared.status).toBe("ready");
    expect(prepared.status === "ready" && isFallbackSummary(prepared.compaction!.summary)).toBe(true);
  });

  it("a build that fails partway leaves the inline call the remainder", async () => {
    const { calls, generateText } = deferred();
    const { threads, appended, state, build } = setup(generateText);
    threads.set("t", overBudgetThread("a"));

    build.onSettled("bot", "t");
    await tick();
    state.busy = true;
    threads.get("t")!.push(message("send", "next question"));
    const settled = build.settle("t", claudeSend, 90_000, () => true);
    await vi.advanceTimersByTimeAsync(30_000);
    calls[0]!.reject(new Error("provider unavailable"));
    const waited = await settled;

    expect(waited).toBe(30_000);
    expect(appended).toEqual([]);
    const instance = { generateText: vi.fn(async () => "SUMMARY\nsecond"), textTimeoutMs: 90_000 };
    await inlineSummarizer(instance, waited)!("prompt");
    expect(instance.generateText).toHaveBeenCalledWith("prompt", { timeoutMs: 60_000 });
  });

  it("under 60 s left after a build wait makes no call and lands the fallback", async () => {
    const { threads, sendPrepares } = setup();
    threads.set("t", overBudgetThread("a"));
    threads.get("t")!.push(message("send", "next question"));
    const instance = { generateText: vi.fn(async () => "SUMMARY\nsecond"), textTimeoutMs: 90_000 };

    const summarize = inlineSummarizer(instance, 30_001);
    expect(summarize).toBeUndefined();
    const { prepared } = await sendPrepares("t", "send", { summarize });

    expect(instance.generateText).not.toHaveBeenCalled();
    expect(prepared.status === "ready" && isFallbackSummary(prepared.compaction!.summary)).toBe(true);
  });

  it("no wait means today's call with no timeout override", async () => {
    const instance = { generateText: vi.fn(async () => "SUMMARY\nsecond"), textTimeoutMs: 90_000 };
    await inlineSummarizer(instance, 0)!("prompt");
    expect(instance.generateText).toHaveBeenCalledWith("prompt");
    expect(inlineSummarizer({ generateText: undefined, textTimeoutMs: 90_000 }, 0)).toBeUndefined();
  });

  it("an undeclared deadline leaves nothing to debit after a wait", async () => {
    const instance = { generateText: vi.fn(async () => "SUMMARY\nsecond"), textTimeoutMs: undefined };
    expect(inlineSummarizer(instance, 50_000)).toBeUndefined();
    await inlineSummarizer(instance, 0)!("prompt");
    expect(instance.generateText).toHaveBeenCalledWith("prompt");
  });
});

describe("summary build wiring", () => {
  const index = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

  it("builds first in the main fold, settles before prepare, and disposes on shutdown", () => {
    expect(index).toMatch(/summaryBuild\.onSettled\(bot\.id, event\.threadId\);\s*summaryRepair\.onSettled\(bot\.id, event\.threadId\);/);
    expect(index).toContain("const sessionResumes = planSummaryGrace(graceInputs).safe;");
    expect(index).toContain("const summarySkipped = sessionResumes && (summaryBuild.inflight(threadId) || fitsOnNativePrompt(planBeforeSummary));");
    expect(index).toContain("grace: graceInputs, onWait: onSummaryWait");
    expect(index.split("90_000, () => summarizesOnEstimate(planBeforeSummary), {")).toHaveLength(3);
    expect(index.indexOf("const summaryWaitMs = await summaryBuild.settle(")).toBeLessThan(index.indexOf("  const prepared = await prepareContext("));
    expect(index).toContain("const prepared = await prepareContext(activeMessages, summaryWaitMs, summarySkipped ? summaryGrace : undefined, sessionResumes ? nativeCycle : undefined);");
    expect(index).toContain("requestText: systemUpdate + text, recycle: summaryGrace.recycle || systemRecycle");
    expect(index).toContain("const finalGrace = summarySkipped ? planSummaryGrace(finalGraceInputs) : null;");
    expect(index).toMatch(/summaryBuild\.dispose\(\);\s*summaryRepair\.dispose\(\);/);
  });

  it("the 1:1 send's inline call runs on the deadline left after the wait; the room path is unchanged", () => {
    const sends = index.split("summarize: inlineSummarizer(summaryInstance(instance, model), waitedMs),");
    expect(sends).toHaveLength(2);
    expect(sends[0]!.lastIndexOf("const summaryWaitMs = await summaryBuild.settle(")).toBeGreaterThan(sends[0]!.lastIndexOf("async function startClaimedTurn("));
    expect(index).toContain("summarize: instance.generateText ? (prompt) => instance.generateText!(prompt) : undefined,");
  });

  it("the 1:1 compact log reports the deadline the inline call gets", () => {
    const send = index.split("summarize: inlineSummarizer(summaryInstance(instance, model), waitedMs),")[1]!;
    expect(send.slice(0, send.indexOf("}, record),"))).toContain("deadlineMs: inlineDeadlineMs(instance, waitedMs),");
    expect(inlineDeadlineMs({ textTimeoutMs: 90_000 }, 30_000)).toBe(60_000);
    expect(inlineDeadlineMs({ textTimeoutMs: 90_000 }, 0)).toBe(90_000);
    expect(inlineDeadlineMs({ textTimeoutMs: undefined }, 30_000)).toBeNull();
  });
});
