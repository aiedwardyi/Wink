// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import lagoon from "./lagoon";
import type { SceneApi } from "./scene-host";

// Every WebGL call is a no-op but the link check, and the ripple uniform is kept to count live ripples.
let uR: Float32Array = new Float32Array(16);
const gl = new Proxy({}, { get: (_, key) => (key === "getProgramParameter" ? () => true : key === "uniform4fv" ? (_at: unknown, v: Float32Array) => (uR = v) : () => null) });
const live = () => [3, 7, 11, 15].filter((i) => uR[i] > 0).length;
const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");

let now = 0;
let layer: HTMLElement;
const wake = vi.fn();
const start = () => {
  const api: SceneApi = { layer, wake, time: () => now, reduced: () => false, skin: () => "lagoon", dark: () => false, rectIn: () => ({ x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 }), after: () => undefined };
  return lagoon.create(api);
};
const run = (scene: ReturnType<typeof start>, ms: number) => {
  let alive = true;
  for (const end = now + ms; alive && now < end; ) alive = scene.frame((now += 16), 16);
  return alive;
};

beforeEach(() => {
  now = 0;
  wake.mockClear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => gl });
  layer = document.createElement("div");
  document.body.append(layer);
});

afterEach(() => {
  layer.remove();
  if (getContext) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", getContext);
  vi.unstubAllGlobals();
});

describe("lagoon", () => {
  it("keeps a tile's loop alive from a first frame in which no time has passed", () => {
    const scene = start();
    scene.event({ name: "loop" });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(scene.frame(0, 0)).toBe(true);
    expect(run(scene, 20_000)).toBe(true);
    scene.dispose();
  });

  it("still rests a few seconds after a send in the chat", () => {
    const scene = start();
    scene.event({ name: "send", at: layer });
    expect(scene.frame(0, 0)).toBe(true);
    expect(run(scene, 2000)).toBe(true);
    expect(run(scene, 20_000)).toBe(false);
    expect(now).toBeLessThan(12_000);
    scene.dispose();
  });

  it("keeps rippling through a busy turn and rests once the reply's ripples fade", () => {
    const scene = start();
    scene.event({ name: "busy" });
    expect(scene.frame(0, 0)).toBe(true);
    expect(run(scene, 2500)).toBe(true);
    const early = live();
    expect(run(scene, 2500)).toBe(true);
    expect(live()).toBeGreaterThan(early);
    expect(run(scene, 15_000)).toBe(true);
    expect(live()).toBeGreaterThanOrEqual(2);
    scene.event({ name: "reply", at: layer });
    const end = now;
    expect(run(scene, 20_000)).toBe(false);
    expect(now - end).toBeLessThan(8000);
    expect(live()).toBe(0);
    scene.dispose();
  });
});
