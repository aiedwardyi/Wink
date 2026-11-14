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
const message = (id: string): Message => ({ id, at: 1, role: "bot", kind: "options",
  card: { title: "Question", subtitle: "Which design should we review first?", options: ["Analytics", "Models"], askUser: true, staysOpen: true } });

async function render(id: string) {
  if (!root) {
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  }
  await act(async () => root!.render(createElement(PendingQuestionPanel, { message: message(id), askerName: "Wink", count: 1, onPick, onDismiss })));
}

const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const pill = () => host.querySelector<HTMLButtonElement>('[data-question-row] button[aria-expanded="false"]');
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

afterEach(async () => {
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
});
