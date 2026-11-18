// A task answering a joined team room is a room turn: the Forum offers, posts and captures nothing private there.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";

import { askUserRequestSchema, postAskUser, type AskUserDeps } from "./ask-user.ts";
import { createBoard } from "./board.ts";
import { createBoardCalls } from "./board-calls.ts";
import { sharedTurn } from "./rooms/guards.ts";
import type { MausColor, Message } from "./store.ts";
import { createTempDirs } from "./testing/cleanup.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

const QUESTION = "git exit 128 (not a git repository) at the repo path. What is the right folder?";
const BLOCKER = { kind: "engine" as const, note: "git exit 128: not a git repository, wrong repo path" };

describe("room fence", () => {
  it("a joined room's bot with a matching private fix asks the user, and its calls stay off the Board", () => {
    const board = createBoard({ dir: join(temps.make(join(tmpdir(), "orbit-board-rooms-")), "board"), pcId: () => "home" });
    const calls = createBoardCalls({ board, projectOf: () => "wink", room: sharedTurn({ groupByThread: () => undefined }, new Set(["tj"])) });
    const stuck = board.post({ author_bot_id: "wink", kind: "stuck", title: BLOCKER.note, body: "git status failed with exit 128 in the parent folder", project_id: "wink", source_ref: "call:ta:0:engine:git" });
    board.solve(stuck.id, "Run git in the worktree folder, not the parent repo folder.");
    const appended: Array<Omit<Message, "id" | "at">> = [];
    const deps: AskUserDeps<{ id: string; name: string; color: MausColor }> = {
      bot: (id) => ({ id, name: "Ada", color: "teal" }),
      conversation: () => ({}),
      appendMessage: (_threadId, message) => (appended.push(message), { ...message, id: `m-${appended.length}`, at: 1 }),
      activePath: () => [],
      patchMessage: () => null,
      cancelHeld: () => false,
      alertThread: (_bot, threadId) => threadId,
      notifyQuestion: () => {},
      whenSettled: (_botId, _threadId, post) => post(),
      forum: (botId, threadId, question, choices) => calls.ask(botId, threadId, question, choices),
    };
    const ask = (threadId: string) => postAskUser(deps, askUserRequestSchema.parse({ fromBotId: "ada", fromThreadId: threadId, question: QUESTION }));
    expect(ask("tj")).toEqual({ status: 201, body: { messageId: "m-1" } });
    expect(ask("ta").status).toBe(200);
    expect(calls.hold("ada", "tj", [], [BLOCKER])).toEqual({ blockers: [BLOCKER], notice: "" });
    expect(calls.called("ada", "tj", BLOCKER)).toBeUndefined();
    expect(calls.cleared("tj", [BLOCKER], [], "Ran it in the worktree.")).toEqual([]);
    expect(board.list()).toHaveLength(1);
  });

  it("a group or hosted room turn is shared too; a 1:1 is not", () => {
    const shared = sharedTurn({ groupByThread: (threadId) => (threadId === "g" ? ({} as never) : undefined) }, new Set(["tj"]));
    expect(["g", "tj", "ta"].map(shared)).toEqual([true, true, false]);
  });
});
