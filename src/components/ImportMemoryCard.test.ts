// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Message } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";

import { ChatView } from "./ChatView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const quiz: Message = { id: "quiz", at: 1, role: "bot", kind: "options", parentId: null, card: { title: "What do you mostly want help with?", subtitle: "Pick one", options: ["Work & projects", "Life admin"] } };
const typed: Message = { id: "u1", at: 2, role: "user", kind: "text", text: "hi", parentId: null };
const bot = (messages: Message[]): Bot => ({
  id: "helper", threadId: "thread-helper", name: "Helper", title: "", description: "", notifications: false,
  color: "blue", unread: false, busy: false, activity: "idle", modelSelection: { instanceId: "inst", model: "m" }, messages, activeLeafId: messages.at(-1)?.id,
});

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(current: Bot, aboutYou: { sources: unknown[]; declined: boolean }) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bots?messages=200"
    ? Response.json({ bots: [current], groups: [], computerControl: {} })
    : url === "/api/about-you" ? Response.json(aboutYou) : new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(ChatView, { bot: current })))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => {
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" });
  });
  return host;
}

it("a new chat shows only the import row before message 1, and no starter quiz", async () => {
  const host = await mount(bot([quiz]), { sources: [], declined: false });
  expect(host.querySelector("[data-import-card]")?.textContent).toContain("Bring your memory from another AI");
  expect(host.textContent).not.toContain("What do you mostly want help with?");
  expect(host.textContent).not.toContain("Work & projects");
});

it("typing a message hides the row", async () => {
  const host = await mount(bot([typed]), { sources: [], declined: false });
  expect(host.querySelector("[data-import-card]")).toBeNull();
});

it("no row once Import Memory has content or the row was dismissed", async () => {
  const filled = await mount(bot([]), { sources: [{ source: "ChatGPT", facts: ["x"] }], declined: false });
  expect(filled.querySelector("[data-import-card]")).toBeNull();
  await unmount?.();
  const declined = await mount(bot([]), { sources: [], declined: true });
  expect(declined.querySelector("[data-import-card]")).toBeNull();
});
