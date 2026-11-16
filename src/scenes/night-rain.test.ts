// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import nightRain from "./night-rain";
import source from "./night-rain.ts?raw";
import type { SceneApi } from "./scene-host";

// GLSL ES 1.00 reserves these; a shader naming one fails to compile and flow quietly falls back to a flat gradient.
const RESERVED = /\b(asm|class|union|enum|typedef|template|this|packed|goto|switch|default|inline|noinline|volatile|public|static|extern|external|interface|flat|long|short|double|half|fixed|unsigned|superp|input|output|[hdf]vec[234]|sampler(1D|3D|1DShadow|2DShadow|2DRect|3DRect|2DRectShadow)|sizeof|cast|namespace|using)\b/g;

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
const frag = () => {
  const api: SceneApi = { layer, wake: () => undefined, time: () => 0, reduced: () => false, skin: () => "night-rain", dark: () => true, rectIn: () => ({ x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 }), after: () => undefined };
  nightRain.create(api).dispose();
  const src = sources.find((s) => s.includes("gl_FragColor"))!;
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
};

beforeEach(() => {
  sources.length = 0;
  looked.length = 0;
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

describe("night rain", () => {
  it("names nothing GLSL ES reserves", () => {
    expect(frag().match(RESERVED) ?? [], "rename it: GLSL ES 1.00 reserves these words").toEqual([]);
  });

  it("declares only uniforms the flow sets", () => {
    const declared = [...frag().matchAll(/\buniform\s+\w+\s+([^;]+);/g)].flatMap((m) => m[1].split(",").map((n) => n.trim()));
    expect(declared.filter((n) => !looked.includes(n)), "an unset uniform reads 0: add it to colors or drop it").toEqual([]);
  });

  it("declares no structs", () => {
    expect(frag().match(/\bstruct\b/g) ?? [], "WebGL 1 refuses ternaries and == on structs: pass vectors").toEqual([]);
  });

  it("never copies the backdrop's live transform", () => {
    expect(source.match(/getTransform\(\)/g) ?? [], "paint resets it while compositing, so a copy taken later is 1:1 and halves everything on hi-dpi: use g.canvas.width / w").toEqual([]);
  });
});
