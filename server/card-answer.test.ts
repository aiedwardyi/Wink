import { expect, it } from "vitest";
import { canReceiveCardAnswer } from "./card-answer.ts";
import type { Message } from "./store.ts";

const question: Message = { id: "q", at: 1, role: "bot", kind: "options", card: { title: "Q", subtitle: "Which region?", options: ["Seoul", "Tokyo"], askUser: true, staysOpen: true } };

it("rejects another answer once the card was answered, regardless of action time", () => {
  const reply: Message = { id: "typed", at: 300, actedAt: 200, role: "user", kind: "text", text: "Tokyo", answersCard: "q" };
  expect(canReceiveCardAnswer([question, reply], "q", "Seoul", 100)).toBe(false);
  expect(canReceiveCardAnswer([question, reply], "q", "Seoul", 400)).toBe(false);
});

it("receives a tap made before a question was superseded", () => {
  const first = { ...question, card: { ...question.card!, staysOpen: undefined } };
  const newer = { ...question, id: "next", at: 300, card: { ...question.card!, subtitle: "Which plan?" } };
  expect(canReceiveCardAnswer([first, newer], "q", "Seoul", 100)).toBe(true);
  expect(canReceiveCardAnswer([first, newer], "q", "Seoul", 400)).toBe(false);
  const later = { ...newer, id: "latest", at: 500 };
  expect(canReceiveCardAnswer([first, newer, later], "q", "Seoul", 400)).toBe(false);
});

it("never receives an unavailable, native or dismissed question", () => {
  expect(canReceiveCardAnswer([], "q", "Seoul", 100)).toBe(false);
  expect(canReceiveCardAnswer([{ ...question, card: { ...question.card!, requestId: "native" } }], "q", "Seoul", 100)).toBe(false);
  expect(canReceiveCardAnswer([{ ...question, card: { ...question.card!, dismissed: true } }], "q", "Seoul", 100)).toBe(false);
});
