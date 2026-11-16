import "@/components/ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import { ChatPeekPart } from "@/lib/chat-preview";
import { SWIPE_MOTION_MS } from "@/lib/phone-swipe";
import { SIDEBAR_ORDER_KEY } from "@/lib/sidebar-preferences";
import { UNASSIGNED_SECTION_ID, sidebarItemKey } from "@/lib/sidebar-order";
import { SNAPSHOT_CACHE_KEY } from "@/state/snapshot-cache";
import App from "./App";

vi.mock("@/components/ChatView", () => ({
  warmCallViews: async () => [],
  ChatView: ({ bot }: { bot: Bot }) => createElement("main", { "data-test-chat": bot.id },
    createElement("h1", null, bot.name),
    ...bot.messages.map((message) => createElement("p", { key: message.id }, message.text)),
    createElement(ChatPeekPart, { part: "composer", children: createElement("footer") }),
  ),
}));
vi.mock("@/components/GroupView", () => ({
  GroupView: ({ group }: { group: Group }) => createElement("main", { "data-test-chat": group.id },
    createElement("h1", null, group.name),
    ...group.messages.map((message) => createElement("p", { key: message.id }, message.text)),
  ),
}));

let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;

const chat = (id: string) => host.querySelector<HTMLElement>(`[data-test-chat="${id}"]`);
const mountedChats = () => [...host.querySelectorAll<HTMLElement>("[data-test-chat]")].map((node) => node.dataset.testChat);
const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

async function mount(selectedId: string, emptyId?: string, room = false) {
  const order = room ? ["a", "room", "b", "c"] : ["a", "b", "c"];
  localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify({ sectionOrder: [], itemOrder: { [UNASSIGNED_SECTION_ID]: order.map((id) => sidebarItemKey(id === "room" ? "group" : "bot", id)) } }));
  localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({
    bots: ["a", "b", "c"].map((id) => ({
      id, threadId: `thread-${id}`, name: id.toUpperCase(), title: "", description: "", color: "purple",
      notifications: false, unread: false, modelSelection: { instanceId: "inst", model: "m" },
      messages: id === emptyId ? [] : [{ id: `last-${id}`, at: 1, role: "user", kind: "text", text: `Cached tail ${id}` }],
    })),
    groups: room ? [{
      id: "room", threadId: "thread-room", name: "Room", memberIds: ["a", "b"], defaultResponder: { kind: "everyone" },
      bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1,
      messages: [{ id: "last-room", at: 1, role: "user", kind: "text", text: "Cached room message" }],
    }] : [],
    selectedId,
  }));
  await act(async () => root.render(createElement(App)));
  expect([...document.querySelectorAll("[data-sidebar-row-id]")].map((row) => row.getAttribute("data-sidebar-row-id"))).toEqual(order);
  expect(mountedChats()).toEqual([selectedId]);
}

async function touch(type: string, x: number, y: number, timeStamp: number, target: HTMLElement) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: type === "touchend" || type === "touchcancel" ? [] : [{ clientX: x, clientY: y }] });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  await act(async () => { target.dispatchEvent(event); });
}

const frame = () => act(async () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
});

async function drag(id: string, from: number, to: number) {
  const target = chat(id)!;
  await touch("touchstart", from, 300, 0, target);
  await touch("touchmove", to, 300, 1000, target);
  await frame();
  return target;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", window.localStorage);
  (window as unknown as { happyDOM: { setViewport(value: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 392, height: 844 });
  localStorage.setItem("omb-onboarding-done", "true");
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("EventSource", class { onmessage = null; close = vi.fn(); });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  frames = new Map();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllGlobals();
  (window as unknown as { happyDOM: { setViewport(value: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1024, height: 800 });
});

describe("phone chat peek", () => {
  it.each([
    [300, 150, "c"],
    [100, 250, "a"],
  ] as const)("shows the sidebar neighbor during a drag from %i to %i", async (from, to, neighbor) => {
    await mount("b");
    await drag("b", from, to);
    expect(mountedChats().sort()).toEqual(["b", neighbor].sort());
    expect(chat(neighbor)?.textContent).toContain(`Cached tail ${neighbor}`);
  });

  it.each([
    ["a", 100, 250],
    ["c", 300, 150],
  ] as const)("keeps only the current chat beyond the %s end", async (id, from, to) => {
    await mount(id);
    await drag(id, from, to);
    expect(mountedChats()).toEqual([id]);
  });

  it("mounts the neighbor a part every other frame, leaving each part's paint frame alone", async () => {
    await mount("b");
    const target = chat("b")!;
    expect(target.querySelector("footer")).not.toBeNull();
    await touch("touchstart", 300, 300, 0, target);
    await touch("touchmove", 140, 300, 1000, target);
    const incoming = chat("c");
    expect(incoming?.querySelector("h1")?.textContent).toBe("C");
    for (let painted = 1; painted <= 3; painted++) {
      await frame();
      expect(incoming?.querySelector("footer")).toBeNull();
    }
    await frame();
    expect(incoming?.querySelector("footer")).not.toBeNull();
  });

  it("completes a neighbor that lands before its parts mount", async () => {
    await mount("b");
    const target = chat("b")!;
    await touch("touchstart", 300, 300, 0, target);
    await touch("touchmove", 140, 300, 1000, target);
    const incoming = chat("c");
    expect(incoming?.querySelector("footer")).toBeNull();
    await touch("touchend", 140, 300, 2000, target);
    await wait(SWIPE_MOTION_MS + 80);
    expect(chat("c")).toBe(incoming);
    expect(mountedChats()).toEqual(["c"]);
    expect(incoming?.querySelector("footer")).not.toBeNull();
  });

  it("restages the neighbor when the drag reverses", async () => {
    await mount("b");
    const target = await drag("b", 200, 100);
    for (let painted = 2; painted <= 4; painted++) await frame();
    expect(chat("c")?.querySelector("footer")).not.toBeNull();
    await touch("touchmove", 300, 300, 2000, target);
    expect(chat("a")).not.toBeNull();
    expect(chat("a")?.querySelector("footer")).toBeNull();
  });

  it("replaces the peek when the drag reverses across its origin", async () => {
    await mount("b");
    const target = await drag("b", 200, 100);
    expect(chat("c")).not.toBeNull();
    await touch("touchmove", 300, 300, 2000, target);
    expect(mountedChats().sort()).toEqual(["a", "b"]);
  });

  it.each(["touchend", "touchcancel"])("releases the neighbor after a short drag ends with %s", async (end) => {
    await mount("b");
    const target = await drag("b", 300, 270);
    expect(chat("c")).not.toBeNull();
    await touch(end, 270, 300, 2000, target);
    await wait(SWIPE_MOTION_MS + 80);
    expect(mountedChats()).toEqual(["b"]);
  });

  it("does not create a peek after locking to vertical scroll", async () => {
    await mount("b");
    const target = chat("b")!;
    await touch("touchstart", 300, 300, 0, target);
    await touch("touchmove", 298, 340, 1000, target);
    await touch("touchmove", 150, 350, 2000, target);
    expect(mountedChats()).toEqual(["b"]);
  });

  it("passes an uncached neighbor through with its header and no messages", async () => {
    await mount("b", "c");
    await drag("b", 300, 150);
    expect(chat("c")?.querySelector("h1")?.textContent).toBe("C");
    expect(chat("c")?.querySelectorAll("p")).toHaveLength(0);
  });

  it("keeps desktop switching outside the phone pager", async () => {
    (window as unknown as { happyDOM: { setViewport(value: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1440, height: 900 });
    await mount("b");
    const target = await drag("b", 300, 140);
    await touch("touchend", 140, 300, 2000, target);
    await wait(SWIPE_MOTION_MS + 80);
    expect(mountedChats()).toEqual(["b"]);
  });

  it("keeps the incoming transcript mounted through landing and releases the outgoing one", async () => {
    await mount("b");
    const target = await drag("b", 300, 140);
    const incoming = chat("c");
    expect(incoming).not.toBeNull();
    expect(incoming?.closest("[data-phone-chat-page]")?.querySelector("button[aria-expanded]")).not.toBeNull();
    expect(host.querySelectorAll("[data-phone-menu]")).toHaveLength(1);
    await touch("touchend", 140, 300, 2000, target);
    await wait(SWIPE_MOTION_MS + 80);
    expect(chat("c")).toBe(incoming);
    expect(mountedChats()).toEqual(["c"]);
    for (let node = incoming; node && host.contains(node); node = node.parentElement) {
      expect(node.getAnimations?.() ?? []).toHaveLength(0);
    }
  });

  it.each([
    ["a", "room", 300, 140],
    ["room", "b", 300, 140],
    ["b", "room", 100, 260],
    ["room", "a", 100, 260],
  ] as const)("peeks and lands from %s to %s in sidebar order", async (fromId, toId, from, to) => {
    await mount(fromId, undefined, true);
    const target = await drag(fromId, from, to);
    const incoming = chat(toId);
    expect(incoming).not.toBeNull();
    expect(incoming?.textContent).toContain(toId === "room" ? "Cached room message" : `Cached tail ${toId}`);
    await touch("touchend", to, 300, 2000, target);
    await wait(SWIPE_MOTION_MS + 80);
    expect(chat(toId)).toBe(incoming);
    expect(mountedChats()).toEqual([toId]);
  });
});
