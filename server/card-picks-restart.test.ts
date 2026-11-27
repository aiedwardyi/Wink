import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { answerPrefix, askStates } from "../shared/open-question.ts";
import { DATA_DIR } from "./config.ts";
import { prepareModelContext } from "./context-compaction.ts";
import { createMemoryPass } from "./memory-pass.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";
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
  it.each([
    { name: "a typed quoted reply", question: "Which wood should the bookshelf use?", options: ["Use red oak", "Skip"], answer: "Use red oak", send: "typed" },
    { name: "a spoken quoted reply", question: "Restart at 8:15 PM instead?", options: ["Yes, 8:15 PM"], answer: "Yeah, that's better.", send: "spoken" },
    { name: "a tapped choice holding a long quote", question: "Which message should appear when a draft is saved?", options: [copy, "Skip"], answer: copy, send: "tap" },
    // the letter reads clean; the option it names holds a password, only partly masked by the text redactor
    { name: "a tapped letter naming a secret option", question: "Which wifi should the kiosk join?", options: ["A) Wi-Fi password: Tr0ub4dor&3xQ", "B) Guest network"], answer: "A", send: "tap", secret: "Wi-Fi password" },
  ])("files $name under the card the chat says it answers, in its whole words", async ({ question, options, answer, send, secret }) => {
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
    expect(currentPicks(filed).find((entry) => entry.questionId === card.id)?.picked).toBe(answer);
    expect(`${prompt}\n`).toContain(`: ${answer}\n`);
  });
});
