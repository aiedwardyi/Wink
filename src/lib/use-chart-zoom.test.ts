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

function Chart({ index = "a", enabled = true }: { index?: string; enabled?: boolean }) {
  renders++;
  const ref = useRef<SVGSVGElement>(null);
  const { zoom } = useChartZoom(ref, enabled, index, { left: 0, right: 400, top: 0, bottom: 200 }, () => true, () => undefined);
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
