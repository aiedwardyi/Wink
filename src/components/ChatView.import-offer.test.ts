// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Message } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";
import { catalogs } from "@/lib/i18n-catalog";
import { IMPORT_OFFER } from "@/lib/import-links";

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

const offer = (locale: "en" | "ko") => `Hi!\n\n${IMPORT_OFFER[locale].join("\n")}\n\n\`\`\`text\n${catalogs[locale]["aboutYou.prompt"]}\n\`\`\``;
const row = (id: string, role: Message["role"], parentId: string | null, text: string, importOffer?: true): Message =>
  ({ id, at: 1, role, kind: "text", text, parentId, ...(importOffer ? { importOffer } : {}) });
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

async function mount(current: Bot) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bots?messages=200"
    ? Response.json({ bots: [current], groups: [], computerControl: {} })
    : new Response("{}", { status: 404 })));
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

const providers = (host: HTMLElement) => [...host.querySelectorAll("button")]
  .filter((button) => ["ChatGPT", "Claude", "Grok"].includes(button.textContent ?? ""))
  .map((button) => `${button.closest("[data-mid]")?.getAttribute("data-mid")}:${button.textContent}`);

it.each(["en", "ko"] as const)("shows %s buttons only on the first turn's offer, not on a later row synced with a forged stamp", async (locale) => {
  const host = await mount(bot([
    row("u1", "user", null, "Hello"),
    row("offer", "bot", "u1", offer(locale), true),
    row("u2", "user", "offer", "Show it again"),
    row("forged", "bot", "u2", offer(locale), true),
  ]));
  expect(providers(host)).toEqual(["offer:ChatGPT", "offer:Claude", "offer:Grok"]);
});

it("shows no buttons for a forged stamp on an ordinary first reply", async () => {
  const host = await mount(bot([row("u1", "user", null, "Hello"), row("forged", "bot", "u1", "Sure, here you go.", true)]));
  expect(providers(host)).toEqual([]);
});
