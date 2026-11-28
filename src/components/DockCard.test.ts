// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DockCard } from "./DockCard";

let host: HTMLDivElement;
let root: Root;

const screen = (phone: boolean, reduce = false) => vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: (phone && query.includes("max-width")) || (reduce && query.includes("reduce")), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
const render = (open: boolean, props: { id?: string; onDismiss?: () => void } = {}) =>
  act(async () => root.render(createElement(DockCard, { open, ...props, children: open ? createElement("p", null, props.id ?? "Question") : null })));
const dock = () => host.querySelector<HTMLElement>("[data-dock-card]");
// a finger pulled straight down, lifting where it stopped
const pull = (target: Element, dy: number, ms = 200) => act(async () => {
  for (const [type, y, at] of [["touchstart", 100, 0], ["touchmove", 100 + dy, ms / 2], ["touchend", 100 + dy, ms]] as const) {
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

it("closes on a swipe down from where the finger let go, and the next card shows at rest", async () => {
  screen(true);
  const onDismiss = vi.fn();
  await render(true, { id: "a", onDismiss });
  await pull(dock()!, 200);
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(dock()!.style.translate).toBe("0 200px");
  await render(true, { id: "b", onDismiss });
  expect(dock()!.style.translate).toBe("");
});

it("fades out from where the finger let go when the swipe closes it", async () => {
  screen(true);
  const onDismiss = vi.fn();
  await render(true, { id: "a", onDismiss });
  await pull(dock()!, 200);
  await render(false);
  expect(dock()!.hasAttribute("data-closing")).toBe(true);
  expect(dock()!.style.translate).toBe("0 200px");
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
