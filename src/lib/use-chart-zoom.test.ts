import "@/components/ProfileFields.test-dom.ts";
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChartZoom } from "./use-chart-zoom";

let host: HTMLDivElement;
let root: Root;
let renders: number;
let frames: FrameRequestCallback[];

function Chart({ index = "a", enabled = true }: { index?: string; enabled?: boolean }) {
  renders++;
  const ref = useRef<SVGSVGElement>(null);
  const { zoom } = useChartZoom(ref, enabled, index, { left: 0, right: 400, top: 0, bottom: 200 }, () => true, () => undefined);
  return createElement("svg", { ref, "data-scale": zoom.scale },
    createElement("g", {
      "data-mi-point": "", "data-mi-x": 0.5, "data-mi-y": 0.5,
      style: { transform: `translate(${(0.5 - zoom.x) * zoom.scale * 400}px, ${(0.5 - zoom.y) * zoom.scale * 200}px)` },
    }, createElement("circle", { r: 6 })),
    createElement("text", { "data-mi-label": "", "data-mi-x": 200, "data-mi-y": 100, style: { fontSize: 10.5 } }, "Model"),
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

function touch(type: string, points: Array<[number, number]>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
  act(() => void host.querySelector("svg")!.dispatchEvent(event));
}

describe("useChartZoom", () => {
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
});
