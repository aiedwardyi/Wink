// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const made: { close: ReturnType<typeof vi.fn> }[] = [];
const voices: { play: ReturnType<typeof vi.fn> }[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  made.length = 0;
  voices.length = 0;
  vi.stubGlobal("AudioContext", class {
    close = vi.fn(async () => {});
    resume = vi.fn(async () => {});
    constructor() { made.push(this); }
  });
  vi.stubGlobal("Audio", class {
    play = vi.fn(async () => {});
    constructor() { voices.push(this); }
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("hands the hover's context to the click", async () => {
  const { callAudio, warmCallAudio } = await import("./warm-audio");
  warmCallAudio();
  warmCallAudio();
  expect(made).toHaveLength(1);
  expect(callAudio().ctx).toBe(made[0]);
  vi.advanceTimersByTime(20_000);
  expect(made[0]!.close).not.toHaveBeenCalled();
  expect(callAudio().ctx).not.toBe(made[0]);
  expect(made).toHaveLength(2);
});

it("closes an unclaimed context ten seconds after the last hover", async () => {
  const { callAudio, warmCallAudio } = await import("./warm-audio");
  warmCallAudio();
  vi.advanceTimersByTime(8_000);
  warmCallAudio();
  vi.advanceTimersByTime(8_000);
  expect(made[0]!.close).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2_000);
  expect(made[0]!.close).toHaveBeenCalledTimes(1);
  expect(callAudio().ctx).not.toBe(made[0]);
});

it("starts the context and the voice's element in the tap itself", async () => {
  const { callAudio } = await import("./warm-audio");
  const sound = callAudio();
  expect(sound.ctx.resume).toHaveBeenCalledOnce();
  expect(sound.voice).toBe(voices[0]);
  expect(voices[0]!.play).toHaveBeenCalledOnce();
});

it("leaves a phone to make its context in the tap", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const { warmCallAudio } = await import("./warm-audio");
  warmCallAudio();
  expect(made).toHaveLength(0);
});
