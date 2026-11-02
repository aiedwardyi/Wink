import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { clearDelegationWakeBudget } from "./comms-budget.ts";
import { handMail, hasUnreadReplyWake, mailForTurn, mailReplayText, markMailRead, markPaneMailRead, registerReplyWake, settleMail, toolMailResult, unreadMail, claimReplyWake } from "./mail.ts";
import { PaneWakeScheduler } from "./pane-wake.ts";
import { Store } from "./store.ts";

let store: Store;
let bot: ReturnType<Store["createBot"]>;
beforeEach(() => {
  store = new Store(() => ({ instanceId: "claude", model: "fake" }));
  bot = store.createBot();
});
afterEach(() => vi.useRealTimers());

function reply(text: string, taskId = "task", threadId = bot.threadId) {
  return store.appendMessage(threadId, { role: "bot", kind: "activity", text, comm: { groupId: "dm", withBotId: "peer", withName: "Peer", withColor: "blue", peer: "reply", taskId, mailKey: `${taskId}:reply:${threadId}`, state: "done" } });
}

it("keeps unread replies across user boundaries and duplicate publication", () => {
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "u0" });
  const first = reply("r1", "one");
  const second = reply("r2", "two");
  markMailRead(store, bot.threadId, [{ id: first.id, upto: 2 }], "turn");
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "u1" });
  expect(reply("r2", "two").id).toBe(second.id);
  expect(mailForTurn(store, bot.threadId).map((part) => part.id)).toEqual([second.id]);
  const reopened = new Store(() => ({ instanceId: "claude", model: "fake" }));
  expect(unreadMail(reopened, bot.threadId).map((row) => row.id)).toEqual([second.id]);
});

it("delivers a long reply whole over bounded, word-aligned folds", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}: the tests passed with no missing results`).join("\n");
  const row = reply(text);
  let upto = 0;
  for (let i = 0; i < 20 && upto < text.length; i++) {
    const parts = mailForTurn(store, bot.threadId, [], 1000);
    expect(parts).toHaveLength(1);
    const part = parts[0];
    expect(part.upto).toBeGreaterThan(upto);
    expect(part.text).toContain(text.slice(upto, part.upto));
    if (part.upto < text.length) expect(/[\s]/.test(text[part.upto - 1])).toBe(true);
    expect(Math.ceil(Buffer.byteLength(part.text, "utf8") / 3) + 6).toBeLessThanOrEqual(325);
    markMailRead(store, bot.threadId, parts, `turn-${i}`);
    upto = part.upto;
  }
  expect(upto).toBe(text.length);
  expect(unreadMail(store, bot.threadId)).toEqual([]);
  expect(mailReplayText(store.messagesFor(bot.threadId).find((m) => m.id === row.id)!)).toContain(text);
});

it.each([[false, undefined], [true, "cancelled"], [true, "interrupted"]])("reverts a handover after ok=%s, stop=%s", (ok, reason) => {
  reply("unread");
  handMail(store, bot.threadId, "task", "turn", "request");
  expect(mailForTurn(store, bot.threadId)).toEqual([]);
  settleMail(store, bot.threadId, "turn", ok, reason);
  expect(mailForTurn(store, bot.threadId)[0].text).toContain("unread");
});

it("commits a tool handover only in the caller's session on clean settle", () => {
  reply("mine");
  const other = store.createTask(bot.id, "other", false)!;
  reply("other", "task", other.threadId);
  handMail(store, bot.threadId, "task", "turn", "request");
  settleMail(store, bot.threadId, "turn", true);
  expect(unreadMail(store, bot.threadId)).toEqual([]);
  expect(unreadMail(store, other.threadId)).toHaveLength(1);
});

it("excludes a consumed pane question from the mail fold", () => {
  const row = reply("Which branch?");
  markPaneMailRead(store, bot.threadId, [row.id], "turn", "steer");
  expect(mailForTurn(store, bot.threadId)).toEqual([]);
});

it("skips legacy rows and does not mark a fold before dispatch accepts it", () => {
  store.appendMessage(bot.threadId, { role: "bot", kind: "activity", text: "legacy", comm: { groupId: "dm", withBotId: "b", withName: "B", withColor: "blue", peer: "reply" } });
  const row = reply("new reply");
  mailForTurn(store, bot.threadId);
  expect(unreadMail(store, bot.threadId).map((r) => r.id)).toEqual([row.id]);
  expect(mailReplayText(row)).toBeNull();
});

it("rearms a failed handover only when that reply already qualified for a wake", () => {
  const row = reply("passive reply");
  handMail(store, bot.threadId, "task", "busy", "request");
  expect(settleMail(store, bot.threadId, "busy", false)).toBe(false);
  expect(hasUnreadReplyWake(store, bot.threadId)).toBe(false);
  registerReplyWake(row);
  handMail(store, bot.threadId, "task", "pull", "request");
  expect(settleMail(store, bot.threadId, "pull", false)).toBe(true);
  expect(hasUnreadReplyWake(store, bot.threadId)).toBe(true);
});

it("keeps the unreturned tail of a clipped tool result unread", () => {
  const text = "report line\n".repeat(1800);
  reply(text);
  const result = `${text.slice(0, 16000)}\n\n[reply cut]`;
  expect(toolMailResult(store, bot.threadId, "task", result, { turnId: "turn", requestId: "request" })).toBe(result);
  settleMail(store, bot.threadId, "turn", true);
  expect(unreadMail(store, bot.threadId)[0].comm?.read?.upto).toBe(16000);
  expect(mailForTurn(store, bot.threadId)[0].text).toContain(text.slice(16000));
});

it("debounces reply bursts and caps five successive reply wakes at four", async () => {
  vi.useFakeTimers();
  clearDelegationWakeBudget(bot.threadId);
  const wake = vi.fn(() => {
    if (!claimReplyWake(store, bot.threadId)) return;
    markMailRead(store, bot.threadId, mailForTurn(store, bot.threadId), "wake");
  });
  const paid = vi.fn();
  const scheduler = new PaneWakeScheduler({ enabled: () => true, busy: () => false, hasNotes: () => unreadMail(store, bot.threadId).length > 0, wake: () => { const count = unreadMail(store, bot.threadId).length; wake(); if (count && !unreadMail(store, bot.threadId).length) paid(); }, warn: () => {} });
  for (let i = 0; i < 5; i++) {
    registerReplyWake(reply(`reply ${i}`, String(i)));
    scheduler.noteArrived(bot.id, bot.threadId);
    scheduler.noteArrived(bot.id, bot.threadId);
    await vi.advanceTimersByTimeAsync(3000);
  }
  expect(paid).toHaveBeenCalledTimes(4);
  expect(unreadMail(store, bot.threadId)).toHaveLength(1);
});
