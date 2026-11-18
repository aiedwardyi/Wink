import { expect, it } from "vitest";
import type { Message } from "@/state/store";
import { openQuestion } from "./open-question";
import { anyChatNeedsYou, answerableCard, withPendingCardAnswers } from "./pending-card-answers";

const question = (id: string): Message => ({ id, at: 1, role: "bot", kind: "options", card: { title: "Q", subtitle: id, options: ["Yes", "No"], askUser: true, staysOpen: true } });

it("closes only the pending answer's card without changing the transcript", () => {
  const first = question("first");
  const next = question("next");
  const messages = [first, next];
  const pending = [{ sendId: "send-first", text: "Yes", cardId: first.id }];
  expect(openQuestion(withPendingCardAnswers(messages, pending))).toBe(next);
  expect(answerableCard(messages, messages, first.id, undefined, pending)).toBeUndefined();
  expect(answerableCard(messages, messages, next.id, undefined, pending)).toBe(next);
  expect(first.card?.answered).toBeUndefined();
  expect(messages).toHaveLength(2);
});

it("reopens when the pending send is rejected or the queued chip is cancelled", () => {
  const card = question("card");
  expect(openQuestion(withPendingCardAnswers([card], [], [{ queueId: "held", text: "Yes", answersCard: card.id }]))).toBeNull();
  expect(openQuestion(withPendingCardAnswers([card], [], []))).toBe(card);
});

it("keeps hidden-chat and drawer attention consistent with a pending answer", () => {
  const chats = [{ id: "chat", threadId: "thread", messages: [question("card")] }];
  expect(anyChatNeedsYou(chats)).toBe(true);
  expect(anyChatNeedsYou(chats, undefined, {}, { thread: [{ queueId: "queued", text: "Yes", answersCard: "card" }] })).toBe(false);
  expect(anyChatNeedsYou(chats, undefined, {}, {})).toBe(true);
});

it("does not reuse an inactive answer's pending overlay after an edit fork", () => {
  const card = question("card");
  const landed: Message = { id: "answer", at: 2, role: "user", kind: "text", text: "Yes", sendId: "send-first", answersCard: card.id };
  const pending = [{ sendId: "send-first", text: "Yes", cardId: card.id }];
  expect(openQuestion(withPendingCardAnswers([card], pending, [], [card, landed]))).toBe(card);
});

it("uses a rendered jump card while leaving branch validation to the server", () => {
  const card = question("old");
  expect(answerableCard([], [], card.id, card)).toBe(card);
  expect(answerableCard([card], [], card.id, card)).toBe(card);
  expect(answerableCard([card], [], card.id, undefined)).toBeUndefined();
  expect(answerableCard([], [], card.id, question("different"))).toBeUndefined();
});
