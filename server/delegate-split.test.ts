import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForPeerReply } from "./ask-bot.ts";
import { getOrCreateChannel } from "./comms-visibility.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { _resetPending, finishDelegatedTurn } from "./delegations.ts";
import { EventBus } from "./harness/bus.ts";
import { peerTurnReplies } from "./peer-turn-reply.ts";
import { _resetSteerQueue, drainSteeredMessages, queueSteeredMessage } from "./steer-queue.ts";
import { Store } from "./store.ts";
import { ownTurnReply } from "./turn-reply.ts";

afterEach(() => { _resetPending(); _resetSteerQueue(); });

describe("the first peer answer after a mid-turn user message", () => {
  it.each([
    ["ask", true], ["delegation", true], ["ask", false], ["delegation", false],
  ] as const)("keeps the user's short line out of the %s result (mid-turn input: %s)", async (kind, midturn) => {
    const store = new Store(() => ({ instanceId: "fake", model: "fake" }));
    const sender = store.createBot();
    const target = store.createBot();
    const channel = getOrCreateChannel(store, sender, target);
    const bus = new EventBus(() => {});
    const replies = peerTurnReplies(() => false);
    const collected = replies.start(target.threadId);
    bus.subscribe(replies.observe);
    const asked = kind === "ask" ? waitForPeerReply({
      threadId: target.threadId, botName: target.name, userName: () => "Edward",
      subscribe: (listener) => bus.subscribe(listener), fold: ownTurnReply(() => false).fold,
      start: async () => {}, adopt: () => undefined, fail: () => {},
    }) : undefined;
    const emit = (patch: Record<string, unknown>) => bus.publish({
      provider: "claude", eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), threadId: target.threadId, turnId: "peer-turn", ...patch,
    } as RuntimeEvent);
    emit({ type: "turn.started" });
    store.patchBot(target.id, { busy: true });
    const ownTurn = vi.fn(() => {
      expect(store.messagesFor(sender.threadId).some((message) => message.comm?.peer === "reply")).toBe(true);
      store.appendMessage(target.threadId, { role: "bot", kind: "text", text: "main 브랜치입니다." });
    });
    if (midturn) {
      store.appendMessage(target.threadId, { role: "user", kind: "text", text: "어느 브랜치인가요?", steered: true });
      emit({ type: "item.completed", itemType: "assistant_text", text: "<user1>main 브랜치입니다.</user1>" });
    } else {
      queueSteeredMessage(target.id, target.threadId, "어느 브랜치인가요?");
      drainSteeredMessages(store, ownTurn);
      expect(ownTurn).not.toHaveBeenCalled();
    }
    emit({ type: "item.completed", itemType: "assistant_text", text: "The requested work is finished." });
    emit({ type: "turn.completed", ok: true });
    const answer = asked ? (await asked).text : collected.text();
    expect(answer).toBe("The requested work is finished.");
    const turn = { taskId: "split-task", toBotId: target.id, sourceThreadId: sender.threadId, sourceBotId: sender.id, channelId: channel.id, ...(kind === "ask" ? { ask: true as const, inline: true as const } : {}) };
    finishDelegatedTurn({ store, broadcast: () => {} }, turn, true, answer);
    finishDelegatedTurn({ store, broadcast: () => {} }, turn, true, answer);
    for (const threadId of [sender.threadId, channel.threadId]) {
      expect(store.messagesFor(threadId).filter((message) => message.comm?.peer === "reply").map((message) => message.text)).toEqual([answer]);
    }
    if (!midturn) {
      store.patchBot(target.id, { busy: false });
      drainSteeredMessages(store, ownTurn);
      drainSteeredMessages(store, ownTurn);
      expect(ownTurn).toHaveBeenCalledOnce();
      expect(store.messagesFor(target.threadId).filter((message) => message.kind === "text").map((message) => message.text)).toEqual(["어느 브랜치인가요?", "main 브랜치입니다."]);
    }
  });
});
