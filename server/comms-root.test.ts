import { EventEmitter } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommsCallers } from "./comms-caller.ts";
import { _resetCommsRoots, adoptHumanRoot, callerSnapshot, commit, release, reserve, ROOT_TURNS, rootForStart, rootThreadOf } from "./comms-root.ts";
import { DATA_DIR } from "./config.ts";
import { loadDelegationReceipts, resetDelegationReceipts } from "./delegation-ledger.ts";
import { _loadPending, _resetPending, drainDelegations, drainWaitingOn, findDelegationReceipt, finishDelegatedTurn, queueDelegation, recordDelegationReceipt } from "./delegations.ts";
import { drivePathRule } from "./drive-mirror.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import { cancelPeerApprovalsFor, resolvePeerComms } from "./peer-approval.ts";
import { _resetSteerQueue, cancelQueuedRoomParticipations, drainSteeredMessages, foldQueuedSends, queueMark, queueRoomParticipation, queueSteeredMessage } from "./steer-queue.ts";
import { Store } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";

let store: Store;
let from: ReturnType<Store["createBot"]>;
let target: ReturnType<Store["createBot"]>;
const bus = () => ({ store, broadcast: () => {} });
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  _resetPending();
  _resetCommsRoots();
  _resetSteerQueue();
  store = new Store(() => ({ instanceId: "claude", model: "fake" }));
  from = store.createBot();
  target = store.createBot();
});

afterEach(() => {
  cancelPeerApprovalsFor(from.id);
  const turn = turnRegistry.current(from.threadId);
  if (turn) turnRegistry.settle(turn.turnId);
  vi.restoreAllMocks();
});

function start(messageKey = "first", threadId = from.threadId, depth = 0) {
  const rootId = rootForStart(threadId, { kind: "human", messageKey });
  turnRegistry.prepare({ botId: from.id, threadId, owner: "user", depth, rootId });
  turnRegistry.started("caller", threadId);
  return rootId;
}

function request(askBotAndWait = vi.fn(async (..._args: unknown[]) => ({ replied: true, text: "answer" }))) {
  const callers = new CommsCallers();
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { authorization: `Bearer ${callers.token(from.id, from.threadId)}` };
  let body = "";
  const res = { writeHead() {}, getHeader() {}, setHeader() {}, end(value: string) { body = value; } } as unknown as ServerResponse;
  const routes = createInternalRoutes({ store, commsBus: bus(), approvalBus: bus(), MAX_COMMS_DEPTH: 1,
    connectorThread: (botId: string, threadId: string) => store.conversationForBot(botId, threadId),
    askBotAndWait, resolveCommsCaller: (header: string | string[] | undefined) => callers.resolve(header),
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
  return { req, res, routes, body: () => JSON.parse(body) };
}

async function send(output: ReturnType<typeof request>, method: "askBot" | "delegateBot" = "askBot", extra: Record<string, unknown> = {}) {
  const pending = output.routes[method](output.req, output.res);
  output.req.emit("data", JSON.stringify({ toBotId: target.id, message: "work", ...extra }));
  output.req.emit("end");
  await pending;
  return output.body();
}

it("refuses a scoped ask after its caller turn settled", async () => {
  turnRegistry.prepare({ botId: from.id, threadId: from.threadId, owner: "user", depth: 0 });
  turnRegistry.started("ended", from.threadId);
  turnRegistry.settle("ended");
  const ask = vi.fn(async () => ({ replied: true, text: "answer" }));
  const output = request(ask);
  const pending = output.routes.askBot(output.req, output.res);
  output.req.emit("data", JSON.stringify({ toBotId: target.id, message: "work" }));
  output.req.emit("end");
  await pending;
  expect(output.body()).toEqual({ error: "This turn has ended, so it can't message teammates." });
  expect(ask).not.toHaveBeenCalled();
});

it("keeps a receipt root across save and load", () => {
  const receipt = { id: "root-receipt", sourceThreadId: from.threadId, toBotId: target.id, toBotName: target.name, status: "done" as const, root: "opaque-root" };
  recordDelegationReceipt(receipt);
  resetDelegationReceipts();
  loadDelegationReceipts();
  expect(findDelegationReceipt(receipt.id)).toMatchObject({ root: receipt.root });
});

it("hands a queued delegation root to runTarget", async () => {
  const item = { toBotId: target.id, message: "work", depth: 0, root: "queued-root" };
  queueDelegation(bus(), from, item, 1);
  const run = vi.fn();
  drainDelegations(bus(), bus(), from.threadId, run);
  await flush();
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0][8]).toBe(item.root);
});

it("reuses send identities and accepted message ids across queue drains", async () => {
  const first = rootForStart(from.threadId, { kind: "human", messageKey: "send-1" });
  expect(rootForStart(from.threadId, { kind: "human", messageKey: "send-1" })).toBe(first);
  expect(rootForStart(from.threadId, { kind: "human", messageKey: "send-2" })).not.toBe(first);
  const key = "queued-send-00001";
  const queuedRoot = rootForStart(from.threadId, { kind: "human", messageKey: key });
  queueSteeredMessage(from.id, from.threadId, "later", { sendId: key });
  let drained: string | null = null;
  const run = vi.fn((_botId, threadId, _prompt, message) => { drained = rootForStart(threadId, { kind: "human", messageKey: message.sendId ?? message.id }); });
  drainSteeredMessages(store, run);
  expect(drained).toBe(queuedRoot);
  const message = store.appendMessage(from.threadId, { role: "user", kind: "text", text: "without sendId" });
  const root = rootForStart(from.threadId, { kind: "human", messageKey: message.id });
  expect(rootForStart(from.threadId, { kind: "human", messageKey: message.id })).toBe(root);
});

it("adopts the newest folded human root and preserves earlier snapshots", () => {
  const original = start();
  const captured = callerSnapshot(from.id, from.threadId);
  const mark = queueMark();
  queueSteeredMessage(from.id, from.threadId, "first fold", { sendId: "folded-send-0001" });
  queueSteeredMessage(from.id, from.threadId, "latest fold", { sendId: "folded-send-0002" });
  const prompts = foldQueuedSends(store, from.id, from.threadId, mark);
  for (const message of store.activePath(from.threadId).slice(-prompts.length)) adoptHumanRoot(from.threadId, message.sendId ?? message.id);
  const latest = rootForStart(from.threadId, { kind: "human", messageKey: "folded-send-0002" });
  expect(callerSnapshot(from.id, from.threadId)?.rootId).toBe(latest);
  expect(captured?.rootId).toBe(original);
  expect(latest).not.toBe(original);
});

it("adopts a human fold before the provider announces its turn", () => {
  const rootId = rootForStart(from.threadId, { kind: "human", messageKey: "first" });
  turnRegistry.prepare({ botId: from.id, threadId: from.threadId, owner: "user", depth: 0, rootId });
  const folded = adoptHumanRoot(from.threadId, "folded");
  expect(callerSnapshot(from.id, from.threadId)).toBeNull();
  turnRegistry.started("caller", from.threadId);
  expect(callerSnapshot(from.id, from.threadId)?.rootId).toBe(folded);
});

it.each(["routine", "card resume", "keep-going", "pane-note", "limit resume", "control steer"])("never mints a root for %s", () => {
  expect(rootForStart(from.threadId, { kind: "automatic" })).toBeNull();
  const root = start();
  turnRegistry.settle("caller");
  expect(rootForStart(from.threadId, { kind: "automatic" })).toBe(root);
  expect(rootForStart("detached", { kind: "automatic" })).toBeNull();
  expect(rootForStart("peer", { kind: "inherit", rootId: root })).toBe(root);
  expect(rootForStart("peer", { kind: "inherit", rootId: null })).toBeNull();
  expect(rootForStart("peer", { kind: "automatic" })).toBeNull();
});

it.each(["inherit", "automatic", "snapshot"] as const)("expires idle roots on %s without another human start", (kind) => {
  const idle = 48 * 60 * 60 * 1_000;
  let touched = 1_000;
  const now = vi.spyOn(Date, "now").mockReturnValue(touched);
  const root = start();
  const live = () => kind === "snapshot" ? callerSnapshot(from.id, from.threadId)?.rootId
    : rootForStart(from.threadId, kind === "inherit" ? { kind, rootId: root } : { kind });
  for (let index = 0; index < 2; index++) {
    touched += idle - 1;
    now.mockReturnValue(touched);
    expect(live()).toBe(root);
  }
  now.mockReturnValue(touched + idle);
  expect(live()).toBeNull();
  now.mockReturnValue(touched);
  expect(rootForStart("peer", { kind: "inherit", rootId: root })).toBeNull();
});

it("drops idle roots on a human start and forgets all roots on restart", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const idle = rootForStart("idle", { kind: "human", messageKey: "old" });
  const active = rootForStart("active", { kind: "human", messageKey: "active" });
  now.mockReturnValue(1_000 + 47 * 60 * 60 * 1_000);
  expect(rootForStart("active", { kind: "automatic" })).toBe(active);
  now.mockReturnValue(1_000 + 49 * 60 * 60 * 1_000);
  rootForStart("new", { kind: "human", messageKey: "new" });
  expect(rootForStart("idle", { kind: "automatic" })).toBeNull();
  expect(rootForStart("peer", { kind: "inherit", rootId: idle })).toBeNull();
  expect(rootForStart("active", { kind: "automatic" })).toBe(active);
  expect(rootForStart("idle", { kind: "human", messageKey: "old" })).not.toBe(idle);
  _resetCommsRoots();
  expect(rootForStart("active", { kind: "automatic" })).toBeNull();
  expect(rootForStart("peer", { kind: "inherit", rootId: active })).toBeNull();
});

it.each(["askBot", "delegateBot"] as const)("captures %s before reading its body and ignores forged identity fields", async (method) => {
  const original = start();
  const ask = vi.fn(async (..._args: unknown[]) => ({ replied: true, text: "answer" }));
  const output = request(ask);
  const pending = output.routes[method](output.req, output.res);
  adoptHumanRoot(from.threadId, "new human");
  output.req.emit("data", JSON.stringify({ toBotId: target.id, message: "work", root: "forged", commsRoot: "forged", depth: 999, fromBotId: target.id, fromThreadId: target.threadId }));
  output.req.emit("end");
  await pending;
  expect(output.body().error).toBeUndefined();
  const id = method === "delegateBot" ? output.body().taskId : JSON.parse(readFileSync(join(DATA_DIR, "delegation-receipts.json"), "utf8"))[0].id;
  expect(findDelegationReceipt(id)).toMatchObject({ root: original, source: { botId: from.id, threadId: from.threadId, turnId: "caller" } });
  expect(ask).toHaveBeenCalledTimes(method === "askBot" ? 1 : 0);
  if (method === "askBot") expect(ask.mock.calls[0][4]).toMatchObject({ commsRoot: original });
});

it.each(["askBot", "delegateBot"] as const)("refuses %s when its turn settles during body parsing", async (method) => {
  start();
  const output = request();
  const pending = output.routes[method](output.req, output.res);
  turnRegistry.settle("caller");
  output.req.emit("data", JSON.stringify({ toBotId: target.id, message: "work" }));
  output.req.emit("end");
  await pending;
  expect(output.body().error).toBe("This turn has ended, so it can't message teammates.");
});

it.each([false, true])("keeps the root captured before approval (target becomes busy: %s)", async (busy) => {
  from = store.patchBot(from.id, { approvePeerComms: true })!;
  const original = start();
  const ask = vi.fn(async (..._args: unknown[]) => ({ replied: true, text: "answer" }));
  const output = request(ask);
  const pending = send(output);
  await flush();
  const requestId = store.messagesFor(from.threadId).find((row) => row.card?.requestId)?.card?.requestId;
  expect(requestId).toBeTruthy();
  const newer = adoptHumanRoot(from.threadId, "new human");
  if (busy) store.setActivity(target.id, "working");
  resolvePeerComms(bus(), requestId!, "allow");
  await pending;
  expect(callerSnapshot(from.id, from.threadId)?.rootId).toBe(newer);
  if (busy) {
    store.setActivity(target.id, "idle");
    const run = vi.fn();
    drainWaitingOn(bus(), bus(), run);
    await flush();
    expect(run.mock.calls[0][8]).toBe(original);
  } else {
    expect(ask.mock.calls[0][4]).toMatchObject({ commsRoot: original });
  }
});

it("refuses an approval callback after the captured turn settled", async () => {
  from = store.patchBot(from.id, { approvePeerComms: true })!;
  start();
  const ask = vi.fn(async (..._args: unknown[]) => ({ replied: true, text: "answer" }));
  const output = request(ask);
  const pending = send(output);
  await flush();
  const requestId = store.messagesFor(from.threadId).find((row) => row.card?.requestId)?.card?.requestId;
  turnRegistry.settle("caller");
  resolvePeerComms(bus(), requestId!, "allow");
  await pending;
  expect(output.body().error).toBe("This turn has ended, so it can't message teammates.");
  expect(ask).not.toHaveBeenCalled();
});

it.each(["askBot", "delegateBot"] as const)("refuses %s without a live caller and never borrows another bot's turn", async (method) => {
  turnRegistry.start("other", { botId: target.id, threadId: from.threadId, owner: "user", depth: 0 });
  const output = request();
  expect((await send(output, method)).error).toBe("This turn has ended, so it can't message teammates.");
  expect(callerSnapshot(from.id, from.threadId)).toBeNull();
  expect(callerSnapshot(target.id, target.threadId)).toBeNull();
});

it("keeps roots through pending reload and takeover reruns", async () => {
  const root = start()!;
  const queued = queueDelegation(bus(), from, { toBotId: target.id, message: "work", depth: 0, root }, 1);
  _loadPending();
  const run = vi.fn();
  drainDelegations(bus(), bus(), from.threadId, run);
  await flush();
  expect(run.mock.calls[0][8]).toBe(root);
  adoptHumanRoot(from.threadId, "later");
  finishDelegatedTurn(bus(), { taskId: queued.id, toBotId: target.id, sourceThreadId: from.threadId, sourceBotId: from.id, takenOverBy: "User" }, true, "answer");
  drainWaitingOn(bus(), bus(), run);
  await flush();
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1][8]).toBe(root);
  expect(findDelegationReceipt(queued.id!)?.root).toBe(root);
});

it("loads old rootless receipts and keeps receipt and pending files PC-local", () => {
  recordDelegationReceipt({ id: "legacy", sourceThreadId: from.threadId, toBotId: target.id, toBotName: target.name, status: "done" });
  loadDelegationReceipts();
  expect(findDelegationReceipt("legacy")?.root).toBeUndefined();
  const ids = { profileDeviceId: "device", memoryDeviceId: "memory", writerId: "writer" };
  for (const file of ["delegation-receipts.json", "delegations.json"]) expect(drivePathRule(file, ids)).toBe("unknown");
});

it.each([[1, 0, "new"], [0, 1, "old"], [0, 0, "new"]] as const)("coalesces room roots with hops %s then %s", (firstHop, nextHop, survivor) => {
  store.setActivity(from.id, "working");
  queueRoomParticipation(from.id, from.threadId, { groupId: "room", hop: firstHop, rootId: "old" });
  queueRoomParticipation(from.id, from.threadId, { groupId: "room", hop: nextHop, rootId: "new" });
  const run = vi.fn();
  drainSteeredMessages(store, run);
  expect(run).not.toHaveBeenCalled();
  store.setActivity(from.id, "idle");
  drainSteeredMessages(store, run);
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0][5]).toMatchObject({ hop: Math.min(firstHop, nextHop), rootId: survivor });
});

it("clears a root on a rootless room tie and drops stopped room waits", () => {
  queueRoomParticipation(from.id, from.threadId, { groupId: "room", rootId: "old" });
  queueRoomParticipation(from.id, from.threadId, { groupId: "room" });
  const run = vi.fn();
  drainSteeredMessages(store, run);
  expect(run.mock.calls[0][5].rootId).toBeUndefined();
  queueRoomParticipation(from.id, from.threadId, { groupId: "room", rootId: "drop" });
  expect(cancelQueuedRoomParticipations("room", from.threadId)).toBe(1);
  drainSteeredMessages(store, run);
  expect(run).toHaveBeenCalledOnce();
});

it("keeps room roots out of queued-sends.json", () => {
  queueRoomParticipation(from.id, from.threadId, { groupId: "room", rootId: "room-secret" });
  queueSteeredMessage(target.id, target.threadId, "held");
  expect(readFileSync(join(DATA_DIR, "queued-sends.json"), "utf8")).not.toContain("room-secret");
});

it("keeps four open asks and spends one root credit per started ask", async () => {
  const root = start()!;
  const commitPeer = vi.fn(async (..._args: unknown[]) => {
    const peer = _args[4] as { reservation?: Parameters<typeof commit>[0] };
    if (peer.reservation) commit(peer.reservation);
    return { replied: false, text: "", taskId: "adopted" };
  });
  for (let index = 0; index < 4; index++) expect((await send(request(commitPeer))).error).toBeUndefined();
  expect((await send(request(commitPeer))).limit).toBe("You already have 4 teammate messages waiting. Collect those replies first.");
  expect(commitPeer).toHaveBeenCalledTimes(4);
  for (let index = 4; index < ROOT_TURNS; index++) commit((reserve(root, "wake") as { reservation: Parameters<typeof commit>[0] }).reservation);
  expect(reserve(root, "ask")).toEqual({ ok: false, reason: "exhausted" });
});

it("reserves, commits and releases each credit once", () => {
  const root = start()!;
  expect(rootThreadOf(root)).toBe(from.threadId);
  const held = Array.from({ length: ROOT_TURNS }, () => reserve(root, "ask"));
  expect(held.every((credit) => credit.ok)).toBe(true);
  expect(reserve(root, "delegation")).toEqual({ ok: false, reason: "reserved" });
  const [first, second] = held.map((credit) => (credit as { reservation: Parameters<typeof commit>[0] }).reservation);
  release(first!);
  release(first!);
  commit(first!);
  const again = reserve(root, "rerun");
  expect(again.ok).toBe(true);
  expect(reserve(root, "rerun")).toEqual({ ok: false, reason: "reserved" });
  commit(second!);
  commit(second!);
  release(second!);
  expect(reserve(root, "wake")).toEqual({ ok: false, reason: "reserved" });
  for (const credit of [...held.slice(2), again]) commit((credit as { reservation: Parameters<typeof commit>[0] }).reservation);
  expect(reserve(root, "ask")).toEqual({ ok: false, reason: "exhausted" });
  expect(reserve(null, "ask")).toEqual({ ok: false, reason: "missing" });
  expect(reserve("forged-root", "ask")).toEqual({ ok: false, reason: "missing" });
  expect(rootThreadOf("forged-root")).toBeNull();
});

it("autonomous starts never refill the human root", () => {
  const root = start()!;
  for (let index = 0; index < ROOT_TURNS; index++) commit((reserve(root, "ask") as { reservation: Parameters<typeof commit>[0] }).reservation);
  // routine, card resume, keep-going and pane note starts all take the automatic kind (comms-root-index.test.ts)
  for (const start of ["routine", "card resume", "keep-going", "pane note"]) {
    const rootId = rootForStart(from.threadId, { kind: "automatic" });
    expect(rootId, start).toBe(root);
    expect(reserve(rootId, "wake"), start).toEqual({ ok: false, reason: "exhausted" });
  }
  expect(rootForStart(from.threadId, { kind: "inherit", rootId: root })).toBe(root);
  const next = rootForStart(from.threadId, { kind: "human", messageKey: "second" })!;
  expect(next).not.toBe(root);
  expect(reserve(next, "ask").ok).toBe(true);
});

it("stores opaque roots without account identity", () => {
  const email = "fake-account@example.invalid";
  const root = start(email)!;
  queueDelegation(bus(), from, { toBotId: target.id, message: "work", depth: 0, root }, 1);
  for (const file of ["delegation-receipts.json", "delegations.json"]) {
    const saved = readFileSync(join(DATA_DIR, file), "utf8");
    expect(saved).toContain(root);
    expect(saved).not.toContain(email);
  }
  expect(JSON.stringify(callerSnapshot(from.id, from.threadId))).not.toContain(email);
  expect(root).not.toContain(email);
});
