import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { beforeEach, expect, it, vi } from "vitest";
import { _resetCommsRoots, rootForStart } from "./comms-root.ts";
import { prepareModelContext } from "./context-compaction.ts";
import { delegationContext } from "./delegation-context.ts";
import { loadDelegationReceipts } from "./delegation-ledger.ts";
import { _resetPending, finishDelegatedTurn, queueDelegation, recordDelegationReceipt } from "./delegations.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import { markMailRead } from "./mail.ts";
import { Store, type Message } from "./store.ts";
import { turnRegistry } from "./turn-registry.ts";

let store: Store;
let bot: ReturnType<Store["createBot"]>;
let peer: ReturnType<Store["createBot"]>;
const bus = () => ({ store, broadcast: () => {} });

beforeEach(() => {
  _resetPending();
  _resetCommsRoots();
  store = new Store(() => ({ instanceId: "claude", model: "fake" }));
  bot = store.createBot({ name: "Caller" }, { seedMessages: false });
  peer = store.createBot({ name: "Pokkey" }, { seedMessages: false });
});

function delegate(text?: string, name = "delegate_bot") {
  const call = store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name, ok: true } });
  const task = queueDelegation(bus(), bot, { toBotId: peer.id, message: "Verify it", depth: 0 }, 1, bot.threadId, { kind: name === "ask_bot" ? "ask" : "delegation" });
  if (!task.id) throw new Error(task.result);
  if (text !== undefined) {
    finishDelegatedTurn(bus(), { taskId: task.id, toBotId: peer.id, sourceThreadId: bot.threadId, sourceBotId: bot.id }, true, text);
    const reply = store.messagesFor(bot.threadId).find((row) => row.comm?.taskId === task.id && row.comm?.peer === "reply")!;
    markMailRead(store, bot.threadId, [{ id: reply.id, upto: text.length }], "read");
  }
  return { id: task.id, call };
}

async function replay(messages = store.activePath(bot.threadId)) {
  const result = await prepareModelContext({ messages, contextWindow: 200_000, taskRecordText: "" });
  if (result.status !== "ready") throw new Error(result.status);
  return result.transcript;
}

function routes(askBotAndWait?: Parameters<typeof createInternalRoutes>[0]["askBotAndWait"]) {
  const deps: Partial<Parameters<typeof createInternalRoutes>[0]> = {
    store, commsBus: bus(), approvalBus: bus(), MAX_COMMS_DEPTH: 1, delegationWatch: new Map(), askBotAndWait,
    connectorThread: (botId, threadId) => store.conversationForBot(botId, threadId),
  };
  // SAFETY: these routes use only the dependencies supplied above.
  return createInternalRoutes(deps as Parameters<typeof createInternalRoutes>[0]);
}

function response() {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const end = vi.spyOn(res, "end").mockReturnValue(res);
  return { res, body: () => JSON.parse(String(end.mock.calls[0]?.[0])) };
}

async function check(taskId?: string, fromBotId = bot.id, fromThreadId = bot.threadId) {
  const output = response();
  const match = `/api/internal/delegations/${taskId ?? "recent"}`.match(/^\/api\/internal\/delegations\/([\w-]{4,64})$/)!;
  await routes().delegationStatus(output.res, match, new URL(`http://localhost/api/internal/delegations/${taskId ?? "recent"}?fromBotId=${fromBotId}&fromThreadId=${fromThreadId}${taskId === undefined ? "&list=1" : ""}`));
  return { status: output.res.statusCode, body: output.body() };
}

it("carries two delegation ids and bounded reply gists without changing other rollup bytes", async () => {
  const first = delegate("Restarted both Sol jobs.\nDetails stay in the reply.");
  const second = delegate("Verified ".repeat(20) + "\nSecond line.", "ask_bot");
  store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "Read", ok: false } });
  const messages = store.activePath(bot.threadId);
  const carried = await replay(messages);
  const plain = await replay(messages.map((row): Message => ({ ...row, comm: row.comm?.peer === "reply" ? row.comm : undefined })));
  const added = carried.map((row) => row.text).join("\n").length - plain.map((row) => row.text).join("\n").length;
  const text = carried.map((row) => row.text).join("\n");
  expect(text).toContain(`delegate_bot 1 (task ${first.id.slice(0, 8)} -> @Pokkey: "Restarted both Sol jobs.")`);
  expect(text).toContain(`ask_bot 1 (task ${second.id.slice(0, 8)} -> @Pokkey: "${("Verified ".repeat(20)).slice(0, 100)}")`);
  expect(carried.map((row) => ({ ...row, text: row.text.replace(/ \(task [^\n]*?\)/g, "") }))).toEqual(plain);
  expect(added).toBeGreaterThan(0);
  expect(added).toBeLessThan(500);
});

it("keeps a queued id when tool detail capture is disabled", async () => {
  const task = delegate();
  expect(await replay()).toEqual([{ role: "assistant", text: `[1 tool call: delegate_bot 1 (task ${task.id.slice(0, 8)} -> @Pokkey)]` }]);
});

it("keeps only the five newest delegations in a tool rollup", async () => {
  const tasks = Array.from({ length: 7 }, (_, i) => {
    const id = `task000${i}-full-id`;
    store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "delegate_bot", ok: true } });
    store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "@Pokkey replied", ok: true }, comm: { groupId: "", withBotId: peer.id, withName: peer.name, withColor: peer.color, taskId: id, state: "done" } });
    recordDelegationReceipt({ id, sourceThreadId: bot.threadId, toBotId: peer.id, toBotName: peer.name, status: "done", result: `Reply ${i}` });
    return { id };
  });
  const text = (await replay()).map((row) => row.text).join("\n");
  expect(text.match(/\(task /g) ?? []).toHaveLength(5);
  for (const task of tasks.slice(0, 2)) expect(text).not.toContain(task.id.slice(0, 8));
  for (const task of tasks.slice(2)) expect(text).toContain(task.id.slice(0, 8));
  expect(text).toContain("delegate_bot 7");
});

it("keeps the five newest annotations per tool in a mixed rollup", async () => {
  const tasks = ["delegate_bot", "ask_bot"].map((name, kind) => Array.from({ length: 7 }, (_, i) => {
    const id = `task${kind}00${i}-full-id`;
    store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: `mcp__agents__${name}`, ok: true, detail: { output: [`Task id: ${id}`] } } });
    recordDelegationReceipt({ id, sourceThreadId: bot.threadId, toBotId: peer.id, toBotName: peer.name, status: "done", result: `Reply ${i}` });
    return id;
  }));
  const text = (await replay())[0].text;
  expect(text.match(/\(task /g) ?? []).toHaveLength(10);
  for (const ids of tasks) {
    for (const id of ids.slice(0, 2)) expect(text).not.toContain(id.slice(0, 8));
    for (const id of ids.slice(2)) expect(text).toContain(id.slice(0, 8));
  }
  expect(text).toContain("delegate_bot 7");
  expect(text).toContain("ask_bot 7");
});

it("carries a busy peer's queued ask without a raw ask chip", async () => {
  const rootId = rootForStart(bot.threadId, { kind: "human", messageKey: "continuity-busy" });
  turnRegistry.prepare({ botId: bot.id, threadId: bot.threadId, owner: "user", depth: 0, rootId });
  turnRegistry.started("continuity-busy", bot.threadId);
  store.patchBot(peer.id, { busy: true });
  const req = new IncomingMessage(new Socket());
  const output = response();
  const pending = routes().askBot(req, output.res);
  req.emit("data", JSON.stringify({ fromBotId: bot.id, fromThreadId: bot.threadId, toBotId: peer.id, message: "Verify" }));
  req.emit("end");
  await pending;
  const id: string = output.body().taskId;
  expect(id).toBeTruthy();
  expect(store.messagesFor(bot.threadId).some((row) => row.tool?.name.endsWith("ask_bot"))).toBe(false);
  expect((await replay()).map((row) => row.text).join("\n")).toContain(`(task ${id.slice(0, 8)} -> @Pokkey)`);
  finishDelegatedTurn(bus(), { taskId: id, toBotId: peer.id, sourceThreadId: bot.threadId, sourceBotId: bot.id, ask: true }, true, "Queued verification finished.\nDetails");
  _resetPending();
  loadDelegationReceipts();
  expect((await replay())[0].text).toContain(`(task ${id.slice(0, 8)} -> @Pokkey: "Queued verification finished.")`);
});

it("keeps a completed synchronous ask out of a later ask's annotation", async () => {
  const rootId = rootForStart(bot.threadId, { kind: "human", messageKey: "continuity-sync" });
  turnRegistry.prepare({ botId: bot.id, threadId: bot.threadId, owner: "user", depth: 0, rootId });
  turnRegistry.started("continuity-sync", bot.threadId);
  const calls: Message[] = [];
  for (const replied of [true, false]) {
    calls.push(store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "ask_bot", ok: true } }));
    const route = routes(async (_target, _text, _depth, _from, task) => replied ? { text: "Done", replied } : { text: "Still working", replied, taskId: task!.taskId });
    const req = new IncomingMessage(new Socket());
    const output = response();
    const pending = route.askBot(req, output.res);
    req.emit("data", JSON.stringify({ fromBotId: bot.id, fromThreadId: bot.threadId, toBotId: peer.id, message: "Verify" }));
    req.emit("end");
    await pending;
  }
  const messages = store.activePath(bot.threadId);
  const details = delegationContext(messages, messages);
  const id = messages.find((row) => row.comm?.peer === "message" && row.comm.taskId)!.comm!.taskId!;
  expect(details.has(calls[0].id)).toBe(false);
  expect(details.get(calls[1].id)).toBe(`task ${id.slice(0, 8)} -> @Pokkey`);
});

it("lists the caller's five newest delegations with status and gist without consuming mail", async () => {
  const tasks = Array.from({ length: 7 }, (_, i) => {
    const id = `task000${i}-full-id`;
    recordDelegationReceipt({ id, sourceThreadId: bot.threadId, toBotId: peer.id, toBotName: peer.name, source: { botId: bot.id, threadId: bot.threadId, turnId: "turn" }, status: (["done", "done", "done", "denied", "running", "queued", "done"] as const)[i], result: `Reply ${i}\nPrivate second line`, finishedAt: Date.now() + i });
    return id;
  });
  recordDelegationReceipt({ id: "outsider-task", sourceThreadId: bot.threadId, toBotId: peer.id, toBotName: peer.name, source: { botId: peer.id, threadId: bot.threadId, turnId: "other" }, status: "done", result: "Other caller", finishedAt: Date.now() + 100 });
  const before = store.messagesFor(bot.threadId);
  const result = await check();
  expect(result.status).toBe(200);
  expect(result.body.tasks).toEqual(tasks.slice(2).reverse().map((id, i) => ({ id: id.slice(0, 8), peer: "Pokkey", status: ["done", "queued", "running", "failed", "done"][i], gist: `Reply ${6 - i}` })));
  expect(store.messagesFor(bot.threadId)).toEqual(before);
});

it("lists queued tasks and preserves the existing lookup by id", async () => {
  const task = delegate();
  expect((await check()).body.tasks).toEqual([{ id: task.id.slice(0, 8), peer: "Pokkey", status: "queued", gist: "" }]);
  expect((await check(task.id)).body).toMatchObject({ status: "queued" });
});

it("returns an empty list and rejects a caller outside the source conversation", async () => {
  expect((await check()).body).toEqual({ tasks: [] });
  expect((await check(undefined, peer.id, bot.threadId)).status).toBe(403);
  expect((await check("recent")).status).toBe(400);
});

it("carries a timed-out ask_bot id before and after its reply settles", async () => {
  const rootId = rootForStart(bot.threadId, { kind: "human", messageKey: "continuity-timeout" });
  turnRegistry.prepare({ botId: bot.id, threadId: bot.threadId, owner: "user", depth: 0, rootId });
  turnRegistry.started("continuity-timeout", bot.threadId);
  const route = routes(async (_target, _text, _depth, _from, task) => ({ text: "Still working", replied: false, taskId: task!.taskId }));
  const req = new IncomingMessage(new Socket());
  const output = response();
  const pending = route.askBot(req, output.res);
  req.emit("data", JSON.stringify({ fromBotId: bot.id, fromThreadId: bot.threadId, toBotId: peer.id, message: "Verify" }));
  req.emit("end");
  await pending;
  const id: string = output.body().taskId;
  expect(id).toBeTruthy();
  expect((await replay()).map((row) => row.text).join("\n")).toContain(`ask_bot 1 (task ${id.slice(0, 8)} -> @Pokkey)`);
  expect((await check()).body.tasks[0].status).toBe("running");
  finishDelegatedTurn(bus(), { taskId: id, toBotId: peer.id, sourceThreadId: bot.threadId, sourceBotId: bot.id, ask: true }, true, "Finished the verification.\nDetails");
  _resetPending();
  expect((await replay()).map((row) => row.text).join("\n")).toContain(`ask_bot 1 (task ${id.slice(0, 8)} -> @Pokkey: "Finished the verification.")`);
  expect(store.messagesFor(bot.threadId).find((row) => row.comm?.taskId === id && row.comm?.peer === "message")?.tool?.detail).toBeUndefined();
});

it("keeps an earlier synchronous ask out of a later delegation's annotation", async () => {
  store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "ask_bot", ok: true } });
  const task = delegate();
  expect((await replay())[0].text).toBe(`[2 tool calls: ask_bot 1, delegate_bot 1 (task ${task.id.slice(0, 8)} -> @Pokkey)]`);
});

it("carries an id captured from an older ask's tool output", async () => {
  const id = "12345678-full-task-id";
  recordDelegationReceipt({ id, sourceThreadId: bot.threadId, toBotId: peer.id, toBotName: peer.name, status: "done", result: 'Verified "release".\r\nDo not include this line.' });
  store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "mcp__agents__ask_bot", ok: true, detail: { output: [`@Pokkey is still working. Task id: ${id}.`] } } });
  expect((await replay())[0].text).toBe(`[1 tool call: ask_bot 1 (task 12345678 -> @Pokkey: ${JSON.stringify('Verified "release".')})]`);
});

it("orders by delegation creation when an older task settles last", async () => {
  const older = delegate();
  const newer = delegate();
  finishDelegatedTurn(bus(), { taskId: older.id, toBotId: peer.id, sourceThreadId: bot.threadId, sourceBotId: bot.id }, true, "Older result");
  const recent = await check();
  expect(recent.status).toBe(200);
  expect(recent.body.tasks.map((task: { id: string }) => task.id)).toEqual([newer.id.slice(0, 8), older.id.slice(0, 8)]);
});

it("lists only the calling conversation's delegations and resolves every listed id", async () => {
  const task = delegate();
  const other = store.createTask(bot.id, "Other", false)!;
  recordDelegationReceipt({ id: "other123-task", sourceThreadId: other.threadId, toBotId: peer.id, toBotName: peer.name, status: "done", result: "Other thread reply" });
  const current = (await check()).body.tasks;
  expect(current).toEqual([{ id: task.id.slice(0, 8), peer: "Pokkey", status: "queued", gist: "" }]);
  for (const row of current) expect((await check(row.id)).status).toBe(200);
  const elsewhere = (await check(undefined, bot.id, other.threadId)).body.tasks;
  expect(elsewhere).toEqual([{ id: "other123", peer: "Pokkey", status: "done", gist: "Other thread reply" }]);
  for (const row of elsewhere) expect((await check(row.id, bot.id, other.threadId)).status).toBe(200);
});
