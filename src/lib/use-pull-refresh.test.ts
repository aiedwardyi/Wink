// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWIPE_MOTION_MS } from "./phone-swipe";
import { PULL_MIN_MS, PULL_THRESHOLD, usePullRefresh } from "./use-pull-refresh";

let host: HTMLDivElement;
let root: Root;
let reduced: boolean;
let time: number;
const refresh = vi.fn<() => Promise<void>>();
const scroller = () => host.querySelector<HTMLElement>("[data-scroller]")!;
const content = () => host.querySelector<HTMLElement>("[data-content]")!;
const badge = () => host.querySelector<HTMLElement>("[data-badge]")!;

function Harness({ enabled = true }) {
  const ref = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLDivElement>(null);
  usePullRefresh(ref, badgeRef, enabled, refresh);
  return createElement("div", null,
    createElement("div", { ref: badgeRef, "data-badge": true }, createElement("span", null)),
    createElement("div", { ref, "data-scroller": true },
      createElement("section", { "data-content": true }, createElement("p", null, "Post"), createElement("textarea")),
    ),
  );
}

function touch(type: string, x: number, y: number, target: Element = content()) {
  time += 16;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }] },
    timeStamp: { value: time },
  });
  target.dispatchEvent(event);
  return event;
}

// a pull of `dy` finger pixels from (100, 100)
function pull(dy: number, dx = 0) {
  touch("touchstart", 100, 100);
  touch("touchmove", 100 + dx / 2, 100 + dy / 2);
  return touch("touchmove", 100 + dx, 100 + dy);
}
const release = (type = "touchend") => act(async () => { touch(type, 0, 0); });
const settleAll = () => act(async () => { await vi.advanceTimersByTimeAsync(PULL_MIN_MS + SWIPE_MOTION_MS + 50); });
const idle = () => {
  expect(content().style.transform).toBe("");
  expect(content().style.transition).toBe("");
  expect(badge().style.opacity).toBe("");
  expect(badge().dataset.spin).toBeUndefined();
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  reduced = false;
  time = 0;
  refresh.mockReset();
  refresh.mockResolvedValue();
  // SAFETY: the hook reads only .matches
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query.includes("reduced-motion") && reduced } as MediaQueryList));
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("pull to refresh", () => {
  it("drags the content down with resistance and shows the badge", () => {
    const event = pull(80);
    expect(event.defaultPrevented).toBe(true);
    expect(content().style.transform).toBe("translate3d(0, 40px, 0)");
    expect(Number(badge().style.opacity)).toBeGreaterThan(0);
  });

  it("refreshes once past the threshold, spins until it settles, then springs back", async () => {
    pull(PULL_THRESHOLD * 2 + 4);
    await release();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(badge().dataset.spin).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(PULL_MIN_MS - 10); });
    expect(badge().dataset.spin).toBe("");
    await settleAll();
    idle();
  });

  it("waits for a slow refresh before springing back", async () => {
    let done!: () => void;
    refresh.mockReturnValue(new Promise<void>((resolve) => { done = resolve; }));
    pull(PULL_THRESHOLD * 2);
    await release();
    await settleAll();
    expect(badge().dataset.spin).toBe("");
    done();
    await settleAll();
    idle();
  });

  it("springs back without refreshing below the threshold", async () => {
    pull(PULL_THRESHOLD * 2 - 8);
    await release();
    expect(refresh).not.toHaveBeenCalled();
    expect(content().style.transform).toBe("translate3d(0, 0px, 0)");
    await settleAll();
    idle();
  });

  it("a cancelled touch springs back without refreshing", async () => {
    pull(PULL_THRESHOLD * 3);
    await release("touchcancel");
    expect(refresh).not.toHaveBeenCalled();
    await settleAll();
    idle();
  });

  it("does not start when the list is scrolled", async () => {
    scroller().scrollTop = 40;
    const event = pull(PULL_THRESHOLD * 3);
    await release();
    expect(event.defaultPrevented).toBe(false);
    expect(content().style.transform).toBe("");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not start when the scroll leaves the top mid-gesture", async () => {
    touch("touchstart", 100, 100);
    scroller().scrollTop = 12;
    const event = touch("touchmove", 100, 220);
    await release();
    expect(event.defaultPrevented).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores a horizontal gesture", async () => {
    const event = pull(20, 150);
    await release();
    expect(event.defaultPrevented).toBe(false);
    expect(content().style.transform).toBe("");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores an upward drag and a drag that starts in a text field", async () => {
    expect(pull(-200).defaultPrevented).toBe(false);
    await release();
    const field = host.querySelector("textarea")!;
    touch("touchstart", 100, 100, field);
    expect(touch("touchmove", 100, 300, field).defaultPrevented).toBe(false);
    await release();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a failed refresh stops the spinner and springs back", async () => {
    refresh.mockRejectedValue(new Error("offline"));
    pull(PULL_THRESHOLD * 2);
    await release();
    expect(badge().dataset.spin).toBe("");
    await settleAll();
    idle();
  });

  it("ignores a new pull while one is refreshing", async () => {
    pull(PULL_THRESHOLD * 2);
    await release();
    expect(pull(PULL_THRESHOLD * 2).defaultPrevented).toBe(false);
    await release();
    expect(refresh).toHaveBeenCalledTimes(1);
    await settleAll();
  });

  it("paints no drag under reduced motion but still refreshes", async () => {
    reduced = true;
    await act(async () => root.render(createElement(Harness, { enabled: false })));
    await act(async () => root.render(createElement(Harness)));
    pull(PULL_THRESHOLD * 2);
    expect(content().style.transform).toBe("");
    await release();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(content().style.transition).toBe("");
    await settleAll();
    idle();
  });

  it("does nothing when disabled and leaves no styles behind when unmounted mid-pull", async () => {
    await act(async () => root.render(createElement(Harness, { enabled: false })));
    expect(pull(PULL_THRESHOLD * 3).defaultPrevented).toBe(false);
    await act(async () => root.render(createElement(Harness)));
    pull(80);
    const badgeNode = badge();
    await act(async () => root.render(createElement(Harness, { enabled: false })));
    expect(badgeNode.style.opacity).toBe("");
    expect(scroller().style.overscrollBehaviorY).toBe("");
  });
});
