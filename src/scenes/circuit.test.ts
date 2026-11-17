// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import circuit from "./circuit";
import type { SceneApi } from "./scene-host";

const sources: string[] = [];
const looked: string[] = [];
const gl = new Proxy(
  {},
  {
    get: (_, key) =>
      key === "shaderSource" ? (_s: WebGLShader, src: string) => sources.push(src) : key === "getUniformLocation" ? (_p: WebGLProgram, name: string) => looked.push(name) : key === "getProgramParameter" ? () => true : () => null,
  },
);
const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");

let layer: HTMLElement;
let images: number;
const frag = () => {
  const api: SceneApi = { layer, wake: () => undefined, time: () => 0, reduced: () => false, skin: () => "circuit", dark: () => true, rectIn: () => ({ x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 }), after: () => undefined };
  circuit.create(api).dispose();
  return sources.find((s) => s.includes("gl_FragColor"))!.replace(/\/\/.*$/gm, "");
};

beforeEach(() => {
  sources.length = 0;
  looked.length = 0;
  images = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("Image", class { constructor() { images += 1; } decode() { return Promise.resolve(); } });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => gl });
  layer = document.createElement("div");
  document.body.append(layer);
});

afterEach(() => {
  layer.remove();
  if (getContext) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", getContext);
  vi.unstubAllGlobals();
});

describe("circuit", () => {
  it("draws the board from its traces alone, with no chip picture", () => {
    const src = frag();
    expect(images, "the chip lived in a plate image: draw the board in the shader").toBe(0);
    expect(src.match(/\b(sampler2D|texture2D|uChip)\b/g) ?? []).toEqual([]);
  });

  it("declares only uniforms it sets", () => {
    const declared = [...frag().matchAll(/\buniform\s+\w+\s+([^;]+);/g)].flatMap((m) => m[1].split(",").map((n) => n.trim()));
    expect(declared.filter((n) => !looked.includes(n))).toEqual([]);
  });
});
