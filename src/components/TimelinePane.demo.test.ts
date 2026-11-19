// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";

import { TimelinePane } from "./TimelinePane";

describe("TimelinePane demo", () => {
  const urls: string[] = [];
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(async () => {
    urls.length = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return new Response("{}", { status: 404 });
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

    // happy-dom drops ctrlKey and clientX/Y from the WheelEvent init
    const zoomEvent = new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ ctrlKey: true, clientX: 100, clientY: 100 })) Object.defineProperty(zoomEvent, key, { value });
    const before = canvas().querySelector(".timeline-hint b")!.textContent;
    act(() => { canvas().dispatchEvent(zoomEvent); });
    expect(canvas().querySelector(".timeline-hint b")!.textContent).not.toBe(before);
  });

  it("has nothing to open, and the demo makes no request beyond the pick list", () => {
    expect(canvas().querySelector(".timeline-open, img")).toBeNull();
    act(() => { canvas().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/memory/topics/decisions.md");
  });
});
