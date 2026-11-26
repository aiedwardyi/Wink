import { describe, expect, it } from "vitest";

import { anyChatNeedsYou, askUserStatus, chatMovedOn, chatNeedsYou, needsYou, openQuestion, pinnedQuestion, questionJumpId } from "./open-question";
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

describe("the chat moving on from a question", () => {
  it("counts only what lands after it, and nothing for a question that is not in the chat", () => {
    const question = ask("q1", { staysOpen: true });
    expect(chatMovedOn([typed("u0"), question], question)).toBe(false);
    expect(chatMovedOn([question, paneNote("n1"), peer("p1")], question)).toBe(false);
    expect(chatMovedOn([question, typed("u1")], question)).toBe(true);
    expect(chatMovedOn([question, botText("b1")], question)).toBe(true);
    expect(chatMovedOn([typed("u2"), botText("b2")], question)).toBe(false);
  });
});

describe("questionJumpId", () => {
  const by = (botId: string, message: Message): Message => ({ ...message, from: { botId, name: botId, color: "blue" } });
  const tool = activity;
  const wake = (id: string): Message => ({ id, role: "bot", kind: "routine.run", at: ++at, routineRun: { wake: true } as never });
  const routine = (id: string): Message => ({ id, role: "bot", kind: "routine.run", at: ++at, routineRun: {} as never });
  // the server stamps a card with its asking turn's last text, or nothing when that turn wrote none
  const asked = (replyId?: string) => ask("q", replyId ? { staysOpen: true, replyId } : { staysOpen: true });
  const jump = (messages: Message[], question: Message, hasMore = false) => questionJumpId(messages, question, pinnedQuestion(messages), hasMore);

  it.each<[string, (q: Message) => Message[], string | undefined]>([
    ["typed turn, reply then card", (q) => [typed("u0"), tool("a0"), botText("b1"), q], "b1"],
    ["turn woken by a pane note, no text", (q) => [typed("u0"), botText("b-prev"), paneNote("n1"), tool("a1"), tool("a2"), q], undefined],
    ["turn woken by a peer note, no text", (q) => [typed("u0"), botText("b-prev"), peer("p1"), tool("a1"), q], undefined],
    ["turn woken by wake_me, no text", (q) => [typed("u0"), botText("b-prev"), wake("w1"), tool("a1"), q], undefined],
    ["turn started by a routine run, no text", (q) => [typed("u0"), botText("b-prev"), routine("r1"), tool("a1"), q], undefined],
    ["three woken turns with no text", (q) => [typed("u0"), botText("b-old"), paneNote("n1"), tool("a1"), paneNote("n2"), tool("a2"), paneNote("n3"), tool("a3"), q], undefined],
    ["a later woken turn writes text", (q) => [typed("u0"), tool("a0"), q, paneNote("n1"), tool("a1"), botText("b-later")], undefined],
    ["person steers mid-turn before the card", (q) => [typed("u0"), botText("b1"), { ...typed("u1"), steered: true }, tool("a1"), q], undefined],
    ["room: ada text, max text, ada asks", (q) => [typed("u0"), by("ada", botText("ada-1")), by("max", botText("max-1")), by("ada", q)], "ada-1"],
    ["room: max calls ada back, ada asks with no text", (q) => [typed("u0"), by("ada", botText("ada-round1")), by("max", botText("max-asks-ada")), by("ada", tool("a1")), by("ada", q)], undefined],
  ])("lands on the asking turn's own text only: %s", (_name, shape, replyId) => {
    const messages = shape(asked(replyId));
    const question = messages.find((message) => message.id === "q")!;
    expect(jump(messages, question)).toBe(replyId ?? null);
  });

  it("pages in a reply older than the loaded tail, and does nothing once no older page is left", () => {
    const question = asked("b-unloaded");
    expect(jump([tool("a1"), tool("a2"), question, tool("a3"), botText("b-after")], question, true)).toBe("b-unloaded");
    expect(jump([tool("a1"), tool("a2"), question], question, false)).toBeNull();
  });

  it("does nothing for an older record with no stamped turn, even with text just before it", () => {
    const question = ask("q1");
    expect(jump([typed("u0"), botText("b1"), activity("a1"), question], question)).toBeNull();
  });

  it("does nothing when the stamped text is hidden", () => {
    const question = asked("b1");
    expect(jump([typed("u0"), { ...botText("b1"), summarized: true }, question], question)).toBeNull();
  });

  it("targets an older docked question's stamped reply, or its own record when no pin hides it", () => {
    const old = ask("q1", { staysOpen: true, replyId: "b1" });
    const newest = ask("q2", { staysOpen: true });
    const messages = [typed("u0"), botText("b1"), old, newest];
    expect(questionJumpId(messages, old, pinnedQuestion(messages))).toBe("b1");
    expect(questionJumpId(messages, old, null)).toBe("q1");
    expect(questionJumpId(messages, newest, pinnedQuestion(messages))).toBeNull();
    // edited away: the older card sits on a branch the chat no longer shows
    expect(questionJumpId([typed("u2"), botText("b2"), newest], old, null)).toBeNull();
  });
});
