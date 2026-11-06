import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import { hasPeerWatch, watchPeerTurn } from "./peer-takeover.ts";
import { _resetPeerUserReplies, beginPeerUserReply, cancelPeerUserReplies, drainPeerUserReplies, foldPeerQueuedSends, peerUserRuntime, persistPeerUserReply, settlePeerUserReplies } from "./peer-user-reply.ts";
import { _resetSteerQueue, drainSteeredMessages, queueMark, queueSteeredMessage } from "./steer-queue.ts";
import { Store, type BotRecord } from "./store.ts";

describe("peer user replies", () => {
  let store: Store;
  let bot: BotRecord;
  let end: () => void;

  beforeEach(() => {
    _resetPeerUserReplies();
    _resetSteerQueue();
    store = new Store(() => ({ instanceId: "fake", model: "fake" }));
    bot = store.createBot();
    end = watchPeerTurn(bot.threadId);
  });
  afterEach(() => { end(); _resetPeerUserReplies(); _resetSteerQueue(); vi.useRealTimers(); vi.restoreAllMocks(); });

  const event = (patch: Record<string, unknown>): RuntimeEvent => ({
    provider: "claude", eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), threadId: bot.threadId, turnId: "t1", ...patch,
  } as RuntimeEvent);
  const text = (body: string, extra: Record<string, unknown> = {}) => event({ type: "item.completed", itemType: "assistant_text", text: body, ...extra });
  const texts = () => store.messagesFor(bot.threadId).filter((message) => message.kind === "text");
  function user(body = "어느 브랜치인가요?") {
    peerUserRuntime(event({ type: "turn.started" }));
    const input = beginPeerUserReply(bot.id, bot.threadId, body)!;
    const message = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: body, steered: true });
    input.accept(message);
    const tag = input.prompt.match(/<user\d+>/)![0];
    return { input, message, mark: (reply: string) => `${tag}${reply}${tag.replace("<", "</")}` };
  }

  it("strips the user's marker from live and stored text, keeping the pane-note hold", () => {
    const input = user();
    const reply = text(`${input.mark("main 브랜치입니다.")}\nThe peer answer.`);
    expect(peerUserRuntime(reply)).toMatchObject({ text: "main 브랜치입니다.", phase: undefined });
    expect(persistPeerUserReply(store, reply)).toBe(true);
    persistPeerUserReply(store, reply);
    expect(texts().filter((message) => message.role === "bot")).toMatchObject([{ text: "main 브랜치입니다." }]);
    expect(hasPeerWatch(bot.threadId)).toBe(true);
    settlePeerUserReplies(bot.threadId, "t1");
    const start = vi.fn(async () => {});
    drainPeerUserReplies(store, start, () => false);
    expect(start).not.toHaveBeenCalled();
  });

  it("withholds partial markers and peer text from the streaming chat", () => {
    user();
    for (const delta of ["<us", "er1>네", "</user1>", "The peer answer."]) {
      expect(peerUserRuntime(event({ type: "content.delta", streamKind: "assistant_text", delta }))).toBeNull();
    }
    expect(peerUserRuntime(text("The peer answer."))).toMatchObject({ text: "" });
  });

  it("starts one ordinary follow-up using the unanswered user's original row", () => {
    const input = user();
    persistPeerUserReply(store, text("The peer answer."));
    const start = vi.fn(async () => {});
    drainPeerUserReplies(store, start, () => false);
    expect(start).not.toHaveBeenCalled();
    settlePeerUserReplies(bot.threadId, "t1");
    drainPeerUserReplies(store, start, () => false);
    drainPeerUserReplies(store, start, () => false);
    expect(start).toHaveBeenCalledExactlyOnceWith(bot.id, input.message.text, { threadId: bot.threadId, userMessage: input.message, excludeMessageIds: [input.message.id] });
    expect(texts().filter((message) => message.role === "user")).toEqual([input.message]);
  });

  it("follows the user message when peer setup ends without a completion event", () => {
    const input = user();
    end();
    const start = vi.fn(async () => {});
    drainPeerUserReplies(store, start, () => false);
    expect(start).toHaveBeenCalledExactlyOnceWith(bot.id, input.message.text, expect.objectContaining({ userMessage: input.message }));
  });

  it.each(["", " ", "<user1>요약</user1>"])("does not count blank or summarized output as a user reply: %s", (body) => {
    user();
    persistPeerUserReply(store, text(body, { summarized: true }));
    settlePeerUserReplies(bot.threadId, "t1");
    const start = vi.fn(async () => {});
    drainPeerUserReplies(store, start, () => false);
    expect(start).toHaveBeenCalledOnce();
    expect(texts().filter((message) => message.role === "bot")).toEqual([]);
  });

  it("follows only the unanswered message when several user messages join", () => {
    const first = user("First question?");
    const second = user("Second question?");
    persistPeerUserReply(store, text(second.mark("Second answer.")));
    settlePeerUserReplies(bot.threadId, "t1");
    const start = vi.fn(async () => {});
    drainPeerUserReplies(store, start, () => false);
    expect(start).toHaveBeenCalledExactlyOnceWith(bot.id, first.message.text, expect.objectContaining({ userMessage: first.message }));
  });

  it("ignores stale text and completion when deciding whether a user was answered", () => {
    const input = user();
    expect(persistPeerUserReply(store, text(input.mark("Old answer."), { turnId: "old" }))).toBe(false);
    settlePeerUserReplies(bot.threadId, "old");
    const start = vi.fn(async () => {});
    drainPeerUserReplies(store, start, () => false);
    expect(start).not.toHaveBeenCalled();
    settlePeerUserReplies(bot.threadId, "t1");
    drainPeerUserReplies(store, start, () => false);
    expect(start).toHaveBeenCalledOnce();
  });

  it("reports a terminal follow-up dispatch error without waiting for another drain", async () => {
    user();
    settlePeerUserReplies(bot.threadId, "t1");
    const start = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    drainPeerUserReplies(store, start, () => false);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(store.messagesFor(bot.threadId).filter((message) => message.kind === "activity")).toMatchObject([
      { tool: { name: "error: queued message could not start - provider unavailable", ok: false } },
    ]);
    drainPeerUserReplies(store, start, () => false);
    expect(start).toHaveBeenCalledOnce();
    expect(texts()).toHaveLength(1);
  });

  it("retries a busy follow-up without another drain or duplicate user row", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = user();
    settlePeerUserReplies(bot.threadId, "t1");
    const start = vi.fn().mockRejectedValueOnce(new Error("the bot is still stopping its last turn")).mockResolvedValue(undefined);
    drainPeerUserReplies(store, start, () => false);
    await Promise.resolve();
    drainPeerUserReplies(store, start, () => false);
    expect(start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]![2].userMessage).toEqual(input.message);
    expect(texts()).toEqual([input.message]);
  });

  it("does not retry a busy follow-up after Stop", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    user();
    settlePeerUserReplies(bot.threadId, "t1");
    const start = vi.fn().mockRejectedValue(new Error("the bot is still stopping its last turn"));
    drainPeerUserReplies(store, start, () => false);
    await Promise.resolve();
    cancelPeerUserReplies(bot.id);
    await vi.advanceTimersByTimeAsync(500);
    settlePeerUserReplies(bot.threadId, "t1");
    drainPeerUserReplies(store, start, () => false);
    expect(start).toHaveBeenCalledOnce();
    expect(store.messagesFor(bot.threadId).filter((message) => message.kind === "activity")).toEqual([]);
  });

  it("starts the next unanswered message after a terminal dispatch error", async () => {
    user("First question");
    const second = user("Second question");
    settlePeerUserReplies(bot.threadId, "t1");
    const start = vi.fn().mockRejectedValueOnce(new Error("provider unavailable")).mockResolvedValue(undefined);
    drainPeerUserReplies(store, start, () => false);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]![2].userMessage).toEqual(second.message);
  });

  it("marks preparation-folded user input and retains its own identity", () => {
    const since = queueMark();
    queueSteeredMessage(bot.id, bot.threadId, "User question");
    const prompts = foldPeerQueuedSends(store, bot.id, bot.threadId, since, true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("<user1>");
    expect(texts()).toMatchObject([{ role: "user", text: "User question", steered: true }]);
    expect(texts()[0]!.from).toBeUndefined();
  });

  it("leaves input for a non-steering engine queued until the peer turn ends", () => {
    const since = queueMark();
    queueSteeredMessage(bot.id, bot.threadId, "User question");
    store.patchBot(bot.id, { busy: true });
    expect(foldPeerQueuedSends(store, bot.id, bot.threadId, since, false)).toEqual([]);
    expect(texts()).toEqual([]);
    const start = vi.fn();
    drainSteeredMessages(store, start);
    expect(start).not.toHaveBeenCalled();
    end();
    store.patchBot(bot.id, { busy: false });
    drainSteeredMessages(store, start);
    drainSteeredMessages(store, start);
    expect(start).toHaveBeenCalledOnce();
    expect(texts()).toMatchObject([{ role: "user", text: "User question" }]);
  });

  it("preserves normal user runtime text and preparation folding", () => {
    end();
    const literal = text("<user1>Example markup</user1>");
    expect(peerUserRuntime(literal)).toBe(literal);
    expect(persistPeerUserReply(store, literal)).toBe(false);
    const since = queueMark();
    queueSteeredMessage(bot.id, bot.threadId, "Normal user question");
    expect(foldPeerQueuedSends(store, bot.id, bot.threadId, since, false)).toEqual(["Normal user question"]);
  });
});
