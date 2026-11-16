// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getRoomHolds } from "@/lib/drafts";
import { StoreProvider, useStore, type Bot, type Group } from "@/state/store";

import { Composer } from "./Composer";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  close = vi.fn();
  constructor() {
    FakeEventSource.last = this;
  }
}

const member = (id: string, name: string, instanceId: string, busy: boolean): Bot => ({
  id, threadId: `thread-${id}`, name, title: "", description: "",
  notifications: false, color: "blue", unread: false, messages: [], busy, activity: busy ? "working" : "idle",
  modelSelection: { instanceId, model: "m" },
});

const room = (busyBotId: string, memberIds: string[]): Group => ({
  id: "room-s", threadId: "room-thread-s", name: "Launch", memberIds, bulletin: "",
  defaultResponder: { kind: "everyone" }, unread: false, createdAt: 1, messages: [],
  working: true, busyBotId,
});

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(members: Bot[], group: Group) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/bots?messages=200") return Response.json({ bots: members, groups: [group], computerControl: {} });
    if (path === "/api/instances") {
      return Response.json({ instances: [{ instanceId: "steers", capabilities: { queueing: true } }, { instanceId: "waits", capabilities: {} }] });
    }
    if (init?.method !== "POST") return Response.json({ error: "not in this test" }, { status: 404 });
    const body = init.body ? JSON.parse(String(init.body)) : {};
    posts.push({ path, body });
    return Response.json({ ok: true, threadId: group.threadId }, { status: 202 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let store!: ReturnType<typeof useStore>;
  function Probe() {
    store = useStore();
    return createElement(Composer, { group, members });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(Probe))));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => {
    FakeEventSource.last!.onmessage!({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "c1" }), lastEventId: "" });
  });
  await vi.waitFor(() => expect(store.state.hydrated).toBe(true));
  await vi.waitFor(() => expect(store.state.instances).toHaveLength(2));
  const box = host.querySelector("textarea")!;
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = async (value: string, init: KeyboardEventInit = {}) => {
    await type(value);
    await act(async () =>
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true, ...init })));
  };
  const sent = () => posts.filter((post) => post.path === `/api/groups/${group.id}/messages`).map((post) => post.body.text);
  const holds = () => getRoomHolds(localStorage, `group:${group.id}:${group.threadId}`).length;
  return { box, host, type, send, sent, holds };
}

const scout = member("scout", "Scout", "steers", true);
const pixel = member("pixel", "Pixel", "steers", false);

describe("busy room Enter", () => {
  it("sends plain Enter into a steering member's turn with 1:1 chrome", async () => {
    const ui = await mount([scout, pixel], room(scout.id, [scout.id, pixel.id]));
    expect(ui.box.placeholder).not.toMatch(/queues/);
    await ui.type("also");
    expect(ui.host.querySelector("button[aria-label='Send now. Ctrl+Enter sends after this turn']")).not.toBeNull();
    await ui.send("also check the tests");
    expect(ui.sent()).toEqual(["also check the tests"]);
    expect(ui.holds()).toBe(0);
  });

  it("holds Ctrl+Enter for after the turn with the Sends next chip", async () => {
    const ui = await mount([scout, pixel], room(scout.id, [scout.id, pixel.id]));
    await ui.send("after this", { ctrlKey: true });
    expect(ui.sent()).toEqual([]);
    expect(ui.holds()).toBe(1);
    expect(ui.host.textContent).toContain("Sends next");
  });

  it("holds a line for another bot until the room settles", async () => {
    const ui = await mount([scout, pixel], room(scout.id, [scout.id, pixel.id]));
    await ui.type("@Pixel take a look");
    expect(ui.host.querySelector("button[aria-label='Send message']")).not.toBeNull();
    await ui.send("@Pixel take a look");
    expect(ui.sent()).toEqual([]);
    expect(ui.holds()).toBe(1);
  });

  it("holds plain Enter when the busy member's engine can't steer, like a 1:1 queue", async () => {
    const waits = member("waits", "Scout", "waits", true);
    const ui = await mount([waits], room(waits.id, [waits.id]));
    expect(ui.box.placeholder).not.toMatch(/queues/);
    await ui.send("later");
    expect(ui.sent()).toEqual([]);
    expect(ui.holds()).toBe(1);
  });
});
