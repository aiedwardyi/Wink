// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store-types";

const contexts: Array<{ state: string; resume: ReturnType<typeof vi.fn> }> = [];
const bot = { id: "b1", name: "Scout" } as Bot;

beforeEach(() => {
  vi.resetModules();
  contexts.length = 0;
  vi.stubGlobal("AudioContext", class {
    state = "suspended";
    resume = vi.fn(async () => {});
    constructor() { contexts.push(this); }
  });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => ({}) }, configurable: true });
});

afterEach(() => vi.unstubAllGlobals());

it("starts the voice call a tapped bot call opened, with its blocker as the opener", async () => {
  const { answerCall } = await import("./active");
  const { webPushCall } = await import("@/lib/web-push");
  const note = webPushCall(`?${new URLSearchParams({ bot: "b1", thread: "t1", call: "Sign in on Home.", t0: "5" })}`);
  expect(note).toBe("Sign in on Home.");
  const call = answerCall(bot, note);
  expect(call).toMatchObject({ botId: "b1", bot, opener: "Sign in on Home." });
  expect(contexts[0]!.resume).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event("pointerdown"));
  expect(contexts[0]!.resume).toHaveBeenCalledTimes(2);
  expect(answerCall(bot, note)).toBeNull();
});

it("leaves a plain alert's open alone", async () => {
  const { answerCall } = await import("./active");
  const { webPushCall } = await import("@/lib/web-push");
  expect(webPushCall("?bot=b1&thread=t1")).toBeNull();
  expect(answerCall(bot, webPushCall("?bot=b1&thread=t1"))).toBeNull();
  expect(answerCall(undefined, "Sign in")).toBeNull();
  expect(contexts).toEqual([]);
});
