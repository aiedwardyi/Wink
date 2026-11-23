// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetMedia } from "@/lib/media-index";
import { PANE_TAB_KEY } from "@/lib/show-pane";
import { StoreProvider, type Bot } from "@/state/store";

import { ChatView } from "./ChatView";
import { ShowMedia } from "./ShowMedia";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const bot = (id: string, extra: Partial<Bot> = {}) => ({
  id, threadId: `thread-${id}`, name: id, title: "", description: "", notifications: false,
  color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, hasMore: false,
  messages: [{ id: "m1", at: 1, role: "user", kind: "text", text: "hello" }],
  ...extra,
}) as unknown as Bot;

afterEach(() => {
  forgetMedia();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ChatView media warm", () => {
  function setup() {
    const idle: Array<() => void> = [];
    const asked: string[] = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("requestIdleCallback", (run: () => void) => idle.push(run));
    vi.stubGlobal("cancelIdleCallback", () => {});
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (/\/media/.test(url)) {
        asked.push(url);
        return Response.json({ v: "1", ids: ["m1"], at: [1], kind: "l", name: ["a.png"], ref: ["C:\\w\\a.png"], size: [null] });
      }
      return new Response("{}", { status: 404 });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = (current: Bot, props: { onOpenTerminal?: () => void } = {}) => act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: current, ...props }))));
    const run = () => act(async () => { for (const next of idle.splice(0)) next(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    return { asked, host, root, show, run };
  }

  it("asks for the open chat's media once it is idle, and the first press draws the held list", async () => {
    const { asked, host, root, show, run } = setup();
    try {
      await show(bot("A"));
      expect(asked).toEqual([]);
      await run();
      expect(asked).toEqual(["/api/threads/thread-A/media"]);
      await show(bot("A"));
      await run();
      expect(asked).toHaveLength(1);

      const pane = document.createElement("div");
      document.body.append(pane);
      const paneRoot = createRoot(pane);
      // flushSync-free first render: what the press paints before any request answers
      await act(async () => paneRoot.render(createElement(ShowMedia, { source: { threadId: "thread-A", messages: [] }, maximized: false })));
      expect(pane.querySelector("[data-show-media]")?.hasAttribute("aria-busy")).toBe(false);
      await act(async () => paneRoot.unmount());
      pane.remove();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("asks nothing for a chat whose pane button opens another tab", async () => {
    const { asked, host, root, show, run } = setup();
    localStorage.setItem(PANE_TAB_KEY, JSON.stringify({ "thread-D": "timeline", "thread-E": "workers", "thread-F": "media" }));
    try {
      await show(bot("D"));
      await run();
      await show(bot("E"), { onOpenTerminal: () => {} });
      await run();
      expect(asked).toEqual([]);
      await show(bot("F"), { onOpenTerminal: () => {} });
      await run();
      expect(asked).toEqual(["/api/threads/thread-F/media"]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("waits while a turn is live or the composer holds text", async () => {
    const { asked, host, root, show, run } = setup();
    try {
      await show(bot("B", { busy: true }));
      await run();
      expect(asked).toEqual([]);
      await show(bot("C"));
      const box = host.querySelector<HTMLTextAreaElement>("textarea[data-orbit-composer]")!;
      box.value = "half a sentence";
      await run();
      expect(asked).toEqual([]);
      box.value = "";
      await show(bot("B"));
      await run();
      expect(asked).toEqual(["/api/threads/thread-B/media"]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
