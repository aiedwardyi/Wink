// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cameraStep, docCamera, type DocCamera } from "./verify-doc-camera";

afterEach(() => { vi.useRealTimers(); });

// Readers hop 400 px every 550 ms, each hop a 280 ms glide: today's long-document replay.
const reader = (ms: number) => {
  const hop = Math.floor(ms / 550), k = Math.min(1, (ms % 550) / 280);
  return { y: 300 + hop * 400 + 400 * k * (2 - k), to: 300 + (hop + 1) * 400 };
};

it("glides down every frame and keeps the leading reader in a 460 px view", () => {
  let cam: DocCamera = { x: 0, v: 0, speed: 0 };
  for (let ms = 16; ms < 4_000; ms += 16) {
    const lead = reader(ms), next = cameraStep(cam, { lead }, 460, 100_000, 16);
    expect(next.x).toBeGreaterThanOrEqual(cam.x);
    if (ms > 600) expect(next.x).toBeGreaterThan(cam.x);
    expect(lead.y).toBeGreaterThanOrEqual(next.x);
    expect(lead.y + 21).toBeLessThanOrEqual(next.x + 460);
    cam = next;
  }
});

it("eases to a stop without pushing the names cursor out the top", () => {
  let cam: DocCamera = { x: 1_000, v: 1_200, speed: 0 };
  for (let i = 0; i < 60; i++) {
    cam = cameraStep(cam, { stop: 1_040 }, 460, 100_000, 16);
    expect(cam.x).toBeLessThanOrEqual(1_040);
  }
  expect(cam.v).toBeLessThan(1);
});

it("does not reverse when a finding points back above the view", () => {
  let cam: DocCamera = { x: 4_000, v: 900, speed: 900, to: 4_400 };
  for (const y of [3_900, 3_400, 3_000, 3_100, 4_500]) {
    const next = cameraStep(cam, { lead: { y, to: y }, stop: 110 }, 460, 100_000, 16);
    expect(next.x).toBeGreaterThanOrEqual(cam.x);
    cam = next;
  }
});

it("keeps following when a resize clamps the view", () => {
  vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  const stage = { scrollTop: 0, clientHeight: 460, scrollHeight: 2_000 } as HTMLElement, hand = vi.fn();
  docCamera(stage, now => ({ lead: reader(now) }), () => true, hand);
  vi.advanceTimersByTime(3_000);
  expect(stage.scrollTop).toBe(1_540);
  Object.assign(stage, { clientHeight: 800, scrollTop: 1_200 });
  vi.advanceTimersByTime(100);
  expect(hand).not.toHaveBeenCalled();
  expect(stage.scrollTop).toBe(1_200);
  expect(vi.getTimerCount()).toBe(1);
});

it("stops on a hand scroll and leaves nothing scheduled", () => {
  vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  const stage = { scrollTop: 0, clientHeight: 460, scrollHeight: 10_000 } as HTMLElement, hand = vi.fn();
  docCamera(stage, now => ({ lead: reader(now) }), () => true, hand);
  vi.advanceTimersByTime(1_000);
  expect(stage.scrollTop).toBeGreaterThan(0);
  stage.scrollTop -= 50;
  vi.advanceTimersByTime(32);
  expect(hand).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  const stop = docCamera(stage, now => ({ lead: reader(now) }), () => true, hand);
  vi.advanceTimersByTime(100);
  stop();
  expect(vi.getTimerCount()).toBe(0);
  let following = true;
  docCamera(stage, now => ({ lead: reader(now) }), () => following, hand);
  following = false;
  vi.advanceTimersByTime(32);
  expect(vi.getTimerCount()).toBe(0);
});
