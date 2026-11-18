// The ask hold: before an ask_user card posts, a Forum post that may answer it goes back to the bot
// once; asking the same question again posts the card. No model calls.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { askUserRequestSchema, postAskUser, type AskUserDeps } from "./ask-user.ts";
import { createBoard, type Board } from "./board.ts";
import { createBoardCalls, type BoardCalls } from "./board-calls.ts";
import type { MausColor, Message } from "./store.ts";
import { createTempDirs } from "./testing/cleanup.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

type Bot = { id: string; name: string; color: MausColor };
const QUESTION = "Which Codex account should the worker use after the usage limit?";

let board: Board;
let calls: BoardCalls;
let appended: Array<Omit<Message, "id" | "at">>;
let deps: AskUserDeps<Bot>;

beforeEach(() => {
  board = createBoard({ dir: join(temps.make(join(tmpdir(), "orbit-board-ask-")), "board"), pcId: () => "home" });
  calls = createBoardCalls({ board, projectOf: () => "wink", rings: (threadId) => threadId !== "room" });
  appended = [];
  deps = {
    bot: (id) => ({ id, name: "Ada", color: "teal" }),
    conversation: () => ({}),
    appendMessage: (_threadId, message) => (appended.push(message), { ...message, id: `m-${appended.length}`, at: 1 }),
    activePath: () => [],
    patchMessage: () => null,
    cancelHeld: () => false,
    alertThread: (_bot, threadId) => threadId,
    notifyQuestion: () => {},
    whenSettled: (_botId, _threadId, post) => post(),
    forum: (botId, threadId, question) => calls.ask(botId, threadId, question),
  };
});

const ask = (question = QUESTION, threadId = "ta") => postAskUser(deps, askUserRequestSchema.parse({ fromBotId: "ada", fromThreadId: threadId, question }));
const handoff = () => board.post({ author_bot_id: "wink", kind: "handoff", title: "Codex usage limit", body: "After the Codex usage limit, the worker should use the work account.", project_id: "wink", source_ref: "tool:handoff" });

// Known miss: a question worded apart from the handoff that answers it (1 of 5 words shared) is not held; exact words at 0.6 cannot reach it.
describe("ask hold", () => {
  it("holds a later ask about an error a solved fix already covers", () => {
    const stuck = board.post({ author_bot_id: "wink", kind: "stuck", title: "git exit 128: not a git repository, wrong repo path", body: "git status failed with exit 128 in the parent folder", project_id: "wink", source_ref: "call:t:0:engine:git" });
    board.solve(stuck.id, "Run git in the worktree folder, not the parent repo folder.");
    const held = ask("git exit 128 (not a git repository) at the repo path. Which folder should I use?");
    expect(held.status).toBe(200);
    expect((held.body as { notice: string }).notice).toContain("Run git in the worktree folder");
    expect(appended).toEqual([]);
  });

  it("posts the card unchanged when the Forum has nothing", () => {
    expect(ask()).toEqual({ status: 201, body: { messageId: "m-1" } });
    expect(appended).toHaveLength(1);
  });

  it("holds a question an open handoff may answer, once", () => {
    const post = handoff();
    const held = ask();
    expect(held.status).toBe(200);
    const notice = (held.body as { notice: string }).notice;
    expect(notice).toMatch(/^Not asked yet: the Forum may answer this:\n/);
    expect(notice).toContain(post.id);
    expect(notice).toMatch(/\nIf it doesn't, ask again\.$/);
    expect(appended).toEqual([]);
    expect(ask()).toEqual({ status: 201, body: { messageId: "m-1" } });
  });

  it("credits the post when the turn ends without asking again", () => {
    const post = handoff();
    ask();
    calls.turnEnded("ta", true);
    expect(board.get(post.id)!.helped_bot_ids).toEqual(["ada"]);
  });

  it("never offers an open stuck post, a room post or a room thread", () => {
    board.post({ author_bot_id: "wink", kind: "stuck", title: QUESTION, body: QUESTION, project_id: "wink", source_ref: "call:t:0:engine:x" });
    board.post({ author_bot_id: "wink", kind: "tip", title: QUESTION, body: QUESTION, project_id: "wink", source_ref: "room:g:tip" });
    expect(ask().status).toBe(201);
    handoff();
    expect(ask(QUESTION, "room").status).toBe(201);
  });

  it("never holds closing a card", () => {
    handoff();
    expect(postAskUser(deps, askUserRequestSchema.parse({ fromBotId: "ada", fromThreadId: "ta", question: QUESTION, close: true }))).toEqual({ status: 200, body: { closed: false } });
  });
});
