// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import circuit from "./circuit";
import nightRain from "./night-rain";
import samuraiInk from "./samurai-ink";
import warp from "./warp";
import type { SceneApi, SceneModule } from "./scene-host";

// Every WebGL call is a no-op; only the link check has to pass.
const gl = new Proxy({}, { get: (_, key) => (key === "getProgramParameter" ? () => true : () => null) });
const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");

let now = 0;
let reduced = false;
let layer: HTMLElement;
const wake = vi.fn();
let scenes: SceneModule;
const start = () => {
  const api: SceneApi = { layer, wake, time: () => now, reduced: () => reduced, skin: () => "", dark: () => true, rectIn: () => ({ x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 }), after: () => undefined };
  return scenes.create(api);
};
const run = (scene: ReturnType<typeof start>, ms: number) => {
  let alive = true;
  for (const end = now + ms; alive && now < end; ) alive = scene.frame((now += 16), 16);
  return alive;
};

beforeEach(() => {
  now = 0;
  reduced = false;
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

describe.each([["samurai ink", samuraiInk], ["night rain", nightRain], ["warp", warp], ["circuit", circuit]] as const)("%s", (_, module) => {
  beforeEach(() => void (scenes = module));

  it("rests the window in the background, like Snow", () => {
    expect(module.pauseOnBlur).toBe(true);
  });

  it("keeps a tile's loop alive from a first frame in which no time has passed", () => {
    const scene = start();
    scene.event({ name: "loop" });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(scene.frame(0, 0)).toBe(true);
    expect(run(scene, 60_000)).toBe(true);
    scene.dispose();
  });

  it("moves through the whole turn, past a mid-turn send, and rests a few seconds after the reply", () => {
    const scene = start();
    scene.event({ name: "send", at: layer });
    scene.event({ name: "busy" });
    expect(run(scene, 10_000)).toBe(true);
    scene.event({ name: "send", at: layer });
    expect(run(scene, 10_000)).toBe(true);
    scene.event({ name: "reply" });
    const replied = now;
    expect(run(scene, 1000)).toBe(true);
    expect(run(scene, 20_000)).toBe(false);
    expect(now - replied).toBeLessThan(8000);
    scene.dispose();
  });

  it("stops moving 30 s into a long turn", () => {
    const scene = start();
    scene.event({ name: "busy" });
    expect(run(scene, 29_000)).toBe(true);
    expect(run(scene, 20_000)).toBe(false);
    expect(now).toBeLessThan(40_000);
    scene.dispose();
  });

  it("rests a few seconds after a send in the chat", () => {
    const scene = start();
    scene.event({ name: "send", at: layer });
    expect(scene.frame(0, 0)).toBe(true);
    expect(run(scene, 2000)).toBe(true);
    expect(run(scene, 20_000)).toBe(false);
    expect(now).toBeLessThan(12_000);
    scene.dispose();
  });

  it("stays a still frame under reduced motion", () => {
    reduced = true;
    const scene = start();
    for (const name of ["loop", "busy", "reply"] as const) scene.event({ name });
    scene.event({ name: "send", at: layer });
    expect(wake).not.toHaveBeenCalled();
    scene.dispose();
  });
});
