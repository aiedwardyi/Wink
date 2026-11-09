import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommsCallers } from "./comms-caller.ts";
import { _resetCommsRoots, rootForStart } from "./comms-root.ts";
import { DATA_DIR } from "./config.ts";
import { paneNotesForTurn, prepareModelContext, repairModelContext, repairTarget } from "./context-compaction.ts";
import { _resetPending, discardDelegations, discardOrphanedDelegations, drainWaitingOn, findDelegationReceipt, finishDelegatedTurn, queueDelegation, recordDelegationReceipt, updateReceipt } from "./delegations.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import { mailForTurn, markMailRead, markPaneMailRead, settleMail, toolMailResult, unreadMail } from "./mail.ts";
import { cancelPeerApprovalsFor, resolvePeerComms } from "./peer-approval.ts";
import { Store, type Message } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";

let store: Store;
let from: ReturnType<Store["createBot"]>;
let target: ReturnType<Store["createBot"]>;
const bus = () => ({ store, broadcast: () => {} });
const start = (turnId: string) => turnRegistry.start(turnId, { botId: from.id, threadId: from.threadId, owner: "user", depth: 0, rootId: rootForStart(from.threadId, { kind: "human", messageKey: turnId }) });
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  _resetPending();
  _resetCommsRoots();
  store = new Store(() => ({ instanceId: "claude", model: "fake" }));
  from = store.createBot();
  target = store.createBot();
});
afterEach(() => {
  cancelPeerApprovalsFor(from.id);
  const turn = turnRegistry.current(from.threadId);
  if (turn) turnRegistry.settle(turn.turnId);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function reply(text: string, taskId = "reply-task", threadId = from.threadId): Message {
  return store.appendMessage(threadId, { role: "bot", kind: "activity", text, comm: { groupId: "dm", withBotId: target.id, withName: target.name, withColor: target.color, peer: "reply", taskId, mailKey: `${taskId}:reply:${threadId}`, state: "done" } });
}

it.each([16_000, 19_000])("collects the full published continuation after offset %s", (offset) => {
  const text = "0123456789".repeat(2600);
  const row = reply(text);
  markMailRead(store, from.threadId, [{ id: row.id, upto: offset }], "fold");
  const result = toolMailResult(store, from.threadId, "reply-task", `${text.slice(0, 16_000)}\n[reply cut]`, { turnId: "pull", requestId: "request" });
  expect(result).toBe(text.slice(offset));
  settleMail(store, from.threadId, "pull", true);
  expect(unreadMail(store, from.threadId)).toEqual([]);
});

it("collects an oversized tool reply in bounded chunks without losing its tail", () => {
  const text = "z".repeat(52_000);
  reply(text);
  let collected = "";
  for (let i = 0; i < 5 && unreadMail(store, from.threadId).length; i++) {
    const result = toolMailResult(store, from.threadId, "reply-task", text.slice(0, 16_000), { turnId: "pull", requestId: `request-${i}` })!;
    expect(result.length).toBeLessThanOrEqual(16_100);
    collected += result.split("\n\n[Reply continues;")[0];
    settleMail(store, from.threadId, "pull", true);
  }
  expect(collected).toBe(text);
});

it.each([[0, true], [37, true], [0, false], [37, false]] as const)("collects successive tool chunks in one turn (committed: %s, clean: %s)", (offset, clean) => {
  const text = "0123456789".repeat(3200) + "tail";
  const row = reply(text);
  if (offset) markMailRead(store, from.threadId, [{ id: row.id, upto: offset }], "fold");
  let collected = "";
  while (collected.length < text.length - offset) {
    const result = toolMailResult(store, from.threadId, "reply-task", text.slice(0, 16_000), { turnId: "pull", requestId: `request-${collected.length}` })!;
    const chunk = result.split("\n\n[Reply continues;")[0];
    expect(chunk).toBe(text.slice(offset + collected.length, offset + collected.length + 16_000));
    collected += chunk;
    expect(toolMailResult(store, from.threadId, "reply-task", text, { turnId: "other", requestId: "other" })).toBe("already in your context");
  }
  expect(collected).toBe(text.slice(offset));
  expect(toolMailResult(store, from.threadId, "reply-task", text, { turnId: "pull", requestId: "again" })).toBe("already in your context");
  settleMail(store, from.threadId, "pull", clean, clean ? undefined : "interrupted");
  if (clean) expect(unreadMail(store, from.threadId)).toEqual([]);
  else {
    expect(unreadMail(store, from.threadId)[0].comm?.read?.upto ?? 0).toBe(offset);
    expect(mailForTurn(store, from.threadId)[0].text).toContain(text.slice(offset));
  }
});

it("keeps a long pane reply's omitted tail available for later folds", () => {
  const row = reply("answer ".repeat(1200));
  store.patchMessage(from.threadId, row.id, { comm: { ...row.comm!, wake: true } });
  const pane = paneNotesForTurn(store.activePath(from.threadId), new Set(), undefined, false, false, 1000);
  const parts = mailForTurn(store, from.threadId, pane.ids, 1000, pane.tokens);
  expect(parts).toHaveLength(1);
  expect(parts[0].upto).toBeGreaterThan(0);
  expect(parts[0].upto).toBeLessThan(row.text!.length);
  markMailRead(store, from.threadId, parts, "fold");
  markPaneMailRead(store, from.threadId, pane.ids ?? [], "fold", "fold");
  expect(unreadMail(store, from.threadId)[0].comm?.read?.upto).toBe(parts[0].upto);
});

it.each(["adopt", "changes"])("indexes unread replies in a %s sync import", (mode) => {
  const source = reply("synced result");
  const row = { ...source, id: "imported", comm: { ...source.comm!, mailKey: "imported-reply" } };
  const threadId = "synced-thread";
  if (mode === "adopt") store.adoptSyncedTask(from.id, { threadId, title: "Synced", createdAt: 1 }, [row], row.id);
  else store.applySyncChanges(from.id, threadId, [
    { cursor: 1, kind: "row", rowId: row.id, value: row, conflict: false },
    { cursor: 2, kind: "head", rowId: "head", value: row.id, conflict: false },
  ]);
  expect(mailForTurn(store, threadId).map((part) => part.id)).toEqual([row.id]);
  const reopened = new Store(() => ({ instanceId: "claude", model: "fake" }));
  expect(mailForTurn(reopened, threadId).map((part) => part.id)).toEqual([row.id]);
});

it("replaces a synced task's stale unread index", () => {
  reply("old reply");
  const row: Message = { id: "text", at: 1, role: "user", kind: "text", text: "replacement" };
  store.adoptSyncedTask(from.id, { threadId: from.threadId, title: "Replacement", createdAt: 1 }, [row], row.id);
  expect(store.taskByThread(from.id, from.threadId)?.mailUnread ?? []).toEqual([]);
});

it("repairs handovers without loading transcripts that have no handed mail", () => {
  store.createTask(from.id, "archived", false);
  store.createGroup("Room", [from.id, target.id]);
  const messagesFor = vi.spyOn(store, "messagesFor");
  discardOrphanedDelegations(bus());
  expect(messagesFor).not.toHaveBeenCalled();
});

it.each(["ready", "approval"] as const)("drops stopped-turn %s asks while retaining older ready asks", async (state) => {
  store.setActivity(target.id, "working");
  start("older");
  const older = queueDelegation(bus(), from, { toBotId: target.id, message: "older", depth: 0 }, 1, from.threadId, { kind: "ask", ready: true });
  start("stopped");
  const stopped = queueDelegation(bus(), from, { toBotId: target.id, message: "stopped", depth: 0 }, 1, from.threadId, { kind: "ask", ready: true });
  updateReceipt(stopped.id!, { state });
  discardDelegations(bus(), from.threadId, from.id, "stopped");
  expect(findDelegationReceipt(stopped.id!)?.state).toBe("dropped");
  expect(findDelegationReceipt(older.id!)?.state).toBe("ready");
  store.setActivity(target.id, "idle");
  const run = vi.fn();
  drainWaitingOn(bus(), bus(), run);
  await flush();
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][1]).toContain("older");
});

it("cannot launch a stopped ask when its outstanding approval is allowed", async () => {
  from = store.patchBot(from.id, { approvePeerComms: true })!;
  start("stopped");
  const queued = queueDelegation(bus(), from, { toBotId: target.id, message: "work", depth: 0 }, 1, from.threadId, { kind: "ask", ready: true });
  const run = vi.fn();
  drainWaitingOn(bus(), bus(), run);
  expect(findDelegationReceipt(queued.id!)?.state).toBe("approval");
  const requestId = store.messagesFor(from.threadId).find((row) => row.card?.requestId)?.card?.requestId;
  discardDelegations(bus(), from.threadId, from.id, "stopped");
  resolvePeerComms(bus(), requestId!, "allow");
  await flush();
  expect(run).not.toHaveBeenCalled();
  expect(findDelegationReceipt(queued.id!)?.state).toBe("dropped");
});

function response() {
  let body = "";
  const res = { writeHead() {}, getHeader() {}, setHeader() {}, end(value: string) { body = value; } } as unknown as ServerResponse;
  return { res, body: () => JSON.parse(body) };
}

function routes(askBotAndWait = vi.fn(), resolveCommsCaller?: Parameters<typeof createInternalRoutes>[0]["resolveCommsCaller"]) {
  return createInternalRoutes({ store, commsBus: bus(), approvalBus: bus(), MAX_COMMS_DEPTH: 1,
    MAX_WORKSPACE_BOTS: 100, checkedMemberIds: (memberIds: string[]) => ({ ok: true, memberIds }),
    connectorThread: (botId: string, threadId: string) => store.conversationForBot(botId, threadId),
    delegationWatch: new Map(), askBotAndWait, resolveCommsCaller,
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
}

it.each(["askBot", "delegateBot", "createBot", "createChannel"] as const)("refuses a second hop through %s", async (method) => {
  from = store.patchBot(from.id, { chiefOfStaff: true })!;
  turnRegistry.start("peer-turn", { botId: from.id, threadId: from.threadId, owner: "peer", depth: 1 });
  const botCount = store.bots.length;
  const groupCount = store.groups.length;
  const askBotAndWait = vi.fn();
  const req = new EventEmitter() as IncomingMessage;
  const output = response();
  const pending = routes(askBotAndWait)[method](req, output.res);
  req.emit("data", JSON.stringify({ fromBotId: from.id, fromThreadId: from.threadId, toBotId: target.id, message: "work", depth: 1, name: "New peer", role: "Reviewer", instructions: "Review work", memberIds: [target.id] }));
  req.emit("end");
  await pending;
  expect(output.body().error).toBe("message chains are limited to one hop");
  expect(askBotAndWait).not.toHaveBeenCalled();
  expect(store.bots).toHaveLength(botCount);
  expect(store.groups).toHaveLength(groupCount);
});

it.each(["createBot", "createChannel"] as const)("keeps %s available at depth 0", async (method) => {
  from = store.patchBot(from.id, { chiefOfStaff: true })!;
  start("user-turn");
  const callers = new CommsCallers();
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { authorization: `Bearer ${callers.token(from.id, from.threadId)}` };
  const output = response();
  const pending = routes(vi.fn(), (header) => callers.resolve(header))[method](req, output.res);
  req.emit("data", JSON.stringify({ fromBotId: from.id, fromThreadId: from.threadId, name: "New peer", role: "Reviewer", instructions: "Review work", memberIds: [target.id], depth: 0 }));
  req.emit("end");
  await pending;
  expect(output.body().id).toBeTruthy();
  expect(output.body().error).toBeUndefined();
});

it.each(["createBot", "createChannel"] as const)("refuses %s with an unknown caller token", async (method) => {
  from = store.patchBot(from.id, { chiefOfStaff: true })!;
  const callers = new CommsCallers();
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { authorization: "Bearer forged" };
  const output = response();
  const pending = routes(vi.fn(), (header) => callers.resolve(header))[method](req, output.res);
  req.emit("data", JSON.stringify({ fromBotId: from.id, fromThreadId: from.threadId,
    depth: 0, name: "New peer", role: "Reviewer", instructions: "Review work", memberIds: [target.id] }));
  req.emit("end");
  await pending;
  expect(output.body()).toEqual({ error: "unknown sender" });
});

it.each([
  ["createBot", "direct"], ["createBot", "channel"], ["createBot", "channel task"],
  ["createChannel", "direct"], ["createChannel", "channel"], ["createChannel", "channel task"],
] as const)("keeps %s scoped to its depth-0 %s caller", async (method, scope) => {
  from = store.patchBot(from.id, { chiefOfStaff: true })!;
  const group = store.createGroup("User channel", [from.id, target.id]);
  const threadId = scope === "direct" ? from.threadId : scope === "channel" ? group.threadId : store.createGroupTask(group.id, "Research")!.threadId;
  const turnId = `user-${scope}`;
  turnRegistry.start(turnId, { botId: from.id, threadId, owner: scope === "direct" ? "user" : "room", depth: 0 });
  try {
    const callers = new CommsCallers();
    const req = new EventEmitter() as IncomingMessage;
    req.headers = { authorization: `Bearer ${callers.token(from.id, threadId)}` };
    const output = response();
    const pending = routes(vi.fn(), (header) => callers.resolve(header))[method](req, output.res);
    req.emit("data", JSON.stringify({ fromBotId: target.id, fromThreadId: target.threadId,
      name: "New operator", role: "Researcher", instructions: "Research the question", memberIds: [target.id] }));
    req.emit("end");
    await pending;
    expect(output.body().id).toBeTruthy();
    expect(output.body().error).toBeUndefined();
    if (method === "createBot") expect(store.bot(output.body().id)).toMatchObject({ color: "white", mascotStyle: "icon-33" });
    else expect(output.body().memberIds).toEqual([from.id, target.id]);
  } finally {
    turnRegistry.settle(turnId);
  }
});

it.each(["createBot", "createChannel"] as const)("refuses %s after its scoped caller loses channel access", async (method) => {
  from = store.patchBot(from.id, { chiefOfStaff: true })!;
  const group = store.createGroup("Revoked channel", [from.id, target.id]);
  const callers = new CommsCallers();
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { authorization: `Bearer ${callers.token(from.id, group.threadId)}` };
  store.patchGroup(group.id, { memberIds: [target.id] });
  const output = response();
  const botCount = store.bots.length;
  const groupCount = store.groups.length;
  const pending = routes(vi.fn(), (header) => callers.resolve(header))[method](req, output.res);
  req.emit("data", JSON.stringify({ fromBotId: from.id, fromThreadId: from.threadId,
    name: "New operator", role: "Researcher", instructions: "Research the question", memberIds: [target.id] }));
  req.emit("end");
  await pending;
  expect(output.body()).toEqual({ error: "source conversation does not belong to sender" });
  expect(store.bots).toHaveLength(botCount);
  expect(store.groups).toHaveLength(groupCount);
});

it.each([
  ["createBot", false], ["createBot", true], ["createChannel", false], ["createChannel", true],
] as const)("binds %s to the peer caller (forged thread: %s)", async (method, forgedThread) => {
  from = store.patchBot(from.id, { chiefOfStaff: true })!;
  const other = store.createTask(from.id, "Other task", false)!;
  turnRegistry.start("peer-turn", { botId: from.id, threadId: from.threadId, owner: "peer", depth: 1 });
  const callers = new CommsCallers();
  const req = new EventEmitter() as IncomingMessage;
  req.headers = { authorization: `Bearer ${callers.token(from.id, from.threadId)}` };
  const output = response();
  const botCount = store.bots.length;
  const groupCount = store.groups.length;
  const pending = routes(vi.fn(), (header) => callers.resolve(header))[method](req, output.res);
  req.emit("data", JSON.stringify({ fromBotId: from.id, fromThreadId: forgedThread ? other.threadId : from.threadId,
    depth: 0, name: "New peer", role: "Reviewer", instructions: "Review work", memberIds: [target.id] }));
  req.emit("end");
  await pending;
  expect(output.body().error).toContain("limited to one hop");
  expect(store.bots).toHaveLength(botCount);
  expect(store.groups).toHaveLength(groupCount);
});

it.each(["askBot", "delegateBot", "createBot", "createChannel"] as const)("uses the live peer depth to guard %s", async (method) => {
  from = store.patchBot(from.id, { chiefOfStaff: true })!;
  turnRegistry.start("peer-turn", { botId: from.id, threadId: from.threadId, owner: "peer", depth: 1 });
  const req = new EventEmitter() as IncomingMessage;
  const output = response();
  const pending = routes()[method](req, output.res);
  req.emit("data", JSON.stringify({ fromBotId: from.id, fromThreadId: from.threadId, toBotId: target.id, message: "work", name: "New peer", role: "Reviewer", instructions: "Review work", memberIds: [target.id], depth: 0 }));
  req.emit("end");
  await pending;
  expect(output.body().error).toContain("limited to one hop");
});

it.each(["wait", "ask"])("leaves an old %s caller's reply unread after a replacement turn completes", async (mode) => {
  vi.useFakeTimers();
  start("old");
  const taskId = "wait-task-12345678";
  let finish: (value: { replied: boolean; text: string }) => void = () => {};
  const askBotAndWait = vi.fn(() => new Promise<{ replied: boolean; text: string }>((resolve) => { finish = resolve; }));
  const route = routes(askBotAndWait);
  const output = response();
  let pending: Promise<unknown>;
  if (mode === "wait") {
    recordDelegationReceipt({ id: taskId, sourceThreadId: from.threadId, toBotId: target.id, toBotName: target.name, status: "running", state: "running" });
    const url = new URL(`http://localhost/task?fromBotId=${from.id}&fromThreadId=${from.threadId}&wait_ms=1000`);
    pending = route.delegationStatus(output.res, ["", taskId] as RegExpMatchArray, url);
  } else {
    const req = new EventEmitter() as IncomingMessage;
    pending = route.askBot(req, output.res);
    req.emit("data", JSON.stringify({ fromBotId: from.id, fromThreadId: from.threadId, toBotId: target.id, message: "work" }));
    req.emit("end");
    await vi.advanceTimersByTimeAsync(0);
    expect(askBotAndWait).toHaveBeenCalledOnce();
  }
  turnRegistry.settle("old");
  start("new");
  if (mode === "wait") finishDelegatedTurn(bus(), { taskId, toBotId: target.id, sourceThreadId: from.threadId, sourceBotId: from.id, inline: true }, true, "late answer");
  else finish({ replied: true, text: "late answer" });
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(output.body()).toBeTruthy();
  settleMail(store, from.threadId, "new", true);
  const parts = mailForTurn(store, from.threadId);
  expect(parts).toHaveLength(1);
  expect(parts[0].text).toContain("late answer");
});

it.each([false, true])("retains deferred mail across compaction and session rebuild (partial: %s)", async (partial) => {
  const row = reply("deferred reply payload");
  if (partial) markMailRead(store, from.threadId, [{ id: row.id, upto: 8 }], "first");
  for (let i = 0; i < 80; i++) store.appendMessage(from.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `history ${i} ${"detail ".repeat(30)}` });
  const prepared = await prepareModelContext({ messages: store.activePath(from.threadId), contextWindow: 2048, taskRecordText: "Keep replies", summarize: async () => "SUMMARY\nolder work" });
  expect(prepared.status).toBe("ready");
  if (prepared.status !== "ready" || !prepared.compaction) throw new Error("missing compaction");
  store.appendCompaction(from.threadId, prepared.compaction);
  markMailRead(store, from.threadId, [{ id: row.id, upto: row.text!.length }], "later");
  const rebuilt = await prepareModelContext({ messages: store.activePath(from.threadId), contextWindow: 2048, taskRecordText: "Keep replies" });
  expect(rebuilt.status).toBe("ready");
  if (rebuilt.status !== "ready") return;
  expect(rebuilt.transcript.some((message) => message.text.includes(partial ? " reply payload" : row.text!))).toBe(true);
});

it.each([false, true])("retains late delivery through another summary (deliver a prefix first: %s)", async (partial) => {
  const row = reply("FIRST-SEGMENT SECOND-SEGMENT");
  const history = () => {
    for (let i = 0; i < 80; i++) store.appendMessage(from.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `more work ${i} ${"detail ".repeat(30)}` });
  };
  const compact = async () => {
    const result = await prepareModelContext({ messages: store.activePath(from.threadId), contextWindow: 2048, taskRecordText: "Keep replies", summarize: async () => "SUMMARY\nolder work" });
    if (result.status !== "ready" || !result.compaction) throw new Error("missing compaction");
    store.appendCompaction(from.threadId, result.compaction);
  };
  history();
  await compact();
  if (partial) markMailRead(store, from.threadId, [{ id: row.id, upto: 14 }], "prefix");
  history();
  await compact();
  markMailRead(store, from.threadId, [{ id: row.id, upto: row.text!.length }], "finish");
  const rebuilt = await prepareModelContext({ messages: store.activePath(from.threadId), contextWindow: 2048, taskRecordText: "Keep replies" });
  expect(rebuilt.status).toBe("ready");
  if (rebuilt.status !== "ready") return;
  expect(rebuilt.transcript.some((message) => message.text.includes(partial ? "SECOND-SEGMENT" : row.text!))).toBe(true);
  if (partial) expect(rebuilt.transcript.some((message) => message.text.includes("FIRST-SEGMENT"))).toBe(false);
});

it.each([false, true])("retains deferred mail when repairing a fallback summary (partial: %s)", async (partial) => {
  const row = reply("FIRST-SEGMENT SECOND-SEGMENT");
  const history = () => {
    for (let i = 0; i < 80; i++) store.appendMessage(from.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `more work ${i} ${"detail ".repeat(30)}` });
  };
  const compact = async (summarize?: (prompt: string) => Promise<string>) => {
    const result = await prepareModelContext({ messages: store.activePath(from.threadId), contextWindow: 2048, taskRecordText: "Keep replies", summarize });
    if (result.status !== "ready" || !result.compaction) throw new Error("missing compaction");
    store.appendCompaction(from.threadId, result.compaction);
  };
  history();
  await compact(async () => "SUMMARY\nolder work");
  if (partial) markMailRead(store, from.threadId, [{ id: row.id, upto: 14 }], "prefix");
  history();
  await compact();
  const target = repairTarget(store.activePath(from.threadId));
  if (!target) throw new Error("missing repair target");
  markMailRead(store, from.threadId, [{ id: row.id, upto: row.text!.length }], "finish");
  const summarize = vi.fn(async (_prompt: string) => "SUMMARY\nrepaired work");
  const repaired = await repairModelContext({ messages: store.activePath(from.threadId), target, taskRecordText: "Keep replies", summarize });
  expect(repaired.status).toBe("ready");
  if (repaired.status !== "ready") return;
  if (partial) expect(summarize.mock.calls.some(([prompt]) => prompt.includes("FIRST-SEGMENT"))).toBe(true);
  expect(summarize.mock.calls.some(([prompt]) => prompt.includes("SECOND-SEGMENT"))).toBe(false);
  store.appendCompaction(from.threadId, repaired.compaction);
  const rebuilt = await prepareModelContext({ messages: store.activePath(from.threadId), contextWindow: 2048, taskRecordText: "Keep replies" });
  expect(rebuilt.status).toBe("ready");
  if (rebuilt.status !== "ready") return;
  expect(rebuilt.transcript.some((message) => message.text.includes(partial ? "SECOND-SEGMENT" : row.text!))).toBe(true);
});
