import { mkdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import * as context from "./context-compaction.ts";
import { joinRunningTurn } from "./continuation-turn.ts";
import { _resetPending, drainDelegations, finishDelegatedTurn, queueDelegation, type DelegatedTurn } from "./delegations.ts";
import * as mail from "./mail.ts";
import { closeMessageDb } from "./message-db.ts";
import { composeUserTurnPrompt, turnReplaysTranscript, userTurnReactionKeys } from "./replies.ts";
import { _resetSteerQueue, foldQueuedSends, queueMark } from "./steer-queue.ts";
import { Store } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import * as turns from "./turn-context.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function section(from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < start) throw new Error(`Missing dispatch section: ${from}`);
  return source.slice(start, end);
}

// Run the production recycle, folds, adapter dispatch and acknowledgements without booting the server.
const messaging = section("      const canMessage =", "\n      // @mentions");
const preparation = section("  const hasPriorUserTurn =", "\n  const persona = [");
const marker = "const started = await dispatchAdapterTurn(threadId, async () => {";
const dispatch = section(marker, "\n      });\n      bindInterruptedTurn").slice(marker.length);
const delivery = section("      // a deferred recycle's live session", "\n      store.markReactionsDelivered");
const javascript = ts.transpileModule(`async function run(scope) { with (scope) {
  ${messaging}
  ${preparation}
  const started = await (async () => { ${dispatch} })();
  ${delivery}
  return { started, recycled, resume };
} }`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
const runDispatch = new Function(`${javascript}\nreturn run;`)();

beforeEach(async () => {
  closeMessageDb();
  await removeTempDir(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  _resetPending();
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  _resetPending();
  _resetSteerQueue();
  vi.restoreAllMocks();
});

it.each([false, true])("delivers a full reply once after session recycle (arrives mid-turn: %s)", async (midTurn) => {
  const instanceId = "claude";
  const model = "fake-model";
  const store = new Store(() => ({ instanceId, model }));
  const sender = store.createBot({}, { seedMessages: false });
  const peer = store.createBot({}, { seedMessages: false });
  const threadId = sender.threadId;
  store.appendMessage(threadId, { role: "user", kind: "text", text: "Delegate the verification" });
  store.markTaskDispatched(sender.id, threadId, instanceId, model);
  store.setResumeCursor(sender.id, instanceId, "old-provider-session", threadId);
  store.markResumeSeeded(sender.id, threadId, { instanceId, cursor: "old-provider-session", compactionId: null });
  const wakeSender = vi.fn();
  const bus = { store, broadcast: () => {}, wakeSender };
  const queued = queueDelegation(bus, sender, { toBotId: peer.id, message: "Verify every result", depth: 0 }, 1);
  expect(queued.result).toBe("ok");
  let delegated: DelegatedTurn | undefined;
  drainDelegations(bus, bus, threadId, (toBotId, _text, _depth, sourceThreadId, channel, taskId, sourceBotId) => {
    delegated = { toBotId, sourceThreadId, channelId: channel?.id, taskId, sourceBotId };
  });
  await vi.waitFor(() => expect(delegated?.taskId).toBe(queued.id));
  const reply = `BEGIN-REPLY\n${Array.from({ length: 520 }, (_, i) => `Result ${i}: verified the complete payload.`).join("\n")}\nEND-REPLY`;
  let turnNumber = 0;
  const sendTurn = vi.fn(async (_input: { text: string; transcript: Array<{ text: string }>; resumeCursor?: unknown }) => ({ turnId: `turn-${++turnNumber}` }));
  const instance = { driverKind: "fake", adapter: { capabilities: { sessionModelSwitch: "in-session" }, sendTurn } };

  const send = async (text: string) => {
    const userMessage = store.appendMessage(threadId, { role: "user", kind: "text", text });
    const activeMessages = store.activePath(threadId);
    const skipTranscript = new Set([userMessage.id]);
    const prepared = await context.prepareModelContext({ messages: activeMessages, contextWindow: 200_000, taskRecordText: "", excludeIds: skipTranscript });
    if (prepared.status !== "ready") throw new Error(prepared.status);
    expect(prepared.compacted).toBe(false);
    const task = store.taskByThread(sender.id, threadId)!;
    const result = await runDispatch({
      ...context, ...turns, ...mail, composeUserTurnPrompt, turnReplaysTranscript, userTurnReactionKeys, foldPeerQueuedSends: foldQueuedSends,
      store, bot: sender, threadId, task, instanceId, model, instance,
      text, userMessage, activeMessages, skipTranscript, transcript: prepared.transcript, prepared,
      compactedThisTurn: false, latestCompactionId: null, sessionPrompt: undefined, nativeAt: null,
      currentTurnEpoch: () => 1, epoch: 1, claimMark: queueMark(), isSendCancelled: () => false,
      clearUnattended: () => {}, resumePaneWakes: () => {},
      rewound: false, recovering: false, unsettled: "", recoveryLatestUserText: text,
      opts: {}, cfg: {}, reactions: {}, threadSyncV2: null, accountNotices: { forTurn: () => ({ text: null, commit: () => {} }) }, modelContextWindow: 200_000,
      taskRecord: undefined, durableTaskRecordText: "", contextCompacted: false,
      providerReload: { started: () => instance }, privateWorkspace: false, opensHostFiles: () => false,
      accounts: { snapshot: [] }, workerTurns: { capture() {}, settled() {} },
      paneNoteTurnThreads: new Set(), routineTurnThreads: new Set(),
      persona: "Verify the delegated work.", cwd: ".", projectFolderPrompt: () => "", projectNotesPrompt: () => "",
      computerKind: undefined, integrations: {}, browserPrompt: () => "", coordinationPrompt: "", credentialPrompt: "", routinePrompt: "",
      commsDepth: 0, MAX_COMMS_DEPTH: 1,
      taskStatePrompt: "", reactPrompt: "", showImagePrompt: "", detailedRepliesEnabled: () => false,
      ALWAYS_REPLY_INSTRUCTIONS: "", CORPUS_SEARCH_INSTRUCTIONS: "", keepGoing: { rules: () => "" },
      skillInstructions: "", packagePlaybooks: "", harnessPlaybookPrompt: () => "", tagged: [],
      graceInputs: {}, summaryGrace: {}, summarySkipped: false, logSummaryWait: () => {},
      seed: {}, systemSeed: undefined, systemSeeds: { set: () => ({}) },
      pendingInterruptThreads: { started: () => {} }, effort: undefined, leanStartup: false, isUnattended: () => false,
      joinRunningTurn, runningTurnIdByThread: new Map(),
    });
    store.markTaskDispatched(sender.id, threadId, instanceId, model);
    const cursor = sendTurn.mock.calls.at(-1)![0].resumeCursor ?? "new-provider-session";
    store.setResumeCursor(sender.id, instanceId, cursor, threadId);
    store.markResumeSeeded(sender.id, threadId, { instanceId, cursor, compactionId: null });
    return result;
  };

  if (midTurn) {
    expect((await send("Keep working while the peer verifies")).recycled).toBe(false);
    expect(sendTurn.mock.calls[0][0].resumeCursor).toBe("old-provider-session");
    store.setActivity(sender.id, "working", threadId);
  }
  finishDelegatedTurn(bus, delegated!, true, reply);
  const rows = store.messagesFor(threadId).filter((row) => row.comm?.taskId === queued.id && row.comm?.peer === "reply");
  expect(rows).toHaveLength(1);
  expect(rows[0].text).toBe(reply);
  expect(store.taskByThread(sender.id, threadId)?.mailUnread).toEqual([rows[0].id]);
  if (midTurn) {
    expect(sendTurn.mock.calls[0][0].text).not.toContain(reply);
    expect(wakeSender).not.toHaveBeenCalled();
    mail.settleMail(store, threadId, "turn-1", true);
    expect(mail.unreadMail(store, threadId).map((row) => row.id)).toEqual([rows[0].id]);
    store.setActivity(sender.id, "idle");
  }
  for (let i = 0; i < turns.PRE_COMPACT_TOOL_ROUND_LIMIT; i++) {
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `Read: result-${i}`, ok: true } });
  }
  const recycled = await send("Use the delegated verification");
  expect(recycled).toMatchObject({ recycled: true, resume: false });
  const input = sendTurn.mock.calls.at(-1)![0];
  expect(input.resumeCursor).toBeUndefined();
  expect(input.text).toContain("Wink started a fresh provider session");
  expect(input.text.split(reply)).toHaveLength(2);
  expect(input.transcript.some((row) => row.text.includes(reply))).toBe(false);
  expect(store.messagesFor(threadId).find((row) => row.id === rows[0].id)?.comm?.read).toMatchObject({ state: "read", turnId: recycled.started.turnId, upto: reply.length });
  expect(mail.unreadMail(store, threadId)).toEqual([]);
  const next = await send("Continue after verification");
  expect(next).toMatchObject({ recycled: false, resume: true });
  const following = sendTurn.mock.calls.at(-1)![0];
  expect(following.resumeCursor).toBe("new-provider-session");
  expect(following.text).not.toContain(reply);
  expect(following.text).not.toContain("BEGIN-REPLY");
  expect(mail.mailForTurn(store, threadId)).toEqual([]);
  expect(sendTurn).toHaveBeenCalledTimes(midTurn ? 3 : 2);
});
