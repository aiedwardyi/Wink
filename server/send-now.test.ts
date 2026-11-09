import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acceptedSendMatch, parseSendId, SendSequencer, sendFingerprint } from "./send-idempotency.ts";
import { steersSend } from "./send-deliver.ts";
import { sendPostReceipt, startedTurn } from "./send-receipt.ts";
import { hasPeerWatch, watchPeerTurn } from "./peer-takeover.ts";
import { _resetPeerUserReplies, beginPeerUserReply, drainPeerUserReplies, peerUserRuntime, persistPeerUserReply, settlePeerUserReplies } from "./peer-user-reply.ts";
import type { RuntimeEvent } from "./contracts.ts";
import * as queue from "./steer-queue.ts";
import type { BotRecord, Message } from "./store.ts";

const source = readFileSync(new URL("./bot-chat-routes.ts", import.meta.url), "utf8");
const start = source.indexOf('      const body = await readBody(req);', source.indexOf('    send: async ('));
const end = source.indexOf('      return json(res, 202, receipt);', start) + '      return json(res, 202, receipt);'.length;
const busy = source.slice(source.indexOf("  const deliverBusy = async ("), source.indexOf("  const startQuick = "));
const route = ts.transpileModule(busy + source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
// Run only the POST body; importing the server would boot its listeners.
const runPost = new Function("scope", `return (async () => { with (scope) { ${route} } })();`) as (scope: object) => Promise<{ status: number; body: any }>;

afterEach(() => { queue._resetSteerQueue(); _resetPeerUserReplies(); vi.restoreAllMocks(); });

function harness(steer = vi.fn(async (..._args: unknown[]) => true), queueing = true) {
  const bot = { id: "bot", threadId: "thread", busy: true, modelSelection: { instanceId: "fake", model: "fake" } } as BotRecord;
  const messages: Message[] = [];
  const appendMessage = (_thread: string, message: Omit<Message, "id" | "at">) => {
    const saved = { ...message, id: `m${messages.length}`, at: messages.length };
    messages.push(saved);
    return saved;
  };
  const store = { bot: () => bot, taskByThread: () => ({ threadId: bot.threadId, title: "", createdAt: 0, resumeCursors: {} }), messagesFor: () => messages, activePath: () => messages, appendMessage, patchMessage: vi.fn() };
  const startTurn = vi.fn(async (_bot: string, text: string, opts: { sendId?: string; replyTo?: Message }) => {
    bot.busy = true;
    return startedTurn(appendMessage(bot.threadId, { role: "user", kind: "text", text, sendId: opts.sendId, replyToId: opts.replyTo?.id }));
  });
  const drainRun = vi.fn(() => { bot.busy = true; });
  const drain = () => queue.drainSteeredMessages(store, drainRun);
  const noop = () => {};
  const interruptTurn = vi.fn(async () => {});
  const busyResumeThreads = new Set<string>();
  const scope = {
    ...queue, acceptedSendMatch, parseSendId, sendFingerprint, steersSend, sendPostReceipt,
    store, startTurn, sendSequencer: new SendSequencer(), m: ["", bot.id], req: {}, res: {},
    readBody: async () => ({}), json: (_res: unknown, status: number, body: unknown) => ({ status, body }),
    noteTalked: noop, threadSyncGate: { enabled: false }, pullSyncedThread: noop,
    ensureChatLatency: noop, markChatLatency: noop, resolveReplyTarget: (_thread: string, id?: string) => messages.find((m) => m.id === id),
    botHasActiveTurn: () => false, registry: new Map([["fake", { adapter: { capabilities: { queueing }, steer, interruptTurn } }]]),
    instanceForBot: () => ({ adapter: { capabilities: { queueing }, steer, interruptTurn } }),
    beginPeerUserReply, cfg: {},
    composeUserTurnPrompt: (text: string) => text, promptWithReply: (text: string) => text,
    userTurnReactionKeys: () => [], hasPeerWatch, clearUnattended: noop,
    resumePaneWakes: noop, cancelUsageWait: noop, paneNoteTurnThreads: new Set(), busyResumeThreads, drainQueuedSends: drain, quick: undefined,
  };
  const hold = (text: string) => {
    const sendId = `send-now-${text.padEnd(16, "0")}`;
    const held = queue.queueSteeredMessage(bot.id, bot.threadId, text, { sendId, after: true });
    return { text, sendId, queueId: held.id, threadId: bot.threadId };
  };
  const post = (body: object) => runPost({ ...scope, readBody: async () => body });
  return { bot, messages, store, steer, startTurn, drain, drainRun, hold, post, interruptTurn, busyResumeThreads };
}

describe("queued send through the message POST", () => {
  it.each([true, false])("splits the user's live reply or follows its original row (marked: %s)", async (marked) => {
    const h = harness();
    const end = watchPeerTurn(h.bot.threadId);
    try {
      const receipt = await h.post({ text: "User question" });
      expect(receipt.body.message).toMatchObject({ role: "user", text: "User question", steered: true });
      expect(h.steer.mock.calls[0]![1]).toContain("one short line");
      const prompt = h.steer.mock.calls[0]![1] as string;
      const tag = prompt.match(/<user\d+>/)![0];
      const event = { provider: "claude", eventId: "reply", createdAt: new Date().toISOString(), threadId: h.bot.threadId, type: "item.completed", itemType: "assistant_text", text: marked ? `${tag}Short answer.${tag.replace("<", "</")}` : "Peer answer." } as RuntimeEvent;
      peerUserRuntime(event);
      persistPeerUserReply(h.store, event);
      expect(hasPeerWatch(h.bot.threadId)).toBe(true);
      settlePeerUserReplies(h.bot.threadId);
      h.bot.busy = false;
      const follow = vi.fn(async () => {});
      drainPeerUserReplies(h.store, follow, () => false);
      if (marked) {
        expect(h.messages.map((message) => message.text)).toEqual(["User question", "Short answer."]);
        expect(follow).not.toHaveBeenCalled();
      } else {
        expect(follow).toHaveBeenCalledExactlyOnceWith(h.bot.id, "User question", expect.objectContaining({ userMessage: receipt.body.message }));
        expect(h.messages.map((message) => message.text)).toEqual(["User question"]);
      }
    } finally { end(); }
  });

  it("holds a peer-turn user send for an engine without mid-turn input", async () => {
    const h = harness(undefined, false);
    const end = watchPeerTurn(h.bot.threadId);
    try {
      expect((await h.post({ text: "User question" })).body).toMatchObject({ queued: true });
      expect(h.steer).not.toHaveBeenCalled();
      expect(h.messages).toEqual([]);
      h.bot.busy = false;
      h.drain();
      expect(h.drainRun).toHaveBeenCalledOnce();
      expect(h.messages.map((message) => message.text)).toEqual(["User question"]);
    } finally { end(); }
  });

  it("uses the same live steer as Enter and consumes only the selected queue receipt", async () => {
    const h = harness();
    h.hold("first");
    const selected = h.hold("second");
    h.hold("third");
    const receipt = await h.post(selected);
    expect(h.steer).toHaveBeenCalledWith("thread", "second", expect.any(Function), { fromUser: true, peerTurn: false });
    expect(receipt.body).toMatchObject({ steered: true, message: { sendId: selected.sendId, text: "second" } });
    h.bot.busy = false;
    h.drain();
    h.bot.busy = false;
    h.drain();
    expect(h.messages.map((m) => m.text)).toEqual(["second", "first", "third"]);
    expect(h.startTurn).not.toHaveBeenCalled();
  });

  it("keeps the original receipt and FIFO when the engine declines the steer", async () => {
    const h = harness(vi.fn(async () => false));
    const selected = h.hold("first");
    h.hold("second");
    expect((await h.post(selected)).body).toMatchObject({ queued: true, queueId: selected.queueId });
    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(queue.takeQueuedSteers("bot", "thread", 0).map((m) => m.text)).toEqual(["first"]);
  });

  it("cancels a busy-provider wait so a queued message runs at once", async () => {
    const h = harness(vi.fn(async () => false));
    h.busyResumeThreads.add("thread");
    expect((await h.post({ text: "do this instead" })).body).toMatchObject({ queued: true });
    expect(h.interruptTurn).toHaveBeenCalledWith("thread");
  });

  it("leaves a running turn alone when a message queues", async () => {
    const h = harness(vi.fn(async () => false));
    expect((await h.post({ text: "after this" })).body).toMatchObject({ queued: true });
    expect(h.interruptTurn).not.toHaveBeenCalled();
  });

  it("coalesces simultaneous clicks and later retries onto the original send", async () => {
    const h = harness();
    const selected = h.hold("one");
    const receipts = await Promise.all([h.post(selected), h.post(selected)]);
    expect(receipts.map((r) => r.body.message?.sendId)).toEqual([selected.sendId, selected.sendId]);
    expect((await h.post(selected)).body.message?.sendId).toBe(selected.sendId);
    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.messages).toHaveLength(1);
  });

  it("starts once if the turn ends during the awaited steer", async () => {
    let finish!: (taken: boolean) => void;
    const h = harness(vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; })));
    const selected = h.hold("race");
    const pending = h.post(selected);
    await vi.waitFor(() => expect(h.steer).toHaveBeenCalledTimes(1), { timeout: 500 });
    h.bot.busy = false;
    h.drain();
    expect(h.drainRun).not.toHaveBeenCalled();
    finish(false);
    const receipt = await pending;
    expect(receipt.body.message?.sendId).toBe(selected.sendId);
    h.drain();
    await h.post(selected);
    expect(h.startTurn).toHaveBeenCalledTimes(1);
    expect(h.messages).toHaveLength(1);
  });

  it("keeps a failed promotion queued and drains it once after settle", async () => {
    const h = harness();
    const selected = h.hold("failure");
    const append = vi.spyOn(h.store, "appendMessage").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    await expect(h.post(selected)).rejects.toThrow("disk unavailable");
    append.mockRestore();
    h.bot.busy = false;
    h.drain();
    h.drain();
    expect(h.drainRun).toHaveBeenCalledTimes(1);
    expect(h.messages).toMatchObject([{ text: "failure", sendId: selected.sendId }]);
  });
});
