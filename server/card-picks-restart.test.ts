import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { answerPrefix, askStates } from "../shared/open-question.ts";
import { DATA_DIR } from "./config.ts";
import { prepareModelContext } from "./context-compaction.ts";
import { createMemoryPass } from "./memory-pass.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import { currentPicks, PICKS_FILE } from "./picks.ts";
import { removeTestData } from "./testing/test-home.ts";
import { buildTurnContext, shouldRecycleProviderSession } from "./turn-context.ts";
import { memorySystemPrompt, readMemoryTopic } from "./workspace.ts";

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
    { name: "a typed reply quoting an earlier message", question: "How should we handle the release notes?", options: [approval, "Leave unchanged"], answer: "Send the release notes\n> Hold everything until Friday.", send: "typed", filed: "Send the release notes" },
    { name: "a tapped choice holding a secret in its blockquote", question: "Which box should the release use?", options: ["Use the staging box\n> password: Tr0ub4dor&3xQ", "Skip"], answer: "Use the staging box\n> password: Tr0ub4dor&3xQ", send: "tap", secret: "Tr0ub4dor" },
    // the letter reads clean; the option it names holds a password, only partly masked by the text redactor
    { name: "a tapped letter naming a secret option", question: "Which wifi should the kiosk join?", options: ["A) Wi-Fi password: Tr0ub4dor&3xQ", "B) Guest network"], answer: "A", send: "tap", secret: "Wi-Fi password" },
  ])("files $name under the card the chat says it answers, in its whole words", async ({ question, options, answer, send, secret, filed: typed }) => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-opus-5-5" }));
    const pass = createMemoryPass({ store, dataDir: DATA_DIR, generate: () => async () => "[]", enabled: () => true, busy: () => false });
    const bot = store.createBot({}, { seedMessages: false });
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
    return { ask, send, settle, answeredBy, restarted, post: (row: Omit<Message, "id" | "at">) => store.appendMessage(bot.threadId, row) };
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
});
