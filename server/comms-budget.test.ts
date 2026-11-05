import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as budget from "./comms-budget.ts";
import { CommsCallers } from "./comms-caller.ts";
import * as roots from "./comms-root.ts";
import { DATA_DIR } from "./config.ts";
import { _resetPending, discardDelegations, drainDelegations, drainWaitingOn, finishDelegatedTurn, recordDelegationReceipt } from "./delegations.ts";
import { resolvePeerComms } from "./peer-approval.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import { admitPaneWake, markMailRead, mailForTurn, registerReplyWake, unreadMail } from "./mail.ts";
import { PaneWakeScheduler } from "./pane-wake.ts";
import { Store } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";

const EXHAUSTED = "This request reached its 24 bot turn limit. Finish with what you have; the user can send a message to continue.";
const PAUSED = "Bot messaging limit reached. Send a message to reset it.";
// The branch point still clears its per-turn ask count on turn.completed; replayed here so both builds see a settled turn.
const settleTurn = (threadId: string) => (budget as unknown as { clearAskBudget?: (id: string) => void }).clearAskBudget?.(threadId);

let store: Store;
let from: ReturnType<Store["createBot"]>;
let target: ReturnType<Store["createBot"]>;

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  _resetPending();
  roots._resetCommsRoots();
  store = new Store(() => ({ instanceId: "claude", model: "fake" }));
  from = store.createBot();
  target = store.createBot();
});
afterEach(() => {
  for (const id of ["turn", "wake", "keep-going", ...Array.from({ length: 6 }, (_, i) => `turn-${i}`)]) turnRegistry.settle(id);
  vi.useRealTimers();
});

function completingAsk() {
  return vi.fn(async (_to: string, _message: string, _depth: number, _from?: string, peer?: { reservation?: roots.Reservation }) => {
    if (peer?.reservation) roots.commit(peer.reservation);
    return { replied: true, text: "done" };
  });
}

type AskBotAndWait = (...args: never[]) => Promise<{ replied: boolean; text: string; taskId?: string }>;
const bus = () => ({ store, broadcast: () => {} });

async function call(method: "askBot" | "delegateBot", askBotAndWait: AskBotAndWait = completingAsk(), extra: Record<string, unknown> = {}, callers?: CommsCallers) {
  const route = createInternalRoutes({ store, commsBus: bus(), approvalBus: bus(), MAX_COMMS_DEPTH: 1,
    MAX_WORKSPACE_BOTS: 100, checkedMemberIds: (memberIds: string[]) => ({ ok: true, memberIds }),
    connectorThread: (botId: string, threadId: string) => store.conversationForBot(botId, threadId),
    delegationWatch: new Map(), askBotAndWait, resolveCommsCaller: callers && ((header: string | string[] | undefined) => callers.resolve(header)),
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
  let body = "";
  const res = { writeHead() {}, getHeader() {}, setHeader() {}, end(value: string) { body = value; } } as unknown as ServerResponse;
  const req = new EventEmitter() as IncomingMessage;
  if (callers) req.headers = { authorization: `Bearer ${callers.token(from.id, from.threadId)}` };
  const pending = route[method](req, res);
  req.emit("data", JSON.stringify({ fromBotId: from.id, fromThreadId: from.threadId, toBotId: target.id, message: "check this", ...extra }));
  req.emit("end");
  await pending;
  return JSON.parse(body) as { limit?: string; error?: string; text?: string; taskId?: string };
}

const ask = (askBotAndWait: ReturnType<typeof completingAsk>) => call("askBot", askBotAndWait);

const startTurn = (turnId: string, rootId: string | null) => turnRegistry.start(turnId, { botId: from.id, threadId: from.threadId, owner: "user", depth: 0, rootId });

describe("root budget through the ask route", () => {
  it("lets one turn's six sequential completed asks all reach askBotAndWait", async () => {
    startTurn("turn", roots.rootForStart(from.threadId, { kind: "human", messageKey: "send-1" }));
    const askBotAndWait = completingAsk();
    const admitted: boolean[] = [];
    for (let i = 0; i < 6; i++) admitted.push((await ask(askBotAndWait)).limit === undefined);
    expect(admitted).toEqual([true, true, true, true, true, true]);
    expect(askBotAndWait).toHaveBeenCalledTimes(6);
  });

  it("refuses later automatic turns' asks once the root committed 24 starts", async () => {
    roots.rootForStart(from.threadId, { kind: "human", messageKey: "send-1" });
    const askBotAndWait = completingAsk();
    for (let turn = 0; turn < 6; turn++) {
      startTurn(`turn-${turn}`, roots.rootForStart(from.threadId, { kind: "automatic" }));
      for (let i = 0; i < 4; i++) expect((await ask(askBotAndWait)).limit).toBeUndefined();
      turnRegistry.settle(`turn-${turn}`);
      settleTurn(from.threadId);
    }
    expect(askBotAndWait).toHaveBeenCalledTimes(24);
    for (const turnId of ["wake", "keep-going"]) {
      startTurn(turnId, roots.rootForStart(from.threadId, { kind: "automatic" }));
      expect((await ask(askBotAndWait)).limit).toBe(EXHAUSTED);
      expect(turnRegistry.get(turnId)).toBeDefined();
      turnRegistry.settle(turnId);
      settleTurn(from.threadId);
    }
    expect(askBotAndWait).toHaveBeenCalledTimes(24);
    expect(store.messagesFor(from.threadId).filter((row) => row.tool?.name === PAUSED)).toHaveLength(1);
  });
});

describe("root budget through reply wakes", () => {
  it("wakes the sender for six question replies under one root", async () => {
    vi.useFakeTimers();
    const rootId = roots.rootForStart(from.threadId, { kind: "human", messageKey: "send-1" })!;
    const wake = vi.fn((_bot: string, threadId: string, admission?: { reservation: roots.Reservation | null }) => {
      if (admission?.reservation) roots.commit(admission.reservation);
      markMailRead(store, threadId, mailForTurn(store, threadId), `wake-${wake.mock.calls.length}`);
    });
    const scheduler = new PaneWakeScheduler({ enabled: () => true, busy: () => false, hasNotes: () => unreadMail(store, from.threadId).length > 0,
      admit: (botId, threadId) => admitPaneWake(store, botId, threadId), wake, warn: () => {} });
    for (let i = 0; i < 6; i++) {
      recordDelegationReceipt({ id: `task-${i}`, sourceThreadId: from.threadId, toBotId: target.id, toBotName: target.name, status: "done", root: rootId });
      registerReplyWake(store.appendMessage(from.threadId, { role: "bot", kind: "activity", text: `@${from.name}, which file?`, comm: { groupId: "dm", withBotId: target.id, withName: target.name, withColor: "blue", peer: "reply", taskId: `task-${i}`, mailKey: `task-${i}:reply:${from.threadId}`, state: "done", wake: true } }));
      scheduler.noteArrived(from.id, from.threadId);
      await vi.advanceTimersByTimeAsync(3000);
    }
    expect(wake).toHaveBeenCalledTimes(6);
    expect(unreadMail(store, from.threadId)).toEqual([]);
  });
});

const committingRun = () => vi.fn((..._args: unknown[]) => {
  const reservation = _args[9] as roots.Reservation | undefined;
  if (reservation) roots.commit(reservation);
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
/** Credits still free, without spending any. */
function left(rootId: string) {
  const held: roots.Reservation[] = [];
  for (let credit = roots.reserve(rootId, "ask"); credit.ok; credit = roots.reserve(rootId, "ask")) held.push(credit.reservation);
  held.forEach(roots.release);
  return held.length;
}
function spend(rootId: string, count: number) {
  for (let index = 0; index < count; index++) roots.commit((roots.reserve(rootId, "ask") as { reservation: roots.Reservation }).reservation);
}
function human(key = "send-1") {
  const rootId = roots.rootForStart(from.threadId, { kind: "human", messageKey: key })!;
  startTurn("turn", rootId);
  return rootId;
}
const UNAVAILABLE = "Bot messaging paused. Send a message to reset it.";
const RESERVED = "This request's remaining bot turns are reserved. Collect pending replies before asking again.";
const WAITING = "You already have 4 teammate messages waiting. Collect those replies first.";
const lines = (threadId: string | undefined, name = PAUSED) => threadId ? store.messagesFor(threadId).filter((row) => row.tool?.name === name) : [];
const channelThread = () => store.dmGroup(from.id, target.id)?.threadId;
function replyRow(taskId: string, rootId?: string) {
  recordDelegationReceipt({ id: taskId, sourceThreadId: from.threadId, toBotId: target.id, toBotName: target.name, status: "done", root: rootId });
  const row = store.appendMessage(from.threadId, { role: "bot", kind: "activity", text: `@${from.name}, which file?`, comm: { groupId: "dm", withBotId: target.id, withName: target.name, withColor: "blue", peer: "reply", taskId, mailKey: `${taskId}:reply:${from.threadId}`, state: "done", wake: true } });
  registerReplyWake(row);
  return row;
}
const readAll = () => markMailRead(store, from.threadId, mailForTurn(store, from.threadId), "turn");
async function delegate() {
  const queued = await call("delegateBot");
  expect(queued.error).toBeUndefined();
  return queued.taskId!;
}
async function drain(run: ReturnType<typeof committingRun>) {
  drainDelegations(bus(), bus(), from.threadId, run);
  await flush();
}
const settle = (taskId: string, patch: Record<string, unknown> = {}) => ({ taskId, toBotId: target.id, sourceThreadId: from.threadId, sourceBotId: from.id, ...patch });

describe("accounting", () => {
  it("refuses the 25th mixed start of one root and posts the paused line once per thread", async () => {
    const rootId = human();
    for (let index = 0; index < 6; index++) expect((await ask(completingAsk())).limit).toBeUndefined();
    const run = committingRun();
    const tasks: string[] = [];
    for (let index = 0; index < 4; index++) tasks.push(await delegate());
    await drain(run);
    expect(run).toHaveBeenCalledTimes(4);
    finishDelegatedTurn(bus(), settle(tasks[0]!, { takenOverBy: "User" }), true, "answer");
    drainWaitingOn(bus(), bus(), run);
    await flush();
    expect(run).toHaveBeenCalledTimes(5);
    expect(left(rootId)).toBe(13);
    for (let index = 0; index < 13; index++) {
      replyRow(`wake-${index}`, rootId);
      const admission = admitPaneWake(store, from.id, from.threadId)!;
      expect(admission.rootId).toBe(rootId);
      roots.commit(admission.reservation!);
      readAll();
    }
    const askBotAndWait = completingAsk();
    expect((await ask(askBotAndWait)).limit).toBe(EXHAUSTED);
    expect((await call("delegateBot")).error).toBe(EXHAUSTED);
    replyRow("wake-late", rootId);
    expect(admitPaneWake(store, from.id, from.threadId)).toBeNull();
    expect(askBotAndWait).not.toHaveBeenCalled();
    expect(lines(from.threadId)).toHaveLength(1);
    expect(lines(channelThread())).toHaveLength(1);
  });

  it("takeover rerun needs another credit", async () => {
    const rootId = human();
    spend(rootId, 23);
    const run = committingRun();
    const taskId = await delegate();
    await drain(run);
    expect(left(rootId)).toBe(0);
    finishDelegatedTurn(bus(), settle(taskId, { takenOverBy: "User" }), true, "answer");
    drainWaitingOn(bus(), bus(), run);
    await flush();
    expect(run).toHaveBeenCalledOnce();
    expect(lines(from.threadId)).toHaveLength(1);
  });

  it("stale completion cannot release a replacement turn's credit", async () => {
    const rootId = human();
    const run = committingRun();
    const taskId = await delegate();
    await drain(run);
    finishDelegatedTurn(bus(), settle(taskId, { takenOverBy: "User" }), true, "answer");
    expect(left(rootId)).toBe(22);
    const dispatching = vi.fn();
    drainWaitingOn(bus(), bus(), dispatching);
    await flush();
    const replacement = dispatching.mock.calls[0]![9] as roots.Reservation;
    expect(replacement).toMatchObject({ rootId, kind: "rerun" });
    finishDelegatedTurn(bus(), settle(taskId), false, "", "Delegated turn did not finish");
    finishDelegatedTurn(bus(), settle(taskId, { takenOverBy: "User" }), true, "late answer");
    discardDelegations(bus(), from.threadId);
    expect(left(rootId)).toBe(22);
    roots.commit(replacement);
    roots.release(replacement);
    expect(left(rootId)).toBe(22);
  });

  it("timeout adoption does not reserve twice", async () => {
    const rootId = human();
    const adopt = vi.fn(async (..._args: unknown[]) => {
      const peer = _args[4] as { reservation?: roots.Reservation; taskId?: string };
      if (peer.reservation) roots.commit(peer.reservation);
      return { replied: false, text: "", taskId: peer.taskId };
    });
    const adopted = await call("askBot", adopt);
    expect(adopted.taskId).toBeDefined();
    expect(left(rootId)).toBe(23);
    finishDelegatedTurn(bus(), settle(adopted.taskId!, { ask: true }), true, "answer");
    expect(left(rootId)).toBe(23);
  });

  it("duplicate failure cannot refund twice", async () => {
    const rootId = human();
    const run = committingRun();
    const taskId = await delegate();
    await drain(run);
    for (let index = 0; index < 2; index++) finishDelegatedTurn(bus(), settle(taskId), false, "", "Delegated turn did not finish");
    discardDelegations(bus(), from.threadId);
    expect(left(rootId)).toBe(23);
  });

  it("releases a denied ask and a delegation dropped by a failed source turn", async () => {
    from = store.patchBot(from.id, { approvePeerComms: true })!;
    const rootId = human();
    spend(rootId, 23);
    const askBotAndWait = completingAsk();
    const pending = call("askBot", askBotAndWait);
    await flush();
    expect(left(rootId)).toBe(0);
    const requestId = store.messagesFor(from.threadId).find((row) => row.card?.requestId)?.card?.requestId;
    resolvePeerComms(bus(), requestId!, "deny");
    expect((await pending).error).toBe("denied by user");
    expect(left(rootId)).toBe(1);
    from = store.patchBot(from.id, { approvePeerComms: false })!;
    await delegate();
    expect(left(rootId)).toBe(0);
    discardDelegations(bus(), from.threadId, from.id, "turn");
    expect(left(rootId)).toBe(1);
    expect((await ask(askBotAndWait)).limit).toBeUndefined();
    expect(left(rootId)).toBe(0);
  });

  it("running turn publishes after root exhaustion", async () => {
    const rootId = human();
    const run = committingRun();
    const taskId = await delegate();
    await drain(run);
    spend(rootId, left(rootId));
    expect(finishDelegatedTurn(bus(), settle(taskId), true, "all done")).toBe(true);
    expect(store.messagesFor(from.threadId).some((row) => row.comm?.peer === "reply" && row.text === "all done")).toBe(true);
  });

  it("answers reserved, not spent, without a line, until a release frees a credit", async () => {
    const rootId = human();
    spend(rootId, 23);
    const held = (roots.reserve(rootId, "delegation") as { reservation: roots.Reservation }).reservation;
    const askBotAndWait = completingAsk();
    expect((await ask(askBotAndWait)).limit).toBe(RESERVED);
    expect(askBotAndWait).not.toHaveBeenCalled();
    expect(store.messagesFor(from.threadId).some((row) => row.tool?.name?.startsWith("Bot messaging"))).toBe(false);
    roots.release(held);
    expect((await ask(askBotAndWait)).limit).toBeUndefined();
  });

  it("never lets a forged body root, depth or thread pick or refill a root", async () => {
    const email = "fake-account@example.invalid";
    const rootId = human(email);
    spend(rootId, 24);
    const other = roots.rootForStart(target.threadId, { kind: "human", messageKey: "other" })!;
    const callers = new CommsCallers();
    const askBotAndWait = completingAsk();
    for (const forged of [{ root: other }, { commsRoot: other, depth: 0 }, { fromThreadId: target.threadId }]) {
      const answer = await call("askBot", askBotAndWait, forged, callers);
      expect(answer.limit).toBe(EXHAUSTED);
      expect(JSON.stringify(answer)).not.toContain(email);
    }
    expect(askBotAndWait).not.toHaveBeenCalled();
    expect(left(other)).toBe(24);
    for (const threadId of [from.threadId, channelThread()]) expect(JSON.stringify(threadId ? store.messagesFor(threadId) : [])).not.toContain(email);
  });
});

describe("open asks", () => {
  it("fifth busy-target ask is refused until a queued ask settles", async () => {
    human();
    store.bot(target.id)!.busy = true;
    const askBotAndWait = completingAsk();
    const queued: string[] = [];
    for (let index = 0; index < 4; index++) queued.push((await ask(askBotAndWait)).taskId!);
    expect((await ask(askBotAndWait)).limit).toBe(WAITING);
    for (let index = 0; index < 2; index++) finishDelegatedTurn(bus(), settle(queued[1]!, { ask: true }), true, "answer");
    expect((await ask(askBotAndWait)).taskId).toBeDefined();
    expect((await ask(askBotAndWait)).limit).toBe(WAITING);
    expect(askBotAndWait).not.toHaveBeenCalled();
  });

  it("timeout adoption keeps its open slot", async () => {
    human();
    const adopt = vi.fn(async (..._args: unknown[]) => ({ replied: false, text: "", taskId: (_args[4] as { taskId: string }).taskId }));
    const adopted: string[] = [];
    for (let index = 0; index < 4; index++) adopted.push((await call("askBot", adopt)).taskId!);
    expect((await call("askBot", adopt)).limit).toBe(WAITING);
    finishDelegatedTurn(bus(), settle(adopted[0]!, { ask: true }), true, "answer");
    expect((await call("askBot", adopt)).limit).toBeUndefined();
  });
});

describe("wake admission", () => {
  it("coalesced replies reserve one wake", () => {
    const rootId = human();
    for (let index = 0; index < 3; index++) replyRow(`task-${index}`, rootId);
    expect(admitPaneWake(store, from.id, from.threadId)!.rootId).toBe(rootId);
    expect(left(rootId)).toBe(23);
  });

  it("pane plus spent reply does not refill", () => {
    const rootId = human();
    spend(rootId, 24);
    replyRow("task-spent", rootId);
    store.appendMessage(from.threadId, { role: "bot", kind: "note", text: "Worker finished", origin: "local-device" });
    expect(admitPaneWake(store, from.id, from.threadId)).toEqual({ rootId: null, reservation: null });
    expect(roots.rootForStart(from.threadId, { kind: "automatic" })).toBe(rootId);
    expect(left(rootId)).toBe(0);
  });

  it("old reply cannot consume a newer pending admission", () => {
    const rootId = human();
    spend(rootId, 23);
    replyRow("task-new", rootId);
    const newer = admitPaneWake(store, from.id, from.threadId)!;
    expect(newer.reservation).not.toBeNull();
    replyRow("task-old", rootId);
    expect(admitPaneWake(store, from.id, from.threadId)).toBeNull();
    expect(store.messagesFor(from.threadId).some((row) => row.tool?.name?.startsWith("Bot messaging"))).toBe(false);
    roots.commit(newer.reservation!);
    expect(left(rootId)).toBe(0);
  });

  it("picks the newest unread reply whose root still has credit", () => {
    const older = human("send-1");
    replyRow("task-a", older);
    const newer = roots.rootForStart(from.threadId, { kind: "human", messageKey: "send-2" })!;
    spend(newer, 24);
    replyRow("task-b", newer);
    expect(admitPaneWake(store, from.id, from.threadId)?.rootId).toBe(older);
    expect(lines(from.threadId)).toHaveLength(0);
  });

  it("never wakes for a legacy receipt without a root and posts one unavailable line", () => {
    human();
    const unwoken = vi.fn();
    replyRow("task-legacy");
    expect(admitPaneWake(store, from.id, from.threadId, unwoken)).toBeNull();
    expect(admitPaneWake(store, from.id, from.threadId, unwoken)).toBeNull();
    expect(unwoken).toHaveBeenCalledWith(from.id, "wake budget spent");
    expect(lines(from.threadId, UNAVAILABLE)).toHaveLength(1);
    expect(unreadMail(store, from.threadId)).toHaveLength(1);
  });
});
