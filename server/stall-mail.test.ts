import { readFileSync, rmSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { handMail, mailForTurn, settleMail } from "./mail.ts";
import { stallErrorActivity } from "./room-error-attribution.ts";
import { Store } from "./store.ts";
import { TurnRegistry } from "./turn-registry.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);

function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}

const onStall = find(parsed, (node) => ts.isPropertyAssignment(node) && node.name.getText(parsed) === "onStall") as ts.PropertyAssignment;
const javascript = ts.transpileModule(`const onStall = ${onStall.initializer.getText(parsed)};`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

it("releases a reply handed to a turn the watchdog stopped", async () => {
  const store = new Store(() => ({ instanceId: "claude", model: "fake" }));
  const bot = store.createBot();
  const turnRegistry = new TurnRegistry();
  turnRegistry.start("stalled", { botId: bot.id, threadId: bot.threadId, owner: "user", depth: 0 });
  const row = store.appendMessage(bot.threadId, { role: "bot", kind: "activity", text: "@Bot, which branch?", comm: { groupId: "dm", withBotId: "peer", withName: "Peer", withColor: "blue", peer: "reply", taskId: "task", mailKey: `task:reply:${bot.threadId}`, wake: true, state: "done" } });
  handMail(store, bot.threadId, "task", "stalled", "request");
  const noteArrived = vi.fn();
  const deps = {
    repeats: { settle() {} }, settlePendingToolMessages() {}, store, routineTurnThreads: new Set(), taskPacketForWrite: () => null,
    persistTaskPacket() {}, recordTaskCompletion() {}, registry: { get: () => null }, botAccounts: { instance: () => null }, TURN_STALL_MS: 600_000, stallErrorActivity,
    finalizeDelegationWatch() {}, turnRegistry, turnUsage: new Map(), roomStallCompletions: { stall() {} }, providerReload: { settled() {} },
    settleMail, paneWake: { noteArrived, settled() {} }, groupSpeakers: new Map(), stopScreenPoller() {}, activeVpsThreads: new Map(),
    drainQueuedSends() {}, drainConnectorResumes() {}, drainSecretResumes() {},
    workerTurns: { capture() {}, settled() {} },
    usageBoard: { turnSettled() {} }, roomLanes: { thread: () => undefined, settle() {} },
  };
  new Function(...Object.keys(deps), `${javascript}\nreturn onStall;`)(...Object.values(deps))({ botId: bot.id, threadId: bot.threadId });
  await vi.advanceTimersByTimeAsync(6_000);
  expect(mailForTurn(store, bot.threadId).map((part) => part.id)).toEqual([row.id]);
  expect(noteArrived).toHaveBeenCalledWith(bot.id, bot.threadId);
  expect(turnRegistry.get("stalled")).toBeUndefined();
});
