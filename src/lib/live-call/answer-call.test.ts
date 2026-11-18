// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store-types";

// oxlint-disable-next-line anti-slop/no-module-mocking -- voice calls ship cut; this test drives the call code behind the flag.
vi.mock("../../../shared/voice-calls", () => ({ VOICE_CALLS: true }));

const contexts: Array<{ state: string; resume: ReturnType<typeof vi.fn> }> = [];
const voices: Array<{ play: ReturnType<typeof vi.fn> }> = [];
const bot = { id: "b1", name: "Scout" } as Bot;

beforeEach(() => {
  vi.resetModules();
  contexts.length = 0;
  voices.length = 0;
  vi.stubGlobal("Audio", class {
    play = vi.fn(async () => {});
    constructor() { voices.push(this); }
  });
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
  expect(voices[0]!.play).toHaveBeenCalledTimes(2);
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

it("waits for the switch to the rung thread before it starts the call", async () => {
  const { answerOnThread } = await import("./active");
  const ring = { botId: "b1", threadId: "t2", opener: "Sign in on Home." };
  expect(answerOnThread([{ ...bot, threadId: "t1" }], ring)).toBeNull();
  expect(answerOnThread([{ ...bot, threadId: "t1" }])).toBeNull();
  expect(answerOnThread([{ ...bot, threadId: "t2" }])).toMatchObject({ botId: "b1", opener: "Sign in on Home." });
  expect(contexts).toHaveLength(1);
});

it("drops a rung call whose switch never lands", async () => {
  vi.useFakeTimers();
  const { answerOnThread } = await import("./active");
  answerOnThread([{ ...bot, threadId: "t1" }], { botId: "b1", threadId: "t2", opener: "Sign in on Home." });
  vi.advanceTimersByTime(31_000);
  expect(answerOnThread([{ ...bot, threadId: "t2" }])).toBeNull();
  expect(contexts).toEqual([]);
  vi.useRealTimers();
});
