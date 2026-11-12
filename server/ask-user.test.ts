// The ask_user endpoint: sender and thread checks, the marked card it posts,
// choice capping, and exactly one alert per question.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { ASK_USER_QUESTION_MAX, askUserCardPatchSchema, askUserChoices, askUserRequestSchema, closedAskNotes, memberClosedAskNotes, postAskUser, skippedQuestion, watchSkippedQuestions, type AskUserDeps, type AskUserRequest } from "./ask-user.ts";
import type { MausColor, Message, StoreChange } from "./store.ts";
import type { TaskAsk } from "./task-asks.ts";

type Bot = { id: string; name: string; color: MausColor };

function harness(conversations = new Map<string, { group?: object }>([["bot-a:thread-a", {}]])) {
  const bots = new Map<string, Bot>([["bot-a", { id: "bot-a", name: "Ada", color: "teal" }]]);
  const appended: Array<{ threadId: string; message: Omit<Message, "id" | "at"> }> = [];
  const alerts: Array<{ bot: Bot; threadId: string; question: string }> = [];
  const deps: AskUserDeps<Bot> = {
    bot: (id) => bots.get(id),
    conversation: (botId, threadId) => conversations.get(`${botId}:${threadId}`) ?? null,
    appendMessage: (threadId, message) => {
      appended.push({ threadId, message });
      return { ...message, id: `m-${appended.length}`, at: 1 };
    },
    alertThread: (_bot, threadId) => threadId,
    notifyQuestion: (bot, threadId, question) => alerts.push({ bot, threadId, question }),
    whenSettled: (_botId, _threadId, post) => post(),
  };
  return { deps, appended, alerts };
}

const ask = (deps: AskUserDeps<Bot>, body: Partial<AskUserRequest>) => postAskUser(deps, askUserRequestSchema.parse(body));

describe("ask-user endpoint", () => {
  it("posts a marked question card into the sender's own thread and alerts once", () => {
    const h = harness();
    const res = ask(h.deps, { fromBotId: "bot-a", fromThreadId: "thread-a", question: "  Prod or staging?  ", choices: ["Prod", "Staging"] });
    expect(res).toEqual({ status: 201, body: { messageId: "m-1" } });
    expect(h.appended).toEqual([
      {
        threadId: "thread-a",
        message: {
          role: "bot",
          kind: "options",
          card: { title: "Your bot has a question", subtitle: "Prod or staging?", options: ["Prod", "Staging"], askUser: true },
        },
      },
    ]);
    expect(h.appended[0].message.card).not.toHaveProperty("requestId");
    expect(h.alerts).toEqual([{ bot: expect.objectContaining({ id: "bot-a" }), threadId: "thread-a", question: "Prod or staging?" }]);
  });

  it("attributes a room question to its sender", () => {
    const h = harness(new Map([["bot-a:room-1", { group: { id: "g1" } }]]));
    expect(ask(h.deps, { fromBotId: "bot-a", fromThreadId: "room-1", question: "Which?" }).status).toBe(201);
    expect(h.appended[0].message.from).toEqual({ botId: "bot-a", name: "Ada", color: "teal" });
    expect(h.appended[0].message.card?.options).toEqual([]);
  });

  it("refuses unknown senders, foreign threads and empty questions without posting or alerting", () => {
    const h = harness();
    expect(ask(h.deps, { fromBotId: "ghost", fromThreadId: "thread-a", question: "x" })).toMatchObject({ status: 403, body: { error: "unknown sender" } });
    expect(ask(h.deps, { fromBotId: "bot-a", fromThreadId: "", question: "x" })).toMatchObject({ status: 400 });
    expect(ask(h.deps, { fromBotId: "bot-a", fromThreadId: "thread-b", question: "x" })).toMatchObject({
      status: 403,
      body: { error: "source thread does not belong to sender" },
    });
    expect(ask(h.deps, { fromBotId: "bot-a", fromThreadId: "thread-a", question: "   " })).toMatchObject({ status: 400 });
    expect(h.appended).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it("caps the question and trims, dedupes and caps the choices", () => {
    const h = harness();
    ask(h.deps, { fromBotId: "bot-a", fromThreadId: "thread-a", question: "q".repeat(ASK_USER_QUESTION_MAX + 50) });
    expect(h.appended[0].message.card?.subtitle).toHaveLength(ASK_USER_QUESTION_MAX);
    expect(askUserRequestSchema.parse({ choices: [" a ", "a", "", 4, "b", "c", "d", "e", "f"] }).choices).toHaveLength(9);
    expect(askUserChoices(askUserRequestSchema.parse({ choices: [" a ", "a", "", 4, "b", "c", "d", "e", "f"] }).choices)).toEqual(["a", "b", "c", "d", "e"]);
    expect(askUserRequestSchema.parse({ choices: "a,b" }).choices).toEqual([]);
    expect(askUserRequestSchema.parse("not an object")).toEqual({ fromBotId: "", fromThreadId: "", question: "", choices: [] });
  });

  it("is routed in the harness with the question alert and never sets waiting-on-you", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("./internal-routes.ts", import.meta.url), "utf8");
    const route = routes.slice(routes.indexOf("askUser: async ("));
    const handler = route.slice(0, route.indexOf("return json(res, result.status, result.body);"));
    expect(handler).toContain("conversation: connectorThread");
    expect(handler).toContain('buildNotification("question", bot, target, question)');
    expect(handler).toContain("routineSourceThread(run)");
    expect(handler).toContain("askHold.whenSettled(botId, threadId, post)");
    expect(source).toContain("askHold.flush();");
    expect(handler).not.toContain("waiting-on-you");
    const dispatch = source.slice(source.indexOf('if (method === "POST" && path === "/api/internal/ask-user")'));
    const guard = dispatch.slice(0, dispatch.indexOf("// terminal_spawn:"));
    expect(guard).toMatch(/^if \(method === "POST" && path === "\/api\/internal\/ask-user"\) \{\s+return await internalRoutes\.askUser\(req, res\);\s+\}\s+$/);
  });

  it("lets a room persist only an ask_user card's answered or dismissed state", () => {
    const source = readFileSync(new URL("./group-routes.ts", import.meta.url), "utf8");
    const route = source.slice(source.indexOf("patchCard: async ("));
    const handler = route.slice(0, route.indexOf("return json(res, 200, { message: patched });"));
    expect(handler).toContain('if (!existing?.card?.askUser) return json(res, 404, { error: "no such card" });');
    expect(handler).toContain("askUserCardPatchSchema.parse(await readBody(req))");
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const cards = index.slice(index.indexOf("m = path.match(/^\\/api\\/groups\\/([\\w-]+)\\/cards\\/([\\w-]+)$/);"));
    const guard = cards.slice(0, cards.indexOf("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/messages$/);"));
    expect(guard).toMatch(/^m = path\.match\(.+\);\s+if \(m && method === "PATCH"\) \{\s+return await groupRoutes\.patchCard\(req, res, m\);\s+\}\s+$/);
    expect(askUserCardPatchSchema.parse({ answered: "Prod", dismissed: "yes", requestId: "r1" })).toEqual({ answered: "Prod" });
    expect(askUserCardPatchSchema.parse({ dismissed: true })).toEqual({ dismissed: true });
  });
});

const askCard = (id: string, question: string, extra: Partial<Message> = {}, card: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id, at: 1, role: "bot", kind: "options", ...extra,
  card: { title: "Your bot has a question", subtitle: question, options: ["Yes", "No"], askUser: true, ...card },
});
const said = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, at: 2, role: "user", kind: "text", text, ...extra });
const CLOSED = '[Your question card ("Ship it?") closed unanswered when they typed their latest message. It is gone from their screen; if you still need it, ask again.]';

describe("closed ask_user card note", () => {
  // startTurn's notes block, run on its own with the real helper.
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const from = index.indexOf("  const recallNotes = turnStartedByUser(opts)");
  const notes = index.slice(from, index.indexOf("\n  let turnTranscript", from));
  const run = new Function(`${ts.transpileModule(`function run(scope) { with (scope) { ${notes}\n return turnPrompt; } }`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None },
  }).outputText}\nreturn run;`)() as (scope: object) => string;
  const turnPrompt = (activeMessages: Message[], userMessage: Message) => run({
    activeMessages, userMessage, text: userMessage.text, closedAskNotes, currentPrompt: userMessage.text,
    turnStartedByUser: () => true, opts: undefined, supportsWorkspaceFiles: () => false, instance: {}, threadSyncV2: null,
    mailForTurn: () => [], store: {}, threadId: "t1", paneNoteIds: [], modelContextWindow: 200_000, paneTokens: 0,
    accountNotices: { forTurn: () => ({ text: "" }) }, paneNotes: [], routineCards: [], quickAnswers: [], callLines: [], bot: { id: "bot-a" },
  });

  it("tells the bot its open card closed when the user typed past it", () => {
    const typed = said("u1", "what's for lunch?");
    expect(turnPrompt([said("u0", "hi"), askCard("c1", "Ship it?"), typed], typed)).toBe(`${CLOSED}\n\nCurrent message:\n\nwhat's for lunch?`);
  });

  it("adds nothing once the card was answered, dismissed, superseded or already closed", () => {
    const typed = said("u2", "ok");
    expect(turnPrompt([askCard("c1", "Ship it?", {}, { answered: "Yes" }), typed], typed)).toBe("ok");
    expect(turnPrompt([askCard("c1", "Ship it?", {}, { dismissed: true }), typed], typed)).toBe("ok");
    expect(turnPrompt([askCard("c1", "Ship it?"), said("u1", "later"), typed], typed)).toBe("ok");
    expect(turnPrompt([said("u0", "hi"), typed], typed)).toBe("ok");
  });

  it("treats a tapped choice as the answer even before its patch lands", () => {
    expect(closedAskNotes([askCard("c1", "Ship it?"), said("u1", "Yes")], "Yes", "u1")).toEqual([]);
  });

  it("reads only the newest card, never approvals, and only for a message the person sent", () => {
    expect(closedAskNotes([askCard("c0", "Old?"), askCard("c1", "Ship it?"), said("u1", "hm")], "hm", "u1")).toEqual([CLOSED]);
    expect(closedAskNotes([askCard("c1", "Ship it?", {}, { askUser: undefined, requestId: "r1", tool: "Bash" }), said("u1", "hm")], "hm", "u1")).toEqual([]);
    expect(closedAskNotes([askCard("c1", "Ship it?"), said("u1", "hm", { from: { botId: "b", name: "B", color: "teal" } })], "hm", "u1")).toEqual([]);
    expect(closedAskNotes([askCard("c1", "Ship it?"), said("u1", "hm")], "hm", "missing")).toEqual([]);
  });

  it("covers a steered message not yet in the transcript, with the question bounded", () => {
    expect(closedAskNotes([askCard("c1", "Ship it?")], "hm")).toEqual([CLOSED]);
    const [line] = closedAskNotes([askCard("c1", "q".repeat(ASK_USER_QUESTION_MAX))], "hm");
    expect(line).toContain(`("${"q".repeat(199)}…")`);
  });

  it("tells only the asking room member, until it next speaks", () => {
    const ada = { botId: "bot-a", name: "Ada", color: "teal" as const };
    const card = askCard("c1", "Ship it?", { from: ada });
    expect(memberClosedAskNotes([card, said("u1", "hm")], "bot-a")).toEqual([CLOSED]);
    expect(memberClosedAskNotes([card, said("u1", "hm")], "bot-b")).toEqual([]);
    expect(memberClosedAskNotes([card, said("u1", "hm"), { id: "r1", at: 3, role: "bot", kind: "text", text: "ok", from: ada }], "bot-a")).toEqual([]);
    expect(memberClosedAskNotes([card], "bot-a")).toEqual([]);
  });
});

describe("skipped ask_user questions", () => {
  function watched(initial: TaskAsk[] = []) {
    const listeners: Array<(change: StoreChange) => void> = [];
    const path: Message[] = [];
    const lists = new Map<string, TaskAsk[]>([["t1", initial]]);
    const store = {
      importingSync: false,
      onChange: (listener: (change: StoreChange) => void) => (listeners.push(listener), () => {}),
      activePath: () => [...path],
    };
    watchSkippedQuestions(store, (threadId, change) => {
      const asks = change(lists.get(threadId));
      if (asks) lists.set(threadId, asks);
    }, () => 50);
    const append = (message: Message, imported?: true) => {
      path.push(message);
      for (const listener of listeners) listener({ type: "message", threadId: "t1", message, ...(imported ? { imported } : {}) });
    };
    const patch = (message: Message) => {
      path.splice(path.findIndex((entry) => entry.id === message.id), 1, message);
      for (const listener of listeners) listener({ type: "message.patch", threadId: "t1", message });
    };
    return { store, append, patch, asks: () => lists.get("t1") };
  }
  const filed = (id: string, ask: string, at = 50): TaskAsk => ({ id, ask, status: "open", kind: "question", choices: "Yes / No", at, changedAt: at });

  it("files a card a newer card replaced", () => {
    const h = watched();
    h.append(askCard("c1", "Ship it?"));
    expect(h.asks()).toEqual([]);
    h.append(askCard("c2", "Which branch?", { at: 3 }));
    expect(h.asks()).toEqual([filed("A1", "Ship it?")]);
  });

  it("never files a card answered by typing or speaking", () => {
    for (const [options, text] of [[["Yes", "No"], "yes"], [["Yes", "No"], "after lunch"], [[], "Ship it Friday."], [["Yes", "No"], "Yes."]] as Array<[string[], string]>) {
      const h = watched();
      h.append(askCard("c1", "Ship it?", {}, { options }));
      h.append(said("u1", text));
      h.append(askCard("c2", "Next?", { at: 3 }));
      expect(h.asks()).toEqual([]);
    }
  });

  it("walks the thread only for a new question card", () => {
    const h = watched();
    const walk = vi.spyOn(h.store, "activePath");
    h.append(said("u1", "hi"));
    h.append({ id: "r1", at: 3, role: "bot", kind: "text", text: "working" });
    expect(walk).not.toHaveBeenCalled();
    h.append(askCard("c1", "Ship it?"));
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it("never files an answered, tapped or dismissed card", () => {
    for (const card of [{ answered: "Yes" }, { dismissed: true }]) {
      const h = watched();
      h.append(askCard("c1", "Ship it?", {}, card));
      h.append(said("u1", "hm"));
      h.append(askCard("c2", "Next?"));
      expect(h.asks()).toEqual([]);
    }
    const tapped = watched();
    tapped.append(askCard("c1", "Ship it?"));
    tapped.append(said("u1", "Yes"));
    tapped.append(askCard("c2", "Next?"));
    expect(tapped.asks()).toEqual([]);
  });

  it("takes back a replaced card whose answer landed just after", () => {
    const h = watched();
    const card = askCard("c1", "Ship it?");
    h.append(card);
    h.append(askCard("c2", "Which branch?", { at: 3 }));
    expect(h.asks()).toHaveLength(1);
    h.patch({ ...card, card: { ...card.card!, answered: "after lunch" } });
    expect(h.asks()).toEqual([]);
  });

  it("closes an older filed question once a re-asked card is answered", () => {
    const h = watched([filed("A1", "Ship it?", 0)]);
    const card = askCard("c1", "Ship it?", { at: 10 });
    h.append(card);
    h.patch({ ...card, card: { ...card.card!, answered: "Yes" } });
    expect(h.asks()).toEqual([{ ...filed("A1", "Ship it?", 0), status: "done", changedAt: 50 }]);
  });

  it("files a question once while it stays open", () => {
    const h = watched();
    h.append(askCard("c1", "Ship it?"));
    h.append(askCard("c2", "ship  it?"));
    h.append(askCard("c3", "Which branch?"));
    expect(h.asks()).toEqual([filed("A1", "Ship it?")]);
  });

  it("ignores synced history and messages that close nothing", () => {
    const h = watched();
    h.append(askCard("c1", "Ship it?"));
    h.append(said("u1", "hm"), true);
    h.append({ id: "n1", at: 3, role: "user", kind: "text", text: "pane note", from: { botId: "b", name: "B", color: "teal" } });
    h.append({ id: "r1", at: 4, role: "bot", kind: "text", text: "working" });
    expect(h.asks()).toEqual([]);
    h.store.importingSync = true;
    h.append(said("u2", "hm"));
    expect(h.asks()).toEqual([]);
  });

  it("reads the transcript before the message, not with it", () => {
    expect(skippedQuestion([askCard("c1", "Ship it?")], askCard("c2", "Next?"))?.id).toBe("c1");
    expect(skippedQuestion([], askCard("c2", "Next?"))).toBeNull();
    expect(skippedQuestion([askCard("c1", "Ship it?"), said("u0", "hm")], said("u1", "hm"))).toBeNull();
  });
});
