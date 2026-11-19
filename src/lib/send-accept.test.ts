import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import { nextTurnSignals, type TurnSignals } from "./turn-stage";
import {
  acceptedSendPaint,
  composerIsBusy,
  dropIdleAcceptedThinking,
  forgetAcceptedSend,
  inSendOrder,
  receiptRejectsAcceptedSend,
  rememberAcceptedSend,
  sendClock,
  settleAcceptedSend,
  shouldDropQueueChip,
  splitQueuedSends,
  turnPresenceWaiting,
  withAcceptedMessages,
} from "./send-accept";

const here = dirname(fileURLToPath(import.meta.url));
const chatView = readFileSync(join(here, "../components/ChatView.tsx"), "utf8");
const groupView = readFileSync(join(here, "../components/GroupView.tsx"), "utf8");
const composer = readFileSync(join(here, "../components/Composer.tsx"), "utf8");

const settledReply: Message = { id: "a1", role: "bot", kind: "text", text: "done", at: 1 };

describe("withAcceptedMessages", () => {
  it("hands back the same list without scanning it when no send is waiting", () => {
    const list = [settledReply];
    const scan = vi.spyOn(list, "flatMap");
    expect(withAcceptedMessages(list)).toBe(list);
    expect(withAcceptedMessages(list, [], [])).toBe(list);
    expect(scan).not.toHaveBeenCalled();
  });

  it("carries the reply a waiting send answers", () => {
    const [, held] = withAcceptedMessages([settledReply], [{ sendId: "s1", kind: "thinking", text: "yes", replyToId: "a1" }]);
    expect(held.replyToId).toBe("a1");
    const [, queued] = withAcceptedMessages([settledReply], [], [{ queueId: "q1", text: "yes", replyToId: "a1" }]);
    expect(queued.replyToId).toBe("a1");
  });

  it("paints a busy send before its POST completes and replaces it once confirmed", () => {
    const accepted = [{ sendId: "s1", kind: "sends-next" as const, text: "extra" }];
    const pending = withAcceptedMessages([settledReply], accepted);
    expect(pending).toHaveLength(2);
    expect(pending[1]).toMatchObject({ id: "s1", role: "user", text: "extra", placeholder: true });
    expect(pending[1].queued).toBeUndefined();
    const confirmed: Message = { id: "canonical", sendId: "s1", role: "user", kind: "text", text: "extra", at: 2 };
    expect(withAcceptedMessages([settledReply, confirmed], accepted)).toEqual([settledReply, confirmed]);
    const queued = [{ queueId: "s1", text: "extra" }];
    expect(withAcceptedMessages([settledReply], accepted, queued)).toHaveLength(2);
    expect(withAcceptedMessages([settledReply], [], queued)[1]).toMatchObject({ role: "user", text: "extra" });
    expect(withAcceptedMessages([settledReply, confirmed], [], queued)).toEqual([settledReply, confirmed]);
    expect(withAcceptedMessages([settledReply], [])).toEqual([settledReply]);
  });

  it("keeps the accepted time on every repaint", () => {
    const accepted = [{ sendId: "s1", kind: "sends-next" as const, text: "extra", at: 42 }];
    expect(withAcceptedMessages([settledReply], accepted).at(-1)?.at).toBe(42);
    expect(withAcceptedMessages([{ ...settledReply, at: 99 }], accepted).at(-1)?.at).toBe(42);
    expect(withAcceptedMessages([settledReply], [], [{ queueId: "q1", text: "extra", at: 42 }]).at(-1)?.at).toBe(42);
  });
});

describe("splitQueuedSends", () => {
  it("moves waiting sends out of the list and keeps a starting send in it", () => {
    const accepted = [
      { sendId: "t1", kind: "thinking" as const, text: "first" },
      { sendId: "s1", kind: "sends-next" as const, text: "next" },
    ];
    const messages = withAcceptedMessages([settledReply], accepted, [{ queueId: "q1", text: "queued" }]);
    const { listed, queued } = splitQueuedSends(messages, accepted, [{ queueId: "q1" }]);
    expect(listed.map((message) => message.id)).toEqual(["a1", "t1"]);
    expect(queued.map((message) => message.id)).toEqual(["q1", "s1"]);
  });

  it("keeps a steering engine's accepted send in the list but moves its queue entry that waits for the turn", () => {
    const accepted = [{ sendId: "s1", kind: "sends-next" as const, text: "steer" }];
    const messages = withAcceptedMessages([settledReply], accepted, [{ queueId: "q1", text: "queued" }]);
    const { listed, queued } = splitQueuedSends(messages, accepted, [{ queueId: "q1", waited: true }], true);
    expect(listed.map((message) => message.id)).toEqual(["a1", "s1"]);
    expect(queued.map((message) => message.id)).toEqual(["q1"]);
  });

  it("keeps a plain send the server held for a steering engine where it was sent", () => {
    const messages = withAcceptedMessages([settledReply], [], [{ queueId: "q1", text: "plain" }, { queueId: "q2", text: "synced" }]);
    const { listed, queued } = splitQueuedSends(messages, [], [{ queueId: "q1" }, { queueId: "q2", reason: "sync" }], true);
    expect(listed.map((message) => message.id)).toEqual(["a1", "q1"]);
    expect(queued.map((message) => message.id)).toEqual(["q2"]);
  });

  it("moves a steering engine's after-this-turn send out of the list", () => {
    const accepted = [
      { sendId: "s1", kind: "sends-next" as const, text: "steer" },
      { sendId: "s2", kind: "sends-next" as const, text: "later", after: true },
    ];
    const messages = withAcceptedMessages([settledReply], accepted);
    const { listed, queued } = splitQueuedSends(messages, accepted, [], true);
    expect(listed.map((message) => message.id)).toEqual(["a1", "s1"]);
    expect(queued.map((message) => message.id)).toEqual(["s2"]);
  });

  it("never moves a canonical message", () => {
    const landed: Message = { id: "q1", role: "user", kind: "text", text: "queued", at: 2 };
    const messages = [settledReply, landed];
    expect(splitQueuedSends(messages, [], [{ queueId: "q1" }])).toEqual({ listed: messages, queued: [] });
  });
});

describe("inSendOrder", () => {
  const row = (id: string, at: number, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at, ...extra });
  const line = (id: string, sent: number, at: number, extra: Partial<Message> = {}) => row(id, at, { role: "user", sendId: `send-${id}`, actedAt: sent, ...extra });
  const ids = (messages: Message[]) => messages.map((message) => message.id);

  it("draws a landed line where it was sent, above what landed after it", () => {
    // recorded timings: the line sent at 26.694 was appended at 28.366, after the reply (28.023) and a quick answer (28.339)
    const messages = [line("weird", 24_509, 25_485), row("quick-0", 25_906), row("reply", 28_023), row("quick-1", 28_339), line("mine", 26_694, 28_366), row("quick-2", 28_979)];
    expect(ids(inSendOrder(messages))).toEqual(["weird", "quick-0", "mine", "reply", "quick-1", "quick-2"]);
  });

  it("draws a line still on its way where it was sent", () => {
    const sending: Message = { ...line("s1", 0, 2_000), actedAt: undefined, placeholder: true };
    expect(ids(inSendOrder([row("a", 1_000), row("b", 3_000), sending]))).toEqual(["a", "s1", "b"]);
  });

  it("leaves a line that waited for the turn, and rows with no send time, where they landed", () => {
    const messages = [row("a", 1_000), row("reply", 3_000), line("after", 2_000, 4_000, { waited: true }), row("peer", 5_000, { role: "user" }), line("old", 0, 6_000, { actedAt: undefined })];
    expect(inSendOrder(messages)).toBe(messages);
  });

  it("draws a line above a row stamped in its millisecond, and two sends in the order sent", () => {
    const sending: Message = { ...line("s1", 0, 2_000), actedAt: undefined, placeholder: true };
    expect(ids(inSendOrder([row("a", 1_000), row("reply", 2_000), sending]))).toEqual(["a", "s1", "reply"]);
    expect(ids(inSendOrder([row("a", 1_000), row("reply", 2_000), line("mine", 2_000, 2_500)]))).toEqual(["a", "mine", "reply"]);
    const pair = [line("first", 2_000, 2_100), line("second", 2_000, 2_200)];
    expect(inSendOrder(pair)).toBe(pair);
  });

  it("hands back a heavy chat untouched when every line is in place", () => {
    const messages = Array.from({ length: 5_000 }, (_, i) => i % 2 ? row(`r${i}`, i * 10) : line(`u${i}`, i * 10 - 5, i * 10));
    expect(inSendOrder(messages)).toBe(messages);
    expect(ids(inSendOrder([...messages, row("reply", 50_010), line("mine", 50_005, 50_020)])).slice(-3)).toEqual(["r4999", "mine", "reply"]);
  });
});

describe("sendClock", () => {
  it("never stamps a send older than the newest row on screen", () => {
    expect(sendClock([{ at: 5_000 }], 4_000)).toBe(5_001);
    expect(sendClock([{ at: 3_000 }], 4_000)).toBe(4_000);
    expect(sendClock([], 4_000)).toBe(4_000);
  });
});

describe("acceptedSendPaint", () => {
  it("starts Thinking on an idle send and Sends-next on a busy follow-up", () => {
    expect(acceptedSendPaint({ alreadyBusy: false })).toEqual({ kind: "thinking" });
    expect(acceptedSendPaint({ alreadyBusy: true })).toEqual({ kind: "sends-next" });
  });
});

describe("turnPresenceWaiting", () => {
  it("stays visible from an automatic dispatch through intermediate replies until completion", () => {
    let signals: TurnSignals = {};
    for (const event of ["dispatched", "started", "settled-message", "retrying", "settled-message"] as const) {
      signals = nextTurnSignals(signals, "t1", event);
      expect(turnPresenceWaiting({ busy: true, turnActive: signals.t1 !== undefined, lastMessage: settledReply }), event).toBe(true);
    }
    signals = nextTurnSignals(signals, "t1", "completed");
    expect(turnPresenceWaiting({ busy: true, turnActive: signals.t1 !== undefined, lastMessage: settledReply })).toBe(false);
  });

  it("does not show work for an idle bot or an approval wait with a retained signal", () => {
    expect(turnPresenceWaiting({ busy: false, turnActive: true, lastMessage: settledReply })).toBe(false);
    expect(turnPresenceWaiting({ busy: true, turnActive: true, activity: "waiting-on-you", lastMessage: settledReply })).toBe(false);
  });

  it("shows Thinking in the same tick as an accepted idle send, even under a settled reply", () => {
    expect(
      turnPresenceWaiting({
        busy: false,
        lastMessage: settledReply,
        accepted: [{ sendId: "s1", kind: "thinking", text: "next" }],
      }),
    ).toBe(true);
  });

  it("keeps end-of-stream jitter hidden when nothing new was accepted", () => {
    expect(turnPresenceWaiting({ busy: true, lastMessage: settledReply })).toBe(false);
  });

  it("does not paint Thinking for a queued follow-up", () => {
    expect(
      turnPresenceWaiting({
        busy: true,
        lastMessage: settledReply,
        accepted: [{ sendId: "s2", kind: "sends-next", text: "later" }],
      }),
    ).toBe(false);
  });
});

describe("composerIsBusy", () => {
  it("treats an accepted start-turn as busy before the server echoes it", () => {
    expect(composerIsBusy(false, [{ sendId: "s1", kind: "thinking", text: "hi" }])).toBe(true);
    expect(composerIsBusy(false, [{ sendId: "s2", kind: "sends-next", text: "later" }])).toBe(false);
    expect(composerIsBusy(true, [])).toBe(true);
  });
});

describe("accepted send bookkeeping", () => {
  it("remembers and forgets by sendId without clobbering another thread", () => {
    const first = rememberAcceptedSend({}, "t1", { sendId: "s1", kind: "thinking", text: "hi" });
    const both = rememberAcceptedSend(first, "t2", { sendId: "s2", kind: "sends-next", text: "later" });
    expect(forgetAcceptedSend(both, "t1", "s1")).toEqual({
      t2: [{ sendId: "s2", kind: "sends-next", text: "later" }],
    });
  });

  it("drops Thinking on an idle snapshot thread and keeps Sends-next", () => {
    const accepted = rememberAcceptedSend(
      rememberAcceptedSend({}, "t1", { sendId: "think", kind: "thinking", text: "hi" }),
      "t1",
      { sendId: "queue", kind: "sends-next", text: "later" },
    );
    expect(dropIdleAcceptedThinking(accepted, [{ threadId: "t1", busy: false }]).t1).toEqual([
      { sendId: "queue", kind: "sends-next", text: "later" },
    ]);
    expect(dropIdleAcceptedThinking(accepted, [{ threadId: "t1", busy: true }])).toBe(accepted);
  });

  it("rejects an accepted send when the POST receipt says dispatch failed", () => {
    expect(receiptRejectsAcceptedSend({ dispatchFailed: true })).toBe(true);
    expect(receiptRejectsAcceptedSend({ dispatchFailed: true, queued: true })).toBe(true);
    expect(receiptRejectsAcceptedSend({ cancelled: true })).toBe(true);
    expect(receiptRejectsAcceptedSend({ ok: true })).toBe(false);
    expect(receiptRejectsAcceptedSend({ queued: true, queueId: "q1" })).toBe(false);
    expect(receiptRejectsAcceptedSend(null)).toBe(false);
  });

  it("lets POST settle only a Sends-next chip, not Thinking", () => {
    const accepted = rememberAcceptedSend(
      rememberAcceptedSend({}, "t1", { sendId: "think", kind: "thinking", text: "hi" }),
      "t1",
      { sendId: "queue", kind: "sends-next", text: "later" },
    );
    const settled = settleAcceptedSend(accepted, "t1", "think");
    expect(settled.t1?.map((entry) => entry.sendId)).toEqual(["think", "queue"]);
    expect(settleAcceptedSend(settled, "t1", "queue").t1).toEqual([
      { sendId: "think", kind: "thinking", text: "hi" },
    ]);
  });
});

describe("queue cancel chrome", () => {
  it("does not drop a chip while the server says that send is already running", () => {
    expect(shouldDropQueueChip({ cancelled: false, running: true })).toBe(false);
    expect(shouldDropQueueChip({ cancelled: true })).toBe(true);
    expect(shouldDropQueueChip({ cancelled: false, running: false })).toBe(false);
  });
});

describe("send-accept wiring", () => {
  it("paints Thinking and Sends-next from accepted-send helpers, not POST wait", () => {
    expect(chatView).toContain("turnPresenceWaiting");
    expect(groupView).toContain("turnPresenceWaiting");
    expect(composer).toContain("composerIsBusy");
    expect(chatView).toContain("withAcceptedMessages");
  });

  it("clears optimistic Thinking from a dispatch-failed receipt, not hydrate", () => {
    const store = readFileSync(join(here, "../state/store.tsx"), "utf8");
    expect(store).toContain("receiptRejectsAcceptedSend");
    expect(store).toContain("shouldDropQueueChip");
  });
});
