import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createGroupRoutes } from "./group-routes.ts";
import { SendSequencer } from "./send-idempotency.ts";
import { mentionedBots, roomResponders, Store, type BotRecord, type GroupRecord } from "./store.ts";
import { owedRoomResponders, packetAfterInterruption } from "./task-recovery-flush.ts";
import { seedTaskResumePacket } from "./task-state-fold.ts";

const index = ts.createSourceFile("index.ts", readFileSync(join(import.meta.dirname, "index.ts"), "utf8").replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true);

/** A top-level function or class of index.ts, built against `deps`. */
function load(name: string, deps: Record<string, unknown>) {
  const node = index.statements.find((statement) => (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name);
  const code = ts.transpileModule(node!.getText(index), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(deps), `${code}\nreturn ${name};`)(...Object.values(deps));
}

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
    expect(startGroupTurn).toHaveBeenCalledWith(group.id, "Yes", undefined, undefined, ray.id);
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
  });
});

describe("trashing a bot that is answering in a room", () => {
  it("stops its room turn while the room still names it", () => {
    store.patchGroup(group.id, { busyBotId: kai.id });
    const order: string[] = [];
    const stopMember = vi.fn(async () => { order.push("stop"); });
    class BotTrash {
      trash(botId: string) {
        order.push("trash");
        store.deleteBot(botId);
        return { botId };
      }
    }
    const ServerBotTrash = load("ServerBotTrash", { BotTrash, store, groupRoutes: { stopMember }, stopBotWork: async () => {} });
    new ServerBotTrash().trash(kai.id);
    expect(stopMember).toHaveBeenCalledWith(group.threadId, kai.id);
    expect(order).toEqual(["stop", "trash"]);
    expect(store.group(group.id)?.busyBotId).toBeNull();
  });
});

describe("a room whose only bot was deleted", () => {
  it("takes a new bot and lets the dead id go", () => {
    const solo = store.createGroup("Solo", [kai.id]);
    store.deleteBot(kai.id);
    const checked = load("checkedMemberIds", { store });
    expect(store.group(solo.id)?.memberIds).toEqual([kai.id]);
    expect(checked([kai.id, ray.id])).toEqual({ ok: true, memberIds: [ray.id] });
    expect(checked([kai.id])).toEqual({ ok: false, error: `unknown channel member: ${kai.id}` });
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

  it("queues the members a restart left owing an answer behind the resumed one", () => {
    store.patchGroup(group.id, { defaultResponder: { kind: "everyone" } });
    const line = store.appendMessage(group.threadId, { role: "user", kind: "text", text: "plan this" });
    reply(kai, "Kai's plan");
    reply(ray, "Ray's half");
    const queueRoomParticipation = vi.fn();
    const record = { ...packet(kai.id, line.id), flushReason: "crash" };
    const queue = load("queueOwedRoomTurns", { store, taskPacketForWrite: () => record, owedRoomResponders, roomResponders, queueRoomParticipation });
    queue(group.id, group.threadId, ray.id);
    expect(queueRoomParticipation.mock.calls).toEqual([[zed.id, group.threadId, { groupId: group.id, hop: 0, instructionId: line.id }]]);

    record.flushReason = "stop";
    queue(group.id, group.threadId, ray.id);
    expect(queueRoomParticipation).toHaveBeenCalledTimes(1);
  });
});
