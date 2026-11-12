import { describe, expect, it } from "vitest";

import { anyChatNeedsYou, askUserStatus, chatNeedsYou, needsYou, openQuestion, pinnedQuestion } from "./open-question";
import type { Message } from "@/state/store";

let at = 0;
const ask = (id: string, card: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id,
  role: "bot",
  kind: "options",
  at: ++at,
  card: { title: "Your bot has a question", subtitle: `question ${id}`, options: ["Yes", "No"], askUser: true, ...card },
});
const typed = (id: string, text = "Yes please\nand more"): Message => ({ id, role: "user", kind: "text", at: ++at, text });
const botText = (id: string): Message => ({ id, role: "bot", kind: "text", at: ++at, text: "Still working on the rest." });
const paneNote = (id: string): Message => ({ id, role: "bot", kind: "note", at: ++at, text: "pane output" });
const peer = (id: string): Message => ({
  id,
  role: "user",
  kind: "text",
  at: ++at,
  text: "From a peer",
  from: { botId: "peer", name: "Peer", color: "blue" },
});
const activity = (id: string): Message => ({ id, role: "bot", kind: "activity", at: ++at, tool: { name: "Read file", ok: true } });
const quiz: Message = {
  id: "quiz",
  role: "bot",
  kind: "options",
  at: 0,
  card: { title: "What do you mostly want help with?", subtitle: "Pick one", options: ["Work", "Life"] },
};
const approval = (card: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id: "approval",
  role: "bot",
  kind: "options",
  at: ++at,
  card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash", ...card },
});

describe("open ask_user question", () => {
  it("is open until the person sends a message, and the typed reply answers it", () => {
    const question = ask("q1");
    expect(openQuestion([typed("u0"), question])).toBe(question);
    const reply = typed("u1");
    const thread = [typed("u0"), question, reply];
    expect(openQuestion(thread)).toBeNull();
    expect(askUserStatus(thread, question)).toEqual({ state: "answered", reply: "Yes please" });
  });

  it("is closed by a tapped choice, which persists answered rather than dismissed", () => {
    const tapped = ask("q1", { answered: "No" });
    expect(openQuestion([tapped])).toBeNull();
    expect(askUserStatus([tapped], tapped)).toEqual({ state: "answered", reply: "No" });
  });

  it("stays open through pane notes, peer messages, bot progress and tool runs", () => {
    const question = ask("q1");
    const thread = [question, botText("b1"), paneNote("n1"), peer("p1"), activity("a1")];
    expect(openQuestion(thread)).toBe(question);
    expect(askUserStatus(thread, question)).toEqual({ state: "waiting" });
  });

  it("is closed by dismissing it", () => {
    const dismissed = ask("q1", { dismissed: true });
    expect(openQuestion([dismissed])).toBeNull();
    expect(askUserStatus([dismissed], dismissed)).toEqual({ state: "dismissed" });
  });

  it("is superseded by a newer question, and a dismissed newer one leaves nothing open", () => {
    const older = ask("q1");
    const newer = ask("q2");
    expect(openQuestion([older, botText("b1"), newer])).toBe(newer);
    expect(askUserStatus([older, botText("b1"), newer], older)).toEqual({ state: "superseded" });
    expect(openQuestion([older, ask("q3", { dismissed: true })])).toBeNull();
  });

  it("never treats the first-run quiz or a live provider question as an ask_user card", () => {
    expect(openQuestion([quiz])).toBeNull();
    expect(chatNeedsYou([quiz])).toBe(false);
    const native = ask("q1", { requestId: "native-1", askUser: undefined });
    expect(openQuestion([native])).toBeNull();
  });

  it("makes the row glow for an open approval or engine question, not for a settled one", () => {
    expect(chatNeedsYou([approval(), typed("u1")])).toBe(true);
    expect(chatNeedsYou([approval({ answered: "allow" })])).toBe(false);
    expect(chatNeedsYou([approval({ dismissed: true })])).toBe(false);
    expect(chatNeedsYou([ask("q1")])).toBe(true);
    expect(chatNeedsYou([ask("q1"), typed("u1")])).toBe(false);
    expect(chatNeedsYou([])).toBe(false);
  });

  it("pins the open question unless an open approval on the shown branch holds the composer", () => {
    const question = ask("q1");
    expect(pinnedQuestion([question])).toBe(question);
    expect(pinnedQuestion([question, approval()])).toBeNull();
    expect(pinnedQuestion([question, approval({ answered: "allow" })])).toBe(question);
    expect(pinnedQuestion([question, approval()], [question])).toBe(question);
    expect(pinnedQuestion([question, ask("q2", { requestId: "native-1", askUser: undefined })])).toBe(question);
    expect(pinnedQuestion([question, typed("u1")])).toBeNull();
  });

  it("memoizes per message array so rows stay cheap", () => {
    const thread = [ask("q1")];
    expect(needsYou(thread)).toBe(needsYou(thread));
    expect(needsYou([...thread])).not.toBe(needsYou(thread));
  });

  it("lets a hiding control know when another chat needs the person", () => {
    const chats = [
      { id: "open", messages: [ask("q1")] },
      { id: "quiet", messages: [typed("u1")] },
      { id: "archived", hidden: true, messages: [ask("q2")] },
    ];
    expect(anyChatNeedsYou(chats)).toBe(true);
    expect(anyChatNeedsYou(chats, "open")).toBe(false);
  });
});

describe("an ask_user card that stays open", () => {
  const live = (id: string, card: Partial<NonNullable<Message["card"]>> = {}) => ask(id, { staysOpen: true, ...card });

  it("stays live while the person types past a card with choices", () => {
    const question = live("q1");
    const thread = [question, typed("u1", "what's for lunch?")];
    expect(openQuestion(thread)).toBe(question);
    expect(askUserStatus(thread, question)).toEqual({ state: "waiting" });
  });

  it("is answered by typing only while pinned without choices", () => {
    const question = live("q1", { options: [] });
    const thread = [question, typed("u1", "Friday")];
    expect(openQuestion(thread)).toBeNull();
    expect(askUserStatus(thread, question)).toEqual({ state: "answered", reply: "Friday" });
  });

  it("keeps an older different question live behind a newer one, and pins the next once one is answered", () => {
    const older = live("q1");
    const newer = live("q2");
    expect(askUserStatus([older, typed("u1", "hm"), newer], older)).toEqual({ state: "waiting" });
    expect(pinnedQuestion([older, newer])).toBe(newer);
    const answered = { ...newer, card: { ...newer.card!, answered: "Yes" } };
    expect(pinnedQuestion([older, answered])).toBe(older);
    expect(pinnedQuestion([{ ...older, card: { ...older.card!, dismissed: true } }, answered])).toBeNull();
  });

  it("reads an older card's quoted answer as its own, leaving the newer one waiting", () => {
    const older = live("q1");
    const newer = live("q2", { options: [] });
    const after = [older, newer, typed("u1", "Re: “question q1”\nNo")];
    expect(askUserStatus(after, older)).toEqual({ state: "answered", reply: "No" });
    expect(askUserStatus(after, newer)).toEqual({ state: "waiting" });
  });

  it("closes only when asked again word for word", () => {
    const older = live("q1");
    const again = live("q2", { subtitle: "question q1" });
    expect(askUserStatus([older, again], older)).toEqual({ state: "askedAgain" });
    expect(openQuestion([older, again])).toBe(again);
  });
});

