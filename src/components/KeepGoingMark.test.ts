// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "../App";
import { KeepGoingMark } from "./KeepGoingMark";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

const bot = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: `${id}-thread`,
  name: id,
  messages: [],
  modelSelection: { instanceId: "muse", model: "muse-spark" },
  ...extra,
});

afterEach(() => {
  window.localStorage.removeItem("omb-onboarding-done");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountApp(bots: unknown[]) {
  window.localStorage.setItem("omb-onboarding-done", "true");
  const engine = {
    instanceId: "muse",
    driverKind: "museAgent",
    displayName: "Meta Muse",
    snapshot: { state: "available" },
    models: { default: "muse-spark", options: [{ id: "muse-spark", label: "Meta Muse" }] },
  };
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path === "/api/bots?messages=200") return new Response(JSON.stringify({ bots, groups: [] }));
    if (path === "/api/instances") return new Response(JSON.stringify({ instances: [engine] }));
    return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  await act(async () => FakeEventSource.current!.onmessage?.({
    data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
    lastEventId: "",
  }));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const sidebarMark = (host: HTMLElement, id: string) =>
  host.querySelector(`[data-sidebar-row-id="${id}"] [data-sidebar-keep-going]`);

describe("keep going mark", () => {
  it("gives simultaneous solid marks separate infinity cutout masks", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement("div", null,
      ...Array.from({ length: 24 }, (_, key) => createElement(KeepGoingMark, { key, state: "on" })),
      createElement(KeepGoingMark, { state: "paused" }),
    ));
    const masks = [...host.querySelectorAll("mask")];
    expect(masks).toHaveLength(24);
    expect(new Set(masks.map((mask) => mask.id)).size).toBe(24);
    for (const mask of masks) {
      expect(mask.id).toMatch(/^kgm[a-zA-Z0-9_-]+$/);
      expect(mask.querySelector("path")?.getAttribute("stroke")).toBe("#000");
      expect(mask.querySelector("path")?.getAttribute("stroke-width")).toBe("1.1");
      expect(mask.parentElement?.querySelector("circle[mask]")?.getAttribute("mask")).toBe(`url(#${mask.id})`);
    }
    const paused = host.querySelector("svg:last-child")!;
    expect(paused.querySelector("mask")).toBeNull();
    expect(paused.querySelector("circle")?.getAttribute("fill")).toBe("none");
    expect(paused.querySelector("path")?.getAttribute("d")).toBe(masks[0].querySelector("path")?.getAttribute("d"));
  });

  it("marks the avatar solid when on, hollow when paused, and not at all when off", async () => {
    const { host, unmount } = await mountApp([
      bot("on", { keepGoing: { paused: null } }),
      bot("paused", { keepGoing: { paused: "no-progress" } }),
      bot("off", { keepGoing: null }),
    ]);
    try {
      await vi.waitFor(() => expect(host.querySelector('[data-sidebar-row-id="off"]')).not.toBeNull());
      expect(sidebarMark(host, "on")?.getAttribute("data-sidebar-keep-going")).toBe("on");
      expect(sidebarMark(host, "on")?.getAttribute("aria-label")).toBe("Agentic Mode on");
      expect(sidebarMark(host, "on")?.querySelector("circle[mask]")?.getAttribute("fill")).toBe("currentColor");
      expect(sidebarMark(host, "paused")?.getAttribute("data-sidebar-keep-going")).toBe("paused");
      expect(sidebarMark(host, "paused")?.getAttribute("aria-label")).toBe("Agentic Mode paused");
      expect(sidebarMark(host, "paused")?.querySelector("circle")?.getAttribute("fill")).toBe("none");
      expect(sidebarMark(host, "off")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("shows the header mark for the open bot and opens its Keep going setting", async () => {
    const { host, unmount } = await mountApp([bot("on", { keepGoing: { paused: null } })]);
    try {
      const mark = () => host.querySelector<HTMLButtonElement>("[data-chat-keep-going]");
      await vi.waitFor(() => expect(mark()).not.toBeNull());
      expect(mark()?.getAttribute("data-chat-keep-going")).toBe("on");
      expect(mark()?.getAttribute("aria-label")).toBe("Agentic Mode on. Turn it off in Bot Details.");
      expect(mark()?.getAttribute("title")).toBe("Agentic Mode on. Turn it off in Bot Details.");
      expect(host.querySelector("[data-settings-keep-going]")).toBeNull();
      const scrolled: Element[] = [];
      vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
        scrolled.push(this);
      });
      await act(async () => mark()!.click());
      await vi.waitFor(() => expect(host.querySelector("[data-settings-keep-going]")).not.toBeNull());
      await vi.waitFor(() => expect(scrolled).toContain(host.querySelector("[data-settings-keep-going]")));
      expect(host.querySelector('[data-settings-keep-going] [role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    } finally {
      await unmount();
    }
  });

  it("labels a paused header mark and drops it when off", async () => {
    const paused = await mountApp([bot("paused", { keepGoing: { paused: "bot-paused" } })]);
    try {
      await vi.waitFor(() => expect(paused.host.querySelector("[data-chat-keep-going]")).not.toBeNull());
      const mark = paused.host.querySelector("[data-chat-keep-going]");
      expect(mark?.getAttribute("aria-label")).toBe("Agentic Mode paused. Turn it off in Bot Details.");
      expect(mark?.getAttribute("title")).toBe("Agentic Mode paused. Turn it off in Bot Details.");
    } finally {
      await paused.unmount();
    }
    const off = await mountApp([bot("off", { keepGoing: null })]);
    try {
      await vi.waitFor(() => expect(off.host.querySelector("[data-orbit-composer]")).not.toBeNull());
      expect(off.host.querySelector("[data-chat-keep-going]")).toBeNull();
    } finally {
      await off.unmount();
    }
  });

  it("says where to turn the header mark off in Korean", async () => {
    window.localStorage.setItem("omb-locale", "ko");
    try {
      for (const [state, text] of [
        ["on", "에이전트 모드 켜짐. 봇 세부 정보에서 끌 수 있어요."],
        ["paused", "에이전트 모드 일시 중지됨. 봇 세부 정보에서 끌 수 있어요."],
      ] as const) {
        const app = await mountApp([bot(state, { keepGoing: { paused: state === "paused" ? "no-progress" : null } })]);
        try {
          await vi.waitFor(() => expect(app.host.querySelector("[data-chat-keep-going]")).not.toBeNull());
          const mark = app.host.querySelector("[data-chat-keep-going]");
          expect(mark?.getAttribute("data-chat-keep-going")).toBe(state);
          expect(mark?.getAttribute("aria-label")).toBe(text);
          expect(mark?.getAttribute("title")).toBe(text);
        } finally {
          await app.unmount();
        }
      }
    } finally {
      window.localStorage.removeItem("omb-locale");
    }
  });
});
