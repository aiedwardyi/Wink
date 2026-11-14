// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWIPE_MOTION_MS } from "./phone-swipe";
import { paneSwipeTarget, usePaneSwipe, type PaneTab } from "./use-pane-swipe";

const tabs: PaneTab[] = ["show", "media", "check", "map"];
const choose = vi.fn();
const close = vi.fn();
let host: HTMLElement;
let root: Root;
let time = 0;
let reduced = false;
const panel = () => host.querySelector<HTMLElement>("aside")!;
const page = () => host.querySelector<HTMLElement>('[data-pane-page="current"]')!;

function Harness({ tab = "show", phone = true, closing = false, order = tabs, threadId = "t1" }: { tab?: PaneTab; phone?: boolean; closing?: boolean; order?: PaneTab[]; threadId?: string }) {
  const ref = useRef<HTMLElement>(null);
  const swipe = usePaneSwipe(ref, phone && !closing, tab, order, choose, close, threadId);
  return createElement("aside", { ref, "data-highlight": swipe.highlight },
    createElement("header", { className: "show-pane-head" }, "Tabs"),
    createElement("div", { "data-pane-page": "current", "data-pane-current": true },
      createElement("p", null, "Content"),
      createElement("div", { className: "map-pane" }, createElement("canvas")),
      createElement("pre", null, "Code"),
      createElement("input"),
      createElement("div", { "data-no-swipe": true }),
      createElement("div", { "data-horizontal": true, style: { overflowX: "auto" } }),
      tab === "media" && createElement("div", { "data-media-kinds": true },
        createElement("button", { "data-media-kind": "photos", "aria-selected": true }),
        createElement("button", { "data-media-kind": "files", "aria-selected": false }),
      ),
    ),
    swipe.preview && createElement("div", { "data-pane-page": "preview", "data-pane-preview": true }, swipe.preview.tab),
  );
}

function touch(type: string, x: number, y = 200, target: Element = page(), dt = 200, fingers = 1) {
  time += dt;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : Array.from({ length: fingers }, () => ({ clientX: x, clientY: y })) },
    timeStamp: { value: time },
  });
  act(() => target.dispatchEvent(event));
  return event;
}

const render = (props = {}) => act(async () => root.render(createElement(Harness, props)));
const settle = () => act(async () => vi.advanceTimersByTime(SWIPE_MOTION_MS));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 392);
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation(query => {
    const media = matchMedia(query);
    Object.defineProperty(media, "matches", { get: () => query.includes("reduced-motion") ? reduced : true });
    return media;
  });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  time = 0;
  reduced = false;
  choose.mockReset();
  close.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pane neighbors", () => {
  it("uses visible tab order and stops at the ends", () => {
    expect(paneSwipeTarget(tabs, "show", 1)).toEqual({ tab: "media" });
    expect(paneSwipeTarget(tabs, "media", 1)).toEqual({ tab: "check" });
    expect(paneSwipeTarget(tabs, "check", 1)).toEqual({ tab: "map" });
    expect(paneSwipeTarget(tabs, "map", 1)).toBeNull();
    expect(paneSwipeTarget(tabs, "show", -1)).toBeNull();
    expect(paneSwipeTarget(["media", "map"], "media", 1)).toEqual({ tab: "map" });
  });

  it("visits the neighboring Media kind before leaving Media", () => {
    expect(paneSwipeTarget(tabs, "media", 1, "photos", true)).toEqual({ tab: "media", kind: "files" });
    expect(paneSwipeTarget(tabs, "media", -1, "files", true)).toEqual({ tab: "media", kind: "photos" });
    expect(paneSwipeTarget(tabs, "media", 1, "files", true)).toEqual({ tab: "check" });
    expect(paneSwipeTarget(tabs, "media", -1, "photos", true)).toEqual({ tab: "show" });
    expect(paneSwipeTarget(tabs, "media", 1, "photos", false)).toEqual({ tab: "check" });
  });
});

describe("pane swipe", () => {
  it("follows the finger, previews the neighbor and commits after settling", async () => {
    await render();
    touch("touchstart", 350);
    touch("touchmove", 100, 200, page(), 2000);
    expect(page().style.transform).toBe("translate3d(-250px, 0, 0)");
    expect(host.querySelector('[data-pane-page="preview"]')).not.toBeNull();
    touch("touchend", 100);
    expect(choose).not.toHaveBeenCalled();
    await settle();
    expect(choose).toHaveBeenCalledWith({ tab: "media" });
    expect(close).not.toHaveBeenCalled();
  });

  it("springs a short release back and rubber-bands at the last tab", async () => {
    await render({ tab: "map" });
    touch("touchstart", 200);
    touch("touchmove", 170, 200, page(), 2000);
    expect(page().style.transform).toBe("translate3d(-10px, 0, 0)");
    touch("touchend", 170);
    await settle();
    expect(page().style.transform).toBe("");
    expect(choose).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("marks the destination on release before the page animation ends", async () => {
    await render();
    touch("touchstart", 350);
    touch("touchmove", 200, 200, page(), 2000);
    expect(panel().getAttribute("data-highlight")).toBeNull();
    touch("touchend", 200);
    expect(panel().getAttribute("data-highlight")).toBe("media");
    expect(choose).not.toHaveBeenCalled();
    await settle();
    expect(choose).toHaveBeenCalledWith({ tab: "media" });
  });

  it("springs a short release back while a neighboring page is visible", async () => {
    await render();
    touch("touchstart", 200);
    touch("touchmove", 170, 200, page(), 2000);
    expect(page().style.transform).toBe("translate3d(-30px, 0, 0)");
    touch("touchend", 170);
    expect(page().style.transition).toContain(`${SWIPE_MOTION_MS}ms`);
    await settle();
    expect(choose).not.toHaveBeenCalled();
    expect(page().style.transform).toBe("");
    expect(host.querySelector("[data-pane-preview]")).toBeNull();
  });

  it("dismisses rightward only from the first available tab", async () => {
    await render();
    touch("touchstart", 20);
    touch("touchmove", 350, 200, page(), 2000);
    expect(panel().style.transform).toBe("translate3d(330px, 0, 0)");
    touch("touchend", 350);
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(choose).not.toHaveBeenCalled();
  });

  it("goes to the previous tab instead of dismissing from Media", async () => {
    await render({ tab: "media" });
    touch("touchstart", 20);
    touch("touchmove", 350, 200, page(), 2000);
    touch("touchend", 350);
    await settle();
    expect(choose).toHaveBeenCalledWith({ tab: "show" });
    expect(close).not.toHaveBeenCalled();
  });

  it("returns Files to Photos before dismissing a first-tab Media pane", async () => {
    await render({ tab: "media", order: ["media", "map"] });
    page().querySelector('[data-media-kind="photos"]')!.setAttribute("aria-selected", "false");
    page().querySelector('[data-media-kind="files"]')!.setAttribute("aria-selected", "true");
    touch("touchstart", 20);
    touch("touchmove", 350, 200, page(), 2000);
    touch("touchend", 350);
    await settle();
    expect(choose).toHaveBeenCalledWith({ tab: "media", kind: "photos" });
    expect(close).not.toHaveBeenCalled();
  });

  it("dismisses from Photos when Media is the first available top tab", async () => {
    await render({ tab: "media", order: ["media", "map"] });
    touch("touchstart", 20);
    touch("touchmove", 350, 200, page(), 2000);
    touch("touchend", 350);
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(choose).not.toHaveBeenCalled();
  });

  it.each([".map-pane canvas", "pre", "input", "[data-no-swipe]", "[data-horizontal]"])("leaves %s in control", async (selector) => {
    await render({ tab: "map" });
    const target = page().querySelector(selector)!;
    Object.defineProperties(page().querySelector("[data-horizontal]")!, { scrollWidth: { value: 600 }, clientWidth: { value: 200 } });
    touch("touchstart", 350, 200, target);
    expect(touch("touchmove", 20, 200, target).defaultPrevented).toBe(false);
    touch("touchend", 20, 200, target);
    await settle();
    expect(choose).not.toHaveBeenCalled();
    expect(page().style.transform).toBe("");
  });

  it("allows leaving Map from the pane header", async () => {
    await render({ tab: "map" });
    const header = host.querySelector("header")!;
    touch("touchstart", 20, 30, header);
    touch("touchmove", 350, 30, header, 2000);
    touch("touchend", 350, 30, header);
    await settle();
    expect(choose).toHaveBeenCalledWith({ tab: "check" });
  });

  it("leaves vertical scrolling and selected text alone", async () => {
    await render();
    touch("touchstart", 150);
    expect(touch("touchmove", 155, 400).defaultPrevented).toBe(false);
    touch("touchend", 155);
    const range = document.createRange();
    range.selectNodeContents(page().querySelector("p")!);
    window.getSelection()!.addRange(range);
    touch("touchstart", 350);
    expect(touch("touchmove", 20).defaultPrevented).toBe(false);
    expect(page().style.transform).toBe("");
  });

  it("leaves text selected after a long press starts alone", async () => {
    await render();
    touch("touchstart", 350);
    const range = document.createRange();
    range.selectNodeContents(page().querySelector("p")!);
    window.getSelection()!.addRange(range);
    expect(touch("touchmove", 20).defaultPrevented).toBe(false);
    expect(page().style.transform).toBe("");
    expect(choose).not.toHaveBeenCalled();
  });

  it("does not turn a paused short flick into a tab switch", async () => {
    await render();
    touch("touchstart", 200);
    touch("touchmove", 160, 200, page(), 20);
    touch("touchend", 160, 200, page(), 200);
    await settle();
    expect(choose).not.toHaveBeenCalled();
  });

  it.each(["touchcancel", "multitouch"])("cancels %s without navigating", async (type) => {
    await render();
    touch("touchstart", 350);
    touch("touchmove", 20);
    if (type === "multitouch") touch("touchstart", 20, 200, page(), 10, 2);
    else touch("touchcancel", 20);
    await settle();
    expect(choose).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(page().style.transform).toBe("");
  });

  it("does not read layout during a drag", async () => {
    await render();
    touch("touchstart", 350);
    touch("touchmove", 300);
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get");
    const style = vi.spyOn(window, "getComputedStyle");
    touch("touchmove", 250);
    expect(width).not.toHaveBeenCalled();
    expect(style).not.toHaveBeenCalled();
  });

  it("commits without movement when reduced motion is requested", async () => {
    reduced = true;
    await render();
    touch("touchstart", 350);
    touch("touchmove", 20);
    touch("touchend", 20);
    expect(choose).toHaveBeenCalledWith({ tab: "media" });
    expect(page().style.transform).toBe("");
  });

  it("attaches no gesture handlers on desktop", async () => {
    const listener = vi.spyOn(HTMLElement.prototype, "addEventListener");
    await render({ phone: false });
    expect(listener.mock.calls.filter(([name]) => name.startsWith("touch"))).toEqual([]);
  });

  it("cancels a pending switch when the pane closes", async () => {
    await render();
    touch("touchstart", 350);
    touch("touchmove", 20);
    touch("touchend", 20);
    await render({ closing: true });
    await settle();
    expect(choose).not.toHaveBeenCalled();
  });

  it("cancels a pending switch when another chat owns the pane", async () => {
    await render();
    touch("touchstart", 350);
    touch("touchmove", 20);
    touch("touchend", 20);
    await render({ threadId: "t2" });
    await settle();
    expect(choose).not.toHaveBeenCalled();
    expect(page().style.transform).toBe("");
  });
});
