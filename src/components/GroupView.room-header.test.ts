// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestFind } from "@/lib/chat-find";
import { StoreProvider, type Group, type Message } from "@/state/store";

import { GroupView } from "./GroupView";

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

class FakeEventSource {
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
}

const line = (id: string, text: string): Message => ({ id, at: 1, role: "user", kind: "text", text });
const botGroup: Group = {
  id: "g1", threadId: "thread-g1", name: "Wink release crew, Seoul HQ 22", memberIds: ["kai", "ray"],
  defaultResponder: { kind: "everyone" }, bulletin: "", unread: false, createdAt: 1, setupCompletedAt: null, setupSkippedAt: 1,
  hasMore: false, messages: [line("m1", "ship the deploy checklist"), line("m2", "status?")],
};
const mixed: Group = { ...botGroup, id: "g2", threadId: "thread-g2", hosted: { roomId: "r1" }, room: { name: "Wink release crew", people: [{ id: "p1", name: "Mina" }], joins: [] } };

let searches: string[];
const header = (host: HTMLElement) => host.querySelector<HTMLElement>("[class*='@container/chathead']")!;
const findInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Find in this conversation"]');

async function mount(group: Group) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(GroupView, { group }))));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  searches = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (!String(path).startsWith("/api/search")) return new Response("{}", { status: 404 });
    searches.push(String(path));
    const hit = { threadId: "thread-g1", messageId: "m1", at: 1, role: "user", kind: "text", snippet: "ship the deploy checklist", matchStart: 9, matchLength: 6, matches: 1 };
    return new Response(JSON.stringify({ hits: [hit], more: false }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("one room header", () => {
  it.each([["bot group", botGroup], ["room with people", mixed]] as const)("%s: picture, name, bell and side pane, nothing else", async (_kind, group) => {
    const { host, unmount } = await mount(group);
    try {
      const top = header(host);
      expect(top.querySelector("[data-room-title]")!.textContent).toBe(group.name);
      expect(top.querySelector("[data-room-title] [data-room-picture]")).not.toBeNull();
      expect(top.querySelector("[data-room-bell]")).not.toBeNull();
      expect(top.querySelector("[data-show-pane-button]")).not.toBeNull();
      expect(top.querySelector('button[aria-label="Find in conversation"]')).toBeNull();
      expect(top.querySelector("[data-member-id], [data-group-people-faces]")).toBeNull();
      expect(top.textContent).not.toMatch(/folder/i);
      expect([...top.querySelectorAll("[aria-label]")].map((each) => each.getAttribute("aria-label"))).not.toContainEqual(expect.stringMatching(/folder/i));
      expect(host.querySelector("[data-testid=room-setup]")).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("opens a new group straight into the chat", async () => {
    const { host, unmount } = await mount({ ...botGroup, messages: [] });
    try {
      expect(host.querySelector("[data-testid=room-setup]")).toBeNull();
      expect(host.querySelector("[data-orbit-composer]")).not.toBeNull();
    } finally {
      await unmount();
    }
  });
});

describe("find in a group", () => {
  it("Ctrl+F opens the chat find bar, finds a line in this group, and Escape closes it", async () => {
    const { unmount } = await mount(botGroup);
    try {
      expect(findInput()).toBeNull();
      await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true })); });
      const input = findInput()!;
      expect(input.closest("[data-chat-find]")).not.toBeNull();
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "deploy");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
      expect(searches.at(-1)).toContain("q=deploy");
      expect(searches.at(-1)).toContain("threadId=thread-g1");
      expect(document.querySelector("[data-chat-find]")!.textContent).toContain("1 of 1");
      await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(findInput()).toBeNull();
    } finally {
      await unmount();
    }
  });

  it("opens the same find bar when Room details asks", async () => {
    const { unmount } = await mount(botGroup);
    try {
      await act(async () => requestFind());
      expect(findInput()).not.toBeNull();
    } finally {
      await unmount();
    }
  });
});
