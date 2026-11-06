import "@/components/ProfileFields.test-dom.ts";
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inZoom } from "./chart-zoom";
import { useChartZoom } from "./use-chart-zoom";

let host: HTMLDivElement;
let root: Root;
let renders: number;
let frames: FrameRequestCallback[];

function Chart({ index = "a", enabled = true, input = "touch" }: { index?: string; enabled?: boolean; input?: "touch" | "mouse" }) {
  renders++;
  const ref = useRef<SVGSVGElement>(null);
  const { zoom } = useChartZoom(ref, enabled ? input : undefined, index, { left: 0, right: 400, top: 0, bottom: 200 }, () => true, () => undefined);
  return createElement("svg", { ref, "data-scale": zoom.scale, "data-mi-zoom": enabled ? zoom.scale : undefined },
    createElement("g", {
      "data-mi-point": "", "data-mi-x": 0.5, "data-mi-y": 0.5,
      style: { transform: `translate(${(0.5 - zoom.x) * zoom.scale * 400}px, ${(0.5 - zoom.y) * zoom.scale * 200}px)`, opacity: 1 },
    }, createElement("circle", { r: 6 })),
    createElement("g", {
      "data-mi-point": "", "data-mi-x": 0.9, "data-mi-y": 0.5,
      style: { transform: `translate(${(0.9 - zoom.x) * zoom.scale * 400}px, ${(0.5 - zoom.y) * zoom.scale * 200}px)`, opacity: inZoom(zoom, { x: 0.9, y: 0.5 }) ? 1 : 0 },
    }),
    createElement("text", { "data-mi-label": "", "data-mi-x": 200, "data-mi-y": 100, style: { fontSize: 10.5, transform: "translate(200px, 100px)" } }, "Model"),
    createElement("g", { "data-mi-live-lines": "" }),
    input === "mouse" && createElement("text", { "data-mi-label": "", "data-mi-x": 210, "data-mi-y": 96, "data-mi-ax": 200, "data-mi-ay": 100, style: { transform: "translate(210px, 96px)" } }, "Pinned"),
    input === "mouse" && createElement("path", { "data-mi-live-lines": "", "data-mi-ax": 200, "data-mi-ay": 100 }),
  );
}

beforeEach(async () => {
  renders = 0;
  frames = [];
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root.render(createElement(Chart)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function touch(type: string, points: Array<[number, number]>, time?: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
  if (time !== undefined) Object.defineProperty(event, "timeStamp", { value: time });
  act(() => void host.querySelector("svg")!.dispatchEvent(event));
}

describe("useChartZoom", () => {
  it.each(["pinch", "pan"])("restores a dot when %s ends before its final frame", (gesture) => {
    const dot = host.querySelectorAll<SVGGElement>("[data-mi-point]")[1]!;
    if (gesture === "pan") {
      touch("touchstart", [[300, 100], [500, 100]]);
      touch("touchmove", [[200, 100], [600, 100]]);
      touch("touchend", []);
    }
    expect(dot.style.opacity).toBe("1");
    const rendered = dot.style.transform;
    if (gesture === "pinch") {
      touch("touchstart", [[100, 100], [300, 100]]);
      touch("touchmove", [[0, 100], [400, 100]]);
    } else {
      touch("touchstart", [[200, 100]]);
      touch("touchmove", [[600, 100]]);
    }
    act(() => frames.at(-1)!(16));
    expect(dot.style.opacity).toBe("0");
    touch("touchmove", gesture === "pinch" ? [[100, 100], [300, 100]] : [[200, 100]]);
    expect(dot.style.opacity).toBe("0");
    touch("touchend", []);
    expect({ opacity: dot.style.opacity, transform: dot.style.transform }).toEqual({ opacity: "1", transform: rendered });
  });

  it("does not count the last pinch finger lifting as a tap", () => {
    touch("touchstart", [[100, 100], [200, 100]], 1000);
    touch("touchmove", [[50, 100], [250, 100]], 1020);
    touch("touchend", [[250, 100]], 1040);
    expect(host.querySelector("svg")!.getAttribute("data-scale")).toBe("2");
    touch("touchend", [], 1060);
    touch("touchstart", [[250, 100]], 1100);
    touch("touchend", [], 1120);
    expect(host.querySelector("svg")!.getAttribute("data-scale")).toBe("2");
  });

  it("keeps panning with the remaining pinch finger", () => {
    touch("touchstart", [[100, 100], [200, 100]]);
    touch("touchmove", [[50, 100], [250, 100]]);
    touch("touchend", [[250, 100]]);
    const dot = host.querySelector<SVGGElement>("[data-mi-point]")!;
    expect(dot.style.transform).toBe("translate(250px, 100px)");
    touch("touchmove", [[210, 100]]);
    touch("touchend", []);
    expect(dot.style.transform).toBe("translate(210px, 100px)");
    expect(host.querySelector("svg")!.getAttribute("data-scale")).toBe("2");
  });

  it("coalesces pinch frames without React layout and keeps text and marks at their size", () => {
    const before = renders;
    touch("touchstart", [[100, 100], [200, 100]]);
    touch("touchmove", [[50, 100], [250, 100]]);
    touch("touchmove", [[0, 100], [300, 100]]);
    expect(frames).toHaveLength(1);
    act(() => frames[0]!(16));
    expect(renders).toBe(before);
    const [x, y] = host.querySelector<SVGGElement>("[data-mi-point]")!.style.transform.match(/-?[\d.]+/g)!.map(Number);
    expect(x).toBeCloseTo(300);
    expect(y).toBeCloseTo(100);
    expect(host.querySelector("circle")!.getAttribute("r")).toBe("6");
    expect(host.querySelector<SVGTextElement>("text")!.style.fontSize).toBe("10.5px");
    touch("touchend", []);
    expect(host.querySelector("svg")!.getAttribute("data-scale")).toBe("3");
    expect(renders).toBeGreaterThan(before);
  });

  it("cancels a queued frame when the index changes or full screen closes", async () => {
    touch("touchstart", [[100, 100], [200, 100]]);
    touch("touchmove", [[50, 100], [250, 100]]);
    await act(async () => root.render(createElement(Chart, { index: "b" })));
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(host.querySelector("svg")!.getAttribute("data-scale")).toBe("1");
    await act(async () => root.render(createElement(Chart, { index: "b", enabled: false })));
    touch("touchstart", [[100, 100], [200, 100]]);
    touch("touchmove", [[0, 100], [300, 100]]);
    expect(frames).toHaveLength(1);
  });

  it("resets a zoomed double-tap when its second tap moves 3 px", () => {
    touch("touchstart", [[100, 100], [200, 100]]);
    touch("touchmove", [[50, 100], [250, 100]]);
    touch("touchend", []);
    expect(host.querySelector("svg")!.getAttribute("data-scale")).toBe("2");
    touch("touchstart", [[200, 100]]);
    touch("touchend", []);
    touch("touchstart", [[200, 100]]);
    touch("touchmove", [[203, 100]]);
    touch("touchend", []);
    expect(host.querySelector("svg")!.getAttribute("data-scale")).toBe("1");
  });

  it.each(["close", "index"])("clears a painted pinch when interrupted by %s", async (change) => {
    touch("touchstart", [[100, 100], [200, 100]]);
    touch("touchmove", [[50, 100], [250, 100]]);
    act(() => frames[0]!(16));
    const svg = host.querySelector("svg")!;
    const line = host.querySelector("[data-mi-live-lines]")!;
    expect(svg.hasAttribute("data-mi-gesture")).toBe(true);
    expect(line.getAttribute("transform")).toContain("matrix(2");
    await act(async () => root.render(createElement(Chart, change === "close" ? { enabled: false } : { index: "b" })));
    expect({ gesture: svg.hasAttribute("data-mi-gesture"), transform: line.getAttribute("transform") }).toEqual({ gesture: false, transform: null });
  });

  it.each([
    { change: "close", scale: 1 }, { change: "index", scale: 1 },
    { change: "close", scale: 2 }, { change: "index", scale: 2 },
  ])("restores painted dots and labels on $change from $scale x", async ({ change, scale }) => {
    const dots = [...host.querySelectorAll<SVGGElement>("[data-mi-point]")];
    const label = host.querySelector<SVGTextElement>("[data-mi-label]")!;
    const styles = () => [...dots.map((dot) => [dot.style.transform, dot.style.opacity]), label.style.transform];
    const rendered = styles();
    if (scale === 2) {
      touch("touchstart", [[100, 100], [200, 100]]);
      touch("touchmove", [[50, 100], [250, 100]]);
      touch("touchend", []);
    }
    touch("touchstart", [[100, 100], [200, 100]]);
    touch("touchmove", [[50, 100], [250, 100]]);
    act(() => frames.at(-1)!(16));
    expect(dots[1]!.style.opacity).toBe("0");
    expect(label.style.transform).not.toBe(rendered.at(-1));
    await act(async () => root.render(createElement(Chart, change === "close" ? { enabled: false } : { index: "b" })));
    expect(styles()).toEqual(rendered);
    expect(host.querySelector("svg")!.getAttribute("data-mi-zoom")).toBe(change === "close" ? null : "1");
  });
});

describe("useChartZoom with a mouse", () => {
  const svg = () => host.querySelector("svg")!;
  const scale = () => Number(svg().getAttribute("data-scale"));
  const spot = (dot: Element) => (dot as SVGGElement).style.transform.match(/-?[\d.]+/g)!.map(Number);
  const wheel = (target: EventTarget, deltaY: number, [clientX, clientY]: [number, number], time: number, ctrlKey = false, cancelable = true) => {
    // happy-dom's WheelEvent drops clientX and ctrlKey.
    const event = new MouseEvent("wheel", { bubbles: true, cancelable, clientX, clientY, ctrlKey });
    for (const [key, value] of Object.entries({ deltaX: 0, deltaY, deltaMode: 0, timeStamp: time })) Object.defineProperty(event, key, { value });
    act(() => void target.dispatchEvent(event));
    return event;
  };
  const mouse = (target: EventTarget, type: string, [clientX, clientY]: [number, number]) =>
    act(() => void target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 })));
  const settle = () => act(() => vi.advanceTimersByTime(200));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => root.render(createElement(Chart, { input: "mouse" })));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([{ deltaY: -100, ctrlKey: false }, { deltaY: -30, ctrlKey: true }])("zooms around the cursor with ctrl $ctrlKey", ({ deltaY, ctrlKey }) => {
    const [center, edge] = host.querySelectorAll("[data-mi-point]");
    expect(wheel(svg(), deltaY, [360, 100], 1000, ctrlKey).defaultPrevented).toBe(true);
    act(() => frames.at(-1)!(16));
    expect(spot(edge!)[0]).toBeCloseTo(360);
    expect(spot(center!)[0]).toBeCloseTo(360 - 160 * 2 ** 0.3);
    settle();
    expect(scale()).toBeCloseTo(2 ** 0.3);
    expect(spot(edge!)[0]).toBeCloseTo(360);
  });

  it("keeps a label and its leader beside their dot while the wheel zooms", () => {
    const center = host.querySelector("[data-mi-point]")!;
    wheel(svg(), -300, [360, 60], 1000);
    act(() => frames.at(-1)!(16));
    const [x, y] = spot(center);
    const [lx, ly] = spot(host.querySelector("text[data-mi-ax]")!);
    const [tx, ty] = host.querySelector("path[data-mi-ax]")!.getAttribute("transform")!.match(/-?[\d.]+/g)!.map(Number);
    expect([lx! - x!, ly! - y!, tx! - (x! - 200), ty! - (y! - 100)].map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([10, -4, 0, 0]);
  });

  it("keeps scrolling the page when a wheel that started outside passes over the chart", () => {
    expect(wheel(document.body, -100, [200, 100], 1000).defaultPrevented).toBe(false);
    expect(wheel(svg(), -100, [200, 100], 1200).defaultPrevented).toBe(false);
    expect(wheel(svg(), -100, [200, 100], 1500).defaultPrevented).toBe(false);
    expect(frames).toHaveLength(0);
    expect(wheel(svg(), -100, [200, 100], 1950).defaultPrevented).toBe(true);
  });

  it("scrolls the page when the browser already scrolled before the chart got the wheel", () => {
    wheel(svg(), -100, [200, 100], 1000, false, false);
    expect(wheel(svg(), -100, [200, 100], 1100).defaultPrevented).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it("scrolls the page on wheel down at 1x, also once a zoom is back at 1x", () => {
    expect(wheel(svg(), 100, [200, 100], 1000).defaultPrevented).toBe(false);
    expect(wheel(svg(), -100, [200, 100], 2000).defaultPrevented).toBe(true);
    expect(wheel(svg(), 100, [200, 100], 2050).defaultPrevented).toBe(true);
    settle();
    expect(scale()).toBe(1);
    expect(wheel(svg(), 100, [200, 100], 2300).defaultPrevented).toBe(false);
  });

  it("pans on drag while zoomed, clamped to the data area", () => {
    mouse(svg(), "mousedown", [200, 100]);
    expect(svg().hasAttribute("data-mi-drag")).toBe(false);
    wheel(svg(), -1000, [200, 100], 1000);
    settle();
    expect(scale()).toBe(8);
    mouse(svg(), "mousedown", [200, 100]);
    expect(svg().hasAttribute("data-mi-drag")).toBe(true);
    mouse(window, "mousemove", [5000, 100]);
    mouse(window, "mouseup", [5000, 100]);
    expect(svg().hasAttribute("data-mi-drag")).toBe(false);
    expect(scale()).toBe(8);
    expect(spot(host.querySelector("[data-mi-point]")!)).toEqual([1600, 100]);
  });

  it("returns to the full view on double-click", () => {
    wheel(svg(), -300, [200, 100], 1000);
    settle();
    expect(scale()).toBeGreaterThan(1);
    mouse(svg(), "dblclick", [200, 100]);
    expect(scale()).toBe(1);
  });

  it("resets when the index changes, even mid-wheel", async () => {
    wheel(svg(), -300, [200, 100], 1000);
    settle();
    expect(scale()).toBeGreaterThan(1);
    wheel(svg(), -300, [200, 100], 1100);
    await act(async () => root.render(createElement(Chart, { input: "mouse", index: "b" })));
    settle();
    expect(scale()).toBe(1);
    expect(wheel(svg(), 100, [200, 100], 3000).defaultPrevented).toBe(false);
  });
});
