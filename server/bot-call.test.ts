import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CALL_RING_GAP_MS, createBotCalls } from "./bot-call.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import type { BotRecord, Store } from "./store.ts";
import { seedTaskResumePacket } from "./task-state-fold.ts";
import type { TaskResumePacket } from "./task-state.ts";
import type { PushPayload } from "./web-push.ts";

let bot: BotRecord;
let packet: TaskResumePacket;
let sent: PushPayload[];
let hosted: boolean;
let room: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  bot = { id: "scout", threadId: "t1", name: "Scout", color: "green" } as BotRecord;
  packet = seedTaskResumePacket({ threadId: "t1", botId: "scout", text: "Run the eval tonight", messageId: "m1", now: 1, turnsAtWrite: 0 });
  sent = [];
  hosted = false;
  room = undefined;
});

afterEach(() => vi.useRealTimers());

function routes() {
  const botCalls = createBotCalls({ send: (payload) => sent.push(payload), current: () => packet.blockers, chat: () => room, skip: () => hosted });
  const store = {
    bot: (id: string) => (id === bot.id ? bot : undefined),
    conversationForBot: () => ({}),
    taskByThread: () => undefined,
    groupTaskByThread: () => undefined,
  } as unknown as Store;
  return createInternalRoutes({
    store,
    botCalls,
    taskPacketForWrite: () => structuredClone(packet),
    persistTaskPacket: (next: TaskResumePacket) => (packet = next),
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
}

async function write(route: ReturnType<typeof routes>, blockers: Array<{ kind: string; note: string }>) {
  let status = 0;
  const res = { writeHead(code: number) { status = code; }, end() {} } as unknown as ServerResponse;
  const req = new EventEmitter() as IncomingMessage;
  const pending = route.taskState(req, res);
  req.emit("data", JSON.stringify({ fromBotId: "scout", fromThreadId: "t1", blockers }));
  req.emit("end");
  await pending;
  expect(status).toBe(200);
}

const LOGIN = { kind: "login", note: "Sign in to Claude on Home so tonight's eval can run." };

describe("bot calls", () => {
  it("rings once for a new login blocker with a call payload", async () => {
    await write(routes(), [LOGIN]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: "📞 Scout is calling",
      body: LOGIN.note,
      tag: "wink-call:scout",
      url: `/?${new URLSearchParams({ bot: "scout", thread: "t1", call: LOGIN.note })}`,
      call: expect.any(String),
    });
  });

  it("rings again twice 45 s apart, then leaves a plain alert", async () => {
    await write(routes(), [{ kind: "engine", note: "Codex is out of credit." }]);
    await vi.advanceTimersByTimeAsync(CALL_RING_GAP_MS * 5);
    expect(sent.map((payload) => payload.title)).toEqual(["📞 Scout is calling", "📞 Scout is calling", "📞 Scout is calling", "Scout needs you"]);
    expect(new Set(sent.slice(0, 3).map((payload) => payload.call)).size).toBe(1);
    expect(sent[3]).toMatchObject({ tag: "wink-call:scout", url: "/?bot=scout&thread=t1" });
    expect(sent[3]!.call).toBeUndefined();
  });

  it("does not ring again for a blocker it already called", async () => {
    const route = routes();
    await write(route, [LOGIN]);
    await write(route, [LOGIN, { kind: "input", note: "Which branch?" }]);
    packet.blockers = [];
    await write(route, [LOGIN]);
    expect(sent).toHaveLength(1);
  });

  it("stops ringing when the blocker clears", async () => {
    const route = routes();
    await write(route, [LOGIN]);
    await write(route, []);
    await vi.advanceTimersByTimeAsync(CALL_RING_GAP_MS * 5);
    expect(sent).toHaveLength(1);
  });

  it("stops ringing when another write clears the blocker, like a turn completing", async () => {
    await write(routes(), [{ kind: "engine", note: "Codex is out of credit." }]);
    packet.blockers = [];
    await vi.advanceTimersByTimeAsync(CALL_RING_GAP_MS * 5);
    expect(sent).toHaveLength(1);
  });

  it("stops ringing once the call is picked up", async () => {
    const botCalls = createBotCalls({ send: (payload) => sent.push(payload), current: () => [{ kind: "login", note: "Sign in" }], chat: () => undefined, skip: () => false });
    botCalls.blockers(bot, "t1", [], [{ kind: "login", note: "Sign in" }]);
    botCalls.answered("scout");
    await vi.advanceTimersByTimeAsync(CALL_RING_GAP_MS * 5);
    botCalls.blockers(bot, "t1", [], [{ kind: "login", note: "Sign in" }]);
    expect(sent).toHaveLength(1);
  });

  it("stays quiet for input blockers, hosted threads, muted bots and rooms", async () => {
    const route = routes();
    await write(route, [{ kind: "input", note: "Which branch?" }]);
    hosted = true;
    await write(route, [LOGIN]);
    hosted = false;
    bot.notifications = false;
    await write(route, [{ kind: "engine", note: "Out of credit." }]);
    bot.notifications = true;
    room = "g1";
    await write(route, [{ kind: "engine", note: "Codex is out of credit." }]);
    expect(sent).toEqual([]);
  });

  it("does not ring for a blocker the record already held", async () => {
    packet.blockers = [{ kind: "login", note: LOGIN.note }];
    await write(routes(), [LOGIN]);
    expect(sent).toEqual([]);
  });
});
