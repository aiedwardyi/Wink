// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { answerCall, dropCall } from "@/lib/live-call/active";

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
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
  document.body.innerHTML = "";
});

async function mount() {
  vi.stubGlobal("EventSource", class { onmessage = null; close() {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ gemini: { configured: true } })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("AudioContext", class { resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(StoreProvider, null, createElement(ChatView, { bot: atlas }), createElement(CallHostSlot))));
  return host;
}

it("renders no Call entry point in a chat where calls work", async () => {
  const host = await mount();
  expect(host.querySelector("[data-orbit-composer-frame]")).not.toBeNull();
  expect(host.querySelector('button[aria-label="Call Atlas"]')).toBeNull();
  expect(host.querySelector('button[aria-label="Call settings"]')).toBeNull();
  expect(host.querySelector("[data-call-box], [data-live-call-bar]")).toBeNull();
});

it("a tapped call push opens the chat without placing a call", () => {
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({}) } });
  vi.stubGlobal("AudioContext", class { state = "running"; resume() { return Promise.resolve(); } close() { return Promise.resolve(); } });
  const placed = answerCall(atlas, "Sign in to Claude");
  if (placed) dropCall(placed);
  expect(placed).toBeNull();
});
