// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { SWIPE_MOTION_MS, SWIPE_SPRING } from "@/lib/phone-swipe";

import { DockCard } from "./DockCard";

let host: HTMLDivElement;
let root: Root;

const screen = (phone: boolean, reduce = false) => vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: (phone && query.includes("max-width")) || (reduce && query.includes("reduce")), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
const render = (open: boolean, props: { id?: string; onDismiss?: () => void } = {}) =>
  act(async () => root.render(createElement(DockCard, { open, ...props, children: open ? createElement("p", null, props.id ?? "Question") : null })));
const dock = () => host.querySelector<HTMLElement>("[data-dock-card]");
// a finger pulled straight down, lifting where it stopped unless it holds on
const pull = (target: Element, dy: number, ms = 200, hold = false) => act(async () => {
  for (const [type, y, at] of [["touchstart", 100, 0], ["touchmove", 100 + dy, ms / 2], ...hold ? [] : [["touchend", 100 + dy, ms] as const]] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: type === "touchend" ? [] : [{ clientX: 100, clientY: y }] },
      changedTouches: { value: [{ clientX: 100, clientY: y }] },
      timeStamp: { value: at },
    });
    target.dispatchEvent(event);
  }
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows at once when open at mount and pops in when it opens later on a phone", async () => {
  screen(true);
  await render(true);
  expect(dock()!.className).not.toContain("animate-pop-in");
  await render(false);
  await vi.waitFor(() => expect(dock()).toBeNull());
  await render(true);
  expect(dock()!.className).toContain("animate-pop-in");
});

it("keeps its last card for the closing fade on a phone, then unmounts", async () => {
  screen(true);
  await render(true);
  await render(false);
  expect(dock()!.hasAttribute("data-closing")).toBe(true);
  expect(dock()!.hasAttribute("inert")).toBe(true);
  expect(dock()!.textContent).toBe("Question");
  await vi.waitFor(() => expect(dock()).toBeNull());
});

it("opens and closes at once on desktop", async () => {
  screen(false);
  await render(false);
  await render(true);
  expect(dock()!.className).toBe("");
  await render(false);
  expect(dock()).toBeNull();
});

it("closes at once with reduced motion", async () => {
  screen(true, true);
  await render(true);
  await render(false);
  expect(dock()).toBeNull();
});

it("rides the finger over the message box, out of the tray's clip, while it is dragged", async () => {
  screen(true);
  await render(true, { onDismiss: vi.fn() });
  await pull(dock()!, 80, 200, true);
  expect(dock()!.style.translate).toBe("0 80px");
  expect(dock()!.hasAttribute("data-sheet-moving")).toBe(true);
  const motion = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../motion.css"), "utf8");
  expect(motion).toMatch(/\[data-composer-tray\]:has\(\[data-dock-card\]\[data-sheet-moving\]\) \{\s*overflow: visible;/);
  expect(motion).toMatch(/\[data-dock-card\]\[data-sheet-moving\] \{\s*position: relative;\s*z-index: 1;/);
});

it("glides off the screen on the chat pages' spring before a swipe closes it, and the next card shows at rest", async () => {
  screen(true);
  const onDismiss = vi.fn();
  await render(true, { id: "a", onDismiss });
  await pull(dock()!, 200);
  expect(onDismiss).not.toHaveBeenCalled();
  expect(dock()!.style.transition).toBe(`translate ${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`);
  expect(dock()!.style.translate).toBe(`0 ${200 + window.innerHeight}px`);
  await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  await render(true, { id: "b", onDismiss });
  expect(dock()!.style.translate).toBe("");
  expect(dock()!.hasAttribute("data-sheet-moving")).toBe(false);
});

it("dismisses the card that was swiped when the next one takes its place mid-glide, and ignores a touch meanwhile", async () => {
  screen(true);
  const first = vi.fn();
  const next = vi.fn();
  await render(true, { id: "a", onDismiss: first });
  await pull(dock()!, 200);
  await render(true, { id: "b", onDismiss: next });
  await pull(dock()!, 200, 200, true);
  expect(dock()!.style.translate).toBe("");
  await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
  expect(next).not.toHaveBeenCalled();
});

it("catches a spring back where it is when the finger comes down again", async () => {
  screen(true);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
  await render(true, { onDismiss: vi.fn() });
  await pull(dock()!, 60, 600);
  expect(dock()!.style.translate).toBe("0 0");
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) => el === dock() ? new Proxy(computed(el), { get: (style, key) => key === "translate" ? "0px 30px" : style.getPropertyValue(String(key)) }) : computed(el));
  await pull(dock()!, 10, 200, true);
  expect(dock()!.style.transition).toBe("");
  expect(dock()!.style.translate).toBe("0 40px");
});

it("springs back from a short slow pull", async () => {
  screen(true);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
  const onDismiss = vi.fn();
  await render(true, { onDismiss });
  await pull(dock()!, 60, 600);
  expect(onDismiss).not.toHaveBeenCalled();
  expect(dock()!.style.translate).toBe("0 0");
});

it("springs back to rest when a second finger comes down mid-drag", async () => {
  screen(true);
  const onDismiss = vi.fn();
  await render(true, { onDismiss });
  await pull(dock()!, 80, 200, true);
  await act(async () => {
    const event = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperties(event, { touches: { value: [{ clientX: 100, clientY: 180 }, { clientX: 200, clientY: 180 }] }, timeStamp: { value: 250 } });
    dock()!.dispatchEvent(event);
  });
  expect(dock()!.style.transition).toBe(`translate ${SWIPE_MOTION_MS}ms ${SWIPE_SPRING}`);
  expect(dock()!.style.translate).toBe("0 0");
  await vi.waitFor(() => expect(dock()!.hasAttribute("data-sheet-moving")).toBe(false));
  expect(dock()!.style.translate).toBe("");
  expect(onDismiss).not.toHaveBeenCalled();
});

it("never swipes without onDismiss", async () => {
  screen(true);
  await render(true);
  await pull(dock()!, 200);
  expect(dock()!.style.translate).toBe("");
});

it("never swipes on desktop", async () => {
  screen(false);
  const onDismiss = vi.fn();
  await render(true, { onDismiss });
  await pull(dock()!, 200);
  expect(onDismiss).not.toHaveBeenCalled();
});
