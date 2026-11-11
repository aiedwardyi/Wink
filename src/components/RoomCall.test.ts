// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";
import type { LiveEvents } from "@/lib/live-call/engine";
import type { TeamRoom } from "@/lib/team-rooms";
import { TeamRoomView } from "./TeamRoomView";

const fakes = vi.hoisted(() => ({ engines: [] as Array<{ events: LiveEvents; contexts: string[] }>, capture: vi.fn() }));
vi.mock("@/lib/live-call/gemini", () => ({ GeminiLive: class {
  events!: LiveEvents;
  contexts: string[] = [];
  connect(_session: unknown, events: LiveEvents) { this.events = events; fakes.engines.push(this); }
  sendAudio() {}
  audioPaused() {}
  sendText() {}
  sendContext(text: string) { this.contexts.push(text); }
  sendToolResult() {}
  close() {}
} }));
vi.mock("@/lib/live-call/audio", () => ({ CallAudio: class {
  playing = false;
  onIdle = () => {};
  onStart = () => {};
  async capture() { fakes.capture(); }
  play() {}
  flush() {}
  close() {}
  heardShare() { return 1; }
  level() { return 0; }
} }));

const bot = (id: string, chiefOfStaff = false, hidden = false) => ({ id, threadId: `${id}-thread`, name: id, messages: [], chiefOfStaff, hidden, modelSelection: { instanceId: "claude", model: "default" } }) as unknown as Bot;
const group = { id: "launch", threadId: "room-thread", name: "Launch", memberIds: [], hosted: { roomId: "room-launch" }, messages: [], room: { people: [] } } as unknown as TeamRoom;
let store: ReturnType<typeof useStore>;
let unmount: (() => Promise<void>) | undefined;
const posts: Array<{ path: string; body: any }> = [];

async function mount(bots = [bot("first"), bot("Wink", true)], key = true, intro = true, locale = "en") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class { close() {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } });
  localStorage.setItem("omb-locale", locale);
  if (intro) localStorage.setItem("wink.liveCall.intro", "1");
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push({ path, body: JSON.parse(String(init.body)) });
    if (path.endsWith("/call/token")) return Response.json(key ? { callId: "c-0123456789ab", token: "fake", url: "wss://fixture.invalid", model: "fake" } : {}, { status: key ? 200 : 409 });
    if (path === "/api/tts/prepare") return Response.json({ utterances: [JSON.parse(String(init?.body)).text] });
    if (/\/call\/(lines|end)$/.test(path)) return Response.json({ ok: true });
    if (path.endsWith("/send")) return Response.json({ ok: true });
    return new Promise<Response>(() => {});
  }));
  function Probe() { store = useStore(); return createElement(TeamRoomView, { group }); }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(Probe)))));
  await act(async () => {
    store.dispatch({ type: "hydrate", bots, groups: [group], botsUnreadable: false, computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } } as never);
    store.dispatch({ type: "configStatus", config: { gemini: { configured: key } } as never });
  });
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  return host;
}

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  localStorage.clear();
  posts.length = 0;
  fakes.engines.length = 0;
  fakes.capture.mockClear();
  vi.unstubAllGlobals();
});

describe("room call", () => {
  it("calls the lead bot and folds its private reply into the room post offer", async () => {
    const host = await mount();
    const call = host.querySelector<HTMLButtonElement>('[aria-label="Call Wink"]')!;
    expect(call.className).toContain("max-md:hidden");
    await act(async () => call.click());
    await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
    expect(posts[0]).toMatchObject({ path: "/api/bots/Wink/call/token", body: { room: { id: "room-launch", kind: "host" } } });
    const engine = fakes.engines[0]!;
    await act(async () => engine.events.ready());
    await act(async () => {
      store.dispatch({ type: "messageAdded", threadId: "Wink-thread", message: { id: "o", role: "user", kind: "text", text: "Check Safari", at: Date.now(), call: { id: "c-0123456789ab", order: true } } });
      store.dispatch({ type: "messageAdded", threadId: "Wink-thread", message: { id: "r", parentId: "o", role: "bot", kind: "text", text: "Found a cookie setting.", at: Date.now() } });
    });
    await vi.waitFor(() => expect(host.querySelector("[data-live-call-post]")?.textContent).toContain("Post in Launch?"));
    const offer = host.querySelector<HTMLElement>("[data-live-call-post]")!;
    await act(async () => [...offer.querySelectorAll("button")].find((button) => button.textContent === "Yes")!.click());
    expect(posts.filter((post) => post.path.endsWith("/send"))).toEqual([{ path: "/api/rooms/room-launch/send", body: { text: "Wink: Found a cookie setting.", sendId: expect.any(String) } }]);
    expect(host.querySelector('[role="log"]')?.textContent).not.toContain("Found a cookie");
    expect(host.querySelector("[data-call-box]")).not.toBeNull();
  });

  it("falls back to the first visible bot and hides the button without one", async () => {
    const host = await mount([bot("hidden", true, true), bot("first")]);
    expect(host.querySelector('[aria-label="Call first"]')).not.toBeNull();
    await act(async () => store.dispatch({ type: "hydrate", bots: [], groups: [group], botsUnreadable: false, computerControl: {}, sidebarOrder: { sectionOrder: [], itemOrder: {} } } as never));
    expect(host.querySelector("button[aria-pressed]")).toBeNull();
  });

  it("shows the intro before capture and the room privacy line in Korean", async () => {
    const host = await mount(undefined, true, false, "ko");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Wink에게 전화"]')!.click());
    expect(document.querySelector("[data-call-intro]")).not.toBeNull();
    expect(host.textContent).toContain("내 Gemini 키로 Google에 전송합니다.");
    expect(posts).toEqual([]);
    expect(fakes.capture).not.toHaveBeenCalled();
  });

  it("names the bot chat on a missing key and links to it", async () => {
    const host = await mount(undefined, false);
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Call Wink"]')!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Add a Gemini key in Wink's chat"));
    const link = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add a Gemini key"))!;
    await act(async () => link.click());
    expect(store.state.selectedId).toBe("Wink");
    expect(fakes.capture).not.toHaveBeenCalled();
  });
});
