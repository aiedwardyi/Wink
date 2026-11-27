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
const routine: Message = { id: "r1", at: 3, role: "bot", kind: "routine.run", text: "", parentId: null, routineRun: { runId: "r", routineId: "x", routineName: "Morning brief", status: "completed" } };
const brief: Message = { id: "r2", at: 4, role: "bot", kind: "text", text: "Here is your morning brief.", parentId: "r1" };
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

async function mount(current: Bot, aboutYou: { sources: unknown[]; declined: boolean; imported?: boolean }, post?: (url: string) => Response, hold?: Promise<void>) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/about-you") && !init?.method) await hold;
    return url === "/api/bots?messages=200"
    ? Response.json({ bots: [current], groups: [], computerControl: {} })
    : init?.method === "POST" && post ? post(url)
    : url.startsWith("/api/about-you") ? Response.json(aboutYou) : new Response("{}", { status: 404 });
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

it("a chat with any message shows no row, even when nothing was typed", async () => {
  const host = await mount(bot([routine, brief]), { sources: [], declined: false });
  expect(host.textContent).toContain("Here is your morning brief.");
  expect(host.querySelector("[data-import-card]")).toBeNull();
});

it("the row does not come back after an Only this bot import", async () => {
  const aboutYou = { sources: [], declined: false, imported: false };
  const post = (url: string) => {
    if (url !== "/api/bots/helper/memory/import") return new Response("{}", { status: 404 });
    aboutYou.imported = true;
    return Response.json({ source: "ChatGPT", found: 1, added: 1, duplicates: 0, hidden: 0 });
  };
  const host = await mount(bot([]), aboutYou, post);
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
  await click(host.querySelector("[data-import-card] button[aria-expanded]"));
  const box = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "- Plays cello on Sundays.\nSource: ChatGPT");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click([...host.querySelectorAll("[role=radio]")].find((radio) => radio.textContent === "Only this bot"));
  await click([...host.querySelectorAll("button")].find((button) => button.textContent === "Add to memory"));
  expect(host.querySelector("[data-import-saved]")?.textContent).toContain("This bot");
  await unmount?.();
  const again = await mount(bot([]), aboutYou, post);
  expect(again.querySelector("[data-import-card]")).toBeNull();
});

it("no row once Import Memory has content or the row was dismissed", async () => {
  const filled = await mount(bot([]), { sources: [{ source: "ChatGPT", facts: ["x"] }], declined: false });
  expect(filled.querySelector("[data-import-card]")).toBeNull();
  await unmount?.();
  const declined = await mount(bot([]), { sources: [], declined: true });
  expect(declined.querySelector("[data-import-card]")).toBeNull();
});

it("a dismissed row stays gone when its slow lookup answers afterwards", async () => {
  // an earlier answer already said the row is on offer, so the next chat paints it before its own answer arrives
  const other = { ...bot([]), id: "dismisser", threadId: "thread-dismisser" };
  await mount(other, { sources: [], declined: false });
  await unmount?.();
  let answer!: () => void;
  const slow = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const host = await mount(other, { sources: [], declined: false }, undefined, slow);
  expect(host.querySelector("[data-import-card]")).not.toBeNull();
  // SAFETY: the selector names the dismiss button, an HTMLElement.
  await act(async () => (host.querySelector("[data-import-card] button[aria-label=\"Don't import\"]") as HTMLElement).click());
  expect(host.querySelector("[data-import-card]")).toBeNull();
  await act(async () => {
    answer();
    await slow;
  });
  expect(host.querySelector("[data-import-card]")).toBeNull();
});
