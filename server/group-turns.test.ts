import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createGroupRoutes } from "./group-routes.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { mentionedBots, roomResponders, Store, type BotRecord, type GroupRecord } from "./store.ts";
import { owedRoomResponders, packetAfterInterruption, roomRepliers, TaskResumeScheduler } from "./task-recovery-flush.ts";
import { seedTaskResumePacket } from "./task-state-fold.ts";

const index = ts.createSourceFile("index.ts", readFileSync(join(import.meta.dirname, "index.ts"), "utf8").replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true);

/** A top-level function, class or const of index.ts, built against `deps`. */
function load(name: string, deps: Record<string, unknown>) {
  const node = index.statements.find((statement) =>
    ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name)
    || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => item.name.getText(index) === name)));
  const code = ts.transpileModule(node!.getText(index), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(deps), `${code}\nreturn ${name};`)(...Object.values(deps));
}

const botChat = ts.createSourceFile("bot-chat-routes.ts", readFileSync(join(import.meta.dirname, "bot-chat-routes.ts"), "utf8").replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true);
const findResumeTask = (node: ts.Node): ts.ArrowFunction | undefined =>
  ts.isPropertyAssignment(node) && node.name.getText(botChat) === "resumeTask" && ts.isArrowFunction(node.initializer) ? node.initializer : ts.forEachChild(node, findResumeTask);
const resumeTaskCode = ts.transpileModule(`async function resumeTask(res, m) ${findResumeTask(botChat)!.body.getText(botChat)}`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

let store: Store;
let kai: BotRecord;
let ray: BotRecord;
let zed: BotRecord;
let group: GroupRecord;

beforeEach(() => {
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  [kai, ray, zed] = [store.createBot(), store.createBot(), store.createBot()];
  group = store.createGroup("Launch", [kai.id, ray.id, zed.id]);
});

const reply = (bot: BotRecord, text: string) =>
  store.appendMessage(group.threadId, { role: "bot", kind: "text", text, from: { botId: bot.id, name: bot.name, color: bot.color } });

describe("a tapped question card in a group", () => {
  const ask = () =>
    store.appendMessage(group.threadId, {
      role: "bot",
      kind: "options",
      from: { botId: ray.id, name: ray.name, color: ray.color },
      card: { title: "Question", subtitle: "Ship to prod?", options: ["Yes", "No"], askUser: true },
    });

  it("goes to the member that asked, not into another member's turn", async () => {
    store.patchGroup(group.id, { busyBotId: kai.id });
    const card = ask();
    const steer = vi.fn(async () => true);
    const startGroupTurn = vi.fn(() => ({ id: "m1" }));
    const routes = createGroupRoutes({
      store,
      groupIsWorking: (value: GroupRecord) => Boolean(value.busyBotId),
      instanceForBot: () => ({ adapter: { capabilities: { queueing: true }, steer } }),
      userName: () => "Edward",
      sendSequencer: new SendSequencer(),
      resolveReplyTarget: () => undefined,
      startGroupTurn,
    } as unknown as Parameters<typeof createGroupRoutes>[0]);
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await routes.postMessage(Readable.from([JSON.stringify({ text: "Yes", cardId: card.id })]) as unknown as IncomingMessage, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
    expect(res.writeHead.mock.calls[0][0]).toBe(202);
    expect(steer).not.toHaveBeenCalled();
    expect(startGroupTurn).toHaveBeenCalledWith(group.id, "Yes", undefined, undefined, ray.id, card.id);
  });

  it("runs the asking bot under a lead rule", async () => {
    store.patchGroup(group.id, { defaultResponder: { kind: "member", botId: kai.id } });
    const groupQueues = new Map<string, Promise<void>>();
    const runGroupMemberTurn = vi.fn(async (_group: string, _thread: string, _botId: string) => true);
    const start = load("startGroupTurn", {
      store,
      peopleOnlyRoom: () => false,
      roomSetupPending: () => false,
      rootForStart: () => null,
      noteTalked: vi.fn(),
      mentionedBots,
      roomResponders,
      resumePaneWakes: vi.fn(),
      taskPacketForWrite: () => null,
      seedTaskResumePacket: () => ({ instructionId: "i1" }),
      persistTaskPacket: vi.fn(),
      beginGroupTurnOperation: () => ({ cancelled: false, instructionId: "i1" }),
      finishGroupTurnOperation: vi.fn(),
      groupQueues,
      runGroupMemberTurn,
      roomTurnStillAssigned: load("roomTurnStillAssigned", { store }),
    });
    start(group.id, "Yes", undefined, undefined, ray.id);
    await groupQueues.get(group.id);
    expect(runGroupMemberTurn.mock.calls.map((call) => call[2])).toEqual([ray.id]);
    expect(store.messagesFor(group.threadId).at(-1)).toMatchObject({ role: "user", askedBy: ray.id });
  });
});

describe("a typed answer to an open question in a group", () => {
  const post = async (body: Record<string, unknown>) => {
    const startGroupTurn = vi.fn(() => ({ id: "m1" }));
    const routes = createGroupRoutes({
      store,
      groupIsWorking: (value: GroupRecord) => Boolean(value.busyBotId),
      instanceForBot: () => ({ adapter: { capabilities: { queueing: true }, steer: vi.fn(async () => true) } }),
      userName: () => "Edward",
      sendSequencer: new SendSequencer(),
      resolveReplyTarget: () => undefined,
      startGroupTurn,
    } as unknown as Parameters<typeof createGroupRoutes>[0]);
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await routes.postMessage(Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
    expect(res.writeHead.mock.calls[0][0]).toBe(202);
    return startGroupTurn;
  };

  it("goes to the member that asked, and stays a chat line", async () => {
    store.patchGroup(group.id, { defaultResponder: { kind: "member", botId: kai.id } });
    store.appendMessage(group.threadId, {
      role: "bot",
      kind: "options",
      from: { botId: ray.id, name: ray.name, color: ray.color },
      card: { title: "Question", subtitle: "Which color?", options: [], askUser: true },
    });
    expect(await post({ text: "blue" })).toHaveBeenCalledWith(group.id, "blue", undefined, undefined, ray.id, undefined);
  });

  it("keeps the room's rule when no question is open", async () => {
    expect(await post({ text: "blue" })).toHaveBeenCalledWith(group.id, "blue", undefined, undefined, undefined, undefined);
  });
});

describe("trashing a bot that is answering in a room", () => {
  it("stops its room turn while the room still names it", () => {
    store.patchGroup(group.id, { busyBotId: kai.id });
    const order: string[] = [];
    const turnEpochByBot = new Map<string, number>();
    const stopMember = vi.fn(async () => { order.push("stop"); turnEpochByBot.set(kai.id, 1); });
    class BotTrash {
      trash(botId: string) {
        order.push("trash");
        store.deleteBot(botId);
        turnEpochByBot.delete(botId);
        return { botId };
      }
    }
    const ServerBotTrash = load("ServerBotTrash", { BotTrash, store, groupRoutes: { stopMember }, stopBotWork: async () => {}, turnEpochByBot, currentTurnEpoch: (id: string) => turnEpochByBot.get(id) ?? 0 });
    new ServerBotTrash().trash(kai.id);
    expect(stopMember).toHaveBeenCalledWith(group.threadId, kai.id);
    expect(order).toEqual(["stop", "trash"]);
    expect(turnEpochByBot.get(kai.id)).toBe(1);
    expect(store.group(group.id)?.busyBotId).toBeNull();
  });
});

describe("a room whose only bot was deleted", () => {
  it("takes a new bot and lets the dead id go", () => {
    const solo = store.createGroup("Solo", [kai.id]);
    store.deleteBot(kai.id);
    const checked = load("checkedMemberIds", { store });
    expect(store.group(solo.id)?.memberIds).toEqual([kai.id]);
    expect(checked([kai.id, ray.id], [kai.id])).toEqual({ ok: true, memberIds: [ray.id] });
    expect(checked([kai.id], [kai.id])).toEqual({ ok: false, error: `unknown channel member: ${kai.id}` });
    expect(checked([ray.id, "missing-bot"], [kai.id])).toEqual({ ok: false, error: "unknown channel member: missing-bot" });
    expect(checked([kai.id, ray.id])).toEqual({ ok: false, error: `unknown channel member: ${kai.id}` });
  });
});

describe("a room turn cut off mid-line", () => {
  const packet = (botId: string, messageId: string) =>
    seedTaskResumePacket({ botId, threadId: group.threadId, text: "plan this", messageId, now: 1, turnsAtWrite: 0 });

  it("stamps the member that was speaking, not the line's first responder", () => {
    const flush = load("flushInterruptedTask", {
      store,
      taskPacketForWrite: (threadId: string) => packet(kai.id, "u1") && { ...packet(kai.id, "u1"), threadId },
      packetAfterInterruption,
      seedFromLastUser: () => null,
      persistTaskPacket: (next: unknown) => next,
    });
    expect(flush(group.threadId, ray.id, "stop")).toMatchObject({ botId: ray.id, flushReason: "stop" });
    expect(flush(kai.threadId, ray.id, "stop")).toMatchObject({ botId: kai.id });
  });

  const owed = (askedBy?: string) => {
    store.patchGroup(group.id, { defaultResponder: { kind: "everyone" } });
    const line = store.appendMessage(group.threadId, { role: "user", kind: "text", text: "plan this", ...(askedBy ? { askedBy } : {}) });
    const queueRoomParticipation = vi.fn();
    const queue = load("queueOwedRoomTurns", { store, owedRoomResponders, roomRepliers, roomResponders, queueRoomParticipation });
    return { line, queueRoomParticipation, run: () => queue(group.id, group.threadId, ray.id, line.id) };
  };

  it("queues the members a restart left owing an answer", () => {
    const { line, queueRoomParticipation, run } = owed();
    reply(kai, "Kai's plan");
    reply(ray, "Ray's half");
    run();
    expect(queueRoomParticipation.mock.calls).toEqual([[zed.id, group.threadId, { groupId: group.id, hop: 0, instructionId: line.id, spoken: new Set([kai.id, ray.id]), ready: expect.any(Function) }]]);
  });

  it("drops a queued member that an earlier recovered one brought in", async () => {
    const { queueRoomParticipation, run } = owed();
    reply(ray, "Ray's half");
    run();
    const ready = Object.fromEntries(queueRoomParticipation.mock.calls.map((call) => [call[0], call[2].ready]));
    reply(kai, "Kai's plan, over to Zed");
    expect(await ready[zed.id]()).toBe(true);
    reply(zed, "Zed's plan");
    expect(await ready[zed.id]()).toBe(false);
  });

  it("skips a member the resumed one brought in itself", () => {
    const { queueRoomParticipation, run } = owed();
    reply(kai, "Kai's plan");
    reply(ray, "Ray's plan, over to Zed");
    reply(zed, "Zed's plan");
    run();
    expect(queueRoomParticipation).not.toHaveBeenCalled();
  });

  it("owes nobody else a card answer, even in an everyone room", () => {
    const { queueRoomParticipation, run } = owed(ray.id);
    reply(ray, "Ray's half");
    run();
    expect(queueRoomParticipation).not.toHaveBeenCalled();
  });

  it("queues them once the resumed turn ends, and not after a Stop or a stall", async () => {
    const queueOwedRoomTurns = vi.fn();
    const groupTaskResumes = new Map();
    const operation = { cancelled: false };
    let ran = true;
    const taskResumes = load("taskResumes", {
      TaskResumeScheduler, groupTaskResumes, store, queueOwedRoomTurns,
      botHasActiveTurn: () => false, hasQueuedSendBefore: () => false, resumePaneWakes: () => {}, rootForStart: () => null,
      runGroupMemberTurn: async () => ran, isBusyRejection: () => false, broadcast: () => {}, drainQueuedSends: () => {},
    });
    const resume = async () => {
      groupTaskResumes.set(`${ray.id}\0${group.threadId}`, { groupId: group.id, operation, prompt: "resume", ready: true, release: () => {}, owedLine: "line-1" });
      await taskResumes.request(ray.id, group.threadId, 0);
    };
    await resume();
    expect(queueOwedRoomTurns.mock.calls).toEqual([[group.id, group.threadId, ray.id, "line-1"]]);
    operation.cancelled = true;
    await resume();
    [operation.cancelled, ran] = [false, false];
    await resume();
    expect(queueOwedRoomTurns).toHaveBeenCalledTimes(1);
  });

  it("leaves the rest alone when Continue follows a Stop", async () => {
    const startGroupCardContinuation = vi.fn();
    const record = { flushReason: "crash", instructionId: "line-1" };
    const deps = {
      store: { bot: () => ({ id: ray.id }), conversationForBot: () => ({ group }) },
      json: (_res: unknown, status: number) => status, cancelUsageWait: () => {}, taskPacketForWrite: () => record, isRecoveryFlushReason: () => true,
      isCompletedTaskRecord: () => false, startGroupCardContinuation, TASK_RESUME_PROMPT: "resume",
      taskResumes: { request: async () => ({ pending: true }) }, queueMark: () => 0, drainQueuedSends: () => {},
    };
    const resumeTask = new Function(...Object.keys(deps), `${resumeTaskCode}\nreturn resumeTask;`)(...Object.values(deps));
    expect(await resumeTask({}, ["", ray.id, group.threadId])).toBe(202);
    record.flushReason = "stop";
    await resumeTask({}, ["", ray.id, group.threadId]);
    expect(startGroupCardContinuation.mock.calls.map((call) => call[4])).toEqual(["line-1", undefined]);
  });
});
