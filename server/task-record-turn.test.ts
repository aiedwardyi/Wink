import { mkdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { closedAskNotes } from "./ask-user.ts";
import { DATA_DIR } from "./config.ts";
import * as context from "./context-compaction.ts";
import * as mail from "./mail.ts";
import { closeMessageDb } from "./message-db.ts";
import { quickAnswersSinceLastUserTurn } from "./quick-ask.ts";
import { composeUserTurnPrompt, turnReplaysTranscript, userTurnReactionKeys } from "./replies.ts";
import { Store } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import * as turns from "./turn-context.ts";

// Run the production turn-text preparation without booting the server.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("  let transcript = prepared.transcript;");
const end = source.indexOf("\n  const persona = [", start);
if (start < 0 || end < start) throw new Error("Missing turn preparation section");
const javascript = ts.transpileModule(`function run(scope) { with (scope) {
  ${source.slice(start, end)}
  return { turnText, resume };
} }`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
const prepareTurn = new Function(`${javascript}\nreturn run;`)();

const RECORD = "[Wink task record]\nGoal: ship the trim";

beforeEach(async () => {
  closeMessageDb();
  await removeTempDir(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("sends the task record only when the session restarts or a summary lands", async () => {
  const instanceId = "claude";
  const model = "claude-opus-5-5";
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

  const send = async (text: string, landed = false) => {
    const userMessage = store.appendMessage(threadId, { role: "user", kind: "text", text });
    const activeMessages = store.activePath(threadId);
    const skipTranscript = new Set([userMessage.id]);
    const ready = await context.prepareModelContext({ messages: activeMessages, contextWindow: 200_000, taskRecordText: RECORD, excludeIds: skipTranscript });
    if (ready.status !== "ready") throw new Error(ready.status);
    expect(ready.compacted).toBe(true);
    expect(ready.compaction).toBeUndefined();
    const prepared = landed ? { ...ready, compaction: store.activePath(threadId).find((row) => row.id === summary.id)!.compaction } : ready;
    const turn = prepareTurn({
      ...context, ...turns, ...mail, quickAnswersSinceLastUserTurn, closedAskNotes, turnStartedByUser: () => false, composeUserTurnPrompt, turnReplaysTranscript, userTurnReactionKeys,
      store, bot, threadId, task: store.taskByThread(bot.id, threadId)!, instanceId, model, instance,
      text, userMessage, activeMessages, skipTranscript, prepared,
      latestCompactionId: summary.id, sessionPrompt: undefined, nativeAt: landed ? 1 : null,
      currentTurnEpoch: () => 0, epoch: 1,
      rewound: false, recovering: false, unsettled: "", recoveryLatestUserText: text,
      opts: {}, cfg: {}, reactions: {}, threadSyncV2: null, accountNotices: { forTurn: () => ({ text: null }) }, modelContextWindow: 200_000,
      taskRecord: undefined, durableTaskRecordText: RECORD,
    });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: "ok" });
    return turn;
  };

  for (const text of ["and the cat?", "and the fish?", "and the bird?"]) {
    expect(await send(text)).toEqual({ turnText: text, resume: true });
  }
  expect(await send("and the horse?", true)).toEqual({ turnText: `${RECORD}\n\nand the horse?`, resume: true });
  store.clearResumeCursors(bot.id, threadId);
  const restarted = await send("and the goat?");
  expect(restarted.resume).toBe(false);
  expect(restarted.turnText.startsWith(`${RECORD}\n\n`)).toBe(true);
});
