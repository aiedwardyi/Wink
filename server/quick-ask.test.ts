import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBotChatRoutes } from "./bot-chat-routes.ts";
import { prepareModelContext, routineCardsSinceLastUserTurn } from "./context-compaction.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { endsNoteWindow } from "./pane-wake.ts";
import { quickAnswersSinceLastUserTurn, quickAnswersTaken, recoverQuickAsks, routesQuick, type QuickGate } from "./quick-ask.ts";
import type { QuickResult } from "./side-chat.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { drainSteeredMessages, foldQueuedSends, queueMark, _queuedCount, _resetSteerQueue } from "./steer-queue.ts";
import { Store, type Message } from "./store.ts";
import { turnAddedMessage } from "./turn-reply.ts";

const queueFails = vi.hoisted(() => ({ on: false }));
vi.mock("./steer-queue.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./steer-queue.ts")>();
  return {
    ...real,
    queueSteeredMessage: (...args: Parameters<typeof real.queueSteeredMessage>) => {
      if (queueFails.on) throw new Error("disk full");
      return real.queueSteeredMessage(...args);
    },
  };
});

afterEach(() => {
  queueFails.on = false;
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
  const instance = { instanceId: "claude", driverKind: "claudeAgent", adapter, generateText: vi.fn(async () => "") };
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
  async function stop() {
    const { out, res } = respond();
    await routes.interrupt(Readable.from(["{}"]) as IncomingMessage, res, ["", bot.id] as RegExpMatchArray);
    store.setActivity(bot.id, "idle");
    return out;
  }
  const rows = () => store.messagesFor(bot.threadId);
  const settled = async () => {
    release();
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { bot, store, steer, ask, usage, startTurn, send, stop, rows, settled, release };
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
    expect(answer).toMatchObject({ role: "bot", kind: "text", text: "Port 8787.", engine: "claudeAgent", quick: { state: "answer", askId: ask!.id } });
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

  it("never replays a handoff steer the engine took after the turn ended", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    h.steer.mockImplementationOnce(async () => {
      h.store.setActivity(h.bot.id, "idle");
      return true;
    });
    await h.settled();
    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.startTurn).not.toHaveBeenCalled();
    expect(_queuedCount(h.bot.threadId)).toBe(0);
    expect(h.rows().at(-1)).toMatchObject({ text: QUESTION, steered: true, quick: { state: "handoff" } });
  });

  it("starts an ordinary turn once on a steer the engine dropped", async () => {
    const h = harness({ consumed: true, result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    h.steer.mockImplementationOnce(async (_threadId, _text, consumed) => {
      h.store.setActivity(h.bot.id, "idle");
      consumed?.(false);
      return true;
    });
    await h.settled();
    const ask = h.rows().at(-1)!;
    expect(ask.steered).toBeUndefined();
    expect(h.startTurn).toHaveBeenCalledExactlyOnceWith(h.bot.id, QUESTION, expect.objectContaining({ userMessage: expect.objectContaining({ id: ask.id }) }));
  });

  it.each([false, true])("queues an ask once when its recorded steer is dropped late, rewound: %s", async (rewound) => {
    const h = harness({ consumed: true, result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    let drop: (taken: boolean) => void = () => {};
    h.steer.mockImplementationOnce(async (_threadId, _text, consumed) => {
      drop = consumed!;
      return true;
    });
    await h.settled();
    const ask = h.rows().at(-1)!;
    expect(ask).toMatchObject({ steered: true, quick: { state: "handoff" } });
    if (rewound) h.store.branchMessage(h.bot.threadId, h.rows().at(-2)!.id, "build the login page");
    h.store.setActivity(h.bot.id, "idle");
    drop(false);
    drop(false);
    expect(_queuedCount(h.bot.threadId)).toBe(rewound ? 0 : 1);
    if (rewound) return;
    expect(h.rows().at(-1)).toMatchObject({ id: ask.id, quick: { state: "handoff" }, queueId: expect.any(String) });
    expect(h.rows().at(-1)?.steered).toBeUndefined();
    const run = vi.fn();
    drainSteeredMessages(h.store, run);
    expect(run).toHaveBeenCalledExactlyOnceWith(h.bot.id, h.bot.threadId, QUESTION, expect.objectContaining({ id: ask.id }), [ask.id]);
  });

  it("drops a handoff rewound while its steer was out", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    h.steer.mockImplementation(async () => {
      if (h.rows().at(-1)?.text === QUESTION) h.store.branchMessage(h.bot.threadId, h.rows().at(-2)!.id, "build the login page");
      return false;
    });
    await h.settled();
    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.startTurn).not.toHaveBeenCalled();
    expect(_queuedCount(h.bot.threadId)).toBe(0);
  });

  it("queues a twice-failed handoff as the bot's next turn", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    h.store.setActivity(h.bot.id, "idle");
    h.startTurn.mockRejectedValue(Object.assign(new Error("busy"), { status: 409 }));
    await h.settled();
    expect(h.startTurn).toHaveBeenCalledTimes(2);
    expect(_queuedCount(h.bot.threadId)).toBe(1);
    expect(h.rows().at(-1)).toMatchObject({ role: "user", text: QUESTION, quick: { state: "handoff" }, queueId: expect.any(String) });
  });

  it("shows the failed-send row when even the queue fails", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    h.store.setActivity(h.bot.id, "idle");
    h.startTurn.mockRejectedValue(Object.assign(new Error("busy"), { status: 409 }));
    queueFails.on = true;
    await h.settled();
    const [ask, failed] = h.rows().slice(-2);
    expect(ask).toMatchObject({ role: "user", text: QUESTION });
    expect(ask?.quick).toBeUndefined();
    expect(failed).toMatchObject({ role: "bot", kind: "activity", tool: { name: "error: queued message could not start - disk full", ok: false } });
  });

  it("lands a late answer in the ask's own task after a switch, without a steer", async () => {
    const h = harness({ consumed: true });
    await h.send({ text: QUESTION });
    const own = h.bot.threadId;
    const other = h.store.createTask(h.bot.id)!;
    h.store.setActivity(h.bot.id, "working", other.threadId);
    await h.settled();
    expect(h.store.messagesFor(own).at(-1)).toMatchObject({ role: "bot", text: "Port 8787.", quick: { state: "answer" } });
    expect(h.store.messagesFor(other.threadId).some((row) => row.quick)).toBe(false);
    expect(h.steer).not.toHaveBeenCalled();
  });

  it("queues a handoff in the ask's own task after a switch", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    const own = h.bot.threadId;
    const other = h.store.createTask(h.bot.id)!;
    await h.settled();
    expect(h.steer).not.toHaveBeenCalled();
    expect(_queuedCount(own)).toBe(1);
    expect(_queuedCount(other.threadId)).toBe(0);
    expect(h.store.messagesFor(own).at(-1)).toMatchObject({ text: QUESTION, quick: { state: "handoff" } });
    h.store.setActivity(h.bot.id, "idle");
    const run = vi.fn();
    drainSteeredMessages(h.store, run);
    expect(run).toHaveBeenCalledExactlyOnceWith(h.bot.id, own, QUESTION, expect.objectContaining({ text: QUESTION }), [expect.any(String)]);
  });

  it.each(["an edit", "a rewind"])("drops a late answer after %s", async (how) => {
    const h = harness();
    await h.send({ text: QUESTION });
    const ask = h.rows().at(-1)!;
    const [source, text] = how === "an edit" ? [ask, "what port is in the client config?"] : [h.rows().at(-2)!, "build the login page"];
    h.store.branchMessage(h.bot.threadId, source.id, text);
    const count = h.rows().length;
    await h.settled();
    expect(h.rows()).toHaveLength(count);
    expect(h.steer).not.toHaveBeenCalled();
  });

  it("drops a handoff after a rewind", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    h.store.branchMessage(h.bot.threadId, h.rows().at(-2)!.id, "build the login page");
    await h.settled();
    expect(h.steer).not.toHaveBeenCalled();
    expect(_queuedCount(h.bot.threadId)).toBe(0);
  });

  it("starts nothing from a handoff after Stop", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION, sendId: "send-quick-0000000002" });
    await h.stop();
    await h.settled();
    expect(h.startTurn).not.toHaveBeenCalled();
    expect(h.steer).not.toHaveBeenCalled();
    expect(_queuedCount(h.bot.threadId)).toBe(0);
  });

  it("still lands an answer after Stop", async () => {
    const h = harness();
    await h.send({ text: QUESTION });
    await h.stop();
    await h.settled();
    expect(h.rows().at(-1)).toMatchObject({ text: "Port 8787.", quick: { state: "answer" } });
    expect(h.steer).not.toHaveBeenCalled();
  });

  it.each([["send-quick-0000000004"], [undefined]])("never requeues a steer dropped after Stop: %s", async (sendId) => {
    const h = harness({ consumed: true, result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION, sendId });
    let drop: (taken: boolean) => void = () => {};
    h.steer.mockImplementationOnce(async (_threadId, _text, consumed) => {
      drop = consumed!;
      return true;
    });
    await h.settled();
    await h.stop();
    drop(false);
    expect(_queuedCount(h.bot.threadId)).toBe(0);
  });

  it.each([["send-quick-0000000003"], [undefined]])("drops a handoff whose steer was taken during Stop: %s", async (sendId) => {
    const h = harness({ consumed: true, result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION, sendId });
    let drop: (taken: boolean) => void = () => {};
    h.steer.mockImplementationOnce(async (_threadId, _text, consumed) => {
      drop = consumed!;
      await h.stop();
      return true;
    });
    await h.settled();
    drop(false);
    expect(h.rows().at(-1)?.steered).toBeUndefined();
    expect(_queuedCount(h.bot.threadId)).toBe(0);
    expect(h.startTurn).not.toHaveBeenCalled();
  });

  it("queues the ask as the next turn when the bot's final reply landed while the helper ran", async () => {
    const h = harness();
    const { message } = (await h.send({ text: QUESTION })).data as { message: Message };
    h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "text", text: "Done, tests pass." });
    h.store.setActivity(h.bot.id, "idle");
    await h.settled();
    expect(h.rows().some((row) => row.quick?.state === "answer")).toBe(false);
    expect(_queuedCount(h.bot.threadId)).toBe(1);
    expect(h.rows().find((row) => row.id === message.id)).toMatchObject({ quick: { state: "handoff" }, queueId: expect.any(String) });
  });

  it("moves a pending ask to handoff on Stop", async () => {
    const h = harness();
    const { message } = (await h.send({ text: QUESTION })).data as { message: Message };
    await h.stop();
    expect(h.rows().find((row) => row.id === message.id)?.quick).toEqual({ state: "handoff" });
  });

  it("posts no answer for an ask handed to the bot while its helper ran", async () => {
    const h = harness();
    const { message } = (await h.send({ text: QUESTION })).data as { message: Message };
    h.store.patchMessage(h.bot.threadId, message.id, { steered: true, quick: { state: "handoff" } });
    await h.settled();
    expect(h.rows().some((row) => row.quick?.state === "answer")).toBe(false);
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

  it("gives a call ask the call lines before it", async () => {
    const h = harness();
    const call = { id: "c-0123456789ab" };
    h.store.appendMessage(h.bot.threadId, { role: "user", kind: "text", text: "Which port does the server use?", call });
    h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "text", text: "Let me check.", call: { ...call, voice: true } });
    await h.send({ text: QUESTION, call: { ...call, ask: true } });
    await h.settled();
    expect((h.ask.mock.calls[0] as unknown[])[2]).toMatchObject({ text: QUESTION, notes: expect.stringContaining("Person: Which port does the server use?\nYou: Let me check.") });
  });
});

describe("boot recovery", () => {
  it("hands an orphaned ask to its bot once, as an ordinary turn", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "build it" });
    const answered = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "which branch?", quick: { state: "asked" } });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "main", quick: { state: "answer", askId: answered.id } });
    const ask = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: QUESTION, quick: { state: "asked" } });
    recoverQuickAsks(store);
    recoverQuickAsks(store);
    expect(_queuedCount(bot.threadId)).toBe(1);
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run.mock.calls.filter(([botId]) => botId === bot.id)).toEqual([[bot.id, bot.threadId, QUESTION, expect.objectContaining({ id: ask.id }), [ask.id]]]);
    expect(store.messagesFor(bot.threadId).filter((row) => row.text === QUESTION)).toHaveLength(1);
  });

  it("moves an orphaned ask to handoff", () => {
    const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
    const bot = store.createBot({}, { seedMessages: false });
    const ask = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: QUESTION, quick: { state: "asked" } });
    recoverQuickAsks(store);
    expect(store.messagesFor(bot.threadId).find((row) => row.id === ask.id)?.quick).toEqual({ state: "handoff" });
  });

  it("leaves an ask stopped before a restart", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    await h.stop();
    recoverQuickAsks(h.store);
    expect(_queuedCount(h.bot.threadId)).toBe(0);
  });

  it("recovers an ask left in another task once", async () => {
    const h = harness({ result: { route: "handoff", ms: 3 } });
    await h.send({ text: QUESTION });
    const own = h.bot.threadId;
    const other = h.store.createTask(h.bot.id)!;
    await new Promise((resolve) => setImmediate(resolve));
    recoverQuickAsks(h.store);
    recoverQuickAsks(h.store);
    expect(_queuedCount(own)).toBe(1);
    expect(_queuedCount(other.threadId)).toBe(0);
    await h.settled();
    expect(_queuedCount(own)).toBe(1);
  });
});

describe("Gate 0", () => {
  const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
  const bot = store.createBot({}, { seedMessages: false });
  const busy = { ...bot, busy: true, activeThreadId: bot.threadId };
  const base: QuickGate = {
    bot: busy, threadId: bot.threadId, text: QUESTION, instance: { driverKind: "claudeAgent", fork: () => null } as never, messages: [],
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
    ["no fork and no fallback", { instance: { driverKind: "claudeAgent", adapter: {} } as never }],
    ["an open ask_user card", { messages: [card] }],
    ["not nominated", { text: "ship it" }],
  ])("skips the helper: %s", (_name, patch) => {
    expect(routesQuick({ ...base, ...patch })).toBe(false);
  });

  const typed = { id: "u", at: 2, role: "user", kind: "text", text: "nevermind, keep going" } as Message;
  const newer = { ...card, id: "c2", at: 3 } as Message;
  const approval = { ...card, card: { title: "?", subtitle: "", options: [], requestId: "r1", tool: "Bash" } } as Message;
  const closed = (patch: object) => ({ ...card, card: { ...card.card!, ...patch } }) as Message;

  describe.each([QUESTION, "지금 뭐 하고 있어?"])("open cards: %s", (text) => {
    it.each<[string, Message[]]>([
      ["an old card the person typed past", [card, typed]],
      ["an answered card", [closed({ answered: "Yes" })]],
      ["a dismissed card", [closed({ dismissed: true })]],
    ])("passes: %s", (_name, messages) => {
      expect(routesQuick({ ...base, text, messages })).toBe(true);
    });

    it.each<[string, Message[]]>([
      ["the newest card, still open", [card, typed, newer]],
      ["an open approval the person typed past", [approval, typed]],
    ])("skips the helper: %s", (_name, messages) => {
      expect(routesQuick({ ...base, text, messages })).toBe(false);
    });
  });

  it("passes past a live card with choices, but not a tap on one of them", () => {
    const choices = closed({ staysOpen: true, options: ["Ship today", "Hold for QA"] });
    expect(routesQuick({ ...base, messages: [choices] })).toBe(true);
    expect(routesQuick({ ...base, messages: [closed({ staysOpen: true, options: [QUESTION, "Hold for QA"] })] })).toBe(false);
    expect(routesQuick({ ...base, messages: [closed({ staysOpen: true })] })).toBe(false);
  });

  it.each(["codex", "grokAgent", "antigravityAgent", "museAgent"])("skips the helper: a %s bot", (driverKind) => {
    expect(routesQuick({ ...base, instance: { driverKind, fork: () => null, generateText: async () => "" } as never })).toBe(false);
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

  const carried = () => {
    const store = new Store(() => ({ instanceId: "claude", model: "opus" }));
    const bot = store.createBot({}, { seedMessages: false });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "build it" });
    const ask = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: QUESTION, quick: { state: "asked" } });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Port 8787.", quick: { state: "answer", askId: ask.id } });
    const turn = () => quickAnswersSinceLastUserTurn(store.activePath(bot.threadId), new Set(), undefined, bot.threadId);
    const event = (type: "content.delta" | "turn.completed") => quickAnswersTaken(store, { threadId: bot.threadId, type } as RuntimeEvent);
    return { turn, event };
  };

  it("carries an answer into one automated turn only", () => {
    const { turn, event } = carried();
    expect(turn()).toHaveLength(1);
    event("content.delta");
    event("turn.completed");
    expect(turn()).toEqual([]);
  });

  it("carries an answer again after a turn that died before its first model event", () => {
    const { turn, event } = carried();
    expect(turn()).toHaveLength(1);
    event("turn.completed");
    event("content.delta");
    expect(turn()).toHaveLength(1);
  });

  it("holds each turn's block and marks it from the event fold", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index.match(/quickAnswersSinceLastUserTurn\([^()]*, threadId\)/g)).toHaveLength(2);
    expect(index).toMatch(/quickAnswersTaken\(store, event\)/);
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
