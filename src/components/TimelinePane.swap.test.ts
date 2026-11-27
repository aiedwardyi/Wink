// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";
import { noteMemorySnapshot } from "@/lib/memory-clean-events";

import { TimelinePane } from "./TimelinePane";

let landed = false;
const pick = { id: "2026-11-19 10:00", key: "name", picked: "Wink", over: ["Nova"], overPictures: [], files: [], tweaks: [] };

describe("TimelinePane demo to first pick", () => {
  const callbacks: (() => void)[] = [];
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    landed = false;
    callbacks.length = 0;
    vi.stubGlobal("fetch", async () => landed ? new Response(JSON.stringify({ entries: [pick] })) : new Response("{}", { status: 404 }));
    // A browser may deliver a queued resize after React detached the old sheet, so the stub keeps every callback.
    vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { callbacks.push(cb); } observe() {} disconnect() {} });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    root.unmount();
    host.remove();
    vi.unstubAllGlobals();
  });

  it("a resize that lands after the demo unmounts does not throw", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(TimelinePane, { botId: "bot-1", threadId: "t1", maximized: false, closing: false })));
    });
    expect(host.querySelector(".timeline-sample")).toBeTruthy();
    const demo = callbacks.length;
    expect(demo).toBeGreaterThan(0);

    landed = true;
    await act(async () => { noteMemorySnapshot(); });
    expect(host.querySelector(".timeline-sample")).toBeNull();
    expect(host.querySelector("[data-timeline-pick]")).toBeTruthy();

    expect(() => callbacks.slice(0, demo).forEach((cb) => cb())).not.toThrow();
  });
});
