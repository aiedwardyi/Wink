// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const member = (id: string, name: string, instanceId: string): Bot => ({
  id, threadId: `thread-${id}`, name, title: "", description: "",
  notifications: false, color: "blue", unread: false, messages: [], busy: false, activity: "idle",
  modelSelection: { instanceId, model: "m" },
});

const grok = member("grok", "Grok", "text");
const wink = member("wink", "Wink", "vision");

const room = (defaultResponder: Group["defaultResponder"]): Group => ({
  id: "room-i", threadId: "room-thread-i", name: "Launch", memberIds: [grok.id, wink.id], bulletin: "",
  defaultResponder, unread: false, createdAt: 1, setupCompletedAt: 1, messages: [],
});

let unmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function mount(group: Group) {
  const posts: string[] = [];
  localStorage.setItem("omb-draft-attachments", JSON.stringify({
    [`group:${group.id}:${group.threadId}`]: [{ kind: "image", id: "img", path: "/tmp/shot.png", name: "shot.png", size: 3, mime: "image/png" }],
  }));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === "/api/bots?messages=200") return Response.json({ bots: [grok, wink], groups: [group], computerControl: {} });
    if (path === "/api/instances") {
      return Response.json({ instances: [
        { instanceId: "text", capabilities: { images: false } },
        { instanceId: "vision", capabilities: { images: true } },
      ] });
    }
    if (init?.method !== "POST") return Response.json({ error: "not in this test" }, { status: 404 });
    posts.push(JSON.parse(String(init.body)).text);
    return Response.json({ ok: true, threadId: group.threadId }, { status: 202 });
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let store!: ReturnType<typeof useStore>;
  function Probe() {
    store = useStore();
    return createElement(Composer, { group, members: [grok, wink] });
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
  await vi.waitFor(() => expect(store.state.instances).toHaveLength(2));
  const box = host.querySelector("textarea")!;
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = async (value: string) => {
    await type(value);
    await act(async () =>
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })));
  };
  const alert = () => host.querySelector("[role='alert']")?.textContent ?? null;
  return { host, posts, type, send, alert };
}

const refused = "Direct image attachments are not supported by this engine.";

describe("room image notice", () => {
  it("posts a picture no bot answers without the engine notice", async () => {
    const ui = await mount(room({ kind: "mentions" }));
    await ui.send("look at this");
    expect(ui.alert()).toBeNull();
    expect(ui.posts).toHaveLength(1);
  });

  it("refuses a picture for a bot whose engine takes no images", async () => {
    const ui = await mount(room({ kind: "member", botId: grok.id }));
    await ui.send("look at this");
    expect(ui.alert()).toBe(refused);
    expect(ui.posts).toEqual([]);
  });

  it("clears once the line is sent to a bot that takes images", async () => {
    const ui = await mount(room({ kind: "member", botId: grok.id }));
    await ui.send("look at this");
    expect(ui.alert()).toBe(refused);
    await ui.send("@Wink look at this");
    expect(ui.posts).toHaveLength(1);
    expect(ui.alert()).toBeNull();
  });

  it("clears as soon as the text names a bot that takes images", async () => {
    const ui = await mount(room({ kind: "member", botId: grok.id }));
    await ui.send("look at this");
    await ui.type("@Wink look at this");
    expect(ui.alert()).toBeNull();
  });

  it("clears when the picture is removed", async () => {
    const ui = await mount(room({ kind: "member", botId: grok.id }));
    await ui.send("look at this");
    expect(ui.alert()).toBe(refused);
    await act(async () => ui.host.querySelector<HTMLButtonElement>("button[aria-label='Remove image']")!.click());
    expect(ui.alert()).toBeNull();
  });

  it("clears from its X", async () => {
    const ui = await mount(room({ kind: "member", botId: grok.id }));
    await ui.send("look at this");
    await act(async () => ui.host.querySelector<HTMLButtonElement>("[role='alert'] button")!.click());
    expect(ui.alert()).toBeNull();
  });
});
