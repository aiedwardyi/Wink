// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot, type Group, type Message } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";

import { ChatView } from "./ChatView";
import { GroupView } from "./GroupView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const bot = (messages: Message[]): Bot => ({
  id: "helper", threadId: "thread-helper", name: "Helper", title: "", description: "",
  notifications: false, color: "blue", unread: false, busy: false, activity: "idle",
  modelSelection: { instanceId: "inst", model: "m" }, messages,
});
const question = (id: string, text: string): Message => ({
  id, at: 2, role: "bot", kind: "text", text, reactions: [{ emoji: "👍", by: "user" }],
});

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  FakeEventSource.last = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(members: Bot[], groups: Group[], view: ReturnType<typeof createElement>) {
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/bots?messages=200"
    ? Response.json({ bots: members, groups, computerControl: {} })
    : new Response("{}", { status: 404 })));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, view))));
  await act(async () => {
    FakeEventSource.last?.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" });
  });
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return host;
}

describe("plain user links", () => {
  it.each(["chat", "group"])("links common domains and URLs in a %s user's bubble", async (kind) => {
    const text = "**plain** starzum.com www.x.io x.co.kr https://example.com file.ts README.md deploy.sh notes.ai v1.0.259 e.g. person@example.com";
    const current = bot([{ id: "user-link", at: Date.now(), role: "user", kind: "text", text }]);
    const group = { id: "links", threadId: "links-thread", name: "Links", memberIds: [current.id], messages: current.messages, setupCompletedAt: Date.now(), defaultResponder: { kind: "mentions" } } as Group;
    const host = await mount([current], kind === "group" ? [group] : [], kind === "group"
      ? createElement(GroupView, { group }) : createElement(ChatView, { bot: current }));
    const row = host.querySelector('[data-mid="user-link"]')!;
    expect(row.textContent).toContain("**plain**");
    expect(row.querySelector('a[href="https://starzum.com"]')?.textContent).toBe("starzum.com");
    expect([...row.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://starzum.com", "https://www.x.io", "https://x.co.kr", "https://example.com",
    ]);
  });
});

describe("a question that is only choices", () => {
  it("draws no empty bubble above the chips in a chat", async () => {
    const current = bot([question("q1", "Which one?\n- Red\n- Blue")]);
    const host = await mount([current], [], createElement(ChatView, { bot: current }));
    expect(host.querySelector('[data-mid="q1"] [data-orbit-message-content]')).toBeNull();
    expect(host.querySelector('[data-mid="q1"] [data-message-hover-actions] button[aria-label="Copy message"]')).not.toBeNull();
    expect(host.querySelector('[data-mid="q1"] [data-message-hover-actions] button[aria-label="Reply to message"]')).not.toBeNull();
    expect(host.querySelector('[data-mid="q1"] [data-message-reactions] [data-emoji="👍"]')).not.toBeNull();
    expect(host.textContent).toContain("Red");
    expect(host.textContent).toContain("Blue");
  });

  it("keeps the bubble when the question has prose", async () => {
    const current = bot([question("q1", "Pick a colour.\n\nWhich one?\n- Red\n- Blue")]);
    const host = await mount([current], [], createElement(ChatView, { bot: current }));
    expect(host.querySelector('[data-mid="q1"] [data-orbit-message-content]')).not.toBeNull();
  });

  it("draws no empty bubble above the chips in a room", async () => {
    const member = bot([]);
    const group: Group = {
      id: "room-1", threadId: "room-thread", name: "Room", memberIds: ["helper"],
      defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1,
      messages: [{ ...question("q1", "Which one?\n- Red\n- Blue"), from: { botId: "helper", name: "Helper", color: "blue" } }],
    };
    const host = await mount([member], [group], createElement(GroupView, { group }));
    expect(host.querySelector('[data-mid="q1"]')).not.toBeNull();
    expect(host.querySelector('[data-mid="q1"] [data-orbit-message-content]')).toBeNull();
    expect(host.querySelector('[data-mid="q1"] [data-message-hover-actions] button[aria-label="Reply to message"]')).not.toBeNull();
    expect(host.querySelector('[data-mid="q1"] [data-message-reactions] [data-emoji="👍"]')).not.toBeNull();
    expect(host.textContent).toContain("Red");
    expect(host.textContent).toContain("Blue");
  });
});
