// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { answerCall, answerOnThread, dropCall } from "@/lib/live-call/active";

import { CallHostSlot } from "./CallSlots";
import { ChatView } from "./ChatView";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Markdown highlighting is not what this test checks.
vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SAFETY: a fixture with the Bot fields the chat reads; the rest stay unset.
const atlas = {
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: false,
  color: "iris", unread: false, modelSelection: { instanceId: "inst", model: "m" }, messages: [], hasMore: false,
} as unknown as Bot;

afterEach(() => {
  posts.length = 0;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
  document.body.innerHTML = "";
});

const posts: string[] = [];
let sse: { onmessage: ((event: { data: string; lastEventId: string }) => void) | null } | undefined;

async function mount(voiceCalls: boolean) {
  vi.stubGlobal("EventSource", class { onmessage = null; constructor() { sse = this; } close() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    posts.push(path);
    if (path === "/api/config") return Response.json({ gemini: { configured: true }, features: { voiceCalls } });
    if (path.startsWith("/api/bots?")) return Response.json({ bots: [atlas], groups: [], computerControl: {} });
    return new Response("{}", { status: 404 });
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: atlas }), createElement(CallHostSlot))));
  await act(async () => sse!.onmessage?.({ data: JSON.stringify({ kind: "hello", resumed: false, cursor: "qa:0" }), lastEventId: "qa:0" }));
  await vi.waitFor(() => expect(posts.some((path) => path.startsWith("/api/bots?"))).toBe(true));
  await act(async () => sse!.onmessage?.({ data: JSON.stringify({ kind: "config", cursor: "qa:1", gemini: { configured: true }, features: { voiceCalls } }), lastEventId: "qa:1" }));
  return host;
}

it("a team PC renders the Call entry point", async () => {
  const host = await mount(true);
  expect(host.querySelector("[data-orbit-composer-frame]")).not.toBeNull();
  await vi.waitFor(() => expect(host.querySelector('button[aria-label="Call Atlas"]')).not.toBeNull());
});

it("any other PC renders no Call entry point in a chat where calls work", async () => {
  const host = await mount(false);
  expect(host.querySelector("[data-orbit-composer-frame]")).not.toBeNull();
  expect(host.querySelector('button[aria-label="Call Atlas"]')).toBeNull();
  expect(host.querySelector('button[aria-label="Call settings"]')).toBeNull();
  expect(host.querySelector("[data-call-box], [data-live-call-bar]")).toBeNull();
});

it("a tapped call push opens the chat without placing a call on a non-team PC", () => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
  vi.stubGlobal("AudioContext", class { state = "running"; resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  const placed = answerCall(atlas, "Sign in to Claude", false);
  if (placed) dropCall(placed);
  expect(placed).toBeNull();
});

it("a tapped call push still rings once the PC reports it is a team member", () => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
  vi.stubGlobal("AudioContext", class { state = "running"; resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  const bots = [{ ...atlas, threadId: "t1" }];
  expect(answerOnThread(bots, false, { botId: "atlas", threadId: "t1", opener: "Sign in to Claude" })).toBeNull();
  const placed = answerOnThread(bots, true);
  if (placed) dropCall(placed);
  expect(placed).not.toBeNull();
});
