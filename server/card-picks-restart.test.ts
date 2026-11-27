import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { ANSWERED_IN_CHAT, answerPrefix, askStates } from "../shared/open-question.ts";
import { askUserRequestSchema, postAskUser } from "./ask-user.ts";
import { DATA_DIR } from "./config.ts";
import { prepareModelContext } from "./context-compaction.ts";
import { createMemoryPass } from "./memory-pass.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import { applyPicks, currentPicks, PICKS_FILE } from "./picks.ts";
import { removeTestData } from "./testing/test-home.ts";
import { buildTurnContext, shouldRecycleProviderSession } from "./turn-context.ts";
import { memorySystemPrompt, readMemoryTopic, workspaceDir } from "./workspace.ts";

const MINUTE = 60_000;

// The nightly eval runs this file alone: pnpm exec vitest run server/card-picks-restart.test.ts
describe("card picks survive a session restart", () => {
  beforeEach(() => {
    closeMessageDb();
    removeTestData(DATA_DIR);
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("puts every card answer in the next session's prompt when the notes and the summary both drop it", async () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-opus-5-5" }));
    const teacher = store.createBot({}, { seedMessages: false });
    const other = store.createBot({}, { seedMessages: false });
    const start = Date.now() - 60 * MINUTE;
    let step = 0;
    const ask = (threadId: string, subtitle: string, options: string[]) =>
      store.appendMessage(threadId, { role: "bot", kind: "options", card: { title: "Pick", subtitle, options, askUser: true } });
    const answer = (threadId: string, card: { id: string }, text: string) =>
      store.appendMessage(threadId, { role: "user", kind: "text", text, answersCard: card.id, actedAt: start + ++step * MINUTE });
    // the note-taker files nothing, as the 11-25 09:26 pass did
    const pass = createMemoryPass({ store, dataDir: DATA_DIR, generate: () => async () => "[]", enabled: () => true, busy: () => false });
    const settle = async (threadId: string, botId: string) => {
      pass.onSettled(botId, threadId, true);
      await pass.idle();
    };

    const gemini = ask(teacher.threadId, "Which Gemini fix ships today?", ["Warm standby", "Cold start trim"]);
    answer(teacher.threadId, gemini, "Warm standby");
    answer(teacher.threadId, ask(teacher.threadId, "Run the nightly eval on Neon too?", ["Yes", "No"]), "Yes");
    answer(teacher.threadId, ask(teacher.threadId, "Keep the side pane open by default?", ["Yes", "No"]), "Yes");
    const db = ask(teacher.threadId, "Which database for the ledger?", ["SQLite", "Postgres"]);
    ask(teacher.threadId, "Ship tonight?", ["Yes", "No"]);
    answer(teacher.threadId, db, "Re: “Which database for the ledger?”\nPostgres, hosted on the home server");
    await settle(teacher.threadId, teacher.id);
    // a revised answer to the same card, in a later pass
    answer(teacher.threadId, gemini, "Re: “Which Gemini fix ships today?”\nCold start trim");
    await settle(teacher.threadId, teacher.id);
    answer(other.threadId, ask(other.threadId, "Which accent color?", ["Neon pink", "Teal"]), "Neon pink");
    await settle(other.threadId, other.id);
    pass.dispose();

    for (let i = 0; i < 80; i++) {
      store.appendMessage(teacher.threadId, { role: "user", kind: "text", text: `Status check ${i}: how is the release going? ${"Details on the build queue. ".repeat(8)}` });
      store.appendMessage(teacher.threadId, { role: "bot", kind: "text", text: `Release step ${i} is done. ${"Build logs look clean and the queue is empty. ".repeat(8)}` });
    }
    const prepared = await prepareModelContext({
      messages: store.activePath(teacher.threadId),
      contextWindow: 16_384,
      taskRecordText: "Goal: Ship the release",
      // the 19:15 summary kept the work and lost the picks
      summarize: async () => "SUMMARY\nThe user and the bot worked through release steps one by one; every build is clean and the queue is empty.",
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.compacted).toBe(true);
    const recycled = shouldRecycleProviderSession({ compacted: prepared.compacted, rewound: false });
    expect(recycled).toBe(true);
    const { turnText } = buildTurnContext({
      text: "Which Gemini fix did I pick this morning?",
      transcript: prepared.transcript,
      rewound: false,
      fresh: false,
      recycled,
      recycleReason: "session-fat",
      replaysNatively: false,
    });
    expect(turnText).not.toContain("Cold start trim");
    const prompt = `${memorySystemPrompt(teacher.id)}\n${turnText}`;

    expect(prompt).toMatch(/- Which Gemini fix ships today\? \(\d\d-\d\d\): Cold start trim\n/);
    expect(prompt).not.toContain("Warm standby");
    expect(prompt).toMatch(/- Run the nightly eval on Neon too\? \(\d\d-\d\d\): Yes\n/);
    expect(prompt).toMatch(/- Keep the side pane open by default\? \(\d\d-\d\d\): Yes\n/);
    expect(prompt).toMatch(/- Which database for the ledger\? \(\d\d-\d\d\): Postgres, hosted on the home server\n/);
    expect(prompt).not.toContain("Ship tonight?");
    expect(prompt).not.toContain("Neon pink");
    expect(memorySystemPrompt(other.id)).toMatch(/- Which accent color\? \(\d\d-\d\d\): Neon pink/);
  });
  const copy = 'Use "Your draft is saved on this device. You can close this window and return when you are ready to finish."';
  const approval = "Send the release notes\n> Wait for my approval before sending.";
  it.each([
    { name: "a typed quoted reply", question: "Which wood should the bookshelf use?", options: ["Use red oak", "Skip"], answer: "Use red oak", send: "typed" },
    { name: "a spoken quoted reply", question: "Restart at 8:15 PM instead?", options: ["Yes, 8:15 PM"], answer: "Yeah, that's better.", send: "spoken" },
    { name: "a tapped choice holding a long quote", question: "Which message should appear when a draft is saved?", options: [copy, "Skip"], answer: copy, send: "tap" },
    { name: "a tapped choice holding a blockquote", question: "How should we handle the release notes?", options: [approval, "Leave unchanged"], answer: approval, send: "tap" },
    { name: "a typed choice holding a blockquote", question: "How should we handle the release notes?", options: [approval, "Leave unchanged"], answer: approval, send: "typed" },
    // a quote the user pasted under their own words is not what they said
    { name: "a typed reply quoting an earlier message", question: "How should we handle the release notes?", options: [approval, "Leave unchanged"], answer: "Send the release notes\n> Hold everything until Friday.", send: "typed", filed: "Send the release notes", earlier: "Last week's plan: hold everything until Friday." },
    { name: "a tapped choice holding a secret in its blockquote", question: "Which box should the release use?", options: ["Use the staging box\n> password: Tr0ub4dor&3xQ", "Skip"], answer: "Use the staging box\n> password: Tr0ub4dor&3xQ", send: "tap", secret: "Tr0ub4dor" },
    // the letter reads clean; the option it names holds a password, only partly masked by the text redactor
    { name: "a tapped letter naming a secret option", question: "Which wifi should the kiosk join?", options: ["A) Wi-Fi password: Tr0ub4dor&3xQ", "B) Guest network"], answer: "A", send: "tap", secret: "Wi-Fi password" },
  ])("files $name under the card the chat says it answers, in its whole words", async ({ question, options, answer, send, secret, filed: typed, earlier }) => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-opus-5-5" }));
    const pass = createMemoryPass({ store, dataDir: DATA_DIR, generate: () => async () => "[]", enabled: () => true, busy: () => false });
    const bot = store.createBot({}, { seedMessages: false });
    if (earlier) store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: earlier });
    const card = store.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { title: "Pick", subtitle: question, options, askUser: true, staysOpen: true } });
    // a newer card makes the reply name its question
    if (send === "typed") store.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { title: "Pick", subtitle: "Where should the sample go?", options: ["By the window", "On the desk"], askUser: true, staysOpen: true } });
    const sent = store.appendMessage(bot.threadId, {
      role: "user", kind: "text", actedAt: Date.now() - MINUTE,
      text: send === "tap" ? answer : answerPrefix(card) + answer,
      ...(send === "tap" ? { answersCard: card.id } : send === "spoken" ? { call: { id: "c-0123456789ab", ask: true as const }, sendId: "send-1" } : {}),
    });
    const messages = store.messagesFor(bot.threadId);
    if (send !== "tap") expect(askStates(messages).get(messages.find((message) => message.id === card.id)!)).toMatchObject({ state: "answered", by: { id: sent.id } });
    pass.onSettled(bot.id, bot.threadId, true);
    await pass.idle();
    pass.dispose();
    const filed = readMemoryTopic(bot.id, PICKS_FILE) ?? "";
    const prompt = memorySystemPrompt(bot.id);
    if (secret) {
      expect(currentPicks(filed).some((entry) => entry.questionId === card.id)).toBe(false);
      expect(filed).not.toContain(secret);
      expect(prompt).not.toContain(secret);
      return;
    }
    const words = (typed ?? answer).replace(/\s+/g, " ");
    expect(currentPicks(filed).find((entry) => entry.questionId === card.id)?.picked).toBe(words);
    expect(`${prompt}\n`).toContain(`: ${words}\n`);
  });
});

describe("every way to answer a card files it under that card", () => {
  beforeEach(() => {
    closeMessageDb();
    removeTestData(DATA_DIR);
    mkdirSync(DATA_DIR, { recursive: true });
  });

  const setup = () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-opus-5-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    let notes: object[] = [];
    const pass = createMemoryPass({ store, dataDir: DATA_DIR, generate: () => async () => JSON.stringify(notes), enabled: () => true, busy: () => false });
    const ask = (subtitle: string, options: string[]) =>
      store.appendMessage(bot.threadId, { role: "bot", kind: "options", card: { title: "Ask", subtitle, options, askUser: true, staysOpen: true } });
    const send = (text: string, extra: Partial<Message> = {}) => store.appendMessage(bot.threadId, { role: "user", kind: "text", text, actedAt: Date.now() - MINUTE, ...extra });
    const settle = async (...facts: object[]) => {
      notes = facts;
      pass.onSettled(bot.id, bot.threadId, true);
      await pass.idle();
    };
    const answeredBy = (card: Message) => {
      const messages = store.messagesFor(bot.threadId);
      const state = askStates(messages).get(messages.find((message) => message.id === card.id)!);
      return state?.state === "answered" ? state.by?.id : undefined;
    };
    // a fresh session after compaction: the picks block is all that carries an answer
    const restarted = async () => {
      pass.dispose();
      for (let i = 0; i < 80; i++) {
        store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `Status ${i}: ${"How is the shipment going? ".repeat(12)}` });
        store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `Progress ${i}: ${"The delivery team is working on the schedule. ".repeat(12)}` });
      }
      const prepared = await prepareModelContext({
        messages: store.activePath(bot.threadId), contextWindow: 16_384, taskRecordText: "Goal: prepare shipment",
        summarize: async () => "SUMMARY\nThe team discussed shipping estimates and compared the delivery schedules.",
      });
      if (prepared.status !== "ready" || !prepared.compacted) throw new Error("no compaction");
      const { turnText } = buildTurnContext({ text: "Continue.", transcript: prepared.transcript, rewound: false, fresh: false, recycled: true, recycleReason: "session-fat", replaysNatively: false });
      return { replay: turnText, prompt: memorySystemPrompt(bot.id), picks: currentPicks(readMemoryTopic(bot.id, PICKS_FILE) ?? "") };
    };
    // the bot's ask_user close:true, as the agents proxy sends it
    const close = (question: string) => postAskUser({
      bot: (id) => store.bot(id), conversation: (botId, threadId) => store.conversationForBot(botId, threadId),
      appendMessage: (threadId, row) => store.appendMessage(threadId, row), activePath: (threadId) => store.activePath(threadId),
      patchMessage: (threadId, id, patch) => store.patchMessage(threadId, id, patch), cancelHeld: () => false,
      alertThread: (_bot, threadId) => threadId, notifyQuestion: () => {}, whenSettled: (_bot, _thread, post) => post(),
    }, askUserRequestSchema.parse({ fromBotId: bot.id, fromThreadId: bot.threadId, question, choices: [], close: true }));
    const card = (id: string) => store.messagesFor(bot.threadId).find((row) => row.id === id)?.card;
    return {
      ask, send, settle, answeredBy, restarted, close, card, post: (row: Omit<Message, "id" | "at">) => store.appendMessage(bot.threadId, row),
      branch: (id: string, text: string) => store.branchMessage(bot.threadId, id, text)!,
      botId: bot.id, threadId: bot.threadId,
    };
  };

  it("files a plain composer reply to a question with no buttons", async () => {
    const { ask, send, settle, answeredBy, restarted } = setup();
    const card = ask("Which environment should we use for the preview?", []);
    const reply = send("Staging", { sendId: "send-1" });
    expect(answeredBy(card)).toBe(reply.id);
    await settle();
    const { replay, prompt, picks } = await restarted();
    expect(replay).not.toContain("Staging");
    expect(picks.map(({ picked, questionId }) => [picked, questionId])).toEqual([["Staging", card.id]]);
    expect(`${prompt}\n`).toMatch(/- Which environment should we use for the preview\? \(\d\d-\d\d\): Staging\n/);
  });

  it.each([{ helper: true }, { helper: false }])("files the option a quoted \"the second one\" points to, with the user's words (helper note $helper)", async ({ helper }) => {
    const { ask, send, settle, answeredBy, restarted } = setup();
    const card = ask("Which material should we order?", ["Cedar", "Balsa", "Pine"]);
    const reply = send(`${answerPrefix(card)}the second one`);
    expect(answeredBy(card)).toBe(reply.id);
    await settle(...(helper ? [{ kind: "decision", key: "Material", fact: "Balsa", quote: "the second one", message_id: reply.id, question_id: card.id }] : []));
    const { prompt, picks } = await restarted();
    expect(picks.map(({ picked, said, questionId }) => [picked, said, questionId])).toEqual([["Balsa", "the second one", card.id]]);
    expect(`${prompt}\n`).toMatch(/\(\d\d-\d\d\): Balsa\n/);
  });

  it.each([{ helper: true }, { helper: false }])("keeps a typed decision and another card's tap the helper files under the same key (helper note $helper)", async ({ helper }) => {
    const { ask, send, settle, restarted, post } = setup();
    const asked = post({ role: "bot", kind: "text", text: "Which signing service should we use for desktop builds? Local signing or unsigned?" });
    const typed = send("Use Local signing for desktop builds", { actedAt: Date.now() - 2 * MINUTE });
    await settle({ kind: "decision", key: "Signing service", fact: "Local signing", quote: "Use Local signing for desktop builds", message_id: typed.id, question_id: asked.id });
    const card = ask("Which signing service should we use for mobile builds?", ["Cloud signing", "Manual signing"]);
    const tap = send("Cloud signing", { answersCard: card.id });
    await settle(...(helper ? [{ kind: "decision", key: "Signing service", fact: "Cloud signing", quote: "Cloud signing", message_id: tap.id, question_id: card.id }] : []));
    const { prompt, picks } = await restarted();
    expect(picks.map(({ picked }) => picked)).toEqual(["Local signing", "Cloud signing"]);
    expect(picks.find(({ picked }) => picked === "Cloud signing")?.questionId).toBe(card.id);
    expect(`${prompt}\n`).toContain(": Local signing\n");
    expect(`${prompt}\n`).toContain(": Cloud signing\n");
  });

  it.each([{ staysOpen: true, sent: "Postgres" }, { staysOpen: false, sent: "Postgres" }, { staysOpen: true, sent: "  Postgres\n" }])("files a typed exact option like a tap of it (stays open $staysOpen)", async ({ staysOpen, sent }) => {
    const { send, settle, answeredBy, restarted, post } = setup();
    const asked: NonNullable<Message["card"]> = { title: "Ask", subtitle: "Which database should the reporting service use?", options: ["Postgres", "MySQL"], askUser: true };
    if (staysOpen) asked.staysOpen = true;
    const card = post({ role: "bot", kind: "options", card: asked });
    const reply = send(sent, { sendId: "send-1" });
    expect(answeredBy(card)).toBe(reply.id);
    await settle();
    const { replay, prompt, picks } = await restarted();
    expect(replay).not.toContain("Postgres");
    expect(picks.map(({ picked, questionId, messageId }) => [picked, questionId, messageId])).toEqual([["Postgres", card.id, reply.id]]);
    expect(`${prompt}\n`).toMatch(/- Which database should the reporting service use\? \(\d\d-\d\d\): Postgres\n/);
  });

  it.each([
    { name: "own words", words: "Use Staging for the preview", picked: "Use Staging for the preview" },
    { name: "a place on the card", words: "The second one", picked: "Staging" },
    { name: "an option to an older card after a newer one was answered", words: "Staging", picked: "Staging", newer: true },
    { name: "holding a secret", words: "Use Staging, password: Tr0ub4dor&3xQ", picked: undefined },
  ])("files a reply the bot closed as answered in chat, $name, after restart", async ({ words, picked, newer }) => {
    const { ask, send, settle, restarted, close, card: cardOf } = setup();
    const question = "Which environment should the preview use?";
    const card = ask(question, ["Prod", "Staging"]);
    const format = newer ? ask("Which export format?", ["CSV", "JSON"]) : undefined;
    if (format) {
      send("CSV", { answersCard: format.id, actedAt: Date.now() - 2 * MINUTE });
      await settle();
    }
    const reply = send(words, { sendId: "send-1" });
    expect(close(question)).toEqual({ status: 200, body: { closed: true } });
    expect(cardOf(card.id)).toMatchObject({ answered: ANSWERED_IN_CHAT, answeredBy: reply.id });
    await settle();
    const { replay, prompt, picks } = await restarted();
    expect(replay).not.toContain(words);
    if (picked === undefined) {
      expect(picks).toEqual([]);
      expect(prompt).not.toContain("Tr0ub4dor");
      return;
    }
    expect(picks.map(({ picked, said, questionId, messageId }) => [picked, said, questionId, messageId]))
      .toEqual([...(format ? [["CSV", "CSV", format.id, expect.any(String)]] : []), [picked, words, card.id, reply.id]]);
    expect(`${prompt}\n`).toContain(`- ${question} (`);
    expect(`${prompt}\n`).toMatch(new RegExp(`\\(\\d\\d-\\d\\d\\): ${picked}\\n`));
  });

  it.each(["postgres", "Postgres please", "B", "the first one"])("leaves a typed %s that is not an option's whole text to the notes", async (sent) => {
    const { send, settle, answeredBy, restarted, post } = setup();
    const card = post({ role: "bot", kind: "options", card: { title: "Ask", subtitle: "Which database should the reporting service use?", options: ["Postgres", "MySQL"], askUser: true } });
    const reply = send(sent);
    expect(answeredBy(card)).toBe(reply.id);
    await settle();
    const { picks } = await restarted();
    expect(picks).toEqual([]);
  });

  it.each([
    { options: ["Last", "First"], tap: "Last" },
    { options: ["Last", "First"], tap: "First" },
    { options: ["2", "1", "4"], tap: "2" },
  ])("files a tapped $tap word for word, wherever it sits on the card", async ({ options, tap }) => {
    const { ask, send, settle, restarted } = setup();
    const card = ask("Where should missing values appear in the sorted table?", options);
    send(tap, { answersCard: card.id });
    await settle();
    const { prompt, picks } = await restarted();
    expect(picks.map(({ picked, said, questionId }) => [picked, said, questionId])).toEqual([[tap, tap, card.id]]);
    expect(`${prompt}\n`).toContain(`): ${tap}\n`);
  });

  it.each([
    { options: ["C#", "Rust"], words: "C++", filed: "C++" },
    { options: ["+5", "Skip"], words: "-5", filed: "-5" },
    { options: ["Release", "main"], words: "release", filed: "release" },
    { options: ["SQLite", "Postgres", "MySQL"], words: "option 2", filed: "Postgres" },
    { options: ["SQLite", "Postgres", "MySQL"], words: "2", filed: "Postgres" },
    { options: ["SQLite", "Postgres", "MySQL"], words: "B", filed: "Postgres" },
    { options: ["SQLite", "Postgres", "MySQL"], words: "the second one", filed: "Postgres" },
    { options: ["SQLite", "Postgres", "MySQL"], words: "the last one", filed: "MySQL" },
    { options: ["1) SQLite", "2) Postgres", "3) MySQL"], words: "option 2", filed: "2) Postgres" },
  ])("files a typed $words on a card offering $options as $filed, with the user's words", async ({ options, words, filed }) => {
    const { ask, send, settle, answeredBy, restarted } = setup();
    const card = ask("Which one should the build use?", options);
    // a newer card makes the reply name its question
    ask("Which shade should the example use?", ["Blue", "Green"]);
    const reply = send(`${answerPrefix(card)}${words}`);
    expect(answeredBy(card)).toBe(reply.id);
    await settle();
    const { prompt, picks } = await restarted();
    expect(picks.map(({ picked, said, questionId }) => [picked, said, questionId])).toEqual([[filed, words, card.id]]);
    expect(`${prompt}\n`).toContain(`): ${filed}\n`);
  });

  it.each([
    { intro: "Delivery choices were A) Pickup or B) Courier.", question: "Which material should we order: A) Cedar or B) Balsa?", words: "the second one", filed: "B - Balsa", quoted: false },
    { intro: "Finish: A) Matte or B) Gloss.", question: "Which environment should the preview use?", words: "Staging", filed: "Staging", quoted: false },
    { intro: "Finish: A) Matte or B) Gloss.", question: "Which environment should the preview use?", words: "Staging", filed: "Staging", quoted: true },
  ])("files $words on a card with no buttons by its own question, never an earlier bot list (quoted $quoted)", async ({ intro, question, words, filed, quoted }) => {
    const { ask, send, settle, answeredBy, restarted, post } = setup();
    post({ role: "bot", kind: "text", text: intro });
    const card = ask(question, []);
    if (quoted) ask("Which shade should the example use?", ["Blue", "Green"]);
    const reply = send(quoted ? `${answerPrefix(card)}${words}` : words);
    expect(answeredBy(card)).toBe(reply.id);
    await settle();
    const { prompt, picks } = await restarted();
    expect(picks.map(({ picked, said, questionId }) => [picked, said, questionId])).toEqual([[filed, words, card.id]]);
    expect(`${prompt}\n`).toContain(`): ${filed}\n`);
  });

  it.each([true, false].flatMap((helper) => ["tap", "typed", "quoted"].map((how) => ({ helper, how }))))("keeps a card answer ($how) and a later typed decision on another question under the same key (helper note $helper)", async ({ helper, how }) => {
    const { ask, send, settle, restarted, post } = setup();
    const card = ask("Which signing service should we use for mobile builds?", ["Cloud signing", "Manual signing"]);
    const tap = send(how === "quoted" ? `${answerPrefix(card)}Cloud signing` : "Cloud signing", { answersCard: how === "tap" ? card.id : undefined, actedAt: Date.now() - 2 * MINUTE });
    await settle(...(helper ? [{ kind: "decision", key: "Signing service", fact: "Cloud signing", quote: "Cloud signing", message_id: tap.id, question_id: card.id }] : []));
    const asked = post({ role: "bot", kind: "text", text: "Which signing service should we use for desktop builds? Local signing or unsigned?" });
    const typed = send("Use Local signing for desktop builds");
    await settle({ kind: "decision", key: "Signing service", fact: "Local signing", quote: "Use Local signing for desktop builds", message_id: typed.id, question_id: asked.id });
    const { prompt, picks } = await restarted();
    expect(picks.map(({ picked, questionId }) => [picked, questionId])).toEqual([["Cloud signing", card.id], ["Local signing", asked.id]]);
    expect(`${prompt}\n`).toContain("): Cloud signing\n");
    expect(`${prompt}\n`).toContain("): Local signing\n");
  });

  it.each(["typed", "quoted"])("keeps a %s card answer over a later press of another option after restart", async (how) => {
    const { send, settle, restarted, post } = setup();
    const card = post({ role: "bot", kind: "options", card: { title: "Ask", subtitle: "Which database should the reporting service use?", options: ["Postgres", "MySQL"], askUser: true } });
    send(how === "quoted" ? `${answerPrefix(card)}Postgres` : "Postgres", { actedAt: Date.now() - 2 * MINUTE });
    await settle();
    send("MySQL", { answersCard: card.id, actedAt: Date.now() - MINUTE });
    await settle();
    const { prompt, picks } = await restarted();
    expect(picks.map(({ picked, questionId }) => [picked, questionId])).toEqual([["Postgres", card.id]]);
    expect(`${prompt}\n`).toMatch(/\): Postgres\n/);
    expect(prompt).not.toContain("MySQL");
  });

  it("keeps a later condition on a long card answer, both whole in the prompt", async () => {
    const { ask, send, settle, restarted } = setup();
    const card = ask("Release announcement", []);
    const words = [
      "Prepare the desktop release announcement for the beta group and schedule it for Monday morning. Start with the change people will notice on their first launch. Mention that their existing settings will carry over, and point them to the setup page if they need to check the installation.",
      "Explain the two improvements to importing invoices. Include an example of the new filename and show the location of the review screen. Put the troubleshooting steps in a separate paragraph so that people who already finished the import can skip them.",
      "Send a copy to the support team and put the runbook link at the end. Include the names of the three supported formats, the way to request a correction and the date the previous importer will stop accepting new files. Ask each regional support lead to confirm the translation.",
      "Keep the existing list of recipients from the pilot. Use the approved subject line from the release calendar. Send the reminder to people who have not completed the update on Thursday and include the link to the office hours session in that reminder.",
    ].join("\n\n");
    send(words, { answersCard: card.id, actedAt: Date.now() - 2 * MINUTE });
    await settle();
    const condition = "Wait for my approval before sending.";
    send(condition);
    await settle({ kind: "tweak", key: "Release announcement", fact: condition, quote: condition });
    const { prompt, picks } = await restarted();
    expect(picks.map(({ questionId, tweaks }) => [questionId, tweaks.map(({ said }) => said)])).toEqual([[card.id, [condition]]]);
    const line = prompt.split("\n").find((each) => each.startsWith("- Release announcement"));
    expect(line).toContain(words.replace(/\s+/g, " "));
    expect(line).toContain(`"${condition}"`);
  });

  const first = "Prepare the release email for the beta group. List the fixes to the desktop installer and include a link to the updated setup guide. Give the support team a copy of the draft so they can check the instructions and flag anything that has changed.";
  const second = "Use the launch mailing list we agreed on yesterday. Keep the subject line short and explain which installer people should download. Put the new schedule in the first paragraph so people can plan around it. Wait for my approval before sending.";
  it.each([
    { name: "a two-paragraph reply", words: `${first}\n\n${second}`, byId: false },
    { name: "a reply its question's quote pushes past a paragraph", words: `${first} ${second.split(" Put the new")[0]}`, byId: false },
    { name: "a reply its question's quote pushes past a paragraph, sent with the card id", words: `${first} ${second.split(" Put the new")[0]}`, byId: true },
  ])("files $name whole", async ({ words, byId }) => {
    const { ask, send, settle, answeredBy, restarted } = setup();
    const card = ask("How should we handle the release notes for the desktop app?", []);
    // a newer card makes the reply name its question
    ask("Which color should we use?", ["Blue", "Green"]);
    const reply = send(`${answerPrefix(card)}${words}`, byId ? { answersCard: card.id } : {});
    expect(answeredBy(card)).toBe(reply.id);
    await settle();
    const { replay, prompt, picks } = await restarted();
    const whole = words.replace(/\s+/g, " ");
    expect(replay).not.toContain("include a link to the updated setup guide");
    expect(picks.map(({ picked, said, questionId }) => [picked, said, questionId])).toEqual([[whole, whole, card.id]]);
    expect(`${prompt}\n`).toContain(`: ${whole}\n`);
  });

  it("files nothing from an edit onto a branch that never shows the card", async () => {
    const { ask, send, settle, restarted, post, branch } = setup();
    post({ role: "bot", kind: "text", text: "I can work on that." });
    const request = send("Prepare the deployment steps.");
    ask("Where should we deploy the service?", []);
    await settle();
    branch(request.id, "Can you summarize the changes?");
    await settle();
    const { prompt, picks } = await restarted();
    expect(picks).toEqual([]);
    expect(prompt).not.toContain("Can you summarize the changes?");
  });

  it.each([
    { revise: "a second quote", ahead: 0 },
    { revise: "an edit of the first quote", ahead: 0 },
    // the first answer's PC clock ran ahead of the server that stamps the edit
    { revise: "an edit of the first quote", ahead: 90 * MINUTE },
    { revise: "two edits of the first quote", ahead: 90 * MINUTE },
  ])("files $revise of an answered card as its answer now (first clock ahead $ahead ms)", async ({ revise, ahead }) => {
    const { ask, send, settle, restarted, branch } = setup();
    const card = ask("What database should billing use?", ["SQLite", "Postgres", "MySQL"]);
    // a newer card makes the reply name its question
    ask("Which theme should billing use?", ["Light", "Dark"]);
    const first = send(`${answerPrefix(card)}SQLite`, { actedAt: Date.now() - 2 * MINUTE + ahead });
    await settle();
    if (revise === "a second quote") send(`${answerPrefix(card)}Postgres`);
    else branch(first.id, `${answerPrefix(card)}Postgres`);
    await settle();
    const latest = revise === "two edits of the first quote" ? "MySQL" : "Postgres";
    if (latest === "MySQL") {
      branch(first.id, `${answerPrefix(card)}MySQL`);
      await settle();
    }
    const { prompt, picks } = await restarted();
    expect(picks.map(({ picked, questionId }) => [picked, questionId])).toEqual([[latest, card.id]]);
    expect(`${prompt}\n`).toContain(`): ${latest}\n`);
    expect(prompt).not.toContain("SQLite");
  });

  it("shows a card answer's long follow-up whole in the prompt", async () => {
    const { ask, send, settle, restarted } = setup();
    const card = ask("Vendor rollout", ["Enable the vendor rollout", "Keep it off"]);
    send("Enable the vendor rollout", { answersCard: card.id, actedAt: Date.now() - 2 * MINUTE });
    await settle();
    const approval = "Wait for my written approval before enabling it.";
    const words = `Check audit findings and invoices before the vendor rollout. ${approval}`;
    send(words);
    await settle({ kind: "tweak", key: "Vendor rollout", fact: approval, quote: words });
    const { prompt, picks } = await restarted();
    expect(picks.map(({ questionId, tweaks }) => [questionId, tweaks.map(({ said }) => said)])).toEqual([[card.id, [words]]]);
    const line = prompt.split("\n").find((each) => each.includes(": Enable the vendor rollout"));
    expect(line).toContain(`"${words}"`);
  });

  it.each([{ quoted: false }, { quoted: true }])("keeps a Markdown callout the user typed in a card answer (quoted $quoted)", async ({ quoted }) => {
    const { ask, send, settle, restarted } = setup();
    const card = ask("How should the release announcement go out?", []);
    if (quoted) ask("Which color should we use?", ["Blue", "Green"]);
    const words = "Prepare the announcement for Monday.\n\n> **Required**\n> Wait for my release approval before sending.";
    send(quoted ? `${answerPrefix(card)}${words}` : words);
    await settle();
    const { prompt, picks } = await restarted();
    const whole = words.replace(/\s+/g, " ");
    expect(picks.map(({ picked, questionId }) => [picked, questionId])).toEqual([[whole, card.id]]);
    expect(`${prompt}\n`).toContain(`: ${whole}\n`);
  });
  it("lands a same-pass follow-up keyed like the note on a revised card answer", async () => {
    const { ask, send, settle, restarted } = setup();
    const card = ask("Which theme?", ["Light", "Dark"]);
    send("Dark", { answersCard: card.id, actedAt: Date.now() - 3 * MINUTE });
    await settle();
    const tap = send("Light", { answersCard: card.id, actedAt: Date.now() - 2 * MINUTE });
    send("Keep the header small.");
    await settle(
      { kind: "decision", key: "Theme", fact: "Light", quote: "Light", message_id: tap.id, question_id: card.id },
      { kind: "tweak", key: "Theme", fact: "Keep the header small", quote: "Keep the header small." },
    );
    const { prompt, picks } = await restarted();
    expect(picks.map(({ picked, questionId, tweaks }) => [picked, questionId, tweaks.map(({ said }) => said)])).toEqual([["Light", card.id, ["Keep the header small."]]]);
    expect(prompt).toContain("Keep the header small.");
  });

  it("files an edit of a tapped answer as the card's answer now", async () => {
    const { ask, send, settle, restarted, branch } = setup();
    const card = ask("What database should billing use?", ["SQLite", "Postgres"]);
    const tap = send("SQLite", { answersCard: card.id });
    await settle();
    branch(tap.id, "Postgres");
    await settle();
    const { prompt, picks } = await restarted();
    expect(picks.map(({ picked, questionId }) => [picked, questionId])).toEqual([["Postgres", card.id]]);
    expect(`${prompt}\n`).toContain(": Postgres\n");
    expect(prompt).not.toContain("SQLite");
  });
  it("files a newer quoted revision over a typed pick an older build saved on the card", async () => {
    const { ask, send, settle, restarted, botId, threadId } = setup();
    const card = ask("What database should billing use?", ["SQLite", "Postgres"]);
    ask("Which theme should billing use?", ["Light", "Dark"]);
    const at = Date.now() - 5 * MINUTE;
    // SAFETY: applyPicks reads only these binding fields; a verified one is minted by validatePickBinding.
    const legacy = applyPicks("", [{ kind: "pick", at, key: "Billing database", picked: "SQLite", said: "SQLite", binding: { at, messageId: "older-reply", questionId: card.id, thread: threadId, files: [], overPictures: [], named: true } as never }])!.text;
    mkdirSync(join(workspaceDir(botId), "memory"), { recursive: true });
    writeFileSync(join(workspaceDir(botId), "memory", PICKS_FILE), legacy);
    send(`${answerPrefix(card)}Postgres`);
    await settle();
    const { prompt, picks } = await restarted();
    expect(picks.map(({ picked, questionId }) => [picked, questionId])).toEqual([["Postgres", card.id]]);
    expect(prompt).not.toContain("SQLite");
  });
});
