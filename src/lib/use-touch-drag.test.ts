// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { hapticTick } from "./phone-swipe";
import { LONG_PRESS_MS, useTouchDrag, type TouchDragHandlers } from "./use-touch-drag";

vi.mock("./phone-swipe", () => ({ hapticTick: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function List({ handlers }: { handlers: TouchDragHandlers }) {
  const ref = useTouchDrag("[data-row]", "[data-row]", handlers);
  return createElement("div", { ref }, createElement("div", { "data-row": true }));
}

it("keeps lift-on-hold and release contextmenu for lists without a hold menu", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const handlers: TouchDragHandlers = { lift: (row) => row, over: () => null, drop: vi.fn(), cancel: vi.fn() };
  try {
    await act(async () => root.render(createElement(List, { handlers })));
    const row = host.querySelector<HTMLElement>("[data-row]")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => row });
    const menu = vi.fn();
    row.addEventListener("contextmenu", menu);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const start = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(start, "touches", { value: [{ clientX: 100, clientY: 100 }] });
    await act(async () => row.dispatchEvent(start));
    await act(async () => void vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(row.hasAttribute("data-touch-lifted")).toBe(true);
    expect(hapticTick).toHaveBeenCalledTimes(1);
    expect(menu).not.toHaveBeenCalled();
    const end = new Event("touchend", { bubbles: true, cancelable: true });
    await act(async () => row.dispatchEvent(end));
    expect(end.defaultPrevented).toBe(true);
    expect(row.hasAttribute("data-touch-lifted")).toBe(false);
    expect(menu).toHaveBeenCalledTimes(1);
    expect(handlers.cancel).toHaveBeenCalledTimes(1);
    expect(handlers.drop).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
