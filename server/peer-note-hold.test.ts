// A worker note that reaches a bot while it answers another bot. The real
// delegation, steer, takeover, wake, ask and context modules run; index.ts's
// wiring is copied below and pinned to its source.
import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ASK_BOT_TIMEOUT_MS, waitForPeerReply, type AskReply } from "./ask-bot.ts";
import { _resetCommsRoots, rootForStart } from "./comms-root.ts";
import type { CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { holdWorkerNotes, paneNotesForTurn, paneNotesSinceLastUserTurn, prepareModelContext, withoutTurnNotes } from "./context-compaction.ts";
import type { ProviderAdapter, RuntimeEvent } from "./contracts.ts";
import {
  _pendingCount,
  _resetPending,
  drainDelegations,
  findDelegationReceipt,
  finishDelegatedTurn,
  queueDelegation,
  settleTakenOverDelegation,
  type DelegatedTurn,
} from "./delegations.ts";
import { hasUnreadReplyWake } from "./mail.ts";
import { NoteSteerer, steerUntilTaken } from "./note-steer.ts";
import { paneWakeEnabled, PaneWakeScheduler, PANE_WAKE_DEBOUNCE_MS } from "./pane-wake.ts";
import { askSwitchedText, hasPeerWatch, onPeerTakeover, peerInputJoined, steerTakeover, takeOverPeerTurn } from "./peer-takeover.ts";
import { peerTurnReplies, type PeerTurnReply } from "./peer-turn-reply.ts";
import { _resetSteerQueue } from "./steer-queue.ts";
import { Store, type BotRecord, type GroupRecord, type Message } from "./store.ts";
import { buildResumeFallback } from "./turn-context.ts";
import { ownTurnReply } from "./turn-reply.ts";

// server/testing/setup.ts moves HOME to a throwaway dir; never touch the real ~/.orbit
if (!DATA_DIR.includes("omb-test-home-")) throw new Error(`refusing to run against ${DATA_DIR}`);

const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const NOTE = "[pane worker01] DONE: ram gate fixed, tests pass";
const NOTE_BODY = "ram gate fixed";
const ANSWER = "Yes, the ko check runs in the release gate.";
const QUESTION = "Is the ko check in the release gate?";
type Watched = DelegatedTurn & { sourceThreadId: string; endTakeover?: () => void; reply: PeerTurnReply };

describe("worker notes while a bot answers a bot", () => {
  let store: Store;
  let pokkey: BotRecord;
  let wink: BotRecord;
  let atlas: BotRecord;
  let commsBus: CommsBus;
  let root: string;
  let dispatched: Array<{ toBotId: string; message: string; taskId: string; channel?: GroupRecord }>;
  let busy: Set<string>;
  let steered: string[];
  let woken: Array<{ threadId: string; notes: string[] }>;
  let paneWake: PaneWakeScheduler;
  let steerer: NoteSteerer;
  let turns: Map<string, string>;
  const senderWakes = vi.fn();
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const delegationWatch = new Map<string, Watched>();
  let peerReplies: ReturnType<typeof peerTurnReplies>;

  beforeEach(() => {
    vi.useFakeTimers();
    rmSync(DATA_DIR, { recursive: true, force: true });
    _resetPending();
    _resetSteerQueue();
    _resetCommsRoots();
    delegationWatch.clear();
    listeners.clear();
    senderWakes.mockClear();
    peerReplies = peerTurnReplies(() => false);
    store = new Store(() => ({ instanceId: "claude", model: "fake-model" }));
    pokkey = store.patchBot(store.createBot().id, { name: "Pokkey" })!;
    wink = store.patchBot(store.createBot().id, { name: "Wink" })!;
    atlas = store.patchBot(store.createBot().id, { name: "Atlas" })!;
    commsBus = { store, broadcast: () => {}, wakeSender: senderWakes };
    root = rootForStart(pokkey.threadId, { kind: "human", messageKey: "send-1105" })!;
    dispatched = [];
    busy = new Set();
    steered = [];
    woken = [];
    turns = new Map();
    paneWake = new PaneWakeScheduler({
      enabled: (botId, threadId) => hasUnreadReplyWake(store, threadId) || paneWakeEnabled(store, botId, threadId),
      paused: () => false,
      busy: (_botId, threadId) => busy.has(threadId),
      hasNotes: paneNotesPending,
      // a wake turn folds what is pending, as startTurn does for a resumed session
      wake: (botId, threadId) => {
        const { notes, newestId } = paneNotesForTurn(store.activePath(threadId), new Set(), deliveredId(threadId), false);
        woken.push({ threadId, notes });
        store.markPaneNotesDelivered(botId, threadId, newestId);
      },
      warn: () => {},
    });
    // an engine that reports the read at its next model request (Claude)
    const adapter = {
      capabilities: { queueing: true, steerConsumed: true } as ProviderAdapter["capabilities"],
      steer: async (_threadId: string, text: string, consumed?: (taken: boolean) => void) => {
        steered.push(text);
        queueMicrotask(() => consumed?.(true));
        return true;
      },
    };
    steerer = new NoteSteerer({
      enabled: (botId) => store.bot(botId)?.shareTerminalWithChat !== false,
      paused: () => false,
      holds: hasPeerWatch,
      liveTurn: (_botId, threadId) => (busy.has(threadId) ? "turn-live" : undefined),
      busy: (_botId, threadId) => busy.has(threadId),
      steer: (_botId, threadId, text) => steerUntilTaken(adapter, threadId, text, () => peerInputJoined(threadId)),
      messages: (threadId) => store.activePath(threadId),
      deliveredId: (_botId, threadId) => deliveredId(threadId),
      markDelivered: (botId, threadId, noteId) => store.markPaneNotesDelivered(botId, threadId, noteId),
      wake: (botId, threadId, paneId) => paneWake.noteArrived(botId, threadId, paneId),
    });
  });
  afterEach(() => {
    _resetPending();
    _resetSteerQueue();
    vi.useRealTimers();
  });

  const botOf = (threadId: string) => store.botByThread(threadId)!;
  const deliveredId = (threadId: string) => store.taskByThread(botOf(threadId).id, threadId)?.paneNotesDeliveredId ?? undefined;

  function paneNotesPending(threadId: string): boolean {
    const bot = store.botByThread(threadId);
    const deliveredId = bot ? store.taskByThread(bot.id, threadId)?.paneNotesDeliveredId : undefined;
    return hasUnreadReplyWake(store, threadId) || paneNotesSinceLastUserTurn(store.activePath(threadId), new Set(), deliveredId ?? undefined, true).length > 0;
  }

  function finalizeDelegationWatch(threadId: string, ok: boolean, reply = "", failureName = "Delegated turn did not finish") {
    const watched = delegationWatch.get(threadId);
    if (!watched) return false;
    delegationWatch.delete(threadId);
    watched.endTakeover?.();
    watched.reply.release();
    return finishDelegatedTurn(commsBus, watched, ok, reply, failureName);
  }

  function watchDelegatedTurn(targetThreadId: string, watched: Watched) {
    delegationWatch.set(targetThreadId, watched);
    watched.endTakeover = onPeerTakeover(targetThreadId, (afterReply) => {
      watched.reply.release();
      const finished = afterReply ? watched.reply.text() : undefined;
      if (finished !== undefined) delegationWatch.delete(targetThreadId);
      settleTakenOverDelegation(commsBus, watched, "Edward", finished);
    }, () => {
      watched.answer ??= watched.reply.text() ?? "";
    });
  }

  // the bus: collectors first, then the main fold, then later subscribers (ask_bot)
  function emit(threadId: string, patch: Record<string, unknown>) {
    const event = { provider: "claude", eventId: crypto.randomUUID(), createdAt: new Date().toISOString(), threadId, turnId: turns.get(threadId), ...patch } as RuntimeEvent;
    peerReplies.observe(event);
    if (event.type === "item.completed" && event.itemType === "assistant_text" && !event.summarized) store.appendMessage(threadId, { role: "bot", kind: "text", text: event.text });
    if (event.type === "turn.completed") {
      busy.delete(threadId);
      finalizeDelegationWatch(threadId, event.ok, delegationWatch.get(threadId)?.reply.text() ?? "");
    }
    for (const listener of listeners) listener(event);
    if (event.type === "turn.completed") paneWake.settled();
  }
  const say = (threadId: string, text: string, phase?: string) => emit(threadId, { type: "item.completed", itemType: "assistant_text", text, phase });
  const callTool = (threadId: string) => emit(threadId, { type: "item.completed", itemType: "tool", itemId: "call-1" });
  const complete = (threadId: string, ok = true) => emit(threadId, { type: "turn.completed", ok });
  function begin(threadId: string, message: string, from?: BotRecord) {
    store.appendMessage(threadId, { role: "user", kind: "text", text: message, from: from && { botId: from.id, name: from.name, color: from.color } });
    busy.add(threadId);
    turns.set(threadId, crypto.randomUUID());
    emit(threadId, { type: "turn.started" });
  }

  // runDelegatedTurn: watch with a fresh collector, then startTurn
  const runTarget = (toBotId: string, message: string, _depth: number, sourceThreadId: string, channel: GroupRecord | undefined, taskId: string, sourceBotId: string) => {
    const targetThreadId = store.bot(toBotId)!.threadId;
    watchDelegatedTurn(targetThreadId, { channelId: channel?.id, toBotId, taskId, sourceThreadId, sourceBotId, reply: peerReplies.start(targetThreadId) });
    dispatched.push({ toBotId, message, taskId, channel });
  };
  async function drain(count: number) {
    drainDelegations(commsBus, { store, broadcast: () => {} }, pokkey.threadId, runTarget);
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatched).toHaveLength(count);
    expect(_pendingCount(pokkey.threadId)).toBe(0);
  }
  async function handoff(target = wink) {
    const queued = queueDelegation(commsBus, pokkey, { toBotId: target.id, message: QUESTION, depth: 0, root }, 1);
    return queued.id!;
  }

  // startTurn's context wiring for one replay mode, with the production hold
  async function startFold(threadId: string, replay: "resume" | "native" | "inline") {
    const messages = store.activePath(threadId);
    const userMessage = messages.findLast((message) => message.role === "user")!;
    const skipTranscript = new Set([userMessage.id]);
    const delivered = deliveredId(threadId);
    const holdNotes = hasPeerWatch(threadId) ? (rows: Message[]) => holdWorkerNotes(rows, skipTranscript, delivered) : undefined;
    holdNotes?.(messages);
    const replaysTranscript = replay !== "resume";
    const { notes, newestId } = paneNotesForTurn(messages, skipTranscript, delivered, replaysTranscript, replay === "inline", 200_000);
    const prepared = await prepareModelContext({ messages, contextWindow: 200_000, taskRecordText: "", excludeIds: skipTranscript });
    if (prepared.status !== "ready") throw new Error(prepared.status);
    const transcript = withoutTurnNotes(prepared.transcript, notes);
    const prompt = notes.length ? [...notes, "Current message:", userMessage.text].join("\n\n") : userMessage.text!;
    const sent = replay === "inline" ? buildResumeFallback({ text: prompt, transcript }) : prompt;
    store.markPaneNotesDelivered(botOf(threadId).id, threadId, holdNotes ? undefined : newestId);
    return { sent, transcript: JSON.stringify(transcript) };
  }

  function edwardWritesMidTurn(text: string) {
    const takeover = steerTakeover(wink.threadId, true);
    takeover.consumed(true, false);
    takeover.accepted();
    store.appendMessage(wink.threadId, { role: "user", kind: "text", text, steered: true });
  }

  async function workerNote(threadId = wink.threadId, text = NOTE, extra: Partial<Message> = {}) {
    store.appendMessage(threadId, { role: "bot", kind: "note", text, ...extra });
    await steerer.noteArrived(botOf(threadId).id, threadId, "worker01");
    await vi.advanceTimersByTimeAsync(0);
  }

  const threads = () => [pokkey.threadId, ...[store.dmGroup(pokkey.id, wink.id)?.threadId ?? [], store.dmGroup(pokkey.id, atlas.id)?.threadId ?? []].flat()];
  const taskRows = (taskId: string) => threads().flatMap((threadId) => store.messagesFor(threadId).filter((m) => m.comm?.taskId === taskId));

  function expectAnswered(taskId: string, answer = ANSWER) {
    expect(findDelegationReceipt(taskId)).toMatchObject({ status: "done", result: answer });
    const rows = taskRows(taskId);
    const replies = rows.filter((m) => m.comm?.peer === "reply");
    expect(replies.map((m) => m.text)).toEqual(replies.map(() => answer));
    expect(new Set(replies.map((m) => m.comm?.mailKey)).size).toBe(replies.length);
    expect(store.messagesFor(pokkey.threadId).filter((m) => m.comm?.taskId === taskId && m.comm.peer === "reply")).toHaveLength(1);
    const keys = threads().flatMap((threadId) => store.messagesFor(threadId).map((m) => m.comm?.mailKey).filter(Boolean));
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.map((m) => m.tool?.name)).not.toContain("Delegated turn completed");
    expect(rows.some((m) => m.text?.includes(NOTE_BODY))).toBe(false);
    expect(senderWakes.mock.calls.length).toBeLessThanOrEqual(1);
  }

  async function expectOneWake(threadId = wink.threadId, body = NOTE_BODY) {
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    const mine = () => woken.filter((wake) => wake.threadId === threadId);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]!.notes.join("\n")).toContain(body);
    paneWake.settled();
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS * 2);
    expect(mine()).toHaveLength(1);
    expect(paneNotesPending(threadId)).toBe(false);
  }

  it("pins the copied wiring to index.ts", () => {
    const fold = index.indexOf("bus.subscribe((event: RuntimeEvent) => {\n  peerReplies.observe(event);");
    expect(fold).toBeGreaterThan(-1);
    expect(index.indexOf("finalizeDelegationWatch(event.threadId, event.ok, delegationWatch.get(event.threadId)?.reply.text() ?? \"\");")).toBeGreaterThan(fold);
    for (const line of [
      "  holds: hasPeerWatch,",
      "    return steerUntilTaken(adapter, threadId, text, () => peerInputJoined(threadId));",
      "  const holdNotes = hasPeerWatch(threadId) ? (messages: Message[]) => holdWorkerNotes(messages, skipTranscript, task.paneNotesDeliveredId ?? undefined) : undefined;",
      "  const messagesBeforeSummary = store.activePath(threadId);\n  holdNotes?.(messagesBeforeSummary);\n",
      "  const activeMessages = summarySkipped ? messagesBeforeSummary : store.activePath(threadId);\n  holdNotes?.(activeMessages);\n",
      "skipTranscript.add(message.id);\n            holdNotes?.(messages);\n            const refreshedNotes = paneNotesForTurn(messages, skipTranscript,",
      "      if (holdNotes) newestPaneNoteId = undefined;\n      // a deferred recycle's live session",
      "      store.markPaneNotesDelivered(bot.id, threadId, newestPaneNoteId);",
      "  watched.reply.release();\n  return finishDelegatedTurn(commsBus, watched, ok, reply, failureName);",
      "    watched.reply.release();\n    // a reply that finished before the read settles now; the turn's later end finds no watch\n    const finished = afterReply ? watched.reply.text() : undefined;",
      "    watched.answer ??= watched.reply.text() ?? \"\";",
      "watchDelegatedTurn(targetThreadId, { channelId: channel?.id, toBotId, taskId, sourceThreadId, sourceBotId, ask, reply: peerReplies.start(targetThreadId) });",
      "  const collected = peer ? peerReplies.start(threadId) : undefined;\n  return waitForPeerReply({",
      "sourceBotId: peer.sender.id, ask: true, reply: collected! });",
      "    if (!reply.taskId) {\n      peerTurnSource.delete(threadId);\n      collected?.release();\n    }",
      "  return hasUnreadReplyWake(store, threadId) || paneNotesSinceLastUserTurn(store.activePath(threadId), new Set(), deliveredId ?? undefined, true).length > 0;",
    ]) expect(index, line).toContain(line);
    expect(index).not.toContain("lastReply.get(targetThreadId)");
  });

  it("11-05: takeover, rerun, a note before the rerun's first text; Pokkey gets the answer and the note wakes Wink once", async () => {
    const taskId = await handoff();
    await drain(1);
    begin(wink.threadId, QUESTION, pokkey);
    edwardWritesMidTurn("Wink, what's left on DOG?");
    say(wink.threadId, "Edward, DOG has one card left.");
    complete(wink.threadId);
    expect(findDelegationReceipt(taskId)?.state).toBe("ready");

    await drain(2);
    expect(dispatched[1]!.message).toContain("Your earlier reply went to Edward");
    begin(wink.threadId, dispatched[1]!.message, pokkey);
    await workerNote();
    callTool(wink.threadId);
    say(wink.threadId, ANSWER);
    complete(wink.threadId);

    expectAnswered(taskId);
    expect(steered).toEqual([]);
    expect(woken).toEqual([]);
    await expectOneWake();
    expect(peerReplies._live()).toBe(0);
  });

  it("a plain handoff whose first read would be a note keeps its answer", async () => {
    const taskId = await handoff();
    await drain(1);
    begin(wink.threadId, QUESTION, pokkey);
    await workerNote();
    say(wink.threadId, ANSWER);
    complete(wink.threadId);

    expectAnswered(taskId);
    expect(steered).toEqual([]);
    await expectOneWake();
  });

  it("sends the whole turn's text, not only its last item", async () => {
    const taskId = await handoff();
    await drain(1);
    begin(wink.threadId, QUESTION, pokkey);
    say(wink.threadId, ANSWER);
    callTool(wink.threadId);
    say(wink.threadId, "Done.");
    complete(wink.threadId);
    expectAnswered(taskId, `${ANSWER}\nDone.`);
  });

  it("settles a reply that finished before Edward's message was read with the whole turn", async () => {
    const taskId = await handoff();
    await drain(1);
    begin(wink.threadId, QUESTION, pokkey);
    say(wink.threadId, "Checking.");
    say(wink.threadId, ANSWER);
    const takeover = steerTakeover(wink.threadId, true);
    takeover.consumed(true, true);
    takeover.accepted();
    say(wink.threadId, "Edward, DOG has one card left.");
    complete(wink.threadId);
    expectAnswered(taskId, `Checking.\n${ANSWER}`);
    expect(peerReplies._live()).toBe(0);
  });

  it("fails a handoff that only called tools, red and unwoken", async () => {
    const taskId = await handoff();
    await drain(1);
    begin(wink.threadId, QUESTION, pokkey);
    callTool(wink.threadId);
    emit(wink.threadId, { type: "item.completed", itemType: "assistant_text", text: "Checked the logs.", summarized: true });
    complete(wink.threadId);
    expect(findDelegationReceipt(taskId)).toMatchObject({ status: "failed", result: "No reply from @Wink" });
    expect(taskRows(taskId).filter((m) => m.comm?.peer === "reply")).toEqual([]);
    expect(taskRows(taskId).some((m) => m.tool?.name === "No reply from @Wink" && m.tool.ok === false)).toBe(true);
    expect(senderWakes).not.toHaveBeenCalled();
  });

  it("backstop: a note the turn still reads freezes everything before it once", async () => {
    const taskId = await handoff();
    await drain(1);
    begin(wink.threadId, QUESTION, pokkey);
    say(wink.threadId, "Let me check.");
    say(wink.threadId, ANSWER);
    peerInputJoined(wink.threadId);
    say(wink.threadId, "worker01 says the ram gate is fixed.");
    peerInputJoined(wink.threadId);
    complete(wink.threadId);
    expectAnswered(taskId, `Let me check.\n${ANSWER}`);
  });

  it.each([["resume"], ["native"], ["inline"]] as const)("holds an idle arrival and a preparing arrival out of a %s peer start, then delivers each once", async (replay) => {
    store.appendMessage(wink.threadId, { role: "user", kind: "text", text: "Watch worker01" });
    const earlier = store.appendMessage(wink.threadId, { role: "bot", kind: "note", text: "[pane worker01] STARTED: ram gate" });
    store.markPaneNotesDelivered(wink.id, wink.threadId, earlier.id);
    await workerNote();
    expect(steered).toEqual([]);
    const taskId = await handoff();
    await drain(1);
    begin(wink.threadId, QUESTION, pokkey);
    await workerNote(wink.threadId, "[pane worker02] DONE: ko lint clean");
    const start = await startFold(wink.threadId, replay);
    for (const body of [NOTE_BODY, "ko lint clean"]) {
      expect(start.sent).not.toContain(body);
      expect(start.transcript).not.toContain(body);
    }
    expect(deliveredId(wink.threadId)).toBe(earlier.id);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(woken).toEqual([]);
    say(wink.threadId, ANSWER);
    complete(wink.threadId);
    expectAnswered(taskId);
    await expectOneWake();
    expect(woken[0]!.notes.join("\n")).toContain("ko lint clean");

    begin(wink.threadId, "Wink, what's left on DOG?");
    const next = await startFold(wink.threadId, replay);
    // once as history where history is replayed, never again as a turn note
    const count = (text: string) => text.split(NOTE_BODY).length - 1;
    expect(count(next.sent)).toBe(replay === "inline" ? 1 : 0);
    if (replay !== "resume") expect(count(next.transcript)).toBe(1);
  });

  it("still folds a pending note into Edward's own turn", async () => {
    store.appendMessage(wink.threadId, { role: "bot", kind: "note", text: NOTE });
    begin(wink.threadId, "Wink, what's left on DOG?");
    const start = await startFold(wink.threadId, "resume");
    expect(start.sent).toContain(NOTE_BODY);
    expect(deliveredId(wink.threadId)).toBeDefined();
  });

  it("keeps notes held through a queued takeover fold and its rerun, then delivers them once", async () => {
    const taskId = await handoff();
    await drain(1);
    begin(wink.threadId, QUESTION, pokkey);
    await workerNote();
    const messages = store.activePath(wink.threadId);
    const skip = new Set([messages.at(-2)!.id]);
    const holdNotes = hasPeerWatch(wink.threadId) ? (rows: Message[]) => holdWorkerNotes(rows, skip, deliveredId(wink.threadId)) : undefined;
    holdNotes?.(messages);
    store.appendMessage(wink.threadId, { role: "user", kind: "text", text: "Wink, what's left on DOG?", steered: true });
    takeOverPeerTurn(wink.threadId);
    holdNotes?.(store.activePath(wink.threadId));
    expect(paneNotesForTurn(store.activePath(wink.threadId), skip, deliveredId(wink.threadId), false).notes).toEqual([]);
    store.markPaneNotesDelivered(wink.id, wink.threadId, holdNotes ? undefined : "moved");
    say(wink.threadId, "Edward, DOG has one card left.");
    complete(wink.threadId);

    await drain(2);
    begin(wink.threadId, dispatched[1]!.message, pokkey);
    expect((await startFold(wink.threadId, "resume")).sent).not.toContain(NOTE_BODY);
    say(wink.threadId, ANSWER);
    complete(wink.threadId);
    expectAnswered(taskId);
    await expectOneWake();
  });

  it("keeps two peer tasks apart: own text, own note, own wake, one reply each", async () => {
    const winkTask = await handoff(wink);
    const atlasTask = await handoff(atlas);
    await drain(2);
    begin(wink.threadId, QUESTION, pokkey);
    begin(atlas.threadId, QUESTION, pokkey);
    await workerNote(wink.threadId, "[pane worker01] DONE: wink build green");
    await workerNote(atlas.threadId, "[pane worker09] DONE: atlas build green");
    say(atlas.threadId, "Atlas: yes.");
    say(wink.threadId, ANSWER);
    complete(atlas.threadId);
    say(wink.threadId, "Done.");
    complete(wink.threadId);
    expect(steered).toEqual([]);
    expect(findDelegationReceipt(winkTask)).toMatchObject({ status: "done", result: `${ANSWER}\nDone.` });
    expect(findDelegationReceipt(atlasTask)).toMatchObject({ status: "done", result: "Atlas: yes." });
    for (const taskId of [winkTask, atlasTask]) expect(store.messagesFor(pokkey.threadId).filter((m) => m.comm?.taskId === taskId && m.comm.peer === "reply")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS);
    expect(woken.map((wake) => [wake.threadId, wake.notes.length])).toEqual(expect.arrayContaining([[wink.threadId, 1], [atlas.threadId, 1]]));
    expect(woken.find((wake) => wake.threadId === wink.threadId)!.notes.join()).toContain("wink build green");
    expect(woken.find((wake) => wake.threadId === atlas.threadId)!.notes.join()).toContain("atlas build green");
    expect(woken.filter((wake) => !store.botByThread(wake.threadId))).toEqual([]);
    expect(peerReplies._live()).toBe(0);
  });

  it("with sharing off holds an ordinary note for Edward's next turn, while a report note still wakes", async () => {
    store.patchBot(wink.id, { shareTerminalWithChat: false });
    store.appendMessage(wink.threadId, { role: "user", kind: "text", text: "Watch worker01" });
    const taskId = await handoff();
    await drain(1);
    begin(wink.threadId, QUESTION, pokkey);
    await workerNote();
    say(wink.threadId, ANSWER);
    complete(wink.threadId);
    expectAnswered(taskId);
    await vi.advanceTimersByTimeAsync(PANE_WAKE_DEBOUNCE_MS * 2);
    expect(woken).toEqual([]);
    begin(wink.threadId, "Wink, what's left on DOG?");
    expect((await startFold(wink.threadId, "resume")).sent).toContain(NOTE_BODY);
    say(wink.threadId, "DOG has one card left.");
    complete(wink.threadId);

    await handoff();
    await drain(2);
    begin(wink.threadId, QUESTION, pokkey);
    await workerNote(wink.threadId, "[pane worker01] REPORT: release gate ready", { reportIds: ["r1"] });
    say(wink.threadId, ANSWER);
    complete(wink.threadId);
    await expectOneWake(wink.threadId, "release gate ready");
  });

  describe("an ask that outlives its wait", () => {
    let dispatchError: ((message: string) => void) | undefined;
    // askBotAndWait: collect from before dispatch, hand the same collection to the watch at adoption
    function ask(taskId: string): Promise<AskReply> {
      const threadId = wink.threadId;
      const collected = peerReplies.start(threadId);
      return waitForPeerReply({
        threadId,
        botName: wink.name,
        userName: () => "Edward",
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        fold: ownTurnReply(() => false).fold,
        start: (onDispatchError) => {
          dispatchError = onDispatchError;
          begin(threadId, QUESTION, pokkey);
          return Promise.resolve();
        },
        adopt: () => {
          if (!busy.has(threadId)) return undefined;
          watchDelegatedTurn(threadId, { toBotId: wink.id, taskId, sourceThreadId: pokkey.threadId, sourceBotId: pokkey.id, ask: true, reply: collected });
          return taskId;
        },
        fail: (id, failureName) => {
          if (delegationWatch.get(threadId)?.taskId !== id) return;
          finalizeDelegationWatch(threadId, false, "", failureName);
        },
      }).then((reply) => {
        if (!reply.taskId) collected.release();
        return reply;
      });
    }
    const adopted = async (reply: Promise<AskReply>) => {
      await vi.advanceTimersByTimeAsync(ASK_BOT_TIMEOUT_MS);
      expect((await reply).taskId).toBe("ask-1");
    };

    it("answers inline before the limit and releases its collection", async () => {
      const reply = ask("ask-1");
      say(wink.threadId, ANSWER);
      complete(wink.threadId);
      expect(await reply).toEqual({ text: ANSWER, replied: true });
      expect(peerReplies._live()).toBe(0);
    });

    it("keeps the text written before adoption and what follows, once", async () => {
      const reply = ask("ask-1");
      await vi.advanceTimersByTimeAsync(60_000);
      say(wink.threadId, ANSWER);
      await adopted(reply);
      say(wink.threadId, "Done.");
      complete(wink.threadId);
      expectAnswered("ask-1", `${ANSWER}\nDone.`);
      expect(peerReplies._live()).toBe(0);
    });

    it("collects a turn that writes only after the limit", async () => {
      const reply = ask("ask-1");
      await adopted(reply);
      say(wink.threadId, ANSWER);
      complete(wink.threadId);
      expectAnswered("ask-1");
    });

    it("carries the final-answer state across adoption", async () => {
      const reply = ask("ask-1");
      say(wink.threadId, "Checking the gate.", "commentary");
      say(wink.threadId, ANSWER, "final_answer");
      await adopted(reply);
      say(wink.threadId, "Rechecking.", "commentary");
      say(wink.threadId, "Done.", "final_answer");
      complete(wink.threadId);
      expectAnswered("ask-1", `${ANSWER}\nDone.`);
    });

    it("fails on a late dispatch failure and leaks no collection", async () => {
      const reply = ask("ask-1");
      await adopted(reply);
      dispatchError?.("spawn failed");
      expect(findDelegationReceipt("ask-1")).toMatchObject({ status: "failed", result: "Asked turn could not start: spawn failed" });
      expect(peerReplies._live()).toBe(0);
      expect(delegationWatch.size).toBe(0);
    });

    it("keeps its takeover failure and never reruns after adoption", async () => {
      const reply = ask("ask-1");
      say(wink.threadId, "Let me check.");
      await adopted(reply);
      edwardWritesMidTurn("Wink, what's left on DOG?");
      say(wink.threadId, "Edward, DOG has one card left.");
      complete(wink.threadId);
      expect(findDelegationReceipt("ask-1")).toMatchObject({ status: "failed", result: askSwitchedText("Wink", "Edward") });
      expect(taskRows("ask-1").filter((m) => m.comm?.peer === "reply")).toEqual([]);
      expect(peerReplies._live()).toBe(0);
      await drain(0);
    });
  });
});
