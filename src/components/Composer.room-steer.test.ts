// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createGroupRoutes } from "../../server/group-routes.ts";
import { SendSequencer } from "../../server/send-idempotency.ts";
import { Store as BackendStore } from "../../server/store.ts";

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

async function mount(members: Bot[], group: Group, post?: (body: Record<string, unknown>) => Promise<Response>) {
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
    if (post) return post(body);
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
  const setGroup = (next: Group) => act(async () => {
    group = next;
    root.render(createElement(StoreProvider, null, createElement(Probe)));
  });
  return { box, host, type, send, sent, holds, setGroup };
}

const scout = member("scout", "Scout", "steers", true);
const pixel = member("pixel", "Pixel", "steers", false);

describe("busy room Enter", () => {
  it("gate 2: sends both held lines when the first answers the free-text card", async () => {
    const backend = new BackendStore(() => ({ instanceId: "steers", model: "m" }));
    const asker = backend.createBot({}, { seedMessages: false });
    const group = backend.createGroup("Release", [asker.id]);
    const question = backend.appendMessage(group.threadId, { role: "bot", kind: "options", from: { botId: asker.id, name: asker.name, color: asker.color }, card: { title: "Q", subtitle: "When should we ship?", options: [], askUser: true, staysOpen: true } });
    const routes = createGroupRoutes({
      store: backend, sendSequencer: new SendSequencer(), resolveReplyTarget: () => undefined,
      groupIsWorking: () => false, instanceForBot: () => ({ adapter: { capabilities: {} } }), userName: () => "Edward",
      startGroupTurn: (_id: string, text: string, _reply: unknown, sendId?: string, _asker?: string, answersCard?: string, _files?: unknown, actedAt?: number) => backend.appendMessage(group.threadId, { role: "user", kind: "text", text, sendId, answersCard, actedAt }),
    } as unknown as Parameters<typeof createGroupRoutes>[0]);
    const post = async (body: Record<string, unknown>) => {
      let status = 0;
      let response = {};
      const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (raw: string) => { response = JSON.parse(raw); } } as unknown as ServerResponse;
      try { await routes.postMessage(Readable.from([JSON.stringify(body)]) as IncomingMessage, res, ["", group.id] as RegExpMatchArray); }
      catch (error) { status = (error as { status?: number }).status ?? 500; response = { error: (error as Error).message }; }
      return Response.json(response, { status });
    };
    const busy = { ...group, messages: [question], busyBotId: asker.id, working: true } as Group;
    const ui = await mount([asker as unknown as Bot], busy, post);
    await ui.send("Friday", { ctrlKey: true });
    await ui.send("Ship after lunch", { ctrlKey: true });
    expect(ui.holds()).toBe(2);
    await ui.setGroup({ ...busy, busyBotId: null, working: false });
    expect(backend.messagesFor(group.threadId).filter((message) => message.role === "user")).toHaveLength(1);
    await ui.setGroup({ ...busy, messages: backend.messagesFor(group.threadId) as Group["messages"] });
    await ui.setGroup({ ...busy, messages: backend.messagesFor(group.threadId) as Group["messages"], busyBotId: null, working: false });
    const delivered = backend.messagesFor(group.threadId).filter((message) => message.role === "user");
    expect(delivered.map((message) => message.text)).toEqual(["Friday", "Ship after lunch"]);
    expect(delivered[0]!.answersCard).toBe(question.id);
    expect(delivered[1]!.answersCard).toBeUndefined();
  });

  it("sends plain Enter into a steering member's turn with 1:1 chrome", async () => {
    const ui = await mount([scout, pixel], room(scout.id, [scout.id, pixel.id]));
    expect(ui.box.placeholder).not.toMatch(/queues/);
    await ui.type("also");
    expect(ui.host.querySelector("button[aria-label='Send now. Ctrl+Enter sends after this turn']")).not.toBeNull();
    await ui.send("also check the tests");
    expect(ui.sent()).toEqual(["also check the tests"]);
    expect(ui.holds()).toBe(0);
  });

  it("holds Ctrl+Enter for after the turn", async () => {
    const ui = await mount([scout, pixel], room(scout.id, [scout.id, pixel.id]));
    await ui.send("after this", { ctrlKey: true });
    expect(ui.sent()).toEqual([]);
    expect(ui.holds()).toBe(1);
  });

  it("posts a line for another bot at once, without a hold", async () => {
    const ui = await mount([scout, pixel], room(scout.id, [scout.id, pixel.id]));
    await ui.type("@Pixel take a look");
    expect(ui.host.querySelector("button[aria-label='Send message']")).not.toBeNull();
    await ui.send("@Pixel take a look");
    expect(ui.sent()).toEqual(["@Pixel take a look"]);
    expect(ui.holds()).toBe(0);
    expect(ui.host.textContent).not.toContain("Sends next");
  });

  it("posts plain Enter at once when the busy member's engine can't steer", async () => {
    const waits = member("waits", "Scout", "waits", true);
    const ui = await mount([waits], room(waits.id, [waits.id]));
    expect(ui.box.placeholder).not.toMatch(/queues/);
    await ui.send("later");
    expect(ui.sent()).toEqual(["later"]);
    expect(ui.holds()).toBe(0);
  });
});
