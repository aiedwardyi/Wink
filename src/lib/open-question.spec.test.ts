// @vitest-environment happy-dom
// Walks every row of the question card's spec (day-1117/ask-card-one/SPEC.md) under its id.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as ask from "@/lib/open-question";
import { I18nProvider } from "@/lib/i18n";
import { isShownMessage } from "@/lib/shown-message";
import { StoreProvider, useStore, type Bot, type Group, type Message } from "@/state/store";
import { AskUserRecord } from "@/components/AskUserRecord";
import { Composer } from "@/components/Composer";
import { Transcript } from "@/components/GroupView";
import { PendingQuestionPanel } from "@/components/PendingQuestion";
import * as shared from "../../shared/open-question";
import * as server from "../../server/ask-user";
import { routesQuick } from "../../server/quick-ask";
import { LiveCall, type CallAudioPort, type Posted } from "@/lib/live-call/controller";
import type { LiveEngine, LiveEvents } from "@/lib/live-call/engine";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.current = this;
  }
}

// fold memory lives per question id, so every row asks fresh ones
let asked = 0;
let at = 10;
const card = (fields: Partial<NonNullable<Message["card"]>> = {}, extra: Partial<Message> = {}): Message => ({
  id: `spec-${++asked}`,
  role: "bot",
  kind: "options",
  at: ++at,
  card: { title: "Your bot has a question", subtitle: "Ship to prod or staging?", options: ["Prod", "Staging"], askUser: true, staysOpen: true, ...fields },
  ...extra,
});
const line = (text: string, extra: Partial<Message> = {}): Message => ({ id: `line-${++asked}`, role: "user", kind: "text", at: ++at, text, ...extra });
const botLine = (extra: Partial<Message> = {}): Message => ({ id: `bot-${++asked}`, role: "bot", kind: "text", at: ++at, text: "On it.", ...extra });
const approval = (): Message => ({ id: `approval-${++asked}`, role: "bot", kind: "options", at: ++at,
  card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" } });
const state = (messages: readonly Message[], message: Message) => shared.askStates(messages).get(message)?.state;
const member = { botId: "ada", name: "Ada", color: "blue" as const };

// drafts persist per thread, so each chat gets its own
const bot = (messages: Message[], threadId = `thread-${++asked}`): Bot => ({
  id: "asker", threadId, name: "Ada", title: "", description: "",
  notifications: false, color: "blue", unread: false, messages, busy: true, activity: "working",
  modelSelection: { instanceId: "claude", model: "claude" },
});
const room = (messages: Message[], id = "room"): Group => ({
  id, threadId: `${id}-thread`, name: "War room", memberIds: ["ada"], bulletin: "",
  defaultResponder: { kind: "everyone" }, unread: false, createdAt: 1, messages,
});
const ada = (): Bot => ({ ...bot([]), id: "ada" });

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
const calls: Array<{ method: string; path: string; body: unknown }> = [];
let failPosts = false;
let dispatch: ReturnType<typeof useStore>["dispatch"] = () => {};
let store: () => ReturnType<typeof useStore>["state"] = () => { throw new Error("no store"); };
function Probe() {
  const value = useStore();
  dispatch = value.dispatch;
  store = () => value.state;
  return null;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  calls.length = 0;
  failPosts = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type ComposerProps = Parameters<typeof Composer>[0];
const tree = (props: ComposerProps, transcript?: Group) => createElement(StoreProvider, null,
  createElement(Probe),
  createElement(Composer, { ...props, key: props.bot?.threadId ?? props.group?.threadId }),
  transcript && createElement(Transcript, {
    group: transcript, members: [ada()], messages: transcript.messages, transcript: transcript.messages, streamingMessage: null,
    dock: null, onReply: () => {}, onMessageMenu: () => {}, workers: [],
  }),
);

/** Loads the chat into the store the way the app does, then mounts its composer (and a room's transcript). */
async function mount(props: ComposerProps, transcript?: Group) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === "/api/bots?messages=200") {
      return new Response(JSON.stringify({ bots: [props.bot, ...(props.members ?? [])].filter(Boolean), groups: [props.group].filter(Boolean) }));
    }
    if (failPosts && method === "POST") return new Response(JSON.stringify({ error: "down" }), { status: 500 });
    if (method === "PATCH") return new Response(JSON.stringify({ message: null }));
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(tree(props, transcript)));
  await act(async () => FakeEventSource.current!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }), lastEventId: "" }));
}
const rerender = (props: ComposerProps, transcript?: Group) => act(async () => root!.render(tree(props, transcript)));
const settle = () => act(() => new Promise((done) => setTimeout(done, 0)));
const pin = () => host!.querySelector("[data-pending-question]");
const row = () => host!.querySelector<HTMLElement>("[data-question-row]");
const openCard = () => host!.querySelector<HTMLElement>('[role="region"][data-pending-question]');
const textarea = () => host!.querySelector("textarea")!;
const buttonIn = (scope: Element | null, name: string) => {
  const found = [...(scope?.querySelectorAll("button") ?? [])].find((button) => button.textContent === name || button.getAttribute("aria-label") === name);
  if (!found) throw new Error(`no ${name} button`);
  return found;
};
const click = (button: HTMLElement) => act(async () => button.click());
const type = (value: string) => act(async () => {
  const input = textarea();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const shrink = async () => {
  await type("S");
  await type("");
  await settle();
};
const swipe = (target: Element, dx: number, dy = 0) => act(async () => {
  const touch = (kind: string, x: number, y: number) => {
    const event = new Event(kind, { bubbles: true });
    Object.defineProperties(event, { touches: { value: kind === "touchend" ? [] : [{ clientX: x, clientY: y }] }, changedTouches: { value: [{ clientX: x, clientY: y }] } });
    target.dispatchEvent(event);
  };
  touch("touchstart", 100, 100);
  touch("touchmove", 100 + dx / 2, 100 + dy / 2);
  touch("touchend", 100 + dx, 100 + dy);
});
const sent = (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path).map((call) => call.body);
const waiting = (id = "asker") => ask.needsYou(store().bots.find((entry) => entry.id === id)?.messages ?? []).questions.length;
// what the first paint draws, before any effect runs
const firstPaint = (props: Partial<Parameters<typeof PendingQuestionPanel>[0]> & { message: Message }) =>
  renderToStaticMarkup(createElement(I18nProvider, null, createElement(PendingQuestionPanel, { askerName: "Ada", count: 1, onPick: () => {}, onDismiss: () => {}, ...props })));
// a closed fold unmounts its content, so the first paint holds only what shows
const shownAs = (html: string) => (html.includes("data-question-row") ? "row" : "card");
// what shows once the fold motion is over
const showing = async () => {
  await settle();
  const live = (el: Element | null) => Boolean(el && !el.closest('[data-fold="closing"]'));
  return live(row()) ? "row" : live(openCard()) ? "card" : null;
};

describe("bot asks", () => {
  it("A1 arrives as the open card with one arrival glow, and the chat needs him", async () => {
    const question = card();
    await mount({ bot: bot([question]) });
    expect(openCard()?.className).toContain("arrival-glow");
    expect(await showing()).toBe("card");
    expect(ask.chatNeedsYou([question])).toBe(true);
  });

  it("A2 arrives folded over a draft, a reply or an attachment, never painting the card first", () => {
    expect(shownAs(firstPaint({ message: card(), typed: "half a thought" }))).toBe("row");
    expect(shownAs(firstPaint({ message: card(), replying: true }))).toBe("row");
    expect(shownAs(firstPaint({ message: card(), attached: 1 }))).toBe("row");
    expect(shownAs(firstPaint({ message: card() }))).toBe("card");
  });

  it("A3 waits for the asking turn to reply before it posts", () => {
    const posts: Array<() => void> = [];
    const appended: unknown[] = [];
    const deps = { bot: () => ({ id: "bot-a", name: "Ada", color: "teal" as const }), conversation: () => ({}),
      appendMessage: (_thread: string, message: object) => (appended.push(message), { ...message, id: "m1", at: 1 }) as Message,
      activePath: () => [], patchMessage: () => null, cancelHeld: () => false, alertThread: (_bot: unknown, thread: string) => thread,
      notifyQuestion: () => {}, whenSettled: (_bot: string, _thread: string, post: () => void) => { posts.push(post); } };
    const res = server.postAskUser(deps as never, server.askUserRequestSchema.parse({ fromBotId: "bot-a", fromThreadId: "t", question: "Prod?" }));
    expect(res).toEqual({ status: 202, body: { held: true } });
    expect(appended).toEqual([]);
    posts[0]!();
    expect(appended).toHaveLength(1);
  });

  it("A4 waits behind an approval on the shown branch, its record staying in the transcript", () => {
    const question = card();
    const messages = [question, approval()];
    expect(ask.pinnedQuestion(messages)).toBeNull();
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(AskUserRecord, { message: question, transcript: messages, pinned: false, onPick: () => {} })));
    expect(html).toContain("data-ask-choices");
  });

  it("A5 keeps a different older question waiting with live choices, and pins the newest of two", async () => {
    const older = card({ subtitle: "Which region?", options: ["Seoul", "Tokyo"] });
    const newer = card({ subtitle: "Which plan?", options: ["Pro", "Team"] });
    expect(ask.openQuestions([older, newer])).toEqual([older, newer]);
    expect(ask.pinnedQuestion([older, newer])).toBe(newer);
    await mount({ bot: bot([older, newer]) });
    await shrink();
    expect(row()!.textContent).toContain("2/2");
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(AskUserRecord, { message: older, transcript: [older, newer], pinned: false, onPick: () => {} })));
    expect(html).toContain("Seoul");
  });

  it("A6 closes the older card when the same asker asks the same words again", () => {
    const older = card();
    const again = card();
    expect(state([older, again], older)).toBe("askedAgain");
    expect(state([older, again], again)).toBe("waiting");
  });

  it("A7 reads answered in chat when the bot closes it, and cancels a held copy", () => {
    const question = card({ subtitle: "Prod or staging?" });
    const patched: unknown[] = [];
    const cancel = vi.fn(() => false);
    const deps = { bot: () => ({ id: "bot-a", name: "Ada", color: "teal" as const }), conversation: () => ({}),
      appendMessage: () => { throw new Error("no new card"); }, activePath: () => [question],
      patchMessage: (_thread: string, _id: string, patch: unknown) => (patched.push(patch), question), cancelHeld: cancel,
      alertThread: (_bot: unknown, thread: string) => thread, notifyQuestion: () => {}, whenSettled: () => {} };
    const res = server.postAskUser(deps as never, server.askUserRequestSchema.parse({ fromBotId: "bot-a", fromThreadId: "t", question: "Prod or staging?", close: true }));
    expect(res).toEqual({ status: 200, body: { closed: true } });
    expect(cancel).toHaveBeenCalledWith("bot-a", "t", "Prod or staging?");
    expect(patched).toEqual([{ card: expect.objectContaining({ answered: shared.ANSWERED_IN_CHAT }) }]);
    const closed = { ...question, card: { ...question.card!, answered: shared.ANSWERED_IN_CHAT } };
    expect(ask.askUserStatus([closed], closed)).toEqual({ state: "answered", reply: shared.ANSWERED_IN_CHAT });
  });

  it("A8 replaces a card from before cards stayed open with any newer one", () => {
    const old = card({ staysOpen: undefined });
    expect(state([old, card({ subtitle: "Another?" })], old)).toBe("superseded");
  });
});

describe("taps", () => {
  it("T1 sends a tapped choice as one hidden line on its card naming its question, which reads answered", async () => {
    const question = card();
    await mount({ bot: bot([question]) });
    await click(buttonIn(openCard(), "Staging"));
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`)).toEqual([{ answered: "Staging" }]);
    await settle();
    expect(sent("POST", "/api/bots/asker/messages")).toEqual([expect.objectContaining({ text: 'Re: “Ship to prod or staging?”\nStaging', cardId: question.id })]);
    expect(isShownMessage(line("Staging", { answersCard: question.id }))).toBe(false);
    expect(waiting()).toBe(0);
  });

  it("T2 names an older card's question in its answer and settles only that card", () => {
    const older = card({ subtitle: "Which region?", options: ["Seoul", "Tokyo"] });
    const newer = card({ subtitle: "Which plan?", options: ["Pro", "Team"] });
    const text = `${shared.answerPrefix(older)}Seoul`;
    expect(text).toBe('Re: “Which region?”\nSeoul');
    const messages = [older, newer, line(text)];
    expect(state(messages, older)).toBe("answered");
    expect(state(messages, newer)).toBe("waiting");
  });

  it("T3 sends nothing for a tap on a settled card, and the server refuses it with the stored row", () => {
    const question = card();
    const messages = [question, line("Prod")];
    expect(ask.canAnswerCard(messages, question.id)).toBe(false);
    expect(server.settledAsk(messages as never, question.id)?.id).toBe(question.id);
  });

  it("T4 lands a late tap on its own card only while that card still waits", () => {
    const question = card();
    const other = card({ subtitle: "Which plan?", options: ["Pro", "Team"] });
    const tap = (text: string) => line(text, { answersCard: question.id });
    const pastIt = [question, other, line("unrelated"), tap("Staging")];
    expect(shared.askStates(pastIt).get(question)).toMatchObject({ state: "answered", reply: "Staging" });
    expect(state(pastIt, other)).toBe("waiting");
    const typedFirst = [question, line("Prod"), tap("Staging")];
    expect(shared.askStates(typedFirst).get(question)).toMatchObject({ state: "answered", reply: "Prod" });
    expect(ask.canAnswerCard(typedFirst, question.id)).toBe(false);
  });

  it("T5 opens the card from the row's text or its +N pill, answering nothing", async () => {
    const onPick = vi.fn();
    const question = card();
    ask.foldQuestion(question.id);
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const render = () => act(async () => root!.render(createElement(PendingQuestionPanel, { message: question, askerName: "Ada", count: 1, onPick, onDismiss: () => {} })));
    await render();
    await click(row()!.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
    await settle();
    expect(await showing()).toBe("card");
    ask.foldQuestion(question.id);
    await render();
    const more = row()!.querySelector<HTMLButtonElement>("[data-row-choices] > button:not([data-row-choice])")!;
    await click(more);
    await settle();
    expect(await showing()).toBe("card");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("T6 delivers one answer per tap: a call's spoken answer to a settled card is refused, never resent bare", async () => {
    const question = card({ subtitle: "Which build?", options: ["Let me pick", "Latest"] });
    const tapped = { ...question, card: { ...question.card!, answered: "Let me pick" } };
    const spoken = `${shared.answerPrefix(question)}Let me pick`;
    expect(server.answeredAgain?.(() => [tapped] as never, spoken)?.id).toBe(question.id);
    expect(server.answeredAgain?.(() => [question, line(spoken, { answersCard: question.id })] as never, spoken)?.id).toBe(question.id);
    expect(server.answeredAgain?.(() => [question] as never, spoken)).toBeNull();

    vi.useFakeTimers();
    vi.stubGlobal("crypto", { randomUUID: () => "send-1" });
    try {
      let t = 0;
      let events!: LiveEvents;
      const posts: Array<{ path: string; body: { text?: string } }> = [];
      const engine: LiveEngine = { connect: (_session: unknown, on: LiveEvents) => { events = on; }, sendAudio() {}, audioPaused() {}, sendText() {}, sendContext() {}, sendToolResult() {}, close() {} } as unknown as LiveEngine;
      const audio = { playing: false, async capture() {}, async heal() { return true; }, stopMic() {}, play() {}, endTurn() {}, tune() {}, flush() {}, close() {}, boop() {},
        heardShare: () => 1, micLevel: () => 0.2, onIdle: () => {}, onStart: () => {} } as unknown as CallAudioPort;
      const call = new LiveCall({ botId: "b1", botName: "Nova", device: "phone", engine: () => engine, audio, now: () => t,
        post: async (path: string, body: { text?: string }): Promise<Posted> => {
          posts.push({ path, body });
          if (path.endsWith("/messages")) return { status: 409, data: { error: "question already settled" } };
          if (path.endsWith("/call/token")) return { status: 200, data: { callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m", voice: "Aoede" } };
          return { status: 200, data: {} };
        } });
      const tick = async (ms: number) => { t += ms; await vi.advanceTimersByTimeAsync(ms); };
      await call.start();
      events.ready();
      events.turnDone();
      await tick(5_000);
      call.observe({ busy: false, messages: [{ ...question, at: 6_000 }] as never });
      events.answering();
      events.turnDone();
      events.heard("Let me pick.");
      events.answering();
      await tick(0);
      call.end();
      await tick(1_100);
      expect(posts.filter((post) => post.path === "/api/bots/b1/messages").map((post) => post.body.text)).toEqual([`${shared.answerPrefix(question)}Let me pick.`]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("typing", () => {
  it("Y1 Y2 folds once on his first keystroke, and stays open once he opens it while typing", async () => {
    await mount({ bot: bot([card()]) });
    await type("S");
    await settle();
    expect(await showing()).toBe("row");
    await click(row()!.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
    await settle();
    await type("St");
    await type("Sta");
    await settle();
    expect(await showing()).toBe("card");
  });

  it("Y3 answers with a choice's exact text", () => {
    const question = card();
    expect(ask.typedAnswer([question], " Staging ")).toMatchObject({ question, answered: "Staging" });
  });

  it("Y4 stays waiting past unrelated text, Quick answers still run, and the bot hears every open question", () => {
    const question = card();
    const other = card({ subtitle: "Which plan?", options: ["Pro", "Team"] });
    expect(ask.typedAnswer([question], "also fix the header")).toBeNull();
    expect(state([question, line("also fix the header")], question)).toBe("waiting");
    const gate = { bot: { busy: true, threadId: "t" }, threadId: "t", text: "what time is it?", messages: [question], room: false, accountReady: true,
      instance: { driverKind: "claude", fork: true } };
    expect(routesQuick(gate as never)).toBe(routesQuick({ ...gate, messages: [] } as never));
    expect(server.closedAskNotes([question, other] as never, "also fix the header").join("")).toContain("2 of your question cards are still open");
  });

  it("Y5 answers a card without choices with his first line, and the box asks for it", async () => {
    const question = card({ options: [] });
    expect(ask.typedAnswer([question], "Use the blue one\nthanks")).toMatchObject({ answered: "Use the blue one" });
    await mount({ bot: bot([question]) });
    expect(textarea().placeholder).toBe("Type your answer");
  });

  it("Y6 reopens the card a rejected send settled", async () => {
    const question = card({ options: [] });
    failPosts = true;
    await mount({ bot: { ...bot([question]), busy: false } });
    await act(async () => dispatch({ type: "send", botId: "asker", text: "the blue one" }));
    await settle();
    expect(waiting()).toBe(1);
  });

  it("Y7 settles nothing on Send now, and a queued line landing by itself is not moving on", async () => {
    const question = card({ options: [] });
    expect(ask.chatMovedOn([question, line("queued", { queueId: "q1" })], question)).toBe(false);
    await mount({ bot: bot([question]) });
    await act(async () => dispatch({ type: "send", botId: "asker", text: "typed earlier", queueId: "q1" }));
    expect(store().bots[0]!.messages.find((message) => message.id === question.id)?.card?.answered).toBeUndefined();
  });
});

describe("attaching, replying and the chat moving on", () => {
  it("P1 folds once when a file is attached", async () => {
    await mount({ bot: bot([card()], "p1-thread") });
    await act(async () => {
      const input = host!.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
      Object.defineProperty(input, "files", { value: [new File(["x"], "notes.txt", { type: "text/plain" })], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(await showing()).toBe("row");
  });

  it("P2 folds once when he starts a reply", async () => {
    const question = card();
    const replied = botLine();
    await mount({ bot: { ...bot([replied, question]), threadId: "p2-thread" } });
    await rerender({ bot: { ...bot([replied, question]), threadId: "p2-thread" }, replyTo: replied });
    await settle();
    expect(await showing()).toBe("row");
  });

  it("M1 folds once on his own message or the asker's shown reply", () => {
    const question = card();
    expect(ask.chatMovedOn([question, line("hi")], question)).toBe(true);
    expect(ask.chatMovedOn([question, botLine()], question)).toBe(true);
    const roomQuestion = card({}, { from: member });
    expect(ask.chatMovedOn([roomQuestion, botLine({ from: member })], roomQuestion)).toBe(true);
  });

  it("M2 neither folds nor answers on a worker note, a tool run, another member or a teammate; his call line folds but never answers", () => {
    const question = card({}, { from: member });
    const rows: Message[] = [
      { id: "n", role: "bot", kind: "note", at: ++at, text: "pane output" },
      { id: "a", role: "bot", kind: "activity", at: ++at, tool: { name: "Read", ok: true } },
      botLine({ from: { botId: "kai", name: "Kai", color: "red" } }),
      line("from a teammate", { author: { kind: "person", id: "p1", name: "Jo" } } as Partial<Message>),
    ];
    expect(ask.chatMovedOn([question, ...rows], question)).toBe(false);
    expect(state([question, ...rows], question)).toBe("waiting");
    const spoken = line("spoken", { call: { id: "c-0123456789ab" } } as Partial<Message>);
    expect(ask.chatMovedOn([question, spoken], question)).toBe(true);
    expect(state([question, spoken], question)).toBe("waiting");
  });
});

describe("x, swipe, chevron and Esc", () => {
  it("X1 dismisses with the open card's x", async () => {
    const question = card();
    await mount({ bot: bot([question]) });
    await click(buttonIn(openCard(), "Dismiss question"));
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`)).toEqual([{ dismissed: true }]);
    expect(waiting()).toBe(0);
  });

  it("X2 dismisses with the row's x, same as the card's", async () => {
    const question = card();
    await mount({ bot: bot([question]) });
    await shrink();
    await click(buttonIn(row(), "Dismiss question"));
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`)).toEqual([{ dismissed: true }]);
    expect(waiting()).toBe(0);
  });

  it("X3 dismisses on a sideways swipe across the row", async () => {
    const question = card();
    await mount({ bot: bot([question]) });
    await shrink();
    Object.defineProperty(row()!, "offsetWidth", { value: 360, configurable: true });
    await swipe(row()!, -300);
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`)).toEqual([{ dismissed: true }]);
  });

  it("X4 X5 folds on a downward swipe, and leaves sideways, upward and text-scrolling gestures alone", async () => {
    const onDismiss = vi.fn();
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const question = card();
    await act(async () => root!.render(createElement(PendingQuestionPanel, { message: question, askerName: "Ada", count: 1, onPick: () => {}, onDismiss })));
    const body = () => host!.querySelector<HTMLElement>("[data-question-body]")!;
    await swipe(body(), 200, 0);
    await swipe(body(), 0, -120);
    body().scrollTop = 30;
    await swipe(body(), 0, 120);
    body().scrollTop = 0;
    expect(await showing()).toBe("card");
    await swipe(body(), 0, 120);
    await settle();
    expect(await showing()).toBe("row");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("X6 folds and opens on the chevron", async () => {
    await mount({ bot: bot([card()]) });
    await click(buttonIn(openCard(), "Fold question"));
    await settle();
    expect(await showing()).toBe("row");
    await click(buttonIn(row(), "Expand question"));
    await settle();
    expect(await showing()).toBe("card");
  });

  it("E1 leaves the card alone on Esc", async () => {
    const question = card();
    await mount({ bot: bot([question]) });
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      openCard()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(await showing()).toBe("card");
    expect(calls).toEqual([]);
  });
});

describe("several open questions", () => {
  const pair = () => [card({ subtitle: "Which region?", options: [] }), card({ subtitle: "Which plan?", options: ["Pro", "Team"] })] as const;

  it("N1 N2 steps between them with the arrows, and shows the newest still waiting once one settles", async () => {
    const [older, newer] = pair();
    await mount({ bot: bot([older, newer]) });
    await shrink();
    await click(buttonIn(row(), "Previous question"));
    expect(row()!.textContent).toContain("1/2");
    expect(row()!.textContent).toContain("Which region?");
    await rerender({ bot: bot([{ ...older, card: { ...older.card!, dismissed: true } }, newer]) });
    expect(row()!.textContent).toContain("Which plan?");
  });

  it("N3 jumps to a newer question that arrives while stepped back", async () => {
    const [older, newer] = pair();
    await mount({ bot: bot([older, newer]) });
    await shrink();
    await click(buttonIn(row(), "Previous question"));
    const newest = card({ subtitle: "Which day?", options: ["Mon", "Tue"] });
    await rerender({ bot: bot([older, newer, newest]) });
    expect(pin()!.textContent).toContain("Which day?");
  });

  it("N4 hides the record of the question the pin shows, and only that one, and the box follows it", async () => {
    const [older, newer] = pair().map((question) => ({ ...question, from: member }));
    const group = room([older!, newer!]);
    await mount({ group, members: [ada()] }, group);
    const record = (id: string) => host!.querySelector(`[data-message-id="${id}"] [data-ask-user-record]`) ?? [...host!.querySelectorAll("[data-ask-user-record]")].find((el) => el.textContent?.includes(id === older!.id ? "Which region?" : "Which plan?"));
    expect(record(newer!.id)).toBeFalsy();
    expect(record(older!.id)).toBeTruthy();
    await shrink();
    await click(buttonIn(row(), "Previous question"));
    expect(row()!.textContent).toContain("Which region?");
    expect(record(older!.id)).toBeFalsy();
    expect(record(newer!.id)).toBeTruthy();
    expect(textarea().placeholder).toBe("Type your answer");
  });
});

describe("rooms", () => {
  it("R1 names the member who asked and answers in the room", async () => {
    const question = card({}, { from: member });
    const group = room([question]);
    await mount({ group, members: [ada()] });
    expect(openCard()?.getAttribute("aria-label")).toBe("Ada asks");
    await click(buttonIn(openCard(), "Staging"));
    expect(sent("PATCH", `/api/groups/room/cards/${question.id}`)).toEqual([{ answered: "Staging" }]);
    await settle();
    expect(sent("POST", "/api/groups/room/messages")).toEqual([expect.objectContaining({ text: 'Re: “Ship to prod or staging?”\nStaging', cardId: question.id })]);
    expect(shared.scanQuestion([question])?.from?.botId).toBe("ada");
  });

  it("R2 keeps both waiting when another member asks the same words", () => {
    const first = card({}, { from: member });
    const second = card({}, { from: { botId: "kai", name: "Kai", color: "red" } });
    expect(state([first, second], first)).toBe("waiting");
    expect(state([first, second], second)).toBe("waiting");
  });

  it("R3 shows an older room task's records without live choices", async () => {
    const question = card({}, { from: member });
    const group = room([], "old-room");
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root!.render(createElement(StoreProvider, null, createElement(Transcript, {
      group, members: [ada()], messages: [question], transcript: [question], streamingMessage: null,
      dock: null, onReply: () => {}, onMessageMenu: () => {}, workers: [], readOnly: true,
    }))));
    expect(host.querySelector("[data-ask-user-record]")).toBeTruthy();
    expect(host.querySelector("[data-ask-choices]")).toBeNull();
  });

  it("R4 tells the bot about its cards only for his own line, not a teammate's or a call line", () => {
    const first = card({}, { from: member });
    const second = card({ subtitle: "Which plan?" }, { from: member });
    const teammate = line("we should ship", { author: { kind: "person", id: "p1", name: "Jo" } } as Partial<Message>);
    expect(server.closedAskNotes([first, second, teammate] as never, teammate.text!, teammate.id, "ada")).toEqual([]);
    expect(server.memberClosedAskNotes([first, second, teammate] as never, "ada")).toEqual([]);
    const own = line("we should ship");
    expect(server.memberClosedAskNotes([first, second, own] as never, "ada").join("")).toContain("2 of your question cards are still open");
  });
});

describe("reload, other devices and restarts", () => {
  it("L1 comes back from the stored transcript, folded when the chat moved on past it, never painting the card first", () => {
    const question = card();
    const stored = JSON.parse(JSON.stringify([question, line("unrelated")])) as Message[];
    expect(state(stored, stored[0]!)).toBe("waiting");
    expect(shownAs(firstPaint({ message: card(), movedOn: true }))).toBe("row");
    expect(shownAs(firstPaint({ message: card() }))).toBe("card");
  });

  it("L2 replays the arrival glow once after a reload", async () => {
    const question = card();
    const glows = async () => {
      vi.resetModules();
      const { PendingQuestionPanel: Fresh } = await import("@/components/PendingQuestion");
      const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(Fresh, { message: question, askerName: "Ada", count: 1, onPick: () => {}, onDismiss: () => {} })));
      return html.includes("arrival-glow");
    };
    expect(await glows()).toBe(true);
    expect(await glows()).toBe(true);
  });

  it("L3 keeps its fold across a chat switch, and the arrows' pick resets to the newest", async () => {
    const older = card({ subtitle: "Which region?", options: ["Seoul", "Tokyo"] });
    const newer = card({ subtitle: "Which plan?", options: ["Pro", "Team"] });
    await mount({ bot: bot([older, newer], "l3-thread") });
    await shrink();
    await click(buttonIn(row(), "Previous question"));
    expect(row()!.textContent).toContain("1/2");
    await rerender({ bot: bot([], "l3-other") });
    await rerender({ bot: bot([older, newer], "l3-thread") });
    expect(await showing()).toBe("row");
    expect(row()!.textContent).toContain("2/2");
  });

  it("L4 follows a settle from another device, and refuses a stale tap there", async () => {
    const question = card();
    await mount({ bot: bot([question], "l4-thread") });
    const answered = { ...question, card: { ...question.card!, answered: "Prod" } };
    await act(async () => FakeEventSource.current!.onmessage?.({
      data: JSON.stringify({ kind: "message.patch", botId: "asker", threadId: "l4-thread", message: answered }), lastEventId: "c1" }));
    await rerender({ bot: bot([answered], "l4-thread") });
    expect(pin()).toBeNull();
    await act(async () => dispatch({ type: "answerCard", botId: "asker", messageId: question.id, answer: "Staging" }));
    expect(sent("POST", "/api/bots/asker/messages")).toEqual([]);
    expect(sent("PATCH", `/api/bots/asker/cards/${question.id}`)).toEqual([]);
  });

  it("L5 reads the same after a restart: states come only from the stored rows", () => {
    const rows = [card(), card({ subtitle: "Which plan?" }), line("Re: “Which plan?”\nPro")];
    const stored = JSON.parse(JSON.stringify(rows)) as Message[];
    expect(stored.map((message) => state(stored, message))).toEqual(rows.map((message) => state(rows, message)));
  });
});
