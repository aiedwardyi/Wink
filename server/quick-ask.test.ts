import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { prepareModelContext, routineCardsSinceLastUserTurn } from "./context-compaction.ts";
import { endsNoteWindow } from "./pane-wake.ts";
import { quickAnswersSinceLastUserTurn, routesQuick, type QuickGate } from "./quick-ask.ts";
import type { QuickResult } from "./side-chat.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { drainSteeredMessages, foldQueuedSends, queueMark, _queuedCount, _resetSteerQueue } from "./steer-queue.ts";
import { Store, type Message } from "./store.ts";
import { turnAddedMessage } from "./turn-reply.ts";

afterEach(() => {
  _resetSteerQueue();
  vi.restoreAllMocks();
});

const QUESTION = "what port is in the server config?";
const ANSWER: QuickResult = { route: "answer", text: "Port 8787.", usage: { input: 100, output: 10, cachedInput: 90 }, ms: 5 };

function harness(opts: { busy?: boolean; consumed?: boolean; queueing?: boolean; result?: QuickResult; quick?: boolean; taken?: boolean } = {}) {
  const selection = { instanceId: "claude", model: "opus", effort: "max" as const };
  const store = new Store(() => selection);
  const bot = store.createBot({}, { seedMessages: false });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "build the settings page" });
  if (opts.busy !== false) store.setActivity(bot.id, "working", bot.threadId);
  const steer = vi.fn(async (_threadId: string, _text: string, consumed?: (taken: boolean) => void) => {
    consumed?.(opts.taken ?? true);
    return true;
  });
  const adapter = { capabilities: { queueing: opts.queueing !== false, steerConsumed: opts.consumed === true }, steer, interruptTurn: vi.fn(async () => {}) };
  const instance = { instanceId: "claude", adapter, generateText: vi.fn(async () => "") };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ask = vi.fn(async () => {
    await gate;
    return opts.result ?? ANSWER;
  });
  const usage = { start: vi.fn(), settle: vi.fn() };
  const startTurn = vi.fn(async () => ({}));
  const noop = () => {};
  const routes = createBotChatRoutes({
    cfg: {}, threadSyncGate: { enabled: false }, store, registry: new Map([["claude", instance]]),
    wireBot: () => ({}), wireTask: () => ({}),
    sendSequencer: new SendSequencer(), startTurn, noteTalked: noop, pullSyncedThread: noop, resolveReplyTarget: () => undefined,
    ensureChatLatency: noop, markChatLatency: noop, broadcast: noop, clearUnattended: noop, resumePaneWakes: noop,
    botHasActiveTurn: () => Boolean(store.bot(bot.id)?.busy), paneNoteTurnThreads: new Set(), busyResumeThreads: new Set(), drainQueuedSends: noop,
    routines: { activeRunForBot: () => null }, taskResumes: { forgetBot: noop }, closeOpenApprovals: noop,
    bumpTurnEpoch: () => 1, markThreadInterrupted: noop, flushInterruptedTask: noop, releaseInterruptedBot: noop,
    ...(opts.quick === false ? {} : { quick: { ask, accountReady: () => true, usage } }),
  } as unknown as Parameters<typeof createBotChatRoutes>[0]);
  const respond = () => {
    const out = { status: 0, data: {} as Record<string, unknown> };
    const res = { writeHead: (code: number) => { out.status = code; }, end: (raw: string) => { out.data = JSON.parse(raw); } } as unknown as ServerResponse;
    return { out, res };
  };
  async function send(body: object) {
    const { out, res } = respond();
    await routes.send(Readable.from([JSON.stringify(body)]) as IncomingMessage, res, ["", bot.id] as RegExpMatchArray);
    return out;
  }
  const rows = () => store.messagesFor(bot.threadId);
  const settled = async () => {
    release();
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { bot, store, steer, ask, usage, startTurn, send, rows, settled, release };
}

describe("quick route", () => {
  it("sends to an idle bot exactly as without the router", async () => {
    const withRouter = harness({ busy: false });
    const without = harness({ busy: false, quick: false });
    const a = await withRouter.send({ text: QUESTION });
    const b = await without.send({ text: QUESTION });
    expect({ ...a.data, threadId: undefined }).toEqual({ ...b.data, threadId: undefined });
    expect(a.status).toBe(b.status);
    expect(withRouter.startTurn.mock.calls).toEqual([[withRouter.bot.id, QUESTION, { threadId: withRouter.bot.threadId, replyTo: undefined, sendId: undefined }]]);
    expect(withRouter.ask).not.toHaveBeenCalled();
    expect(withRouter.rows().some((row) => row.quick)).toBe(false);
  });

  it("steers a busy, non-nominated send as today", async () => {
    const h = harness();
    const response = await h.send({ text: "also update the docs when you are done" });
    expect(response.data.steered).toBe(true);
    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.ask).not.toHaveBeenCalled();
    expect(h.rows().at(-1)).toMatchObject({ steered: true, text: "also update the docs when you are done" });
    expect(h.rows().at(-1)?.quick).toBeUndefined();
  });

  it("answers a nominated ask in two rows without a steer", async () => {
    const h = harness();
    const response = await h.send({ text: QUESTION, sendId: "send-quick-0000000001" });
    expect(response.status).toBe(202);
    expect(response.data).toMatchObject({ ok: true, quick: true });
    await h.settled();
    const [ask, answer] = h.rows().slice(-2);
    expect(ask).toMatchObject({ role: "user", kind: "text", text: QUESTION, quick: { state: "asked" } });
    expect(answer).toMatchObject({ role: "bot", kind: "text", text: "Port 8787.", quick: { state: "answer", askId: ask!.id } });
    expect(h.steer).not.toHaveBeenCalled();
    const retry = await h.send({ text: QUESTION, sendId: "send-quick-0000000001" });
    expect(retry.data).toMatchObject({ quick: true, message: { id: ask!.id } });
  });

  it("hands off down today's steer, flipping the ask row", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    const count = h.rows().length;
    await h.settled();
    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.steer.mock.calls[0]![1]).toContain(QUESTION);
    expect(h.rows()).toHaveLength(count);
    expect(h.rows().at(-1)).toMatchObject({ steered: true, quick: { state: "handoff" } });
  });

  it("queues a handoff an engine cannot steer, marking the ask row", async () => {
    const h = harness({ queueing: false, result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    await h.settled();
    expect(_queuedCount(h.bot.threadId)).toBe(1);
    expect(h.rows().at(-1)).toMatchObject({ quick: { state: "handoff" } });
    expect(h.rows().at(-1)?.queueId).toBeTruthy();
  });

  it("drains a queued handoff on its ask row, so the ask shows once", async () => {
    const h = harness({ queueing: false, result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    await h.settled();
    const ask = h.rows().at(-1)!;
    h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "text", text: "Settings page is done." });
    h.store.setActivity(h.bot.id, "idle");
    const run = vi.fn();
    drainSteeredMessages(h.store, run);
    expect(h.rows().filter((row) => row.text === QUESTION)).toHaveLength(1);
    expect(h.rows().find((row) => row.id === ask.id)?.quick).toBeUndefined();
    expect(run).toHaveBeenCalledExactlyOnceWith(h.bot.id, h.bot.threadId, QUESTION, expect.objectContaining({ id: ask.id }), [ask.id]);
    expect(_queuedCount(h.bot.threadId)).toBe(0);
  });

  it("folds a handoff queued after a claim on its ask row, so the ask shows once", async () => {
    const h = harness({ queueing: false, result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    const claim = queueMark();
    await h.settled();
    const ask = h.rows().at(-1)!;
    expect(foldQueuedSends(h.store, h.bot.id, h.bot.threadId, claim)).toEqual([QUESTION]);
    expect(h.rows().filter((row) => row.text === QUESTION)).toHaveLength(1);
    expect(h.rows().find((row) => row.id === ask.id)).toMatchObject({ steered: true });
    expect(h.rows().find((row) => row.id === ask.id)?.quick).toBeUndefined();
  });

  it("starts an ordinary turn on the ask when the bot finished first", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    h.store.setActivity(h.bot.id, "idle");
    await h.settled();
    const ask = h.rows().at(-1)!;
    expect(ask.quick).toBeUndefined();
    expect(h.startTurn).toHaveBeenCalledWith(h.bot.id, QUESTION, expect.objectContaining({ userMessage: expect.objectContaining({ id: ask.id }) }));
  });

  it("retries a handoff whose turn ended mid-steer as an ordinary turn", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    h.steer.mockImplementationOnce(async () => {
      h.store.setActivity(h.bot.id, "idle");
      return true;
    });
    await h.settled();
    const ask = h.rows().at(-1)!;
    expect(ask.quick).toBeUndefined();
    expect(h.startTurn).toHaveBeenCalledWith(h.bot.id, QUESTION, expect.objectContaining({ userMessage: expect.objectContaining({ id: ask.id }) }));
  });

  it("leaves a twice-failed handoff as a plain unanswered ask", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    h.steer.mockImplementationOnce(async () => {
      h.store.setActivity(h.bot.id, "idle");
      return true;
    });
    h.startTurn.mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 409 }));
    await h.settled();
    expect(h.startTurn).toHaveBeenCalledTimes(1);
    expect(h.rows().at(-1)).toMatchObject({ role: "user", text: QUESTION });
    expect(h.rows().at(-1)?.quick).toBeUndefined();
  });

  it.each([true, false])("steers the live note and marks it noted only when taken: %s", async (taken) => {
    const h = harness({ consumed: true, taken });
    await h.send({ text: QUESTION });
    await h.settled();
    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.steer.mock.calls[0]![1]).toMatch(/^\[Wink note, automated, not from the person\.[\s\S]*Q: what port[\s\S]*A: Port 8787\.$/);
    expect(h.rows().at(-1)?.quick?.noted).toBe(taken ? true : undefined);
  });

  it("words the live note and the block as the bot's own earlier reply", async () => {
    const h = harness({ consumed: true, taken: true });
    await h.send({ text: QUESTION });
    await h.settled();
    const note = String(h.steer.mock.calls[0]![1]);
    const [block] = quickAnswersSinceLastUserTurn([row("q", "user", "x?", { quick: { state: "asked" } }), row("a", "bot", "y", { quick: { state: "answer", askId: "q" } })], new Set());
    for (const head of [note.split(" Q: ")[0]!, block!.split("\nQ: ")[0]!]) {
      expect(head).toMatch(/Correction:/);
      expect(head).not.toMatch(/helper|copy|fork/i);
    }
  });

  it("records helper usage under quick:<askId>", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const h = harness();
    await h.send({ text: QUESTION });
    await h.settled();
    const id = `quick:${h.rows().at(-2)!.id}`;
    expect(h.usage.start).toHaveBeenCalledWith(h.bot.id, h.bot.threadId, id);
    expect(h.usage.settle).toHaveBeenCalledWith(id);
    const line = info.mock.calls.map(([text]) => String(text)).find((text) => text.startsWith("[quick] "))!;
    expect(JSON.parse(line.slice(8))).toEqual({ id, accountId: "claude", route: "answer", ms: 5, input: 100, output: 10, cachedInput: 90 });
  });

  it("gives the helper the earlier quick answers", async () => {
    const h = harness();
    await h.send({ text: QUESTION });
    await h.settled();
    await h.send({ text: "and which file is that in?" });
    await vi.waitFor(() => expect(h.ask).toHaveBeenCalledTimes(2));
    expect((h.ask.mock.calls[1] as unknown[])[2]).toMatchObject({ text: "and which file is that in?", notes: expect.stringContaining(`Q: ${QUESTION}\nA: Port 8787.`) });
  });
});

describe("Gate 0", () => {
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = store.createBot({}, { seedMessages: false });
  const busy = { ...bot, busy: true, activeThreadId: bot.threadId };
  const base: QuickGate = {
    bot: busy, threadId: bot.threadId, text: QUESTION, instance: { fork: () => null } as never, messages: [],
    deliverAfter: false, room: false, accountReady: true,
  };
  const card = { id: "c", at: 1, role: "bot", kind: "options", card: { title: "?", subtitle: "", options: [], askUser: true } } as Message;

  it("passes a busy, nominated ask", () => {
    expect(routesQuick(base)).toBe(true);
  });

  it.each<[string, Partial<QuickGate>]>([
    ["idle", { bot: { ...bot, busy: false } }],
    ["busy on another thread", { bot: { ...busy, activeThreadId: "room" } }],
    ["sent after this turn", { deliverAfter: true }],
    ["a Reply", { replyTo: card }],
    ["a queued send", { queueId: "q1" }],
    ["a room", { room: true }],
    ["signed out or at a limit", { accountReady: false }],
    ["no fork and no fallback", { instance: { adapter: {} } as never }],
    ["an open ask_user card", { messages: [card] }],
    ["not nominated", { text: "ship it" }],
  ])("skips the helper: %s", (_name, patch) => {
    expect(routesQuick({ ...base, ...patch })).toBe(false);
  });
});

const row = (id: string, role: Message["role"], text: string, extra: Partial<Message> = {}): Message => ({ id, at: Number(id.slice(1)), role, kind: "text", text, ...extra });
const pair = (n: number, extra: Partial<NonNullable<Message["quick"]>> = {}) => [
  row(`q${n}`, "user", `question ${n}?`, { quick: { state: "asked" } }),
  row(`a${n}`, "bot", `answer ${n}`, { quick: { state: "answer", askId: `q${n}`, ...extra } }),
];

describe("next-turn block", () => {
  it("keeps the newest 6 un-noted pairs since the last real user turn", () => {
    const messages = [row("u1", "user", "old ask"), ...pair(0), row("u2", "user", "build it"), ...[1, 2, 3, 4, 5, 6, 7].flatMap((n) => pair(n)), ...pair(8, { noted: true }), row("u3", "user", "now")];
    const [block] = quickAnswersSinceLastUserTurn(messages, new Set(["u3"]));
    expect(block).toMatch(/^\[Your earlier fast replies in this chat,/);
    expect(block!.match(/^Q: /gm)).toHaveLength(6);
    expect(block).toContain("Q: question 2?\nA: answer 2");
    expect(block).not.toContain("question 1?");
    expect(block).not.toContain("question 8?");
    expect(block).not.toContain("question 0?");
  });

  it("drops the oldest pairs past ~1.5k tokens", () => {
    const long = (n: number) => [row(`q${n}`, "user", `q${n}?`, { quick: { state: "asked" } }), row(`a${n}`, "bot", "x".repeat(1_500), { quick: { state: "answer", askId: `q${n}` } })];
    const [block] = quickAnswersSinceLastUserTurn([row("u1", "user", "go"), ...long(1), ...long(2), ...long(3), ...long(4)], new Set());
    expect(block!.match(/^Q: /gm)).toHaveLength(2);
    expect(block).toContain("Q: q4?");
  });

  it("is empty without answers and stops at the bound row", () => {
    expect(quickAnswersSinceLastUserTurn([row("u1", "user", "go")], new Set())).toEqual([]);
    expect(quickAnswersSinceLastUserTurn([row("u1", "user", "go"), ...pair(1), row("b1", "bot", "ok"), ...pair(2)], new Set(), "b1")[0]).not.toContain("question 1?");
  });

  it("tags quick answers in a replayed transcript and drops a queued handoff's ask", async () => {
    const messages = [row("u1", "user", "go"), ...pair(1), row("q2", "user", "queued ask?", { quick: { state: "handoff" }, queueId: "qq" }), row("u3", "user", "queued ask?", { queueId: "qq" })];
    const prepared = await prepareModelContext({ messages, contextWindow: 200_000, taskRecordText: "" });
    expect(prepared.status).toBe("ready");
    const texts = prepared.status === "ready" ? prepared.transcript.map((line) => line.text) : [];
    expect(texts).toContain("[your fast reply] answer 1");
    expect(texts.filter((text) => text === "queued ask?")).toHaveLength(1);
  });
});

describe("predicates skip quick rows", () => {
  const [ask, answer] = pair(1);

  it("endsNoteWindow", () => {
    expect(endsNoteWindow(ask!)).toBe(false);
    expect(endsNoteWindow(row("u1", "user", "go"))).toBe(true);
  });

  it("routine cards since the last user turn", () => {
    const card = { id: "r1", at: 1, role: "bot", kind: "routine.run", routineRun: { routineName: "Daily", status: "missed", instruction: "check" } } as unknown as Message;
    expect(routineCardsSinceLastUserTurn([row("u1", "user", "go"), card, ask!, answer!], new Set())).toEqual(["[Routine card] Daily missed: check"]);
  });

  it("turnAddedMessage", () => {
    expect(turnAddedMessage([answer!], 0)).toBe(false);
    expect(turnAddedMessage([row("b1", "bot", "done")], 0)).toBe(true);
  });

  it("verify human and the sync join's user turns", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const sync = readFileSync(new URL("./thread-sync-v2-store.ts", import.meta.url), "utf8");
    expect(index).toMatch(/const human = [^\n]*!message\.steered && !message\.quick/);
    expect(sync).toMatch(/const turns = rows\.filter\(\(row\) => [^\n]*&& !row\.quick\)/);
  });
});
