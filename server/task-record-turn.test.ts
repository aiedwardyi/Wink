import { mkdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { closedAskNotes } from "./ask-user.ts";
import { DATA_DIR } from "./config.ts";
import * as context from "./context-compaction.ts";
import * as mail from "./mail.ts";
import { callLinesSinceLastUserTurn } from "./live-call.ts";
import { closeMessageDb } from "./message-db.ts";
import { roomEchoesSinceLastUserTurn } from "./one-mind.ts";
import { quickAnswersSinceLastUserTurn } from "./quick-ask.ts";
import { composeUserTurnPrompt, turnReplaysTranscript, userTurnReactionKeys } from "./replies.ts";
import { Store } from "./store.ts";
import { asksNudge } from "./task-asks.ts";
import * as turns from "./turn-context.ts";
import { removeTestData } from "./testing/test-home.ts";

// Run the production turn-text preparation without booting the server.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("  let transcript = prepared.transcript;");
const end = source.indexOf("\n  const persona = [", start);
if (start < 0 || end < start) throw new Error("Missing turn preparation section");
const compile = (result: string) => new Function(`${ts.transpileModule(`function run(scope) { with (scope) {
  ${source.slice(start, end)}
  return ${result};
} }`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText}\nreturn run;`)();
const prepareTurn = compile("{ turnText, resume }");
const prepareInputs = compile("{ turnText, resumeFallback, recycled: systemRecycleText() }");

const RECORD = "[Wink task record]\nGoal: ship the trim";

beforeEach(async () => {
  closeMessageDb();
  removeTestData(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const instanceId = "claude";
const model = "claude-opus-5-5";

function summarizedChat() {
  const store = new Store(() => ({ instanceId, model }));
  const bot = store.createBot({}, { seedMessages: false });
  const threadId = bot.threadId;
  store.appendMessage(threadId, { role: "user", kind: "text", text: "Name the dog" });
  const covered = store.appendMessage(threadId, { role: "bot", kind: "text", text: "Biscuit" });
  const summary = store.appendCompaction(threadId, {
    v: 1, summary: "The dog is Biscuit.", coveredThroughId: covered.id, firstKeptId: null,
    contextWindow: 200_000, estimatedTokensBefore: 1_000, sourceMessageCount: 2,
  });
  store.markTaskDispatched(bot.id, threadId, instanceId, model);
  store.setResumeCursor(bot.id, instanceId, "session-1", threadId);
  store.markResumeSeeded(bot.id, threadId, { instanceId, cursor: "session-1", compactionId: summary.id });
  const instance = { driverKind: "fake", adapter: { capabilities: { sessionModelSwitch: "in-session" } } };

  const send = async (text: string, landed = false, nativeAt: number | null = landed ? 1 : null, prepare = prepareTurn) => {
    const userMessage = store.appendMessage(threadId, { role: "user", kind: "text", text });
    const activeMessages = store.activePath(threadId);
    const skipTranscript = new Set([userMessage.id]);
    const ready = await context.prepareModelContext({ messages: activeMessages, contextWindow: 200_000, taskRecordText: RECORD, excludeIds: skipTranscript });
    if (ready.status !== "ready") throw new Error(ready.status);
    expect(ready.compacted).toBe(true);
    expect(ready.compaction).toBeUndefined();
    const prepared = landed ? { ...ready, compaction: store.activePath(threadId).find((row) => row.id === summary.id)!.compaction } : ready;
    const turn = prepare({
      ...context, ...turns, ...mail, quickAnswersSinceLastUserTurn, roomEchoesSinceLastUserTurn, callLinesSinceLastUserTurn, closedAskNotes, turnStartedByUser: () => false, composeUserTurnPrompt, turnReplaysTranscript, userTurnReactionKeys, asksNudge, notOwnerChats: () => new Set(), stampShownAsks: () => {},
      store, bot, threadId, task: store.taskByThread(bot.id, threadId)!, instanceId, model, instance,
      text, userMessage, activeMessages, skipTranscript, prepared,
      latestCompactionId: ready.compactionId ?? null, sessionPrompt: undefined, nativeAt,
      currentTurnEpoch: () => 0, epoch: 1,
      rewound: false, recovering: false, unsettled: "", recoveryLatestUserText: text,
      opts: {}, cfg: {}, reactions: {}, threadSyncV2: null, accountNotices: { forTurn: () => ({ text: null }) }, modelContextWindow: 200_000,
      taskRecord: undefined, durableTaskRecordText: RECORD, commsDepth: 0, codexHistory: false,
      closes: { notes: () => [] },
    });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "ok" });
    return turn;
  };
  return { store, bot, threadId, send };
}

it("sends the task record only when the session restarts or a summary lands", async () => {
  const { store, bot, threadId, send } = summarizedChat();
  for (const text of ["and the cat?", "and the fish?", "and the bird?"]) {
    expect(await send(text)).toEqual({ turnText: text, resume: true });
  }
  expect(await send("and the horse?", true)).toEqual({ turnText: `${RECORD}\n\nand the horse?`, resume: true });
  store.clearResumeCursors(bot.id, threadId);
  const restarted = await send("and the goat?");
  expect(restarted.resume).toBe(false);
  expect(restarted.turnText.startsWith(`${RECORD}\n\n`)).toBe(true);
});

it("sends the task record once after a background summary lands on a live session", async () => {
  const { store, bot, threadId, send } = summarizedChat();
  expect(await send("and the cat?", false, 1)).toEqual({ turnText: "and the cat?", resume: true });
  const built = store.appendCompaction(threadId, {
    v: 1, summary: "The dog is Biscuit. The cat is unnamed.", coveredThroughId: store.activePath(threadId).at(-1)!.id, firstKeptId: null,
    contextWindow: 200_000, estimatedTokensBefore: 1_000, sourceMessageCount: 4,
  });
  expect(await send("and the fish?", false, 1)).toEqual({ turnText: `${RECORD}\n\nand the fish?`, resume: true });
  const seed = store.taskByThread(bot.id, threadId)!.resumeSeed;
  store.markResumeSeeded(bot.id, threadId, {
    instanceId, cursor: "session-1",
    compactionId: turns.turnSeedCompactionId({ replayed: false, instanceId, cursor: "session-1", seed, sessionCompactionId: built.id, supersededIds: context.supersededCompactionIds(store.activePath(threadId), built.id) }),
  });
  expect(await send("and the bird?", false, 1)).toEqual({ turnText: "and the bird?", resume: true });
});

it("keeps the other chats' asks beside the task record on every input that carries it", async () => {
  const { store, bot, threadId, send } = summarizedChat();
  const other = store.createTask(bot.id, "Other chat")!;
  store.writeTaskPacket({
    v: 1, threadId: other.threadId, botId: bot.id, goal: "Ship", plan: [], completed: [], evidence: [], artifacts: [], blockers: [], nextAction: "",
    updatedAt: 100, updatedBy: "harness", flushReason: "progress", turnsAtWrite: 0,
    asks: [{ id: "A1", ask: "make the header smaller on phone", status: "open", at: 100, changedAt: 100 }], lastAskId: 1,
  });
  store.clearResumeCursors(bot.id, threadId);
  const inputs = await send("what's left?", false, null, prepareInputs);
  for (const input of [inputs.turnText, inputs.resumeFallback, inputs.recycled]) {
    expect(input).toContain(RECORD);
    expect(input).toContain("[Wink asks from the user's other chats with you - 1; update them in that chat.]");
    expect(input).toContain("make the header smaller on phone");
  }
});

it("carries a call's spoken lines into a resumed session's next turn once", async () => {
  const { store, threadId, send } = summarizedChat();
  await send("and the cat?");
  const call = { id: "c-0123456789ab" };
  store.appendMessage(threadId, { role: "bot", kind: "text", text: "Good evening. What do you need?", call: { ...call, voice: true } });
  store.appendMessage(threadId, { role: "user", kind: "text", text: "Is the password reset email fixed?", call });
  const { turnText } = await send("what did we just say?");
  expect(turnText).toContain("Voice: Good evening. What do you need?\nPerson: Is the password reset email fixed?");
  expect(turnText.endsWith("Current message:\n\nwhat did we just say?")).toBe(true);
  expect(await send("and the fish?")).toEqual({ turnText: "and the fish?", resume: true });
});
