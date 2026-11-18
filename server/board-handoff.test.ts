// Handoff eval: Bot A is blocked on X and calls; the user answers in chat and Bot A posts
// the fix. Later Bot B hits X, gets that fix from the Board, and finishes without a call. A stub engine plays
// both bots through the same task-state route and call wiring the server uses.
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOARD_USER, createBoard, type Board } from "./board.ts";
import { createBoardCalls, userAnswer, type BoardCalls } from "./board-calls.ts";
import { createBotCalls } from "./bot-call.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import type { BotRecord, Store } from "./store.ts";
import { seedTaskResumePacket } from "./task-state-fold.ts";
import type { TaskResumePacket } from "./task-state.ts";
import { createTempDirs } from "./testing/cleanup.ts";
import type { PushPayload } from "./web-push.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

const BOTS: Record<string, BotRecord> = {
  astra: { id: "astra", threadId: "ta", name: "Astra", color: "green", cwd: "D:\\wink\\wt\\Wink" } as BotRecord,
  carbon: { id: "carbon", threadId: "tc", name: "Carbon", color: "blue", cwd: "C:\\Users\\me\\Wink" } as BotRecord,
};
const X = (resets: string) => ({ kind: "engine", note: `Codex: You've hit your usage limit. Try again at ${resets}.` });
const ANSWER = "Switch the worker to the Claude account; Codex resets tomorrow.";

let packets: Map<string, TaskResumePacket>;
let sent: PushPayload[];
let board: Board;
let boardCalls: BoardCalls;
let route: ReturnType<typeof createInternalRoutes>;

beforeEach(() => {
  vi.useFakeTimers();
  packets = new Map(Object.values(BOTS).map((bot) => [bot.threadId, seedTaskResumePacket({ threadId: bot.threadId, botId: bot.id, text: "Run the eval", messageId: `m-${bot.id}`, now: 1, turnsAtWrite: 0 })]));
  sent = [];
  board = createBoard({ dir: join(temps.make(join(tmpdir(), "orbit-board-eval-")), "board"), pcId: () => "home" });
  const owner = (threadId: string) => Object.values(BOTS).find((bot) => bot.threadId === threadId)!;
  boardCalls = createBoardCalls({ board, projectOf: (threadId) => owner(threadId).cwd!.split("\\").at(-1)!.toLowerCase(), rings: () => true });
  const botCalls = createBotCalls({
    calls: true,
    send: (payload) => sent.push(payload),
    current: (threadId) => packets.get(threadId)!.blockers,
    chat: () => undefined,
    skip: () => false,
    called: (botId, threadId, blocker) => void boardCalls.called(botId, threadId, blocker),
  });
  const store = {
    bot: (id: string) => BOTS[id],
    conversationForBot: () => ({}),
    taskByThread: () => undefined,
    groupTaskByThread: () => undefined,
  } as unknown as Store;
  route = createInternalRoutes({
    store,
    botCalls,
    boardCalls,
    taskPacketForWrite: (threadId: string) => structuredClone(packets.get(threadId)!),
    persistTaskPacket: (next: TaskResumePacket) => (packets.set(next.threadId, next), next),
    readOnlyTurn: () => false,
  } as unknown as Parameters<typeof createInternalRoutes>[0]);
});

afterEach(() => vi.useRealTimers());

/** The stub engine's update_task_state call. */
async function blockers(bot: BotRecord, list: Array<{ kind: string; note: string }>): Promise<string> {
  let status = 0;
  let body = "";
  const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
  const req = new EventEmitter() as IncomingMessage;
  const pending = route.taskState(req, res);
  req.emit("data", JSON.stringify({ fromBotId: bot.id, fromThreadId: bot.threadId, blockers: list }));
  req.emit("end");
  await pending;
  expect(status).toBe(200);
  return String(JSON.parse(body).notice ?? "");
}

/** What the server does with a message the user types. */
const say = (threadId: string, text: string, id = "m-answer") => {
  const message = { id, role: "user", kind: "text", text };
  if (userAnswer(message)) boardCalls.answered(threadId, message);
};

/** What a bot's board_post does with the fix once the answer unblocked it. */
const posted = (bot: BotRecord, parentId: string, text: string) => {
  const parent = board.get(parentId)!;
  board.post({ author_bot_id: bot.id, kind: "fix", title: parent.title, body: text, fix: text, parent_id: parentId, project_id: parent.project_id, error_sig: parent.error_sig, source_ref: `tool:${bot.threadId}:${text}` });
};

const stored = () => readdirSync(board.dir).map((name) => readFileSync(join(board.dir, name), "utf8")).join("\n");

describe("board handoff eval", () => {
  it("Bot B finishes on Bot A's fix without calling", async () => {
    // Bot A is blocked on X: it calls, and the call leaves a stuck post
    await blockers(BOTS.astra!, [X("14:05")]);
    expect(sent.map((payload) => payload.title)).toEqual(["📞 Astra is calling"]);
    const [stuck] = board.list();
    expect(stuck).toMatchObject({ kind: "stuck", status: "open", author_bot_id: "astra", project_id: "wink" });

    // the user answers in chat: the post is solved without their words, and Bot A posts the fix as itself
    say("ta", ANSWER);
    expect(board.get(stuck!.id)).toMatchObject({ status: "solved", fix: "" });
    posted(BOTS.astra!, stuck!.id, ANSWER);
    await blockers(BOTS.astra!, []);
    boardCalls.turnEnded("ta", true);
    expect(board.get(stuck!.id)).toMatchObject({ status: "solved", fix: ANSWER });
    expect(board.list().find((post) => post.kind === "fix")).toMatchObject({ parent_id: stuck!.id, author_bot_id: "astra", body: ANSWER });

    // later Bot B hits X: Wink finds the fix before the call goes out
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const callsBefore = sent.length;
    const notice = await blockers(BOTS.carbon!, [X("09:30")]);
    expect(notice).toContain(ANSWER);
    expect(notice.length / 4).toBeLessThanOrEqual(200);
    expect(packets.get("tc")!.blockers).toEqual([]);
    // it tries the fix, clears its blockers and finishes the turn without calling
    await blockers(BOTS.carbon!, []);
    boardCalls.turnEnded("tc", true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent.slice(callsBefore)).toEqual([]);
    expect(board.get(stuck!.id)!.helped_bot_ids).toEqual(["carbon"]);
  });

  it("a fix that did not work calls on the second try", async () => {
    await blockers(BOTS.astra!, [X("14:05")]);
    say("ta", ANSWER);
    posted(BOTS.astra!, board.list()[0]!.id, ANSWER);
    const callsBefore = sent.length;
    await blockers(BOTS.carbon!, [X("09:30")]);
    expect(sent.length).toBe(callsBefore);
    await blockers(BOTS.carbon!, [X("09:30")]);
    expect(sent.slice(callsBefore).map((payload) => payload.title)).toEqual(["📞 Carbon is calling"]);
    boardCalls.turnEnded("tc", true);
    expect(board.list().find((post) => post.kind === "stuck")!.helped_bot_ids).toEqual([]);
  });

  it("a solved blocker that comes back gets a fresh post, rings and takes the new answer", async () => {
    await blockers(BOTS.astra!, [X("14:05")]);
    const [first] = board.list();
    say("ta", ANSWER);
    posted(BOTS.astra!, first!.id, ANSWER);
    await blockers(BOTS.astra!, []);
    boardCalls.turnEnded("ta", true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const callsBefore = sent.length;
    // the old fix is offered once, fails, and the same blocker written again calls
    expect(await blockers(BOTS.astra!, [X("14:05")])).toContain(ANSWER);
    await blockers(BOTS.astra!, [X("14:05")]);
    expect(sent.slice(callsBefore).map((payload) => payload.title)).toEqual(["📞 Astra is calling"]);
    const stuck = board.list().filter((post) => post.kind === "stuck");
    expect(stuck).toHaveLength(2);
    const fresh = stuck.find((post) => post.id !== first!.id)!;
    expect(fresh).toMatchObject({ status: "open", author_bot_id: "astra" });
    const NEW = "Codex moved to the team plan; sign in again with the work account.";
    say("ta", NEW, "m-answer-2");
    posted(BOTS.astra!, fresh.id, NEW);
    expect(board.get(fresh.id)).toMatchObject({ status: "solved", fix: NEW });
    expect(board.list().find((post) => post.kind === "fix" && post.parent_id === fresh.id)).toMatchObject({ body: NEW, author_bot_id: "astra" });
    expect(board.get(first!.id)).toMatchObject({ status: "solved", fix: ANSWER });
  });

  it("holds only blockers whose fixes fit in the notice; the rest call", async () => {
    const LOGIN = { kind: "login", note: "Claude: login expired on the work PC, run claude login." };
    for (const [n, blocker] of [X("14:05"), X("14:05"), LOGIN, LOGIN].entries()) {
      const stuck = board.post({ author_bot_id: "astra", kind: "stuck", title: blocker.note, body: blocker.note, project_id: "wink", source_ref: `seed:${n}` });
      board.solve(stuck.id, `fix ${n}`);
    }
    const notice = await blockers(BOTS.carbon!, [X("14:05"), LOGIN]);
    expect(sent.map((payload) => payload.title)).toEqual(["📞 Carbon is calling"]);
    expect(packets.get("tc")!.blockers.map((blocker) => blocker.kind)).toEqual(["login"]);
    expect(notice).toContain("fix 0");
    expect(notice).toContain("fix 1");
    expect(notice).not.toContain("fix 2");
    expect(notice).not.toContain("fix 3");
    boardCalls.turnEnded("tc", true);
    expect(board.list().filter((post) => post.helped_bot_ids.includes("carbon")).map((post) => post.fix).sort()).toEqual(["fix 0", "fix 1"]);
  });

  it("answering a call stores none of the user's words, in a 1:1 or a room", async () => {
    const room = createBoardCalls({ board, projectOf: () => "wink", rings: () => false });
    await blockers(BOTS.astra!, [X("14:05")]);
    room.called("carbon", "room-thread", { kind: "engine", note: X("09:30").note });
    say("ta", ANSWER);
    const ROOM_ANSWER = "Teammates can use my Claude seat today.";
    const message = { id: "m-room", role: "user", kind: "text", text: ROOM_ANSWER };
    if (userAnswer(message)) room.answered("room-thread", message);
    expect(board.list().filter((post) => post.kind === "stuck").map((post) => post.status)).toEqual(["solved", "solved"]);
    expect(board.list().some((post) => post.author_bot_id === BOARD_USER)).toBe(false);
    expect(stored()).not.toContain(ANSWER);
    expect(stored()).not.toContain(ROOM_ANSWER);
    expect(JSON.stringify(board.search({ query: ANSWER }))).not.toContain(ANSWER);
  });

  it("an open post with no answer yet holds nothing back", async () => {
    await blockers(BOTS.astra!, [X("14:05")]);
    await blockers(BOTS.carbon!, [X("09:30")]);
    expect(sent.map((payload) => payload.title)).toEqual(["📞 Astra is calling", "📞 Carbon is calling"]);
  });
});
