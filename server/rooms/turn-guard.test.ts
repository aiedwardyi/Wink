import { readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { createGroupRoutes } from "../group-routes.ts";
import { _resetSteerQueue, drainSteeredMessages, queueRoomParticipation, type RoomDrain } from "../steer-queue.ts";
import { Store, type GroupRecord } from "../store.ts";
import { askById, closeAsksDb, configureRoomAsks, createAsk, hostedTurnRefused, startAsk, type HostedGroup, type RoomAsk } from "./asks.ts";
import { appendRoomEntry, closeRoomsDb, createRoom, recentRoomEntries } from "./db.ts";

const index = ts.createSourceFile("index.ts", readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8").replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true);
const js = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

/** A top-level function of index.ts, built against `deps`. */
function load(name: string, deps: Record<string, unknown>) {
  const node = index.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  expect(node).toBeDefined();
  return new Function(...Object.keys(deps), `${js(node!.getText(index))}\nreturn ${name};`)(...Object.values(deps));
}

const RUNNERS = ["runGroupMemberTurn", "runClaimedGroupMemberTurn", "enqueueDrainedRoomTurn"];

/** Every call of a room runner in index.ts, named by the function or property it sits in. */
function runnerCallers(): string[] {
  const out: string[] = [];
  const owner = (node: ts.Node): string => {
    for (let at = node.parent; at; at = at.parent) {
      if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
      if ((ts.isPropertyAssignment(at) || ts.isMethodDeclaration(at)) && at.name) return at.name.getText(index);
      if (ts.isVariableDeclaration(at) && ts.isSourceFile(at.parent.parent.parent)) return at.name.getText(index);
    }
    return "top";
  };
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && RUNNERS.includes(node.expression.text)) out.push(`${owner(node)} > ${node.expression.text}`);
    ts.forEachChild(node, walk);
  };
  walk(index);
  return out.sort();
}

let store: Store;
let group: HostedGroup;
let botId: string;
let interrupt: ReturnType<typeof vi.fn>;
let finishSession: () => void;

function ask(state: "queued" | "running" = "queued"): RoomAsk {
  const entry = appendRoomEntry(group.hosted.roomId, { author: { kind: "host", id: "host", name: "Edward" }, text: "@Wink go" });
  const created = createAsk({ roomId: group.hosted.roomId, threadId: group.threadId, botId, entryId: entry.id, clean: true, asker: { kind: "host", id: "host" }, grant: "work" });
  if (state === "running") expect(startAsk(created.id)).toBe(true);
  return created;
}

beforeEach(() => {
  closeRoomsDb();
  closeAsksDb();
  _resetSteerQueue();
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  botId = store.patchBot(store.createBot().id, { name: "Wink" })!.id;
  group = store.createGroup("Team", [botId], false, undefined, undefined, { roomId: createRoom("Team").id }) as HostedGroup;
  interrupt = vi.fn(async () => {});
  configureRoomAsks({
    store,
    hostName: () => "Edward",
    instance: () => null,
    dispatch: vi.fn(),
    stopTurn: vi.fn(async () => {}),
    endSession: () => new Promise<void>((resolve) => { finishSession = resolve; }),
  });
});
afterEach(() => {
  configureRoomAsks(null);
  closeAsksDb();
  closeRoomsDb();
});

describe("every room runner caller on a hosted thread", () => {
  it("is one of the known callers, each behind the guard", () => {
    expect(runnerCallers()).toEqual([
      "dispatch > enqueueDrainedRoomTurn",
      "dispatchConnectorResume > runGroupMemberTurn",
      "dispatchSecretResume > runGroupMemberTurn",
      "drainQueuedSends > enqueueDrainedRoomTurn",
      "enqueueDrainedRoomTurn > runGroupMemberTurn",
      "fix > enqueueDrainedRoomTurn",
      "runClaimedGroupMemberTurn > runGroupMemberTurn",
      "runGroupMemberTurn > runClaimedGroupMemberTurn",
      "start > runGroupMemberTurn",
      "startChatTurn > runGroupMemberTurn",
      "startGroupTurn > runGroupMemberTurn",
    ]);
    for (const name of RUNNERS) {
      const node = index.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name)!;
      expect(node.getText(index)).toMatch(/hostedTurnRefused\(/);
    }
  });

  const spies = () => ({
    botHasActiveTurn: vi.fn(() => false),
    tryClaimTurnStart: vi.fn(() => true),
    queueBusyRoomMember: vi.fn(() => true),
    runClaimedGroupMemberTurn: vi.fn(async () => true),
    resolvedBotSelection: vi.fn(),
    takeStartingHold: vi.fn(() => () => {}),
    beginGroupTurnOperation: vi.fn(),
  });

  // Task resume, routine, connector and credential resumes, a hop and an askless drain.
  const SHAPES: Array<[string, unknown[]]> = [
    ["task resume", [0, new Set(), "Continue the task", vi.fn(), () => false, undefined, undefined, null]],
    ["routine", [0, new Set(), "routine line", vi.fn(), () => false, undefined, new Set(["card"]), null]],
    ["connector resume", [0, new Set(), "Wink connection update", vi.fn(), () => false, undefined, undefined, null]],
    ["credential resume", [0, new Set(), "Wink credential update", vi.fn(), () => false, undefined, undefined, null]],
    ["hop", [1, new Set(), undefined, undefined, () => false, "instruction", undefined, "root"]],
    ["drain without an ask", [0, new Set(), undefined, vi.fn(), () => false, undefined, undefined, null, undefined]],
  ];

  it.each(SHAPES)("refuses the %s shape off the room's thread with 0 model calls", async (_name, args) => {
    const deps = spies();
    const cfg = { profile: {} };
    const run = load("runGroupMemberTurn", { ...deps, store, cfg, hostedTurnRefused, continueQueuedDrainIfIdle: vi.fn(), drainQueuedSends: vi.fn(), paneWake: {}, turnStartClaims: new Map() });
    expect(await run(group.id, "other-thread", botId, ...args)).toBe(false);
    const claimed = load("runClaimedGroupMemberTurn", { ...deps, store, cfg, hostedTurnRefused, currentTurnEpoch: () => 0 });
    expect(await claimed(group.id, "other-thread", botId, ...args.slice(0, 5), undefined, ...args.slice(5))).toBe(false);
    for (const spy of Object.values(deps)) expect(spy).not.toHaveBeenCalled();
  });

  it("refuses the Live Verify doc fix and any askless drain off the room's thread before ready or a queue slot", async () => {
    const ready = vi.fn(async () => true);
    const failed = vi.fn();
    const groupQueues = new Map();
    const beginGroupTurnOperation = vi.fn(() => ({ cancelled: false }));
    const runGroupMemberTurn = vi.fn();
    const drain = load("enqueueDrainedRoomTurn", {
      store, hostedTurnRefused, roomTurnStillAssigned: () => true, beginGroupTurnOperation, groupQueues, runGroupMemberTurn,
      finishGroupTurnOperation: vi.fn(), writeChatError: () => false, terminalBridgeAccess: null,
    });
    await drain(botId, "other-thread", { groupId: group.id, hop: 0, cardContinuation: "fix the doc", onDispatchError: failed, ready });
    expect(failed).toHaveBeenCalledTimes(1);
    expect([ready, beginGroupTurnOperation, runGroupMemberTurn].map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    expect(groupQueues.size).toBe(0);
  });

  it("passes a live ask's authority through the drain to the runner", async () => {
    const live = ask();
    const runGroupMemberTurn = vi.fn(async () => true);
    const finishGroupTurnOperation = vi.fn();
    const drain = load("enqueueDrainedRoomTurn", {
      store, hostedTurnRefused, roomTurnStillAssigned: () => true, groupQueues: new Map(), runGroupMemberTurn, finishGroupTurnOperation,
      beginGroupTurnOperation: () => ({ cancelled: false }), writeChatError: () => false, terminalBridgeAccess: null,
    });
    await drain(botId, group.threadId, { groupId: group.id, hop: 0, askId: live.id });
    expect(runGroupMemberTurn).toHaveBeenCalledTimes(1);
    expect((runGroupMemberTurn.mock.calls[0] as unknown[]).at(-1)).toBe(live.id);
  });

  it("commits the host's own room line with hostSend, then wakes the group's responders", () => {
    const hostSend = vi.fn(() => ({ message: { id: "m1" } }));
    const roomResponders = vi.fn(() => []);
    const appendMessage = vi.spyOn(store, "appendMessage");
    const start = load("startGroupTurn", {
      store, hostSend, roomResponders, peopleOnlyRoom: () => false, roomSetupPending: () => false, rootForStart: vi.fn(), noteTalked: vi.fn(), mentionedBots: () => [],
    });
    let sent: unknown;
    expect(() => { sent = start(group.id, "@Wink hi", { id: "x", roomEntryId: "e1" }, "send-0000000001"); }).not.toThrow();
    expect(sent).toEqual({ id: "m1" });
    expect(hostSend.mock.calls[0]).toEqual([expect.objectContaining({ id: group.id }), "@Wink hi", { id: "x", roomEntryId: "e1" }, "send-0000000001"]);
    expect(roomResponders).toHaveBeenCalledWith("@Wink hi", expect.anything(), group.defaultResponder);
    expect(appendMessage).not.toHaveBeenCalled();
  });
});

describe("askId through the room queue", () => {
  const fakeStore = () => ({ bot: (id: string) => store.bot(id), messagesFor: () => [], appendMessage: vi.fn(), patchMessage: vi.fn() });

  it("never folds two asks for one bot, and drains them one at a time", () => {
    queueRoomParticipation(botId, group.threadId, { groupId: group.id, askId: "ask-1" });
    queueRoomParticipation(botId, group.threadId, { groupId: group.id, askId: "ask-2" });
    queueRoomParticipation(botId, group.threadId, { groupId: group.id });
    const drained: RoomDrain[] = [];
    const run = (_bot: string, _thread: string, _prompt: string, _user: unknown, _ex: string[], room?: RoomDrain) => { drained.push(room!); };
    for (let i = 0; i < 4; i++) drainSteeredMessages(fakeStore(), run);
    expect(drained.map((room) => room.askId)).toEqual(["ask-1", "ask-2", undefined]);
  });
});

describe("room Stop on a hosted room", () => {
  it("cancels queued asks, takes stopping before the interrupt, and frees the bot only after endSession", async () => {
    finishSession = undefined as unknown as () => void;
    const releaseInterruptedBot = vi.fn();
    const running = ask("running");
    const queued = ask();
    store.patchGroup(group.id, { busyBotId: botId });
    const states: string[] = [];
    interrupt.mockImplementation(async () => { states.push(askById(running.id)!.state); });
    const routes = createGroupRoutes({
      store,
      registry: { get: () => ({ adapter: { interruptTurn: interrupt } }) },
      cancelGroupTurnOperations: vi.fn(),
      taskResumes: { forgetThread: vi.fn() },
      bumpTurnEpoch: () => 1,
      markThreadInterrupted: vi.fn(),
      flushInterruptedTask: vi.fn(),
      closeOpenApprovals: vi.fn(),
      releaseInterruptedBot,
      broadcast: vi.fn(),
      publicGroupState: (group: unknown) => group,
    } as unknown as Parameters<typeof createGroupRoutes>[0]);
    const res = { writeHead: vi.fn(), end: vi.fn() };
    const stopped = routes.interrupt(Readable.from([]) as unknown as IncomingMessage, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
    await vi.waitFor(() => expect(finishSession).toBeTypeOf("function"));
    expect(states).toEqual(["stopping"]);
    expect(askById(queued.id)!.state).toBe("cancelled");
    expect(askById(running.id)!.state).toBe("stopping");
    expect(releaseInterruptedBot).not.toHaveBeenCalled();
    finishSession();
    await stopped;
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    expect(releaseInterruptedBot).toHaveBeenCalledTimes(1);
    expect(askById(running.id)!.state).toBe("cancelled");
    expect(recentRoomEntries(group.hosted.roomId, 10).filter((entry) => entry.author.kind === "bot").map((entry) => entry.text)).toEqual(["Cancelled.", "Cancelled."]);
    expect(hostedTurnRefused(group as GroupRecord, group.threadId, botId, running.id)).toBe(true);
  });
});
