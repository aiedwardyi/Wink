// The ask hold: an ask_user card posts unless the bot marked it as a plain fact that a solved fix in the same project
// already covers; then the fix goes back to the bot once and its next ask posts. No model calls.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { watchAskHold } from "./ask-hold.ts";
import { askUserRequestSchema, postAskUser, type AskUserDeps } from "./ask-user.ts";
import { BOARD_USER, createBoard, errorSig, type Board, type NewBoardPost } from "./board.ts";
import { createBoardCalls, type BoardCalls } from "./board-calls.ts";
import { Store, type MausColor, type Message } from "./store.ts";
import { createTempDirs } from "./testing/cleanup.ts";

const temps = createTempDirs();
afterAll(() => temps.remove());

type Bot = { id: string; name: string; color: MausColor };
const QUESTION = "Which Codex account should the worker use after the usage limit?";
const GIT = "git exit 128 (not a git repository) at the repo path. What is the right folder?";
const GIT_TITLE = "git exit 128: not a git repository, wrong repo path";
const GIT_BODY = "git status failed with exit 128 in the parent folder";
const GIT_FIX = "Run git in the worktree folder, not the parent repo folder.";
const RESTART = "Can I restart the preview worker?";
const REBOOT = "Can I reboot the preview worker?";
const PROBES = [
  ["Can I", RESTART],
  ["May I", "May I restart the preview worker?"],
  ["an imperative", "Restart the preview worker?"],
  ["a sign-off", "Sign off on the preview worker restart?"],
  ["a reworded retry", REBOOT],
  ["a production ask on a staging fix", "Which port does the production preview worker listen on?"],
];

let board: Board;
let calls: BoardCalls;
let appended: Array<Omit<Message, "id" | "at">>;
let alerts: string[];
let deps: AskUserDeps<Bot>;
let holds: unknown[];

beforeEach(() => {
  holds = [];
  board = createBoard({ dir: join(temps.make(join(tmpdir(), "orbit-board-ask-")), "board"), pcId: () => "home" });
  calls = createBoardCalls({ board, projectOf: () => "wink", room: (threadId) => threadId === "room", held: (row) => holds.push(row) });
  appended = [];
  alerts = [];
  deps = {
    bot: (id) => ({ id, name: "Ada", color: "teal" }),
    conversation: () => ({}),
    appendMessage: (_threadId, message) => (appended.push(message), { ...message, id: `m-${appended.length}`, at: 1 }),
    activePath: () => [],
    patchMessage: () => null,
    cancelHeld: () => false,
    alertThread: (_bot, threadId) => threadId,
    notifyQuestion: (_bot, _target, question) => void alerts.push(question),
    whenSettled: (_botId, _threadId, post) => post(),
    forum: (botId, threadId, question, choices) => calls.ask(botId, threadId, question, choices),
  };
});

const ask = (question = QUESTION, threadId = "ta", choices: string[] = [], fact = true) => postAskUser(deps, askUserRequestSchema.parse({ fromBotId: "ada", fromThreadId: threadId, question, choices, fact }));
const solvedFix = (title: string, body: string, fix: string, extra: Partial<NewBoardPost> = {}) => {
  const stuck = board.post({ author_bot_id: "wink", kind: "stuck", title, body, project_id: "wink", source_ref: `call:t:0:engine:${title}`, ...extra });
  return board.solve(stuck.id, fix)!;
};
const gitFix = (extra: Partial<NewBoardPost> = {}) => solvedFix(GIT_TITLE, GIT_BODY, GIT_FIX, extra);
const workerFixes = () => {
  solvedFix("Restart the preview worker", RESTART, "Restart it from the worker panel.");
  solvedFix("Reboot the preview worker", REBOOT, "Reboot it with the worker script.");
  solvedFix("Staging preview worker port", "Which port does the staging preview worker listen on?", "The staging preview worker listens on port 4801.");
};

// Known miss: a question worded apart from the post that answers it (1 of 5 words shared) is not held; exact words at 0.6 cannot reach it.
describe("ask hold", () => {
  it("holds a later ask about an error a solved fix already covers, once", () => {
    gitFix();
    const held = ask(GIT);
    expect(held.status).toBe(200);
    const notice = (held.body as { notice: string }).notice;
    expect(notice).toMatch(/^Not asked yet: the Forum may answer this:\n/);
    expect(notice).toContain(GIT_FIX);
    expect(notice).toMatch(/\nIf it doesn't, ask again\.$/);
    expect(appended).toEqual([]);
    expect(ask(GIT)).toEqual({ status: 201, body: { messageId: "m-1" } });
  });

  it("posts the card unchanged when the Forum has nothing", () => {
    expect(ask()).toEqual({ status: 201, body: { messageId: "m-1" } });
    expect(appended).toHaveLength(1);
  });

  it.each(PROBES)("delivers %s, unmarked, as one card and one alert without a Board lookup", (_name, question) => {
    workerFixes();
    const search = vi.spyOn(board, "search");
    expect(ask(question, "ta", [], false)).toEqual({ status: 201, body: { messageId: "m-1" } });
    expect(appended.map((message) => message.card!.subtitle)).toEqual([question]);
    expect(alerts).toEqual([question]);
    expect(search).not.toHaveBeenCalled();
  });

  it("delivers the ask after a hold as one card and one alert, reworded or next turn, even on another post", () => {
    workerFixes();
    expect(ask(RESTART).status).toBe(200);
    expect(ask(REBOOT)).toEqual({ status: 201, body: { messageId: "m-1" } });
    expect(ask(RESTART, "tb").status).toBe(200);
    calls.turnEnded("tb", true);
    expect(ask(REBOOT, "tb")).toEqual({ status: 201, body: { messageId: "m-2" } });
    expect(alerts).toEqual([REBOOT, REBOOT]);
  });

  it("delivers an unmarked ask from a running turn once the turn settles, with one alert", () => {
    workerFixes();
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const askHold = watchAskHold(store, { subscribe: () => () => {} });
    const bot = store.createBot({ name: "Ada" });
    const live: AskUserDeps<Bot> = {
      ...deps,
      bot: (id) => store.bot(id),
      conversation: (botId, threadId) => store.conversationForBot(botId, threadId),
      appendMessage: (threadId, message) => store.appendMessage(threadId, message),
      whenSettled: (botId, threadId, post, question) => askHold.whenSettled(botId, threadId, post, question),
    };
    store.setActivity(bot.id, "working", bot.threadId);
    expect(postAskUser(live, askUserRequestSchema.parse({ fromBotId: bot.id, fromThreadId: bot.threadId, question: RESTART }))).toEqual({ status: 202, body: { held: true } });
    store.setActivity(bot.id, "idle");
    expect(store.messagesFor(bot.threadId).filter((message) => message.card?.askUser).map((message) => message.card!.subtitle)).toEqual([RESTART]);
    expect(alerts).toEqual([RESTART]);
  });

  it("posts a choices card and a sign-in, money or shipping question even marked as a fact", () => {
    const vetoed = ["Which login does the preview worker use?", "Who pays the preview worker bill?", "Which branch do I push the preview worker fix to?", "When does the preview worker fix merge?", "Which release has the preview worker fix?"];
    const port = "Which port does the preview worker listen on?";
    solvedFix("Preview worker notes", [...vetoed, port].join(" "), "Read the preview worker notes in the repo.");
    for (const question of vetoed) expect(ask(question).status).toBe(201);
    expect(ask(port, "ta", ["4801", "4802"]).status).toBe(201);
    expect(ask(port, "tb").status).toBe(200);
    expect(alerts).toEqual([...vetoed, port]);
  });

  it("holds on nothing but a top-level solved fix from the same project", () => {
    const open = board.post({ author_bot_id: "wink", kind: "stuck", title: GIT_TITLE, body: GIT_BODY, project_id: "wink", source_ref: "call:t:0:engine:open" });
    board.post({ author_bot_id: BOARD_USER, kind: "tip", parent_id: open.id, title: open.title, body: "Thanks!", project_id: "wink", source_ref: "reply:r1" });
    board.post({ author_bot_id: "wink", kind: "tip", parent_id: open.id, title: open.title, body: GIT_FIX, project_id: "wink", source_ref: "tool:t:reply" });
    board.post({ author_bot_id: "wink", kind: "handoff", title: GIT_TITLE, body: `${GIT_BODY}. ${GIT_FIX}`, project_id: "wink", source_ref: "tool:handoff" });
    board.post({ author_bot_id: "wink", kind: "tip", title: GIT_TITLE, body: `${GIT_BODY}. ${GIT_FIX}`, project_id: "wink", source_ref: "tool:tip" });
    gitFix({ project_id: "orbit", source_ref: "call:o:0:engine:git" });
    expect(ask(GIT).status).toBe(201);
  });

  it("an error signature alone never holds a free-form question", () => {
    const question = "ENOENT on D:\\data\\cfg.json at startup, where does the config live now?";
    solvedFix("Disk quota", "Disk quota", "Moved.", { error_sig: errorSig(question) });
    expect(ask(question).status).toBe(201);
  });

  it("never credits a post it offered", () => {
    const post = gitFix();
    ask(GIT);
    calls.turnEnded("ta", true);
    expect(board.get(post.id)!.helped_bot_ids).toEqual([]);
  });

  it("never offers an open stuck post, a room post or a room thread", () => {
    board.post({ author_bot_id: "wink", kind: "stuck", title: GIT_TITLE, body: GIT_BODY, project_id: "wink", source_ref: "call:t:0:engine:x" });
    board.post({ author_bot_id: "wink", kind: "fix", title: GIT_TITLE, body: GIT_FIX, project_id: "wink", source_ref: "room:g:fix" });
    expect(ask(GIT).status).toBe(201);
    gitFix();
    expect(ask(GIT, "room").status).toBe(201);
  });

  it("a bot already shown a fix asks the user next, in other words or a later turn", () => {
    gitFix();
    expect(ask(GIT).status).toBe(200);
    expect(ask("git exit 128 not a git repository in the repo path; where is the right folder?").status).toBe(201);
    calls.turnEnded("ta", true);
    expect(ask(GIT).status).toBe(201);
  });

  it("needs three shared words, not only a share", () => {
    gitFix();
    expect(ask("git exit?").status).toBe(201);
  });

  it("logs each hold with post ids, never the question", () => {
    const post = gitFix();
    ask(GIT);
    calls.hold("ada", "tb", [], [{ kind: "engine", note: GIT_TITLE }]);
    expect(holds).toEqual([{ kind: "ask", botId: "ada", threadId: "ta", postIds: [post.id] }, { kind: "call", botId: "ada", threadId: "tb", postIds: [post.id] }]);
  });

  it("never holds closing a card", () => {
    gitFix();
    expect(postAskUser(deps, askUserRequestSchema.parse({ fromBotId: "ada", fromThreadId: "ta", question: GIT, close: true }))).toEqual({ status: 200, body: { closed: false } });
  });
});
