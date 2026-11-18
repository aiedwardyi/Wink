// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { applyLocale } from "@/lib/i18n";
import type { LiveEvents, LiveSession } from "@/lib/live-call/engine";
import type { TeamRoom } from "@/lib/team-rooms";
import type { Message } from "@/state/store-types";

import { CallHostSlot } from "./CallSlots";
import { TeamRoomView } from "./TeamRoomView";

type Fakes = { engines: Array<{ events: LiveEvents; texts: string[]; contexts: string[] }>; bots: Bot[]; sse?: { onmessage: ((event: { data: string; lastEventId: string }) => void) | null } };
// oxlint-disable-next-line anti-slop/no-module-mocking -- voice calls ship cut; this test drives the call code behind the flag.
vi.mock("../../shared/voice-calls", () => ({ VOICE_CALLS: true }));
const fakes = vi.hoisted((): Fakes => ({ engines: [], bots: [] }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Markdown highlighting is not what this test checks.
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- room file state polls the server; this room has no files.
vi.mock("@/lib/room-files-state", () => ({ useRoomFilesState: () => ({ deleted: [], error: null }) }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- LiveCallHost builds its own engine; the fake stands in for Gemini Live.
vi.mock("@/lib/live-call/gemini", () => ({
  GeminiLive: class {
    events!: LiveEvents;
    texts: string[] = [];
    contexts: string[] = [];
    connect(_session: LiveSession, events: LiveEvents) { this.events = events; fakes.engines.push(this); }
    sendAudio() {}
    audioPaused() {}
    sendText(text: string) { this.texts.push(text); }
    sendContext(text: string) { this.contexts.push(text); }
    sendToolResult() {}
    close() {}
  },
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- no audio device in the test; calls stay silent.
vi.mock("@/lib/live-call/audio", () => ({
  CallAudio: class {
    playing = false;
    onIdle = () => {};
    onStart = () => {};
    async capture() {}
    stopMic() {}
    play() {}
    endTurn() {}
    tune() {}
    flush() {}
    close() {}
    boop() {}
    heardShare() { return 1; }
    level() { return 0; }
    micLevel() { return 0; }
  },
}));

// SAFETY: a fixture with the Bot fields the room and call read; the rest stay unset.
const bot = (id: string, chiefOfStaff = false, hidden = false) => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: false, color: "blue", unread: false,
  modelSelection: { instanceId: "inst", model: "m" }, messages: [], hasMore: false, chiefOfStaff, hidden,
}) as Bot;
const minji = (id: string, text: string): Message => ({ id, role: "user", kind: "text", text, at: Date.now(), roomEntryId: `e-${id}`, author: { kind: "person", id: "minji", name: "Minji" } });
// SAFETY: a hosted room with the fields TeamRoomView reads.
const room = (messages: Message[] = [minji("m1", "Login breaks on Safari")]) => ({
  id: "launch", threadId: "room-thread", name: "Launch", memberIds: [], messages, hasMore: false, bulletin: "", unread: false, createdAt: 1, defaultResponder: { kind: "mentions" },
  hosted: { roomId: "room-launch" }, room: { name: "Launch", people: [{ id: "minji", name: "Minji" }], joins: [] },
}) as TeamRoom;

const posts: Array<{ path: string; body: any }> = [];
const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  if (init?.method === "POST") posts.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
  if (path.startsWith("/api/bots?")) return Response.json({ bots: fakes.bots, groups: [room()], computerControl: {} });
  if (path.endsWith("/call/token")) return Response.json({ callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" });
  if (path === "/api/tts/prepare") return Response.json({ utterances: [JSON.parse(String(init?.body)).text] });
  if (path.endsWith("/messages")) return Response.json({ ok: true }, { status: 202 });
  if (path.endsWith("/send")) return Response.json({ ok: true });
  return new Response("{}", { status: 404 });
};

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  fakes.engines.length = 0;
  posts.length = 0;
  applyLocale("en");
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(bots: Bot[] = [bot("first"), bot("Wink", true)], phone = false, locale: "en" | "ko" = "en") {
  fakes.bots = bots;
  applyLocale(locale);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", class { onmessage = null; constructor() { fakes.sse = this; } close() {} });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: phone && /coarse|max-width/.test(query), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = (group?: TeamRoom) => act(async () => root.render(createElement(StoreProvider, null, group && createElement(TeamRoomView, { group }), createElement(CallHostSlot))));
  await render(room());
  await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" }));
  await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "config", cursor: "qa:2", gemini: { configured: true, introSeen: true } }), lastEventId: "qa:2" }));
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  return { host, render, sse: (frame: { kind: string; threadId: string; message: Partial<Message> }, n: number) => act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ cursor: `qa:${n}`, ...frame }), lastEventId: `qa:${n}` })) };
}

const callButton = (host: HTMLElement, name: string) => host.querySelector<HTMLButtonElement>(`[data-orbit-composer-frame] button[aria-label="Call ${name}"]`);

describe("voice call in a team room", () => {
  it("calls the caller's own lead bot with the room, hears teammates silently and posts only on a yes", async () => {
    const { host, sse } = await mount();
    await vi.waitFor(() => expect(callButton(host, "Wink")).not.toBeNull());
    await act(async () => callButton(host, "Wink")!.click());
    await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
    expect(posts.find((post) => post.path.endsWith("/call/token"))).toMatchObject({ path: "/api/bots/Wink/call/token", body: { room: { id: "room-launch", kind: "host" } } });
    const engine = fakes.engines[0]!;
    await act(async () => engine.events.ready());
    await act(async () => engine.events.turnDone());
    await vi.waitFor(() => expect(host.querySelector("[data-orbit-composer-frame] [data-call-box]")).not.toBeNull());
    expect(host.querySelector("[data-live-call-room-privacy]")?.textContent).toContain("sends it to Google on your Gemini key");

    await sse({ kind: "message", threadId: "room-thread", message: minji("m2", "I can test once fixed") }, 3);
    await vi.waitFor(() => expect(engine.contexts.some((text) => text.includes("Minji: I can test once fixed"))).toBe(true));
    expect(engine.texts.some((text) => text.includes("I can test once fixed"))).toBe(false);

    const at = Date.now();
    await sse({ kind: "message", threadId: "Wink-thread", message: { id: "o", role: "user", kind: "text", text: "Check Safari", at, call: { id: "c-0123456789ab", order: true } } }, 4);
    await sse({ kind: "message", threadId: "Wink-thread", message: { id: "r", parentId: "o", role: "bot", kind: "text", text: "Found a cookie setting.", at: at + 1 } }, 5);
    await vi.waitFor(() => expect(host.querySelector("[data-live-call-post]")?.textContent).toContain("Post in Launch?"));
    expect(posts.some((post) => post.path.endsWith("/send"))).toBe(false);
    const offer = host.querySelector<HTMLElement>("[data-live-call-post]")!;
    await act(async () => [...offer.querySelectorAll("button")].find((button) => button.textContent === "Yes")!.click());
    expect(posts.filter((post) => post.path.endsWith("/send"))).toEqual([{ path: "/api/rooms/room-launch/send", body: { text: "Wink: Found a cookie setting.", sendId: expect.any(String) } }]);
    expect(host.querySelector("[data-room-transcript]")?.textContent ?? "").not.toMatch(/Found a cookie|Check Safari/);
  });

  it("keeps hearing the room it was placed from after the caller opens another chat", async () => {
    const { host, render, sse } = await mount();
    await vi.waitFor(() => expect(callButton(host, "Wink")).not.toBeNull());
    await act(async () => callButton(host, "Wink")!.click());
    await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
    const engine = fakes.engines[0]!;
    await act(async () => engine.events.ready());
    await act(async () => engine.events.turnDone());
    await vi.waitFor(() => expect(host.querySelector("[data-call-box]")).not.toBeNull());
    await render();
    expect(host.querySelector("[data-room-transcript]")).toBeNull();
    await sse({ kind: "message", threadId: "room-thread", message: minji("m3", "Safari works on my side") }, 3);
    await vi.waitFor(() => expect(engine.contexts.some((text) => text.includes("Minji: Safari works on my side"))).toBe(true));
    expect(engine.texts.some((text) => text.includes("Safari works on my side"))).toBe(false);
  });

  it("falls back to the first visible bot and has no call button without one", async () => {
    const first = await mount([bot("hidden", true, true), bot("first")]);
    await vi.waitFor(() => expect(callButton(first.host, "first")).not.toBeNull());
    await unmount?.();
    unmount = undefined;
    const none = await mount([]);
    await act(async () => {});
    expect(none.host.querySelector('[data-orbit-composer-frame] button[aria-label^="Call "]')).toBeNull();
  });

  it("shows the same call button on a phone", async () => {
    const { host } = await mount(undefined, true, "ko");
    await vi.waitFor(() => expect(host.querySelector('[data-orbit-composer-frame] button[aria-label="Wink에게 전화"]')).not.toBeNull());
    expect(host.querySelector('[data-orbit-composer-frame] button[aria-label="Wink에게 전화"]')!.className).not.toMatch(/(^|\s)(max-md:)?hidden(\s|$)/);
  });
});
