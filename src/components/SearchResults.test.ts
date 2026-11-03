// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { StoreProvider } from "@/state/store";

import { SearchResults } from "./SearchResults";

class FakeEventSource {
  static current: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    FakeEventSource.current = this;
  }
}

afterEach(() => {
  applyLocale("en");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SearchResults", () => {
  it("drops hits inside a hidden bot-to-bot channel and keeps the rest", async () => {
    const mirrored = { id: "m1", role: "bot", kind: "text", at: 1, text: "hi", from: { botId: "wink", name: "Wink", color: "blue" } };
    const sent = { id: "m2", role: "user", kind: "text", at: 2, text: "hello" };
    const group = (id: string, name: string, dm: boolean, messages: unknown[]) =>
      ({ id, threadId: `${id}-thread`, name, memberIds: [], messages, dm });
    const hit = (id: string, extra: Record<string, string>) => ({
      threadId: `${id}-thread`, messageId: id, name: id, role: "user", kind: "text", at: 1,
      snippet: `needle in ${id}`, matchStart: 0, matchLength: 6, onActivePath: true, ...extra,
    });
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/bots?messages=200") {
          return new Response(JSON.stringify({
            bots: [{ id: "bot-1", name: "Chat bot", color: "#fff", messages: [] }],
            groups: [
              group("room-1", "Launch room", false, []),
              group("dm-hidden", "Career and Wink", true, [mirrored]),
              group("dm-joined", "Joined channel", true, [mirrored, sent]),
            ],
          }));
        }
        if (path.startsWith("/api/search")) {
          return new Response(JSON.stringify({
            hits: [
              hit("hidden-hit", { groupId: "dm-hidden" }),
              hit("room-hit", { groupId: "room-1" }),
              hit("bot-hit", { botId: "bot-1" }),
              hit("joined-hit", { groupId: "dm-joined" }),
            ],
          }));
        }
        return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(StoreProvider, null, createElement(SearchResults, { query: "needle", onLanded: () => {} }))));
      await act(async () => FakeEventSource.current!.onmessage?.({
        data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
        lastEventId: "",
      }));
      await vi.waitFor(() => expect(host.textContent).toContain("needle in room-hit"));
      expect(host.textContent).toContain("needle in bot-hit");
      expect(host.textContent).toContain("needle in joined-hit");
      expect(host.textContent).not.toContain("needle in hidden-hit");
      expect(host.textContent).toContain("3");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("SearchResults in Korean", () => {
  async function mountSearch(search: () => Response) {
    applyLocale("ko");
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/api/bots?messages=200") return new Response(JSON.stringify({ bots: [], groups: [] }));
      if (path.startsWith("/api/search")) return search();
      return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
    }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(StoreProvider, null, createElement(SearchResults, { query: "needle", onLanded: () => {} }))));
    await act(async () => FakeEventSource.current!.onmessage?.({
      data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c0" }),
      lastEventId: "",
    }));
    return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
  }

  it("prefixes a search failure in Korean", async () => {
    const { host, unmount } = await mountSearch(() => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("검색하지 못했어요"));
      expect(host.textContent).not.toContain("couldn't search");
    } finally {
      await unmount();
    }
  });

  it("badges a hit from another version in Korean", async () => {
    const hit = {
      threadId: "t1", messageId: "m1", name: "Old", role: "user", kind: "text", at: 1,
      snippet: "needle here", matchStart: 0, matchLength: 6, onActivePath: false,
    };
    const { host, unmount } = await mountSearch(() => new Response(JSON.stringify({ hits: [hit] })));
    try {
      await vi.waitFor(() => expect(host.textContent).toContain("다른 버전"));
      expect(host.textContent).not.toContain("other version");
    } finally {
      await unmount();
    }
  });
});
