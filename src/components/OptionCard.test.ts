import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { applyLocale } from "@/lib/i18n";
import { StoreProvider, type Message } from "@/state/store";

const msg = (partial: Partial<Message> & Pick<Message, "id" | "kind">): Message => ({
  role: "bot",
  at: 1,
  ...partial,
});

describe("shouldHideOnboardingCard", () => {
  const quiz = msg({
    id: "quiz",
    kind: "options",
    card: {
      title: "What do you mostly want help with?",
      subtitle: "Pick whatever's closest; we can always expand from there.",
      options: ["Work & projects"],
    },
  });

  it("hides a seeded quiz before anyone talks, answered or not", () => {
    expect(shouldHideOnboardingCard(quiz)).toBe(true);
    expect(shouldHideOnboardingCard({ ...quiz, card: { ...quiz.card!, answered: "Work & projects" } })).toBe(true);
    expect(shouldHideOnboardingCard({ ...quiz, card: { ...quiz.card!, dismissed: true } })).toBe(true);
  });

  it("never hides a live permission or question card", () => {
    const ask = msg({
      id: "ask",
      kind: "options",
      card: {
        title: "Approval needed",
        subtitle: "run rm",
        options: ["Allow", "Deny"],
        requestId: "req-1",
        tool: "Bash",
      },
    });
    expect(shouldHideOnboardingCard(ask)).toBe(false);
    const question = msg({
      id: "q",
      kind: "options",
      card: {
        title: "Your bot has a question",
        subtitle: "which file?",
        options: [],
        requestId: "req-2",
      },
    });
    expect(shouldHideOnboardingCard(question)).toBe(false);
  });
});

describe("OptionCard language", () => {
  const firstQuestion = msg({
    id: "first",
    kind: "options",
    card: {
      title: "What do you mostly want help with?",
      subtitle: "Pick whatever's closest; we can always expand from there.",
      options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"],
    },
  });
  const render = (message: Message, locale: "en" | "ko") => {
    const { document } = new Window();
    applyLocale(locale);
    try {
      document.body.innerHTML = renderToStaticMarkup(createElement(StoreProvider, null, createElement(OptionCard, { botId: "bot", message })));
    } finally {
      applyLocale("en");
    }
    return {
      text: document.body.textContent ?? "",
      dismiss: document.querySelector("button[aria-label]")?.getAttribute("aria-label"),
      placeholder: document.querySelector("input")?.getAttribute("placeholder"),
    };
  };

  it("renders nothing for the starter quiz in either language", () => {
    expect(render(firstQuestion, "en").text).toBe("");
    expect(render(firstQuestion, "ko").text).toBe("");
  });

  it("keeps a live question's own text in Korean", () => {
    const question = msg({
      id: "q",
      kind: "options",
      card: { title: "Your bot has a question", subtitle: "which file?", options: ["a.ts", "b.ts"], requestId: "req-2" },
    });
    const text = render(question, "ko").text;
    expect(text).toContain("Your bot has a question");
    expect(text).toContain("which file?");
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
  });
});
