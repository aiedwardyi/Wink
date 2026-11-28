// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import type { SceneApi } from "./scene-host";

const calls: string[] = [];
const gl = new Proxy({}, { get: (_, key) => (key === "getProgramParameter" ? () => true : () => void calls.push(String(key))) });
const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
let sized: (() => void) | undefined;

afterEach(() => {
  if (getContext) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", getContext);
  vi.unstubAllGlobals();
});

it("draws its plate in the first frame it has a size, not a blank canvas over the tile's still", async () => {
  vi.stubGlobal("WebGLRenderingContext", class {});
  vi.stubGlobal("Image", class { src = ""; naturalWidth = 1024; decode() { return Promise.resolve(); } });
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { sized = cb; } observe() {} disconnect() {} });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => gl });
  const warp = (await import("./warp")).default;
  const layer = document.createElement("div");
  const api: SceneApi = { layer, wake: () => undefined, time: () => 0, reduced: () => false, skin: () => "warp", dark: () => true, rectIn: () => ({ x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 }), after: () => undefined };
  const scene = warp.create(api);
  calls.length = 0;
  sized?.();
  expect(calls.indexOf("texImage2D"), "decode the plate before the module resolves").toBeGreaterThanOrEqual(0);
  expect(calls.lastIndexOf("drawArrays")).toBeGreaterThan(calls.indexOf("texImage2D"));
  scene.dispose();
});
