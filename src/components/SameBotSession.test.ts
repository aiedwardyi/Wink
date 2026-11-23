// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StoreProvider, useStore, type Bot } from "@/state/store";
import { turnCompleted } from "@/lib/call";
import { I18nProvider } from "@/lib/i18n";
import type { LiveEvents } from "@/lib/live-call/engine";

import { CallHostSlot } from "./CallSlots";
import { ChatView } from "./ChatView";

const fakes = vi.hoisted(() => ({ loads: 0, built: 0, engines: [] as Array<{ events: LiveEvents; closed: boolean; texts: string[] }>, sse: undefined as { onmessage: ((event: { data: string; lastEventId: string }) => void) | null } | undefined }));
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));
// Counts every load of the same-bot code: a Gemini voice call must never pull it in.
vi.mock("@/lib/live-call/same-bot", async (importOriginal) => {
  fakes.loads += 1;
  const real = await importOriginal<typeof import("@/lib/live-call/same-bot")>();
  return { SameBotCall: class extends real.SameBotCall { constructor(...args: ConstructorParameters<typeof real.SameBotCall>) { super(...args); fakes.built += 1; } } };
});
vi.mock("@/lib/live-call/gemini", () => ({
  GeminiLive: class {
    events!: LiveEvents;
    closed = false;
    texts: string[] = [];
    connect(_session: unknown, events: LiveEvents) { this.events = events; fakes.engines.push(this); }
    sendAudio() {}
    audioPaused() {}
    sendText(text: string) { this.texts.push(text); }
    sendContext() {}
    sendToolResult() {}
    close() { this.closed = true; }
  },
}));
vi.mock("@/lib/live-call/audio", () => ({
  CallAudio: class {
    playing = false;
    onIdle = () => {};
    onStart = () => {};
    async capture() {}
    stopMic() {}
    async heal() { return true; }
    play() {}
    endTurn() {}
    tune() {}
    flush() {}
    close() {}
    boop() {}
    handOver() {}
    heardShare() { return 1; }
    level() { return 0; }
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const atlas = {
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: false,
  color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages: [], hasMore: false,
} as unknown as Bot;
const older = {
  ...atlas, threadId: "thread-previous", messages: [
    { id: "old-user", role: "user", kind: "text", text: "Earlier user fixture.", at: 1 },
    { id: "old-bot", role: "bot", kind: "text", text: "Crocus 918 old only.", at: 2, parentId: "old-user" },
  ],
};
const config = (answer?: "bot" | "gemini") => ({ gemini: { configured: true }, features: { voiceCalls: true }, liveCall: { voice: "Aoede", ...(answer ? { answer } : {}) } });

const posts: Array<{ path: string; body?: any }> = [];
let current = config();
let rejectMessage = false;
let thread: object[] = [];
const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  posts.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
  if (path === "/api/config") return Response.json(current);
  if (path.includes("/tasks/thread-previous")) return Response.json({ bot: older });
  if (path.startsWith("/api/threads/")) return Response.json({ messages: thread, hasMore: false });
  if (path.endsWith("/call/token")) return Response.json({ callId: "c-0123456789ab", url: "wss://x", token: "t", model: "m" });
  if (path.endsWith("/messages")) return rejectMessage ? Response.json({ error: "Fixture engine could not start." }, { status: 503 }) : Response.json({ ok: true }, { status: 202 });
  if (path.startsWith("/api/bots?")) return Response.json({ bots: [atlas], groups: [], computerControl: {} });
  return new Response("{}", { status: 404 });
};

let root: Root;
let host: HTMLElement;
let dispatch!: ReturnType<typeof useStore>["dispatch"];
function Chat() {
  const store = useStore();
  dispatch = store.dispatch;
  return createElement(ChatView, { bot: store.state.bots.find((bot) => bot.id === atlas.id) ?? atlas });
}
async function mount(answer?: "bot" | "gemini") {
  current = config(answer);
  localStorage.setItem("wink.liveCall.intro", "1");
  vi.stubGlobal("EventSource", class { onmessage = null; constructor() { fakes.sse = this; } close() {} });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(StoreProvider, null, createElement(Chat), createElement(CallHostSlot)))));
  await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:1" }), lastEventId: "qa:1" }));
  await vi.waitFor(() => expect(posts.some(({ path }) => path.startsWith("/api/bots?"))).toBe(true));
  await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "config", cursor: "qa:2", ...current }), lastEventId: "qa:2" }));
}

async function call() {
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Call Atlas"]')!.click());
  await vi.waitFor(() => expect(fakes.engines).toHaveLength(1));
  await act(async () => fakes.engines[0]!.events.ready());
  await vi.waitFor(() => expect(host.querySelector("[data-call-box]")).not.toBeNull());
  return fakes.engines[0]!;
}
const tokens = () => posts.filter(({ path }) => path.endsWith("/call/token"));
const box = () => host.querySelector("[data-call-box]")?.getAttribute("data-call-box");
let picks = 0;
const pickAnswer = (answer: "bot" | "gemini") => act(async () => {
  current = config(answer);
  fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "config", cursor: `pick:${++picks}`, ...current }), lastEventId: `pick:${picks}` });
});
async function gemini(index: number) {
  await vi.waitFor(() => expect(fakes.engines).toHaveLength(index + 1));
  const engine = fakes.engines[index]!;
  await act(async () => engine.events.ready());
  await vi.waitFor(() => expect(engine.texts).toHaveLength(1));
  await act(async () => {
    engine.events.answering();
    engine.events.said("Hey, I'm here.");
    engine.events.turnDone();
  });
  return engine;
}

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  posts.length = 0;
  rejectMessage = false;
  thread = [];
  fakes.engines.length = 0;
  fakes.sse = undefined;
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("who answers a call", () => {
  // First, so nothing earlier has loaded the module.
  it("Gemini voice (the default) never loads or runs the same-bot code", async () => {
    await mount();
    const engine = await call();
    await act(async () => engine.events.heard("what is the build status"));
    expect(fakes.loads).toBe(0);
    expect(fakes.built).toBe(0);
    expect(tokens()).toHaveLength(1);
    expect(tokens()[0]!.body).not.toHaveProperty("mode");
    expect(host.querySelector("[data-call-stop]")).toBeNull();
  });

  it("Same bot sends his words as a chat message the bot answers", async () => {
    await mount("bot");
    const engine = await call();
    expect(fakes.built).toBe(1);
    expect(tokens()[0]!.body).toMatchObject({ mode: "bot" });
    await act(async () => {
      engine.events.heard("what is the build status");
      engine.events.answering();
      engine.events.turnDone();
    });
    await vi.waitFor(() => expect(posts.find(({ path }) => path === "/api/bots/atlas/messages")?.body).toMatchObject({ text: "what is the build status" }));
    expect(host.textContent).toContain("what is the build status");
    expect(engine.texts).toEqual([]);
  });
  it("a pick of who answers made during the call switches the live call, and back", async () => {
    await mount("bot");
    const same = await call();
    await pickAnswer("gemini");
    const voice = await gemini(1);
    expect(same.closed).toBe(true);
    expect(tokens()).toHaveLength(2);
    expect(tokens()[1]!.body).not.toHaveProperty("mode");
    expect(box()).toBe("listening");
    await act(async () => {
      voice.events.heard("how are you");
      voice.events.answering();
      voice.events.audio(new Int16Array(4));
      voice.events.said("Doing well. What can I help with?");
      voice.events.turnDone();
    });
    expect(posts.filter(({ path }) => path === "/api/bots/atlas/messages")).toHaveLength(0);

    await pickAnswer("bot");
    await vi.waitFor(() => expect(fakes.engines).toHaveLength(3));
    expect(voice.closed).toBe(true);
    expect(tokens()[2]!.body).toMatchObject({ mode: "bot" });
    const back = fakes.engines[2]!;
    await act(async () => back.events.ready());
    await act(async () => {
      back.events.heard("and the tests");
      back.events.answering();
      back.events.turnDone();
    });
    await vi.waitFor(() => expect(posts.find(({ path }) => path === "/api/bots/atlas/messages")?.body).toMatchObject({ text: "and the tests" }));
    expect(back.texts).toEqual([]);
    expect(box()).toBe("working");
  });

  it("a switch made while the bot works waits for its reply to be read, once, then moves", async () => {
    await mount("bot");
    const same = await call();
    await act(async () => {
      same.events.heard("what is the build status");
      same.events.answering();
      same.events.turnDone();
    });
    await vi.waitFor(() => expect(posts.some(({ path }) => path === "/api/bots/atlas/messages")).toBe(true));
    const { sendId } = posts.find(({ path }) => path === "/api/bots/atlas/messages")!.body;
    await act(async () => dispatch({ type: "switchTask", botId: atlas.id, threadId: "thread-previous" }));
    await vi.waitFor(() => expect(host.textContent).toContain("Crocus 918 old only."));
    await pickAnswer("gemini");
    expect(fakes.engines).toHaveLength(1);
    expect(box()).toBe("working");
    thread = [
      { id: "u1", at: 10, role: "user", kind: "text", text: "what is the build status", sendId },
      { id: "r1", at: 11, role: "bot", kind: "text", text: "The build is green.", parentId: "u1" },
    ];
    await act(async () => {
      fakes.sse!.onmessage?.({ data: JSON.stringify({ kind: "bot", cursor: "qa:3", bot: { id: atlas.id, busy: false } }), lastEventId: "qa:3" });
      turnCompleted(atlas.threadId);
    });
    await vi.waitFor(() => expect(same.texts).toEqual(["[READ]\nThe build is green."]));
    expect(fakes.engines).toHaveLength(1);
    await act(async () => {
      same.events.answering();
      same.events.said("The build is green.");
      same.events.turnDone();
    });
    await gemini(1);
    expect(same.closed).toBe(true);
    expect(same.texts).toHaveLength(1);
    expect(box()).toBe("listening");
  });

  it("Same bot reads nothing when he switches to a task that already has a reply", async () => {
    await mount("bot");
    const engine = await call();
    await act(async () => dispatch({ type: "switchTask", botId: atlas.id, threadId: "thread-previous" }));
    await vi.waitFor(() => expect(host.textContent).toContain("Crocus 918 old only."));
    await act(async () => {});
    expect(engine.texts).toEqual([]);
    expect(posts.filter(({ path }) => path.endsWith("/messages"))).toHaveLength(0);
  });

  it("Same bot reads the reply to a send made on a task he has left, once that turn ends", async () => {
    await mount("bot");
    const engine = await call();
    await act(async () => {
      engine.events.heard("what is the build status");
      engine.events.answering();
      engine.events.turnDone();
    });
    await vi.waitFor(() => expect(posts.some(({ path }) => path === "/api/bots/atlas/messages")).toBe(true));
    const { sendId } = posts.find(({ path }) => path === "/api/bots/atlas/messages")!.body;
    await act(async () => dispatch({ type: "switchTask", botId: atlas.id, threadId: "thread-previous" }));
    await vi.waitFor(() => expect(host.textContent).toContain("Crocus 918 old only."));
    expect(host.querySelector("[data-call-box]")?.getAttribute("data-call-box")).toBe("working");
    thread = [
      { id: "u1", at: 10, role: "user", kind: "text", text: "what is the build status", sendId },
      { id: "r1", at: 11, role: "bot", kind: "text", text: "The build is green and nothing is waiting.", parentId: "u1" },
    ];
    await act(async () => turnCompleted(atlas.threadId));
    await vi.waitFor(() => expect(engine.texts).toEqual(["[READ]\nThe build is green and nothing is waiting."]));
    expect(host.querySelector("[data-call-box]")?.getAttribute("data-call-box")).not.toBe("working");
    await act(async () => turnCompleted(atlas.threadId));
    expect(engine.texts).toHaveLength(1);
  });

  it("Same bot leaves a turn that ends on the task he is looking at to the chat", async () => {
    await mount("bot");
    await call();
    await act(async () => turnCompleted(atlas.threadId));
    expect(posts.filter(({ path }) => path.includes("/api/threads/"))).toHaveLength(0);
  });

  it("Same bot leaves Working and says the line was not sent when the send fails", async () => {
    await mount("bot");
    const engine = await call();
    rejectMessage = true;
    await act(async () => {
      engine.events.heard("Check the fixture engine.");
      engine.events.answering();
      engine.events.turnDone();
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Fixture engine could not start."));
    await vi.waitFor(() => expect(host.querySelector("[data-call-box]")?.getAttribute("data-call-box")).toBe("listening"));
    expect(host.textContent).toContain("Not sent: Check the fixture engine.");
    expect(posts.filter(({ path }) => path.endsWith("/messages"))).toHaveLength(1);
    expect(engine.texts).toEqual([]);
  });

  it("Same bot says Not sent when the send's turn could not start", async () => {
    await mount("bot");
    const engine = await call();
    const line = "Check the restored fixture after the update.";
    const failed = "This conversation uses context summary version 99. Update Wink before continuing.";
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/messages") && init?.method === "POST") {
        const { sendId } = JSON.parse(String(init.body));
        return Response.json({ ok: true, threadId: atlas.threadId, dispatchFailed: true, error: failed, message: { id: "failed-user", role: "user", kind: "text", sendId, text: line, at: 10 } }, { status: 202 });
      }
      return original(input, init);
    });
    await act(async () => {
      engine.events.heard(line);
      engine.events.answering();
      engine.events.turnDone();
    });
    await act(async () => fakes.sse!.onmessage?.({ data: JSON.stringify({
      kind: "message", threadId: atlas.threadId, cursor: "qa:3",
      message: { id: "failed-activity", parentId: "failed-user", role: "bot", kind: "activity", tool: { name: `error: ${failed}`, ok: false }, at: 11 },
    }), lastEventId: "qa:3" }));
    await vi.waitFor(() => expect(host.textContent).toContain(`Not sent: ${line}`));
    expect(host.querySelector("[data-call-box]")?.getAttribute("data-call-box")).toBe("listening");
    expect(engine.texts).toEqual([]);
  });

  it("Same bot leaves Working when Stop this turn cancels a pending send", async () => {
    await mount("bot");
    const engine = await call();
    const line = "Stop this pending browser fixture turn.";
    let release: undefined | (() => void);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/messages") && init?.method === "POST") {
        await new Promise<void>((resolve) => { release = resolve; });
        return Response.json({ ok: true, threadId: atlas.threadId, cancelled: true }, { status: 202 });
      }
      if (path.includes("/queue/")) return Response.json({ cancelled: true });
      if (path.endsWith("/interrupt")) return Response.json({ stopped: true, returned: [] });
      return original(input, init);
    });
    await act(async () => {
      engine.events.heard(line);
      engine.events.answering();
      engine.events.turnDone();
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(host.querySelector("[data-call-box]")?.getAttribute("data-call-box")).toBe("working");
    await act(async () => dispatch({ type: "interrupt", botId: atlas.id }));
    await act(async () => release!());
    await vi.waitFor(() => expect(host.querySelector("[data-call-box]")?.getAttribute("data-call-box")).toBe("listening"));
    expect(host.querySelector("textarea")?.value).toBe(line);
    expect(host.textContent).not.toContain("Not sent");
    expect(engine.texts).toEqual([]);
  });
});
