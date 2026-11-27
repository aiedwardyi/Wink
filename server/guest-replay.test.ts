import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { closedAskNotes } from "./ask-user.ts";
import { DATA_DIR, ensureDirs } from "./config.ts";
import * as context from "./context-compaction.ts";
import { joinRunningTurn } from "./continuation-turn.ts";
import type { ProviderInstance, SendTurnInput } from "./contracts.ts";
import { GrokAgentDriver } from "./drivers/acp/grok.ts";
import { guestTurnInput } from "./drivers/turn-access.ts";
import * as mail from "./mail.ts";
import { callLinesSinceLastUserTurn } from "./live-call.ts";
import { closeMessageDb } from "./message-db.ts";
import { roomEchoesSinceLastUserTurn } from "./one-mind.ts";
import { GuestSessions } from "./rooms/guest-sessions.ts";
import { quickAnswersSinceLastUserTurn } from "./quick-ask.ts";
import { composeUserTurnPrompt, inertMentions, turnReplaysTranscript, unstampedAsGuest, userTurnReactionKeys } from "./replies.ts";
import { _resetSteerQueue, foldQueuedSends, queueMark } from "./steer-queue.ts";
import { Store } from "./store.ts";
import { asksNudge, isStatusTurn } from "./task-asks.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { recordEvents } from "./testing/events.ts";
import { removeTestData } from "./testing/test-home.ts";
import { isRecoveringPacket, lastUserInstruction, unsettledRequest } from "./task-recovery-flush.ts";
import { recordTaskCompletion, recordTaskInstruction, seedTaskResumePacket } from "./task-state-fold.ts";
import * as turns from "./turn-context.ts";
import { currentTurnTrace, tracePart } from "./turn-timing.ts";
import { retiredPickLines } from "./workspace.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function section(from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < start) throw new Error(`Missing dispatch section: ${from}`);
  return source.slice(start, end);
}

// Run the production recycle, replay and adapter dispatch without booting the server.
const messaging = section("      const canMessage =", "\n      // @mentions");
const preparation = section("  const hasPriorUserTurn =", "\n  const persona = [");
const marker = "const started = await dispatchAdapterTurn(threadId, async () => {";
const dispatch = section(marker, "\n      });\n      bindInterruptedTurn").slice(marker.length);
const javascript = ts.transpileModule(`async function run(scope) { with (scope) {
  ${messaging}
  ${preparation}
  const started = await (async () => { ${dispatch} })();
  return { started, recycled, resume };
} }`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
const runDispatch = new Function(`${javascript}\nreturn run;`)();
// The joined room's startTurn and the user row it appends
const joined = section("  startTurn: (botId, threadId, prompt, typed, failed, readOnly, guest) => {", "\n  readOnlyTurns:");
const append = section("  let userMessage = opts?.userMessage;", "\n  let rootId =");
const rowJavascript = ts.transpileModule(`function row(scope) { with (scope) {
  const opts = ({ ${joined} }).startTurn(bot.id, threadId, text, typed, () => {}, readOnly, guest);
  ${append}
  return { opts, userMessage };
} }`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
const joinedRow = new Function(`${rowJavascript}\nreturn row;`)();
// The task record, the unfinished request and the rows the model context reads
const recorded = section("  const priorTaskPacket = taskPacketForWrite(threadId);", "\n  // the model context below reads the whole chat");
const rows = section("  const taskRows =", "\n  // a teammate's turn leaves");
const before = section("  const messagesBeforeSummary =", "\n  holdNotes?.(messagesBeforeSummary);");
const record = section("  let storedTaskRecord = taskPacketForWrite(threadId);", "\n  const catalogWindow =");
const recordJavascript = ts.transpileModule(`function rec(scope) { with (scope) {
  ${recorded}
  ${rows}
  ${before}
  ${record}
  return { taskRows, messagesBeforeSummary, taskRecord, durableTaskRecordText, unsettled, recovering, recoveryLatestUserText };
} }`, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
const taskRecordOf = new Function(`${recordJavascript}\nreturn rec;`)();

const fakeCli = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const CANARY = "host-only file: canary GJR-7731";
let scratch: string;
const live: ProviderInstance[] = [];
const envBefore = new Map<string, string | undefined>();
const setEnv = (name: string, value: string) => {
  if (!envBefore.has(name)) envBefore.set(name, process.env[name]);
  process.env[name] = value;
};

beforeEach(() => {
  closeMessageDb();
  removeTestData(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  ensureDirs();
  vi.spyOn(console, "info").mockImplementation(() => {});
  scratch = mkdtempSync(join(tmpdir(), "omb-guest-replay-"));
});

afterEach(async () => {
  for (const instance of live.splice(0)) await instance.dispose();
  for (const [name, value] of envBefore) value === undefined ? delete process.env[name] : (process.env[name] = value);
  envBefore.clear();
  _resetSteerQueue();
  vi.restoreAllMocks();
  await removeTempDir(scratch);
});

// A joined room stores the typed words as the task's user row (index.ts startTurn transcriptText), with no author
const rig = async () => {
  const project = join(scratch, "proj");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.txt"), CANARY);
  const elsewhere = join(scratch, "elsewhere.txt");
  writeFileSync(elsewhere, "outside canary");
  const out = join(scratch, "read-out.txt");
  setEnv("FAKE_ACP_MODE", "read");
  setEnv("FAKE_ACP_READ_OUT", out);
  const instance = await GrokAgentDriver.create({ instanceId: "replay-grok", displayName: undefined, environment: {}, enabled: true, config: { cli: fakeCli, fullAuto: true } });
  live.push(instance);
  const sendTurn = vi.spyOn(instance.adapter, "sendTurn");
  const instanceId = "claude";
  const model = "fake-model";
  const store = new Store(() => ({ instanceId, model }));
  const bot = store.createBot({}, { seedMessages: false });
  const threadId = bot.threadId;
  const ref = { sessions: new GuestSessions() };
  const packets = new Map<string, Parameters<typeof recordTaskCompletion>[0]>();
  const settle = (cursor: string) => {
    store.markTaskDispatched(bot.id, threadId, instanceId, model);
    store.setResumeCursor(bot.id, instanceId, cursor, threadId);
    store.markResumeSeeded(bot.id, threadId, { instanceId, cursor, compactionId: null });
  };
  const answer = () => store.appendMessage(threadId, { role: "bot", kind: "text", text: "Answer.", from: { botId: bot.id, name: "Pete", color: bot.color } });
  const send = async (who: "owner" | "guest", typed: string, ended: "ok" | "interrupted" | "failed" = "ok") => {
    const prompt = who === "guest" ? `"Mina" asked you: ${inertMentions(typed)}` : `"Peter" asked you: ${typed}`;
    const { opts, userMessage } = joinedRow({
      store, bot, threadId, text: prompt, typed, readOnly: who === "guest", guest: who === "guest", randomUUID,
      joinedRoomThreads: new Set(), joinedGuestThreads: new Set(), startTurn: (_botId: string, _text: string, startOpts: unknown) => startOpts,
    });
    const task = store.taskByThread(bot.id, threadId)!;
    const skipTranscript = new Set([userMessage.id]);
    const rec = taskRecordOf({
      store, opts, text: prompt, userMessage, task, bot, threadId, skipTranscript, commsDepth: 0, modelContextWindow: 200_000,
      taskPacketForWrite: (id: string) => packets.get(id) ?? null, persistTaskPacket: (packet: Parameters<typeof recordTaskCompletion>[0]) => (packets.set(threadId, packet), packet),
      isRecoveringPacket, recordTaskInstruction, seedTaskResumePacket, lastUserInstruction, unsettledRequest, isStatusTurn, taskRecordBlock: turns.taskRecordBlock,
      closeMergedAsks: () => ({ shown: (packet: unknown) => packet }), roomTaskThreads: () => new Set([threadId]), unstampedAsGuest,
    });
    const activeMessages = rec.messagesBeforeSummary;
    const prepared = await context.prepareModelContext({ messages: activeMessages, contextWindow: 200_000, taskRecordText: rec.durableTaskRecordText, excludeIds: skipTranscript, userName: "Peter", referenceMessages: rec.taskRows(store.messagesFor(threadId)) });
    if (prepared.status !== "ready") throw new Error(prepared.status);
    rmSync(out, { force: true });
    const recorder = recordEvents(instance.adapter);
    await runDispatch({
      ...context, ...turns, ...mail, quickAnswersSinceLastUserTurn, roomEchoesSinceLastUserTurn, callLinesSinceLastUserTurn, closedAskNotes, turnStartedByUser: () => false, composeUserTurnPrompt, turnReplaysTranscript, userTurnReactionKeys, asksNudge, stampShownAsks: () => {}, foldPeerQueuedSends: (store: Parameters<typeof foldQueuedSends>[0], botId: string, threadId: string, since: number) => foldQueuedSends(store, botId, threadId, since), tracePart, trace: currentTurnTrace(),
      store, bot, threadId, task: store.taskByThread(bot.id, threadId)!, instanceId, model, instance,
      text: prompt, userMessage, activeMessages, skipTranscript, transcript: prepared.transcript, prepared,
      compactedThisTurn: false, latestCompactionId: null, sessionPrompt: undefined, nativeAt: null,
      currentTurnEpoch: () => 1, epoch: 1, claimMark: queueMark(), isSendCancelled: () => false,
      clearUnattended: () => {}, resumePaneWakes: () => {},
      rewound: false, recovering: rec.recovering, unsettled: rec.unsettled, recoveryLatestUserText: rec.recoveryLatestUserText,
      opts, cfg: {}, reactions: {}, guestSessions: ref.sessions, threadSyncV2: null, accountNotices: { forTurn: () => ({ text: null, commit: () => {} }) }, modelContextWindow: 200_000, closes: { notes: () => [] },
      taskRecord: rec.taskRecord ?? undefined, durableTaskRecordText: rec.durableTaskRecordText,
      providerReload: { started: () => instance }, aboutYouPrompt: () => "", roomTaskThreads: () => new Set([threadId]), notOwnerChats: () => new Set(), privateWorkspace: false, opensHostFiles: () => false,
      accounts: { snapshot: [] }, workerTurns: { capture() {}, settled() {} },
      paneNoteTurnThreads: new Set(), routineTurnThreads: new Set(),
      persona: "You are Pete.", cwd: project, projectFolderPrompt: () => "", projectNotesPrompt: () => "",
      computerKind: undefined, integrations: {}, browserPrompt: () => "", coordinationPrompt: "", credentialPrompt: "", routinePrompt: "",
      commsDepth: 0, MAX_COMMS_DEPTH: 1,
      taskStatePrompt: "", reactPrompt: "", showImagePrompt: "", detailedRepliesEnabled: () => false,
      ALWAYS_REPLY_INSTRUCTIONS: "", DEFAULT_RULES: "", accessRules: () => "", keepGoing: { rules: () => "" },
      skillInstructions: "", packagePlaybooks: "", harnessPlaybookPrompt: () => "", tagged: [],
      graceInputs: {}, summaryGrace: {}, summarySkipped: false, codexHistory: false, logSummaryWait: () => {},
      seed: {}, systemSeed: undefined, systemSeeds: { set: () => ({}) },
      pendingInterruptThreads: { started: () => {} }, effort: undefined, leanStartup: false, isUnattended: () => false, turnCwdByThread: new Map(),
      joinRunningTurn, guestTurnInput, runningTurnIdByThread: new Map(), readOnly: opts.readOnly === true, retiredPickLines,
    });
    expect(await recorder.until((e) => e.type === "turn.completed" && e.threadId === threadId)).toMatchObject({ ok: true });
    const sent = sendTurn.mock.calls.at(-1)![0] as SendTurnInput;
    settle((sent.resumeCursor as string | undefined) ?? `${who}-session-${sendTurn.mock.calls.length}`);
    // a Stop, an engine error or a quit leaves the turn unsettled, as index.ts records it
    const reply = ended === "ok" ? answer() : undefined;
    packets.set(threadId, recordTaskCompletion(packets.get(threadId)!, { ok: ended !== "failed", ...(ended === "interrupted" && { interrupted: true }), reply: reply?.text ?? "", messageId: reply?.id, now: Date.now(), turnsAtWrite: 0 }));
    return { read: existsSync(out) ? readFileSync(out, "utf8") : null, sent, unsettled: rec.unsettled as string };
  };
  // a row as Wink wrote it before the guest stamp: the typed words, no author, no stamp
  const old = (typed: string) => {
    store.appendMessage(threadId, { role: "user", kind: "text", text: typed });
    answer();
    settle(`old-session-${store.messagesFor(threadId).length}`);
  };
  return { send, old, restart: () => { ref.sessions = new GuestSessions(); }, ask: `@Pete-Coder what does @notes.txt say? and @${elsewhere}` };
};

// GATE-REVIEW-2239G: a guest turn that starts over replays the task, whose rows keep a guest's typed words raw
it.each([["the owner's turn", "owner"], ["a Wink restart", "restart"]] as const)("a guest turn that starts over after %s inlines no file a guest's earlier @path named", async (_between, between) => {
  const r = await rig();
  expect((await r.send("guest", r.ask)).read).toBeNull();
  if (between === "owner") await r.send("owner", "@Pete-Coder thanks");
  else r.restart();
  const again = await r.send("guest", "@Pete-Coder and now?");
  expect(again.sent.resumeCursor).toBeUndefined();
  expect(again.read).toBeNull();
  for (const text of [again.sent.text, ...(again.sent.transcript ?? []).map((line) => line.text)]) expect(text).not.toMatch(/@(?!\u200B)/);
}, 30_000);

// GATE-REVIEW-2239I: the owner's next turn that starts over replays the joined task, a guest's row included
it.each([["@Pete-Coder thanks", 0], ["@Pete-Coder what does @notes.txt say?", 1]] as const)("an owner turn that starts over after a guest's @path inlines only the owner's own: %s", async (typed, own) => {
  const r = await rig();
  expect((await r.send("guest", r.ask)).read).toBeNull();
  setEnv("FAKE_ACP_LOAD_FAILS", "1");
  const owner = await r.send("owner", typed);
  // the owner's tools read notes.txt once on their own; a live @notes.txt, in the text or the task record, inlines more
  expect((owner.read?.split(CANARY).length ?? 0) > 2).toBe(own === 1);
  expect(owner.read).not.toContain("outside canary");
  expect([owner.sent.text, owner.sent.resumeFallback?.text, ...(owner.sent.transcript ?? []).map((line) => line.text)].some((text) => text?.includes(inertMentions(r.ask)))).toBe(true);
  expect(owner.sent.text).toContain(typed);
}, 30_000);

// GATE-REVIEW-2245A must-fix 1: a guest turn that never settles rides the owner's next turn as its unfinished request
it.each(["interrupted", "failed"] as const)("an owner turn after a guest turn that %s carries the guest's words with no live @", async (ended) => {
  const r = await rig();
  expect((await r.send("guest", r.ask, ended)).read).toBeNull();
  const owner = await r.send("owner", "@Pete-Coder thanks");
  expect(owner.sent.resumeCursor).toBeDefined();
  expect(owner.unsettled).toBe(inertMentions(r.ask));
  expect(owner.sent.text).toContain(`Unfinished request: ${inertMentions(r.ask)}`);
  expect(owner.read?.split(CANARY).length).toBe(2);
  expect(owner.read).not.toContain("outside canary");
}, 30_000);

it("an owner's own unfinished request still carries as typed", async () => {
  const r = await rig();
  await r.send("owner", r.ask, "interrupted");
  const owner = await r.send("owner", "@Pete-Coder go on");
  expect(owner.unsettled).toBe(r.ask);
  expect(owner.read).toContain("outside canary");
}, 30_000);

// GATE-REVIEW-2245A must-fix 2: a joined room's rows from before the stamp may be a guest's
it("an owner turn that starts over in a room task inlines no file an unstamped row names, and still the owner's stamped one", async () => {
  const r = await rig();
  r.old(r.ask);
  setEnv("FAKE_ACP_LOAD_FAILS", "1");
  const after = await r.send("owner", "@Pete-Coder thanks");
  expect(after.read).not.toContain("outside canary");
  expect(after.read?.split(CANARY).length).toBe(2);
  expect(after.sent.resumeFallback?.text).toContain(inertMentions(r.ask));
  const own = await rig();
  setEnv("FAKE_ACP_LOAD_FAILS", "");
  await own.send("owner", own.ask);
  setEnv("FAKE_ACP_LOAD_FAILS", "1");
  expect((await own.send("owner", "@Pete-Coder thanks")).read).toContain("outside canary");
}, 30_000);

it("reads a room task's rows for the model through taskRows", () => {
  const turn = section("async function startClaimedTurn(", "\nasync function ");
  expect(turn.match(/referenceMessages: (?!taskRows\()/g), "wrap the rows in taskRows so a room task's unstamped row reads as a guest's").toBeNull();
  expect(turn).toContain("const messagesBeforeSummary = taskRows(store.activePath(threadId));");
  expect(turn).toContain("messages: taskRows(messages),");
});

it("hands every engine send and steer in index.ts through guestTurnInput", () => {
  expect(source.match(/\.sendTurn\((?!input\)|guestTurnInput\()/g), "build the input with guestTurnInput (drivers/turn-access.ts) so a guest turn's every text is inert").toBeNull();
  expect(source.match(/joinRunningTurn\(live\.adapter, (?!input,)/g), "steer with the guestTurnInput-built input").toBeNull();
  expect(source).toContain("const input = guestTurnInput({");
});

it("guestTurnInput breaks every @ a guest turn sends and leaves an owner's or owner lane's input untouched", () => {
  const turn = { threadId: "t", text: "@a", resumeFallback: { text: "@b" }, transcript: [{ role: "user" as const, text: "@c" }], nativeReplayPrefix: "@d", system: "@ another bot" };
  expect(guestTurnInput(turn)).toBe(turn);
  expect(guestTurnInput({ ...turn, readOnly: true, ownerText: true }).text).toBe("@a");
  expect(guestTurnInput({ ...turn, readOnly: true })).toEqual({ ...turn, readOnly: true, text: "@\u200Ba", resumeFallback: { text: "@\u200Bb" }, transcript: [{ role: "user", text: "@\u200Bc" }], nativeReplayPrefix: "@\u200Bd" });
});

it("an owner turn's own @path still reads, with its words as typed", async () => {
  const r = await rig();
  const owner = await r.send("owner", "@Pete-Coder what does @notes.txt say?");
  expect(owner.read).toContain(CANARY);
  expect(owner.sent.text).toContain("@Pete-Coder what does @notes.txt say?");
}, 30_000);
