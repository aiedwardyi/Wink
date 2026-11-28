// Handoff eval: Bot A is blocked on X and calls; the user answers in chat and Bot A clears
// the blocker with the fix as its note. Later Bot B hits X, gets that fix from the Board, and finishes without a call. A stub engine plays
// both bots through the same task-state route and call wiring the server uses.
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOARD_USER, createBoard, type Board } from "./board.ts";
import { createBoardCalls, type BoardCalls } from "./board-calls.ts";
import { createBoardRoutes } from "./board-routes.ts";
import { createBotCalls } from "./bot-call.ts";
import { createInternalRoutes } from "./internal-routes.ts";
import type { BotRecord, Store } from "./store.ts";
import { seedTaskResumePacket } from "./task-state-fold.ts";
import type { TaskResumePacket } from "./task-state.ts";
import { createTempDirs } from "./testing/cleanup.ts";
import { olderCall } from "./testing/older-call.ts";
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
  boardCalls = createBoardCalls({ board, projectOf: (threadId) => owner(threadId).cwd!.split("\\").at(-1)!.toLowerCase(), room: () => false });
  const botCalls = createBotCalls({
    calls: () => true,
    send: (payload) => sent.push(payload),
    current: (threadId) => packets.get(threadId)!.blockers,
    chat: () => undefined,
    skip: () => false,
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
async function blockers(bot: BotRecord, list: Array<{ kind: string; note: string }>, completed_note?: string): Promise<string> {
  let status = 0;
  let body = "";
  const res = { writeHead(code: number) { status = code; }, end(text: string) { body = text; } } as unknown as ServerResponse;
  const req = new EventEmitter() as IncomingMessage;
  const pending = route.taskState(req, res);
  req.emit("data", JSON.stringify({ fromBotId: bot.id, fromThreadId: bot.threadId, blockers: list, completed_note }));
  req.emit("end");
  await pending;
  expect(status).toBe(200);
  return String(JSON.parse(body).notice ?? "");
}

/** What a bot's board_post does with the fix once the answer unblocked it. */
const posted = (bot: BotRecord, parentId: string, text: string) => {
  const parent = board.get(parentId)!;
  board.post({ author_bot_id: bot.id, kind: "fix", title: parent.title, body: text, fix: text, parent_id: parentId, project_id: parent.project_id, error_sig: parent.error_sig, source_ref: `tool:${bot.threadId}:${text}` });
};

describe("board handoff eval", () => {
  it("Bot B finishes on Bot A's fix without calling", async () => {
    // Bot A is blocked on X and calls; an older build on another PC left the stuck post
    await blockers(BOTS.astra!, [X("14:05")]);
    expect(sent.map((payload) => payload.title)).toEqual(["📞 Astra is calling"]);
    const stuck = olderCall(board, "astra", "ta", X("14:05"));

    // the user answers in chat; Bot A clears the blocker and the note it writes then is the fix
    await blockers(BOTS.astra!, [], ANSWER);
    boardCalls.turnEnded("ta", true);
    expect(board.get(stuck!.id)).toMatchObject({ status: "solved", fix: ANSWER });

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
    posted(BOTS.astra!, olderCall(board, "astra", "ta", X("14:05")).id, ANSWER);
    const callsBefore = sent.length;
    await blockers(BOTS.carbon!, [X("09:30")]);
    expect(sent.length).toBe(callsBefore);
    await blockers(BOTS.carbon!, [X("09:30")]);
    expect(sent.slice(callsBefore).map((payload) => payload.title)).toEqual(["📞 Carbon is calling"]);
    boardCalls.turnEnded("tc", true);
    expect(board.list().find((post) => post.kind === "stuck")!.helped_bot_ids).toEqual([]);
  });

  it("a solved blocker that comes back is offered its fix once, then rings without a new post", async () => {
    await blockers(BOTS.astra!, [X("14:05")]);
    const first = olderCall(board, "astra", "ta", X("14:05"));
    posted(BOTS.astra!, first.id, ANSWER);
    await blockers(BOTS.astra!, []);
    boardCalls.turnEnded("ta", true);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const callsBefore = sent.length;
    // the old fix is offered once, fails, and the same blocker written again calls
    expect(await blockers(BOTS.astra!, [X("14:05")])).toContain(ANSWER);
    await blockers(BOTS.astra!, [X("14:05")]);
    expect(sent.slice(callsBefore).map((payload) => payload.title)).toEqual(["📞 Astra is calling"]);
    expect(board.list().filter((post) => post.kind === "stuck")).toEqual([board.get(first.id)]);
    expect(board.get(first.id)).toMatchObject({ status: "solved", fix: ANSWER });
  });

  it("holds only blockers whose fixes fit in the notice; the rest call", async () => {
    const Y = { kind: "engine", note: "Claude: overloaded on the work PC, wait for capacity." };
    for (const [n, blocker] of [X("14:05"), X("14:05"), Y, Y].entries()) {
      const stuck = board.post({ author_bot_id: "astra", kind: "stuck", title: blocker.note, body: blocker.note, project_id: "wink", source_ref: `seed:${n}` });
      board.solve(stuck.id, `fix ${n}`);
    }
    const notice = await blockers(BOTS.carbon!, [X("14:05"), Y]);
    expect(sent.map((payload) => payload.title)).toEqual(["📞 Carbon is calling"]);
    expect(packets.get("tc")!.blockers).toEqual([Y]);
    expect(notice).toContain("fix 0");
    expect(notice).toContain("fix 1");
    expect(notice).not.toContain("fix 2");
    expect(notice).not.toContain("fix 3");
    boardCalls.turnEnded("tc", true);
    expect(board.list().filter((post) => post.helped_bot_ids.includes("carbon")).map((post) => post.fix).sort()).toEqual(["fix 0", "fix 1"]);
  });

  it("a chat reply is never the fix: the post waits for the bot to clear its blocker", async () => {
    await blockers(BOTS.astra!, [X("14:05")]);
    const stuck = olderCall(board, "astra", "ta", X("14:05"));
    expect("answered" in boardCalls).toBe(false);
    expect(board.get(stuck!.id)!.status).toBe("open");
    await blockers(BOTS.astra!, []);
    expect(board.get(stuck!.id)).toMatchObject({ status: "open", fix: "" });
    expect(board.list().some((post) => post.author_bot_id === BOARD_USER)).toBe(false);
  });

  it("one note clearing two calls solves neither", async () => {
    const Y = { kind: "engine", note: "Claude: overloaded on the work PC, wait for capacity." };
    await blockers(BOTS.astra!, [X("14:05"), Y]);
    for (const blocker of [X("14:05"), Y]) olderCall(board, "astra", "ta", blocker);
    await blockers(BOTS.astra!, [], ANSWER);
    expect(board.list().map((post) => post.status)).toEqual(["open", "open"]);
  });

  it("a Board write error never skips phone cleanup", async () => {
    await blockers(BOTS.astra!, [X("14:05")]);
    olderCall(board, "astra", "ta", X("14:05"));
    vi.spyOn(board, "solve").mockImplementation(() => {
      throw new Error("disk full");
    });
    await blockers(BOTS.astra!, [], ANSWER);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent.map((payload) => payload.title)).toEqual(["📞 Astra is calling"]);
  });

  it("a call posted under the old full-note ref is still solved", async () => {
    const old = board.post({ author_bot_id: "astra", kind: "stuck", title: X("14:05").note, body: X("14:05").note, project_id: "wink", source_ref: `call:ta:0:engine:${X("14:05").note}` });
    packets.get("ta")!.blockers = [X("14:05") as TaskResumePacket["blockers"][number]];
    await blockers(BOTS.astra!, [], ANSWER);
    expect(board.get(old.id)).toMatchObject({ status: "solved", fix: ANSWER });
  });

  it("a cleared blocker that was never called leaves the Board alone", async () => {
    packets.get("ta")!.blockers = [{ kind: "input", note: "Which folder?" } as TaskResumePacket["blockers"][number]];
    await blockers(BOTS.astra!, [], "picked the Wink folder");
    expect(board.list()).toEqual([]);
  });

  it("a phone blocker rings past an open handoff, tip or reply", async () => {
    const TEXT = "When Codex says you hit the usage limit, try again later or switch the worker to the Claude account.";
    board.post({ author_bot_id: "astra", kind: "handoff", title: "Codex usage limit", body: TEXT, project_id: "wink", source_ref: "tool:handoff" });
    board.post({ author_bot_id: "astra", kind: "tip", title: "Codex usage limit", body: TEXT, project_id: "wink", source_ref: "tool:tip" });
    const open = board.post({ author_bot_id: "astra", kind: "stuck", title: X("08:00").note, body: X("08:00").note, project_id: "wink", source_ref: "seed:open" });
    board.post({ author_bot_id: BOARD_USER, kind: "tip", parent_id: open.id, title: open.title, body: "Thanks!", project_id: "wink", source_ref: "reply:r1" });
    expect(await blockers(BOTS.carbon!, [X("09:30")])).toBe("");
    expect(sent.map((payload) => payload.title)).toEqual(["📞 Carbon is calling"]);
  });

  it("a login blocker always rings, even with a matching fix", async () => {
    const LOGIN = { kind: "login", note: "Claude: login expired on the work PC, run claude login." };
    const stuck = board.post({ author_bot_id: "astra", kind: "stuck", title: LOGIN.note, body: LOGIN.note, project_id: "wink", source_ref: "seed:login" });
    board.solve(stuck.id, "Ran claude login on the work PC.");
    expect(await blockers(BOTS.carbon!, [LOGIN])).toBe("");
    expect(sent.map((payload) => payload.title)).toEqual(["📞 Carbon is calling"]);
  });

  it("a login or engine call rings once and leaves the Forum alone", async () => {
    await blockers(BOTS.astra!, [{ kind: "login", note: "Sign in to Claude on Home so tonight's eval can run." }]);
    await blockers(BOTS.carbon!, [X("09:30")]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const calls = new Map(sent.filter((payload) => payload.call).map((payload) => [payload.call, payload.title]));
    expect([...calls.values()]).toEqual(["📞 Astra is calling", "📞 Carbon is calling"]);
    expect(board.list()).toEqual([]);
  });

  it("a login stuck post made before the rule still closes when its login clears", () => {
    const LOGIN = { kind: "login" as const, note: "Sign in to Claude on Home so tonight's eval can run." };
    const old = board.post({ author_bot_id: "astra", kind: "stuck", title: LOGIN.note, body: LOGIN.note, project_id: "wink", source_ref: `call:ta:0:login:${LOGIN.note}` });
    const solved = boardCalls.cleared("ta", [LOGIN], [], "Signed in to Claude on Home.");
    expect(solved.map((post) => [post.id, post.status])).toEqual([[old.id, "solved"]]);
  });

  it("an open post with no answer yet holds nothing back", async () => {
    await blockers(BOTS.astra!, [X("14:05")]);
    await blockers(BOTS.carbon!, [X("09:30")]);
    expect(sent.map((payload) => payload.title)).toEqual(["📞 Astra is calling", "📞 Carbon is calling"]);
  });
});

describe("a bot's own open Stuck post", () => {
  const stuckBy = async (bot: BotRecord, title: string) => {
    let reply = "";
    // SAFETY: the route calls only writeHead, end and the request's headers and data events.
    const res = { writeHead() {}, end(text: string) { reply = text; } } as unknown as ServerResponse;
    // SAFETY: as above.
    const req = new EventEmitter() as IncomingMessage;
    req.headers = {};
    const routes = createBoardRoutes({ board, caller: () => ({ botId: bot.id, threadId: bot.threadId }), known: () => true, projectOf: () => "wink", roomTurn: () => null });
    const pending = routes.post(req, res);
    req.emit("data", JSON.stringify({ kind: "stuck", title, body: title }));
    req.emit("end");
    await pending;
    return String(JSON.parse(reply).id);
  };

  it("rides each task write on its thread until a fix reply under it solves it", async () => {
    const id = await stuckBy(BOTS.astra!, "post_to_group is missing from the Wink tools");
    const notice = await blockers(BOTS.astra!, []);
    expect(notice).toContain(id);
    expect(notice.length / 4).toBeLessThanOrEqual(40);
    expect(await blockers(BOTS.astra!, [])).toContain(id);
    posted(BOTS.astra!, id, "post_to_group shipped in #2231; it posts now.");
    expect(board.get(id)).toMatchObject({ status: "solved", fix: "post_to_group shipped in #2231; it posts now." });
    expect(await blockers(BOTS.astra!, [])).toBe("");
  });

  it("skips a call post an older build left on the thread and still names the bot's own Stuck", async () => {
    const old = olderCall(board, "astra", "ta", X("14:05"));
    expect(await blockers(BOTS.astra!, [])).toBe("");
    vi.advanceTimersByTime(1_000);
    const id = await stuckBy(BOTS.astra!, "post_to_group is missing from the Wink tools");
    const notice = await blockers(BOTS.astra!, []);
    expect([notice.includes(id), notice.includes(old.id)]).toEqual([true, false]);
    posted(BOTS.astra!, id, "post_to_group shipped in #2231.");
    expect(await blockers(BOTS.astra!, [])).toBe("");
  });

  it("a merge alone closes nothing and adds no line", async () => {
    expect(await blockers(BOTS.astra!, [], "Merged #2231: post_to_group is live.")).toBe("");
    const id = await stuckBy(BOTS.astra!, "post_to_group is missing from the Wink tools");
    expect(await blockers(BOTS.astra!, [], "Merged #2231: post_to_group is live.")).toContain(id);
    expect(board.get(id)!.status).toBe("open");
  });

  it("another bot's post gives no line", async () => {
    await stuckBy(BOTS.astra!, "post_to_group is missing from the Wink tools");
    expect(await blockers(BOTS.carbon!, [])).toBe("");
  });

  it("a room turn gives no line", async () => {
    await stuckBy(BOTS.astra!, "post_to_group is missing from the Wink tools");
    olderCall(board, "astra", "ta", X("14:05"));
    const room = createBoardCalls({ board, projectOf: () => "wink", room: (threadId) => threadId === "ta" });
    expect(room.ownStuck("astra", "ta")).toBe("");
    expect(boardCalls.ownStuck("astra", "ta")).not.toBe("");
  });
});
