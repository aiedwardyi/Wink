import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { AskHold } from "./ask-hold.ts";
import { askUserRequestSchema, postAskUser, type AskUserDeps } from "./ask-user.ts";
import { Store, type BotRecord } from "./store.ts";
import { scanQuestion } from "../shared/open-question.ts";

function harness() {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const bot = store.createBot({ name: "Ada" });
  const hold = new AskHold(() => Boolean(store.bot(bot.id)?.busy));
  const notifyQuestion = vi.fn();
  const patchMessage = vi.fn(store.patchMessage.bind(store));
  const deps: AskUserDeps<BotRecord> = {
    bot: (id) => store.bot(id),
    conversation: (botId, threadId) => store.conversationForBot(botId, threadId),
    appendMessage: (threadId, message) => store.appendMessage(threadId, message),
    activePath: (threadId) => store.activePath(threadId),
    patchMessage,
    cancelHeld: (botId, threadId, question) => hold.cancel(botId, threadId, question),
    alertThread: (_bot, threadId) => threadId,
    notifyQuestion,
    whenSettled: (botId, threadId, post, question) => hold.whenSettled(botId, threadId, post, question),
  };
  const ask = (question: string, close = false, threadId = bot.threadId) => postAskUser(deps,
    askUserRequestSchema.parse({ fromBotId: bot.id, fromThreadId: threadId, question, choices: ["Yes", "No"], close }));
  return { store, bot, hold, ask, notifyQuestion, patchMessage };
}

describe("close question", () => {
  it("removes the open card after a typed answer through the persisted card patch", () => {
    const h = harness();
    h.ask("Ship it?");
    h.store.appendMessage(h.bot.threadId, { role: "user", kind: "text", text: "Use staging first." });
    expect(scanQuestion(h.store.activePath(h.bot.threadId))).not.toBeNull();
    expect(h.ask("Ship it?", true)).toEqual({ status: 200, body: { closed: true } });
    expect(scanQuestion(h.store.activePath(h.bot.threadId))).toBeNull();
    expect(h.patchMessage).toHaveBeenCalledWith(h.bot.threadId, expect.any(String), {
      card: expect.objectContaining({ answered: "Answered in chat" }),
    });
    expect(h.notifyQuestion).toHaveBeenCalledTimes(1);
  });

  it.each([{ answered: "Yes" }, { dismissed: true }])("leaves a settled card unchanged: %j", (patch) => {
    const h = harness();
    h.ask("Ship it?");
    const card = h.store.activePath(h.bot.threadId).at(-1)!;
    h.store.patchMessage(h.bot.threadId, card.id, { card: { ...card.card!, ...patch } });
    const before = h.store.activePath(h.bot.threadId);
    expect(h.ask("Ship it?", true)).toEqual({ status: 200, body: { closed: false } });
    expect(h.patchMessage).not.toHaveBeenCalled();
    expect(h.store.activePath(h.bot.threadId)).toEqual(before);
  });

  it("closes once and leaves other questions open", () => {
    const h = harness();
    h.ask("Ship it?");
    h.ask("Which region?");
    expect(h.ask(" Ship it? ", true)).toMatchObject({ body: { closed: true } });
    expect(h.ask("Ship it?", true)).toMatchObject({ body: { closed: false } });
    expect(scanQuestion(h.store.activePath(h.bot.threadId))?.card?.subtitle).toBe("Which region?");
    expect(h.patchMessage).toHaveBeenCalledTimes(1);
  });

  it("cancels only the matching held question before it can post or alert", () => {
    const h = harness();
    h.store.setActivity(h.bot.id, "working", h.bot.threadId);
    h.ask("Ship it?");
    h.ask("Which region?");
    expect(h.ask("Ship it?", true)).toMatchObject({ body: { closed: true } });
    h.hold.flush();
    expect(h.store.activePath(h.bot.threadId).filter((m) => m.card?.askUser).map((m) => m.card?.subtitle)).toEqual(["Which region?"]);
    expect(h.notifyQuestion).toHaveBeenCalledTimes(1);
  });

  it("closes only its own room card and refuses a foreign thread", () => {
    const h = harness();
    const peer = h.store.createBot({ name: "Grace" });
    const room = h.store.createGroup("Review", [h.bot.id, peer.id]);
    h.ask("Ship it?", false, room.threadId);
    h.store.appendMessage(room.threadId, { role: "bot", kind: "options", from: { botId: peer.id, name: peer.name, color: peer.color },
      card: { title: "Question", subtitle: "Ship it?", options: ["Yes"], askUser: true, staysOpen: true } });
    expect(h.ask("Ship it?", true, room.threadId)).toMatchObject({ body: { closed: true } });
    expect(scanQuestion(h.store.activePath(room.threadId))?.from?.botId).toBe(peer.id);
    expect(h.ask("Ship it?", true, peer.threadId)).toMatchObject({ status: 403 });
  });

  it("never closes a native approval or creates a question when nothing matches", () => {
    const h = harness();
    h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "options",
      card: { title: "Approval", subtitle: "Ship it?", options: ["Yes"], requestId: "approval" } });
    const before = h.store.activePath(h.bot.threadId);
    expect(h.ask("Ship it?", true)).toMatchObject({ body: { closed: false } });
    expect(h.patchMessage).not.toHaveBeenCalled();
    expect(h.store.activePath(h.bot.threadId)).toEqual(before);
  });
});

describe("default report and question rules", () => {
  it.each(["ALWAYS_REPLY_INSTRUCTIONS", "DETAILED_REPLY_INSTRUCTIONS"])("includes both rules in %s", (name) => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.indexOf("const ALWAYS_REPLY_FUNCTIONAL_INSTRUCTIONS =");
    const constants = source.slice(start, source.indexOf("const CORPUS_SEARCH_INSTRUCTIONS =", start));
    const prompt = runInNewContext(`${constants}\n${name}`) as string;
    expect(prompt).toContain("every finished deliverable and every item waiting on the user");
    expect(prompt).toContain("picture or clickable link");
    expect(prompt).toContain("skipped, cut, left for them to do by hand, or failed");
    expect(prompt).toContain("If the user answers an open card in their own words, close the card.");
  });
});
