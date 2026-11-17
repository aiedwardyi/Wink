// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { PendingQuestionPanel } from "./PendingQuestion";

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
const onPick = vi.fn();
const onDismiss = vi.fn();
const message = (id: string, options = ["Analytics", "Models"]): Message => ({ id, at: 1, role: "bot", kind: "options",
  card: { title: "Question", subtitle: "Which design should we review first?", options, askUser: true, staysOpen: true } });

async function render(id: string, options?: string[]) {
  if (!root) {
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  }
  await act(async () => root!.render(createElement(PendingQuestionPanel, { message: message(id, options), askerName: "Wink", count: 1, onPick, onDismiss })));
}

const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const pill = () => host.querySelector<HTMLButtonElement>('[data-question-row] button[aria-expanded="false"]');
// detail is the click count: 0 for Enter or Space, 1 for a mouse or a tap
const press = (target: Element, detail: number) => act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail })); });
const settle = () => act(() => new Promise((done) => setTimeout(done, 200)));
const open = async () => {
  await act(async () => pill()!.click());
  await settle();
};
const fold = async () => {
  await act(async () => button("Fold question").click());
  await settle();
};

async function swipe(dx: number, dy: number, scrollTop = 0) {
  const target = host.querySelector<HTMLDivElement>('[tabindex="0"]')!;
  target.scrollTop = scrollTop;
  const touch = (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : [{ clientX: x, clientY: y }] },
      changedTouches: { value: [{ clientX: x, clientY: y }] } });
    target.dispatchEvent(event);
  };
  await act(async () => { touch("touchstart", 100, 100); touch("touchend", 100 + dx, 100 + dy); });
}

// Tailwind spacing in px: n * 4, or an arbitrary [npx]
const size = (cls: string, name: string, variant = "") => {
  const found = cls.match(new RegExp(`(?:^| )${variant}(-?)${name}-(?:\\[(\\d+)px\\]|([\\d.]+))(?= |$)`));
  return found ? (found[1] ? -1 : 1) * (found[2] ? Number(found[2]) : Number(found[3]) * 4) : 0;
};

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  onPick.mockClear();
  onDismiss.mockClear();
  applyLocale("en");
});

describe("question folding", () => {
  it("arrives as the full card, folds to the row and opens again without answering or dismissing", async () => {
    await render("fold-chevron");
    expect(pill()).toBeNull();
    expect(host.querySelector("[data-term-choices]")?.textContent).toContain("Analytics");
    await act(async () => button("Fold question").click());
    expect(pill()?.textContent).toContain("Wink asks");
    expect(pill()?.textContent).toContain("Which design");
    expect(pill()?.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[data-fold="closing"]')?.textContent).toContain("Analytics");
    await settle();
    expect(host.querySelector("[data-term-choices]")).toBeNull();
    await open();
    expect(pill()).toBeNull();
    expect(host.querySelector("[data-term-choices]")?.textContent).toContain("Analytics");
    expect(onPick).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps each card's fold after switching chats and remounting", async () => {
    await render("fold-kept");
    await fold();
    await render("fold-other");
    await settle();
    expect(pill()).toBeNull();
    await act(async () => root!.unmount());
    host.remove();
    root = undefined;
    await render("fold-kept");
    expect(pill()).not.toBeNull();
  });

  it("folds on a downward swipe", async () => {
    await render("fold-swipe");
    await swipe(5, 75);
    expect(pill()).not.toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("leaves sideways, upward and text-scrolling gestures alone", async () => {
    await render("fold-scroll");
    await swipe(80, 10);
    expect(pill()).toBeNull();
    await swipe(0, -80);
    expect(pill()).toBeNull();
    await swipe(0, 80, 25);
    expect(pill()).toBeNull();
  });

  it("looks the same folded and open: one frame, one label, one chip and one pair of controls", async () => {
    const look = (el: Element | null | undefined) => [...(el?.classList ?? [])].filter((name) => /^(rounded|border|bg-|text-\[|text-(ink|accent)|font-|tracking|uppercase|hover:)/.test(name)).sort();
    const label = (scope: Element) => [...scope.querySelectorAll("*")].find((el) => !el.childElementCount && el.textContent === "Wink asks");
    const chip = (scope: Element) => [...scope.querySelectorAll("button")].find((el) => el.textContent === "Analytics");
    const controls = (scope: Element) => [...scope.querySelectorAll("button")].filter((el) => el.querySelector("svg") && !el.textContent).slice(-2).map((el) => el.className);
    // the count badge sits in front of the label, at a count of one too
    const badge = (scope: Element) => {
      const found = [...scope.querySelectorAll("span")].find((el) => !el.childElementCount && el.textContent === "1");
      return found && label(scope)!.compareDocumentPosition(found) & Node.DOCUMENT_POSITION_PRECEDING ? look(found) : [];
    };
    const parts = (scope: Element) => ({ frame: look(scope), fill: look(scope.firstElementChild), badge: badge(scope), label: look(label(scope)), chip: look(chip(scope)), controls: controls(scope) });
    await render("one-look");
    const open = parts(host.querySelector('[role="region"]')!);
    await fold();
    const folded = parts(host.querySelector("[data-question-row]")!);
    expect(open.frame.length).toBeGreaterThan(0);
    expect(open.badge).toContain("bg-accent");
    expect(open.label.length).toBeGreaterThan(0);
    expect(folded.chip).toContain("text-[13px]");
    expect(open.controls).toHaveLength(2);
    expect(folded).toEqual(open);
  });

  it("gives the chevron and x 44px touch targets at 392 that split their gap and never overlap", async () => {
    const ICON = 14;
    const FRAME_PAD = 16;
    const boxes = (scope: Element) => {
      const [chevron, x] = [...scope.querySelectorAll("button")].filter((el) => el.querySelector("svg") && !el.textContent).slice(-2);
      const gap = size(x.parentElement!.className, "gap");
      // laid out from the right edge of a 392px frame's padding box, as flex puts them
      const xRight = 392 - FRAME_PAD - size(x.className, "mr");
      const box = (button: HTMLButtonElement, right: number) => {
        const width = ICON + 2 * size(button.className, "p");
        const after = (side: string) => -size(button.className, side, "pointer-coarse:after:");
        return { buttonLeft: right - width, buttonRight: right, left: right - width - after("left"), right: right + after("right"), height: width + 2 * after("inset-y") };
      };
      const xBox = box(x, xRight);
      return { chevron: box(chevron, xBox.buttonLeft - gap), x: xBox, gap };
    };
    await render("hit-boxes");
    const open = boxes(host.querySelector('[role="region"]')!);
    await fold();
    const folded = boxes(host.querySelector("[data-question-row]")!);
    expect(folded).toEqual(open);
    const { chevron, x, gap } = open;
    expect(chevron.height).toBeGreaterThanOrEqual(44);
    expect(x.height).toBeGreaterThanOrEqual(44);
    expect(chevron.right).toBeLessThanOrEqual(x.left);
    expect(chevron.right - chevron.buttonRight).toBe(gap / 2);
    expect(x.buttonLeft - x.left).toBe(gap / 2);
    expect(x.right).toBeLessThanOrEqual(392);
  });

  it("draws the card's choices as pills of one height on desktop and phone, a 1-letter one wider than tall", async () => {
    // happy-dom has no layout: a 13px glyph is at most 13px wide, a line 20px tall, the border 2px
    const box = (choice: HTMLButtonElement, coarse: boolean) => {
      const cls = choice.className;
      const height = Math.max(2 + 2 * size(cls, "py") + (size(cls, "leading") || 20), coarse ? size(cls, "min-h", "pointer-coarse:") : 0);
      const width = Math.max(2 + 2 * size(cls, "px") + Math.max(13, 8 * choice.textContent!.length), size(cls, "min-w"));
      return { width, height, target: height - 2 * (coarse ? size(cls, "inset-y", "pointer-coarse:after:") : 0) };
    };
    await render("choice-pills", ["A", "Neither", "Keep both for now"]);
    const choices = [...host.querySelectorAll<HTMLButtonElement>("[data-term-choices] button")];
    const list = choices[0].parentElement!.className;
    const [desktop, phone] = [false, true].map((coarse) => choices.map((choice) => box(choice, coarse)));
    for (const [letter, word, words] of [desktop, phone]) {
      expect(letter.width).toBeGreaterThan(letter.height);
      expect([word.height, words.height]).toEqual([letter.height, letter.height]);
    }
    expect(phone.map(({ height }) => height)).toEqual(desktop.map(({ height }) => height));
    // the phone's 44px target reaches past the pill only into half the gap to the next row
    expect(phone[0].target).toBeGreaterThanOrEqual(44);
    expect(phone[0].target - phone[0].height).toBeLessThanOrEqual(size(list, "gap-y", "pointer-coarse:") || size(list, "gap"));
    expect(choices.every((choice) => choice.classList.contains("text-center"))).toBe(true);
  });

  it("localizes folding and reopening in Korean", async () => {
    applyLocale("ko");
    await render("fold-korean");
    await act(async () => button("질문 접기").click());
    await settle();
    expect(pill()?.getAttribute("aria-label")).toContain("질문 펼치기");
    expect(pill()?.textContent).toContain("Wink");
    expect(button("질문 숨기기")).not.toBeNull();
    expect(host.querySelector("[data-row-choices]")?.textContent).toContain("Analytics");
    await open();
    expect(pill()).toBeNull();
  });

  it("counts every choice the row has no room for in one +N pill that opens the card", async () => {
    // happy-dom has no layout: each shown pill is 100px wide in a 250px space
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches("[data-row-choices]") ? this.querySelectorAll("button:not([hidden])").length * 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches("[data-row-choices]") ? 250 : 0;
    });
    const options = ["Yes, both", "Only the open speed", "Change it"];
    await render("fold-more", options);
    await fold();
    const pills = [...host.querySelectorAll<HTMLButtonElement>("[data-row-choices] button")].filter((pill) => !pill.hidden);
    const more = pills.find((pill) => /^\+\d+$/.test(pill.textContent ?? ""));
    const shown = pills.filter((pill) => pill !== more).map((pill) => pill.textContent);
    expect(shown).toEqual(["Yes, both"]);
    expect(more?.textContent).toBe("+2");
    expect(more?.getAttribute("aria-label")).toBe("2 more choices");
    expect(more?.className).toBe(pills[0].className);
    await press(more!, 1);
    await settle();
    expect(pill()).toBeNull();
    expect([...host.querySelectorAll("[data-term-choices] button")].map((choice) => choice.textContent)).toEqual(options);
    expect(onPick).not.toHaveBeenCalled();
  });

  it.each([["en", "1 more choice"], ["ko", "선택지 1개 더 보기"]] as const)("names one cut choice in the singular in %s", async (locale, label) => {
    applyLocale(locale);
    // the +N pill is narrower than a choice, so cutting one choice makes room
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.matches("[data-row-choices]")) return 0;
      return [...this.querySelectorAll("button:not([hidden])")].reduce((width, chip) => width + (chip.textContent?.startsWith("+") ? 40 : 100), 0);
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.matches("[data-row-choices]") ? 250 : 0;
    });
    await render(`fold-one-more-${locale}`, ["Yes, both", "Only the open speed", "Change it"]);
    await act(async () => button(locale === "ko" ? "질문 접기" : "Fold question").click());
    await settle();
    const more = [...host.querySelectorAll<HTMLButtonElement>("[data-row-choices] button")].find((chip) => !chip.hidden && chip.textContent === "+1");
    expect(more?.getAttribute("aria-label")).toBe(label);
    expect(more?.title).toBe(label);
  });

  it("shows no +N pill when every choice fits", async () => {
    await render("fold-all-fit", ["Yes, both", "Only the open speed", "Change it"]);
    await fold();
    const pills = [...host.querySelectorAll<HTMLButtonElement>("[data-row-choices] button")].filter((pill) => !pill.hidden);
    expect(pills.map((pill) => pill.textContent)).toEqual(["Yes, both", "Only the open speed", "Change it"]);
  });

  it("moves focus between the row and the card only for the keyboard, so a click never inherits a focus ring", async () => {
    await render("fold-focus");
    await press(button("Fold question"), 1);
    await settle();
    expect(document.activeElement).not.toBe(pill());
    await press(pill()!, 1);
    await settle();
    expect(document.activeElement).not.toBe(button("Fold question"));
    await press(button("Fold question"), 0);
    await settle();
    expect(document.activeElement).toBe(pill());
    await press(pill()!, 0);
    await settle();
    expect(document.activeElement).toBe(button("Fold question"));
  });
});
