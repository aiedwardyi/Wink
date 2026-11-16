// @vitest-environment happy-dom
import { act, createElement, useEffect, type Dispatch } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Action, type Bot, type Message } from "@/state/store";

import { ChatView } from "./ChatView";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

// ADEMark A11: one prompt, 1,000 short steps each followed by a Read.
function longThread(): Message[] {
  const rows: Message[] = [{ id: "ask", at: 1, role: "user", kind: "text", text: "replay:long-2000" }];
  for (let i = 1; i <= 1000; i++) {
    rows.push({ id: `t${i}`, at: 2 * i, role: "bot", kind: "text", text: `Step ${i} of 1000.` });
    rows.push({ id: `r${i}`, at: 2 * i + 1, role: "bot", kind: "activity", tool: { name: "Read", summary: "src/invoices.ts", ok: true } });
  }
  rows.push({ id: "end", at: 3000, role: "bot", kind: "text", text: "LONGTHREAD-END." });
  return rows.map((message, i) => (i ? { ...message, parentId: rows[i - 1]!.id } : message));
}

const thread = longThread();
// a chat off screen at boot comes back as a short tail (server/chat-tail.ts)
const long = (tail: number) => ({
  id: "long", threadId: "thread-long", name: "Long", title: "", description: "", notifications: false,
  color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages: thread.slice(-tail), hasMore: true,
}) as unknown as Bot;
const hydrate = (bot: Bot) => ({ type: "hydrate", bots: [bot], groups: [], computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } }) as never;

const harness: { dispatch?: Dispatch<Action> } = {};

function View() {
  const { state, dispatch } = useStore();
  harness.dispatch = dispatch;
  useEffect(() => dispatch(hydrate(long(30))), [dispatch]);
  const live = state.bots[0];
  return live ? createElement(ChatView, { bot: live }) : null;
}

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  const pages: string[] = [];
  const waiting: (() => void)[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const page = String(url).match(/^\/api\/threads\/thread-long\/messages\?limit=(\d+)&before=(\w+)(?:&pages=(\d+))?$/);
    if (!page) return new Response("{}", { status: 404 });
    pages.push(String(url));
    const stop = thread.findIndex((message) => message.id === page[2]);
    const start = Math.max(0, stop - Number(page[1]) * Number(page[3] ?? 1));
    await new Promise<void>((resolve) => waiting.push(resolve));
    return Response.json({ messages: thread.slice(start, stop), hasMore: start > 0 });
  }));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = async () => {
    for (const release of waiting) release();
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(createElement(StoreProvider, null, createElement(View))));
  return { host, pages, waiting };
}

describe("ChatView prompt hunt", () => {
  it("lands the hunt for a far prompt with the page that fills the tail, never under a reader", async () => {
    const { host, pages, waiting } = await open();
    expect(pages).toHaveLength(1);
    await act(async () => waiting.shift()!());
    await vi.waitFor(() => expect(host.querySelectorAll("[data-orbit-message]").length).toBeGreaterThan(30));
    await act(async () => {});
    // every later landing re-renders the chat while its rows sit still: a long frame mid-scroll
    expect(pages).toHaveLength(1);
  });

  it("hunts again from a snapshot's new tail when it replaces the one still being paged", async () => {
    const { pages, waiting } = await open();
    expect(pages).toEqual(["/api/threads/thread-long/messages?limit=200&before=r986&pages=3"]);
    await act(async () => harness.dispatch!(hydrate(long(40))));
    expect(pages.at(-1)).toBe("/api/threads/thread-long/messages?limit=200&before=r981&pages=3");
    await act(async () => waiting.splice(0).forEach((release) => release()));
    await act(async () => {});
    expect(pages).toHaveLength(2);
  });
});
