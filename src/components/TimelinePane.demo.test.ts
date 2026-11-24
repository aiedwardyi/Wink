// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { noteMemorySnapshot } from "@/lib/memory-clean-events";

import { TimelinePane } from "./TimelinePane";

describe("TimelinePane demo", () => {
  const urls: string[] = [];
  let landed = false;
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    urls.length = 0;
    landed = false;
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return landed ? new Response(JSON.stringify({ entries: [{ id: "2026-11-19 10:00", key: "name", picked: "Wink", over: ["Nova"], overPictures: [], files: [], tweaks: [] }] })) : new Response("{}", { status: 404 });
    });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(TimelinePane, { botId: "bot-1", threadId: "t1", maximized: false, closing: false })));
    });
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    vi.unstubAllGlobals();
  });

  const canvas = () => host.querySelector<HTMLElement>(".timeline-canvas")!;
  const sheet = () => canvas().querySelector<HTMLElement>(".timeline-sheet")!;
  const pointer = (type: string, x: number, y: number, init: PointerEventInit = { pointerType: "touch" }) => {
    const event = new PointerEvent(type, { pointerId: 1, bubbles: true, cancelable: true, ...init });
    for (const [key, value] of Object.entries({ clientX: x, clientY: y, buttons: init.buttons ?? 0 })) Object.defineProperty(event, key, { value });
    act(() => { canvas().dispatchEvent(event); });
  };

  it("is not inert, so the real Canvas handlers reach it", () => {
    expect(host.querySelector(".timeline-sample")).toBeTruthy();
    expect(canvas().closest("[inert]")).toBeNull();
  });

  it("pans on wheel and arrow keys, zooms on ctrl+wheel", () => {
    const first = sheet().style.transform;
    act(() => { canvas().dispatchEvent(new WheelEvent("wheel", { deltaY: 60, bubbles: true, cancelable: true })); });
    const wheeled = sheet().style.transform;
    expect(wheeled).not.toBe(first);

    act(() => { canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    const keyed = sheet().style.transform;
    expect(keyed).not.toBe(wheeled);

    // happy-dom ignores ctrlKey/clientX/clientY in WheelEventInit (gap vs. spec); patch them in by hand
    const zoomEvent = new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ ctrlKey: true, clientX: 100, clientY: 100 })) Object.defineProperty(zoomEvent, key, { value });
    const before = canvas().querySelector(".timeline-hint b")!.textContent;
    act(() => { canvas().dispatchEvent(zoomEvent); });
    expect(canvas().querySelector(".timeline-hint b")!.textContent).not.toBe(before);
  });

  it("holds will-change only while a drag moves the sheet, so it re-rasters sharp when it stops", () => {
    vi.stubGlobal("devicePixelRatio", 1.5);
    expect(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "TimelinePane.css"), "utf8")).not.toMatch(/will-change/);
    expect(sheet().style.willChange).toBe("");
    pointer("pointerdown", 100, 100);
    pointer("pointermove", 100, 160);
    expect(sheet().style.willChange).toBe("transform");
    pointer("pointerup", 100, 160);
    expect(sheet().style.willChange).toBe("");
  });

  it("never lifts the sheet below 1.5x, where a layer would turn its subpixel text grayscale mid-drag", () => {
    for (const ratio of [1, 1.25]) {
      vi.stubGlobal("devicePixelRatio", ratio);
      pointer("pointerdown", 100, 100);
      pointer("pointermove", 100, 160);
      expect(sheet().style.willChange).toBe("");
      pointer("pointerup", 100, 160);
    }
  });

  it("lifts only when both the display scale and the window-zoomed ratio reach 1.5x", () => {
    for (const [ratio, zoom, lifted] of [[1.5, 1.2, ""], [1.2, 0.8, ""], [1.6, 0.8, "transform"]] as const) {
      vi.stubGlobal("devicePixelRatio", ratio);
      vi.stubGlobal("ogb", { zoomFactor: () => zoom });
      pointer("pointerdown", 100, 100);
      pointer("pointermove", 100, 160);
      expect(sheet().style.willChange).toBe(lifted);
      pointer("pointerup", 100, 160);
    }
  });

  it("lifts the sheet for a two-finger pinch and drops it when the last finger lifts", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const second = { pointerType: "touch", pointerId: 2 };
    pointer("pointerdown", 100, 100);
    pointer("pointerdown", 200, 100, second);
    pointer("pointermove", 240, 100, second);
    expect(sheet().style.willChange).toBe("transform");
    pointer("pointerup", 240, 100, second);
    expect(sheet().style.willChange).toBe("transform");
    pointer("pointerup", 100, 100);
    expect(sheet().style.willChange).toBe("");
  });

  it("ends a mouse drag whose mouse-up never arrived like one that did", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const mouse = { pointerType: "mouse", buttons: 1 };
    pointer("pointerdown", 100, 100, mouse);
    pointer("pointermove", 100, 160, mouse);
    expect(sheet().style.willChange).toBe("transform");
    expect(canvas().hasAttribute("data-grabbing")).toBe(true);
    pointer("pointermove", 100, 170, { pointerType: "mouse", buttons: 0 });
    expect(sheet().style.willChange).toBe("");
    expect(canvas().hasAttribute("data-grabbing")).toBe(false);
  });

  it("has nothing to open, and the demo makes no request beyond the pick list", () => {
    expect(canvas().querySelector(".timeline-open, img")).toBeNull();
    act(() => { canvas().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/memory/topics/decisions.md");
  });

  it("the first real pick starts from the default view, not where the demo was panned", async () => {
    const start = sheet().style.transform;
    act(() => { canvas().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    expect(sheet().style.transform).not.toBe(start);

    landed = true;
    await act(async () => { noteMemorySnapshot(); });
    expect(host.querySelector("[data-timeline-pick]")).toBeTruthy();
    expect(sheet().style.transform).toBe(start);
  });
});
