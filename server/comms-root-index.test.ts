import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { isVoiceLine } from "../shared/live-call.ts";
import { _resetCommsRoots, adoptHumanRoot, callerSnapshot, commit, ownerRoot, reserve, ROOT_TURNS, rootForStart, type Reservation, type RootStart } from "./comms-root.ts";
import { Store } from "./store.ts";
import { _resetSteerQueue, foldQueuedSends, queueMark, queueSteeredMessage } from "./steer-queue.ts";
import { turnRegistry } from "./turn-registry.ts";

const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const compact = (text: string) => text.replace(/\s+/g, " ").trim();
const nodes = <T extends ts.Node>(guard: (node: ts.Node) => node is T): T[] => {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (guard(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

afterEach(() => {
  const turn = turnRegistry.current("root-index-thread");
  if (turn) turnRegistry.settle(turn.turnId);
  _resetCommsRoots();
  _resetSteerQueue();
});

it("adopts direct human steers without adopting control or imported messages", () => {
  const threadId = "root-index-thread";
  const botId = "direct-bot";
  const rootId = rootForStart(threadId, { kind: "human", messageKey: "original" });
  turnRegistry.prepare({ botId, threadId, owner: "user", depth: 0, rootId });
  turnRegistry.started("direct-turn", threadId);
  const captured = callerSnapshot(botId, threadId);
  const prelude = source.text.split("store.onChange((change) => {")[1]!.split("  switch (change.type) {")[0]!;
  const onChange = new Function("change", "store", "limitWaits", "console", "adoptHumanRoot", "isVoiceLine", prelude);
  const error = vi.fn();
  const message = { id: "steered", sendId: "direct-send", role: "user", kind: "text", steered: true };
  const change = (patch = {}, imported = false) => onChange({ type: "message", threadId, message: { ...message, ...patch }, imported }, { botByThread: () => null }, {}, { error }, adoptHumanRoot, isVoiceLine);
  change();
  const adopted = callerSnapshot(botId, threadId)?.rootId;
  expect(adopted).not.toBe(rootId);
  expect(adopted).toBe(rootForStart(threadId, { kind: "human", messageKey: message.sendId }));
  expect(captured?.rootId).toBe(rootId);
  change();
  expect(callerSnapshot(botId, threadId)?.rootId).toBe(adopted);
  for (const patch of [{ role: "bot", kind: "note" }, { origin: "routine" }, { from: { botId: "peer" } }, { steered: false }]) change({ ...patch, sendId: "control" });
  change({ sendId: "imported" }, true);
  expect(callerSnapshot(botId, threadId)?.rootId).toBe(adopted);
  expect(error).not.toHaveBeenCalled();
});

it("spends the thread root on provider continuation without minting one or taking its owner origin", () => {
  const threadId = "root-index-thread";
  const rootId = rootForStart(threadId, { kind: "human", messageKey: "original" });
  const starts = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "turnRegistry.start");
  expect(starts).toHaveLength(1);
  const options = new Function("botId", "threadId", "rootForStart", `return ${starts[0].arguments[1].getText(source)};`);
  for (let index = 0; index < ROOT_TURNS; index++) commit((reserve(rootId, "ask") as { reservation: Reservation }).reservation);
  turnRegistry.start("continued", options("bot", threadId, rootForStart));
  const continued = callerSnapshot("bot", threadId)?.rootId;
  expect([ownerRoot(continued), reserve(continued, "ask")]).toEqual([false, { ok: false, reason: "exhausted" }]);
  expect(options("bot", "detached", rootForStart).rootId).toBeNull();
});

it("lists every startTurn caller with its RootStart kind", () => {
  const starts: Array<{ call: string; kind: RootStart["kind"]; marker: string }> = [
    { call: "targetBotId, message", kind: "inherit", marker: "commsRoot: peer?.commsRoot ?? null" },
    { call: "botId, prompt", kind: "automatic", marker: "options" },
    { call: "row.botId, prompt", kind: "automatic", marker: "cardContinuation: true" },
    { call: "toBotId, text", kind: "inherit", marker: "commsRoot: root ?? null" },
    { call: "botId, PANE_WAKE_PROMPT", kind: "automatic", marker: "paneNoteWake: true" },
    { call: "botId, prompt", kind: "human", marker: "owner: true" },
    { call: "bot.id, TASK_RESUME_PROMPT", kind: "automatic", marker: "cardContinuation: true" },
    { call: "botId, prompt", kind: "automatic", marker: "automationSource: triggerSource" },
    { call: "source.bot.id, line", kind: "automatic", marker: "automationSource" },
    { call: "botId, prompt", kind: "human", marker: "owner: !guest" },
    { call: "entry.botId, prompt", kind: "automatic", marker: "cardContinuation: true" },
    { call: "entry.botId, prompt", kind: "automatic", marker: "cardContinuation: true" },
    { call: "botId, prompt", kind: "automatic", marker: "cardContinuation: true" },
    { call: "botId, text", kind: "human", marker: "{ ...opts, owner: true, privateOwner: true }" },
  ];
  const calls = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "startTurn");
  expect(calls.map((node) => node.arguments.slice(0, 2).map((arg) => compact(arg.getText(source))).join(", "))).toEqual(starts.map((row) => row.call));
  for (const [index, row] of starts.entries()) expect(compact(calls[index].arguments[2].getText(source)), row.kind).toContain(row.marker);
  expect(source.text).toContain("startTurn,");
});

it("lists every runGroupMemberTurn caller with its RootStart kind", () => {
  const starts: Array<{ call: string; kind: RootStart["kind"]; root: string; tail?: string[] }> = [
    { call: "group.id, threadId, botId", kind: "automatic", root: 'rootForStart(threadId, { kind: "automatic" })' },
    { call: "source.group.id, source.threadId, source.bot.id", kind: "automatic", root: 'guestWake ?? rootForStart(source.threadId, { kind: "automatic" })' },
    { call: "room.groupId, threadId, botId", kind: "inherit", root: "room.rootId ?? null", tail: ["room.askId", "room.hands", "room.chainAsk"] },
    { call: "groupId, threadId, next.id", kind: "inherit", root: "rootId", tail: ["undefined", "undefined", "asked"] },
    { call: "groupId, threadId, responder.id", kind: "human", root: "rootId" },
    { call: "current.group.id, entry.threadId, entry.botId", kind: "automatic", root: 'rootForStart(entry.threadId, { kind: "automatic" })' },
    { call: "current.group.id, entry.threadId, entry.botId", kind: "automatic", root: 'rootForStart(entry.threadId, { kind: "automatic" })' },
  ];
  const calls = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "runGroupMemberTurn");
  expect(calls.map((node) => node.arguments.slice(0, 3).map((arg) => compact(arg.getText(source))).join(", "))).toEqual(starts.map((row) => row.call));
  for (const [index, row] of starts.entries()) {
    expect(calls[index].arguments.slice(11).map((arg) => arg.getText(source)), row.kind).toEqual(row.tail ?? []);
    expect(compact(calls[index].arguments[10].getText(source)), row.kind).toBe(row.root);
  }
  const post = nodes(ts.isFunctionDeclaration).find((node) => node.name?.text === "startGroupTurn")!.getText(source);
  expect(post.indexOf('rootForStart(threadId, { kind: "human", messageKey: message.sendId ?? message.id })')).toBeLessThan(post.indexOf("prev.then("));
  expect(post).toContain('rootForStart(threadId, { kind: "human", messageKey: message.sendId ?? message.id })');
});

it("classifies accepted starts using server options and the accepted message key", () => {
  const root = nodes(ts.isVariableDeclaration).find((node) => node.name.getText(source) === "rootId" && node.initializer?.getText(source).includes("turnStartedByUser(opts)"))!;
  const predicate = nodes(ts.isFunctionDeclaration).find((node) => node.name?.text === "turnStartedByUser")!;
  const script = ts.transpileModule(`${predicate.getText(source)}\nreturn ${root.initializer!.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = new Function("rootForStart", "threadId", "opts", "commsDepth", "userMessage", script);
  const message = { id: "accepted", sendId: "send" };
  const human = run(rootForStart, "root-index-thread", {}, 0, message);
  expect(human).toBe(rootForStart("root-index-thread", { kind: "human", messageKey: "send" }));
  expect(run(rootForStart, "root-index-thread", {}, 0, message)).toBe(human);
  const fallback = run(rootForStart, "fallback", {}, 0, { id: "without-send" });
  expect(fallback).toBe(rootForStart("fallback", { kind: "human", messageKey: "without-send" }));
  const automatic = rootForStart("root-index-thread", { kind: "automatic" });
  expect([automatic === human, ownerRoot(automatic)]).toEqual([false, false]);
  for (const opts of [{ automationSource: "schedule" }, { cardContinuation: true }, { cardContinuation: true, keepGoingWake: true }, { cardContinuation: true, paneNoteWake: true }, { cardContinuation: true, limitWaitId: "wait" }]) {
    expect(run(rootForStart, "root-index-thread", opts, 0, { id: "control" })).toBe(automatic);
    expect(run(rootForStart, "detached", opts, 0, { id: "control" })).toBeNull();
  }
  expect(run(rootForStart, "peer", { commsDepth: 1, commsRoot: human }, 1, message)).toBe(human);
  expect(run(rootForStart, "peer", { commsDepth: 1 }, 1, message)).toBeNull();
});

it.each([["folded", "store.activePath(threadId).slice(-folded.length)"], ["queued", "store.pathTail(threadId, queued.length)"]])("adopts every human at the production %s fold and keeps captured roots", (_name, expression) => {
  const store = new Store(() => ({ instanceId: "claude", model: "fake" }));
  const bot = store.createBot();
  const threadId = bot.threadId;
  const rootId = rootForStart(threadId, { kind: "human", messageKey: "original" });
  turnRegistry.prepare({ botId: bot.id, threadId, owner: "user", depth: 0, rootId });
  turnRegistry.started("fold-turn", threadId);
  const snapshot = callerSnapshot(bot.id, threadId);
  const mark = queueMark();
  queueSteeredMessage(bot.id, threadId, "first", { sendId: "fold-first-00001" });
  queueSteeredMessage(bot.id, threadId, "last", { sendId: "fold-last-000001" });
  const folded = foldQueuedSends(store, bot.id, threadId, mark);
  const loop = nodes(ts.isForOfStatement).find((node) => node.expression.getText(source) === expression)!;
  expect(loop).toBeTruthy();
  const script = ts.transpileModule(loop.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = new Function("scope", `with (scope) { ${script}; return rootId; }`);
  const adopted = run({ store, threadId, rootId, folded, queued: folded, adoptHumanRoot });
  expect(adopted).toBe(rootForStart(threadId, { kind: "human", messageKey: "fold-last-000001" }));
  expect(callerSnapshot(bot.id, threadId)?.rootId).toBe(adopted);
  expect(snapshot?.rootId).toBe(rootId);
  expect(adopted).not.toBe(rootId);
  turnRegistry.settle("fold-turn");
});

it("keeps the comms depth cap and wires captured roots into every busy room path", () => {
  expect(source.text).toContain("const MAX_COMMS_DEPTH = 1;");
  const busy = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "queueBusyRoomMember");
  const busyPath = ["rootId", "authority", "hands", "chainAsk"];
  // the lane's hand-off: the teammate's ask is settled, so it carries the ask only for its start recheck, plus the chain's asker
  expect(busy.map((call) => call.arguments.slice(8).map((arg) => arg.getText(source)))).toEqual([busyPath, busyPath, busyPath, ["rootId", "undefined", "authority ?? true", "asked"]]);
  const prepares = nodes(ts.isCallExpression).filter((node) => node.expression.getText(source) === "turnRegistry.prepare");
  expect(prepares).toHaveLength(2);
  for (const call of prepares) expect(call.arguments[0].getText(source)).toContain("rootId");
});
