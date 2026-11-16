// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SWIPE_MOTION_MS } from "./phone-swipe";
import { useBubbleSwipe } from "./use-bubble-swipe";

const onReply = vi.fn();
const onTranslate = vi.fn();
const click = vi.fn();
const vibrate = vi.fn();
let host: HTMLDivElement;
let root: Root;
let phone: boolean;
let reduced: boolean;
let time: number;
const row = () => host.querySelector<HTMLElement>("[data-row]")!;
const bubble = () => host.querySelector<HTMLElement>("[data-bubble]")!;

function Harness({ canReply = true, canTranslate = true }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  useBubbleSwipe({ row: rowRef, bubble: bubbleRef, canReply, canTranslate, onReply, onTranslate });
  return createElement("div", { "data-swipe-list": true }, createElement("div", { ref: rowRef, "data-row": true },
    createElement("div", { ref: bubbleRef, "data-bubble": true },
      createElement("p", null, "hello"),
      createElement("a", { href: "#x", onClick: click }, "file"),
      createElement("pre", null, "code"),
      createElement("div", { "data-no-swipe": true }, createElement("span", null, "inner")),
    ),
  ));
}

function touch(type: string, x: number, y = 200, target: Element = bubble().querySelector("p")!, dt = 16, count = 1) {
  time += dt;
  const event = new Event(type, { bubbles: true, cancelable: true });
  const points = Array.from({ length: count }, (_, i) => ({ clientX: x + i * 40, clientY: y }));
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : points },
    timeStamp: { value: time },
  });
  target.dispatchEvent(event);
  return event;
}

async function drag(from: number, ...to: number[]) {
  await act(async () => {
    touch("touchstart", from);
    for (const x of to) touch("touchmove", x);
  });
}
const lift = () => act(async () => { touch("touchend", 0); vi.advanceTimersByTime(SWIPE_MOTION_MS); });

async function render(props = {}) {
  await act(async () => root.render(createElement(Harness, props)));
}

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  phone = true;
  reduced = false;
  time = 0;
  setWidth(392);
  [onReply, onTranslate, click, vibrate].forEach((fn) => fn.mockReset());
  Object.defineProperty(window.navigator, "vibrate", { configurable: true, value: vibrate });
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query.includes("reduced-motion") ? reduced : query.includes("max-width") ? phone : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaQueryList));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe.each([360, 392])("bubble swipe at %i px", (width) => {
  beforeEach(() => setWidth(width));

  it("right past 56 px replies once on release", async () => {
    await render();
    await drag(100, 130, 170);
    expect(bubble().style.transform).toBe("translateX(65.8px)");
    await lift();
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it("left past 56 px translates once on release", async () => {
    await render();
    await drag(300, 270, 230);
    await lift();
    expect(onTranslate).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
  });

  it("a start inside 24 px of either edge does nothing", async () => {
    await render();
    for (const [from, to] of [[20, 140], [width - 20, width - 140]]) {
      await drag(from, from + Math.sign(to - from) * 20, to);
      await lift();
    }
    expect(onReply).not.toHaveBeenCalled();
    expect(onTranslate).not.toHaveBeenCalled();
    expect(bubble().style.transform).toBe("");
  });
});

describe("bubble swipe rules", () => {
  it("a flick short of 56 px does nothing and springs back", async () => {
    await render();
    await drag(100, 120, 150);
    expect(bubble().style.transform).toBe("translateX(50px)");
    await lift();
    expect(onReply).not.toHaveBeenCalled();
    expect(bubble().style.transform).toBe("");
  });

  it("follows 1:1 to 64 px, then 0.3x, and stops at 96 px", async () => {
    await render();
    await drag(100, 130, 164);
    expect(bubble().style.transform).toBe("translateX(64px)");
    await drag(100, 130, 400);
    expect(bubble().style.transform).toBe("translateX(96px)");
  });

  it("a tie goes to scrolling and a vertical lock ignores later sideways movement", async () => {
    await render();
    await act(async () => {
      touch("touchstart", 100, 200);
      touch("touchmove", 112, 212);
      touch("touchmove", 220, 215);
    });
    expect(bubble().style.transform).toBe("");
    await lift();
    expect(bubble().style.transform).toBe("");
    expect(onReply).not.toHaveBeenCalled();
  });

  it("a mostly vertical drag scrolls", async () => {
    await render();
    await act(async () => {
      touch("touchstart", 100, 200);
      touch("touchmove", 108, 260);
      touch("touchmove", 190, 300);
    });
    await lift();
    expect(onReply).not.toHaveBeenCalled();
    expect(bubble().style.transform).toBe("");
  });

  it("rows get touch-action pan-y on a phone", async () => {
    await render();
    expect(row().style.touchAction).toBe("pan-y");
  });

  it("ticks once per arm, and again after disarming", async () => {
    await render();
    await drag(100, 130, 160, 175, 190);
    expect(vibrate).toHaveBeenCalledTimes(1);
    await act(async () => { touch("touchmove", 120); });
    expect(row().dataset.armed).toBeUndefined();
    await act(async () => { touch("touchmove", 165); });
    expect(vibrate).toHaveBeenCalledTimes(2);
    expect(row().dataset.armed).toBe("right");
  });

  it("release after disarming does nothing", async () => {
    await render();
    await drag(100, 160, 130);
    await lift();
    expect(onReply).not.toHaveBeenCalled();
  });

  it("left does nothing on a line without translate, and right does nothing without reply", async () => {
    await render({ canTranslate: false });
    await drag(300, 270, 200);
    expect(bubble().style.transform).toBe("");
    await lift();
    expect(onTranslate).not.toHaveBeenCalled();
    await render({ canReply: false, canTranslate: true });
    await drag(100, 130, 200);
    await lift();
    expect(onReply).not.toHaveBeenCalled();
  });

  it.each([
    ["text is selected", () => {
      const range = document.createRange();
      range.selectNodeContents(bubble().querySelector("p")!);
      window.getSelection()!.addRange(range);
    }, undefined],
    ["it starts in a code block", () => {}, "pre"],
    ["it starts in a no-swipe region", () => {}, "[data-no-swipe] span"],
  ])("does nothing when %s", async (_name, setup, selector) => {
    await render();
    setup();
    const target = selector ? bubble().querySelector(selector)! : undefined;
    await act(async () => {
      touch("touchstart", 100, 200, target);
      touch("touchmove", 140, 200, target);
      touch("touchmove", 200, 200, target);
    });
    await lift();
    expect(onReply).not.toHaveBeenCalled();
    expect(bubble().style.transform).toBe("");
  });

  it("does nothing while a menu is open", async () => {
    await render();
    await act(async () => { window.dispatchEvent(new CustomEvent("orbit:message-menu", { detail: true })); });
    await drag(100, 140, 200);
    await lift();
    expect(onReply).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new CustomEvent("orbit:message-menu", { detail: false })); });
    await drag(100, 140, 200);
    await lift();
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it("a menu opening mid-drag cancels it", async () => {
    await render();
    await drag(100, 140);
    await act(async () => { window.dispatchEvent(new CustomEvent("orbit:message-menu", { detail: true })); });
    await act(async () => { touch("touchmove", 200); });
    await lift();
    expect(onReply).not.toHaveBeenCalled();
    expect(bubble().style.transform).toBe("");
    await act(async () => { window.dispatchEvent(new CustomEvent("orbit:message-menu", { detail: false })); });
  });

  it("a second finger cancels the swipe", async () => {
    await render();
    await drag(100, 140);
    await act(async () => { touch("touchmove", 200, 200, undefined, 16, 2); });
    await lift();
    expect(onReply).not.toHaveBeenCalled();
    expect(bubble().style.transform).toBe("");
    await act(async () => { touch("touchstart", 100, 200, undefined, 16, 2); touch("touchmove", 200, 200, undefined, 16, 2); });
    await lift();
    expect(onReply).not.toHaveBeenCalled();
  });

  it("springs back over 260 ms and swallows the click after a sideways drag", async () => {
    await render();
    const animate = vi.fn(() => ({ finished: Promise.resolve() }));
    bubble().animate = animate as unknown as HTMLElement["animate"];
    await drag(100, 130, 200);
    await act(async () => { touch("touchend", 0); });
    expect(bubble().style.transform).toBe("");
    expect(animate).toHaveBeenCalledWith(
      [{ transform: "translateX(74.8px)" }, { transform: "translateX(0)" }],
      { duration: SWIPE_MOTION_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    await act(async () => { bubble().querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    expect(click).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(500); });
    await act(async () => { bubble().querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("a new touch cancels the running spring", async () => {
    await render();
    const cancel = vi.fn();
    bubble().animate = vi.fn(() => ({ cancel, finished: Promise.resolve() })) as unknown as HTMLElement["animate"];
    await drag(100, 130, 200);
    await act(async () => { touch("touchend", 0); });
    await act(async () => { touch("touchstart", 100); });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("a tap right after a drag is not swallowed", async () => {
    await render();
    await drag(100, 130, 200);
    await act(async () => { touch("touchend", 0); });
    await act(async () => { touch("touchstart", 100); touch("touchend", 0); });
    await act(async () => { bubble().querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("decides on the lift position, not the last move", async () => {
    await render();
    await drag(100, 130, 140);
    await act(async () => { touch("touchend", 0); });
    expect(onReply).not.toHaveBeenCalled();
    await drag(100, 130, 200);
    await act(async () => {
      const end = new Event("touchend", { bubbles: true, cancelable: true });
      Object.defineProperties(end, { touches: { value: [] }, changedTouches: { value: [{ clientX: 120, clientY: 200 }] }, timeStamp: { value: 9999 } });
      bubble().querySelector("p")!.dispatchEvent(end);
    });
    expect(onReply).not.toHaveBeenCalled();
    await drag(100, 130, 140);
    await act(async () => {
      const end = new Event("touchend", { bubbles: true, cancelable: true });
      Object.defineProperties(end, { touches: { value: [] }, changedTouches: { value: [{ clientX: 200, clientY: 200 }] }, timeStamp: { value: 10000 } });
      bubble().querySelector("p")!.dispatchEvent(end);
    });
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it("a plain tap is not swallowed", async () => {
    await render();
    await act(async () => { touch("touchstart", 100); touch("touchend", 0); });
    await act(async () => { bubble().querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("reduced motion keeps the bubble still, still marks the threshold, fires on release and never ticks", async () => {
    reduced = true;
    await render();
    await drag(100, 130, 170);
    expect(bubble().style.transform).toBe("");
    expect(row().dataset.swipe).toBe("right");
    expect(row().dataset.armed).toBe("right");
    await lift();
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("attaches nothing at desktop width", async () => {
    phone = false;
    setWidth(1280);
    const add = vi.spyOn(HTMLElement.prototype, "addEventListener");
    await render();
    expect(add.mock.calls.filter(([type]) => String(type).startsWith("touch") || type === "click")).toEqual([]);
    expect(row().style.touchAction).toBe("");
    await drag(100, 140, 200);
    await lift();
    expect(onReply).not.toHaveBeenCalled();
    expect(bubble().style.transform).toBe("");
  });
});
