// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import circuit from "./circuit";
import { flowScene } from "./flow";
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
  document.body.replaceChildren();
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

describe("a scene's second texture", () => {
  it("uploads to unit 1 as uTex2 and hands unit 0 back to the backdrop", () => {
    const calls: string[] = [];
    const img = new ImageData(1, 1);
    const record = new Proxy(
      {},
      {
        get: (_, key: string) =>
          key === key.toUpperCase() ? key : key === "getProgramParameter" ? () => true : key === "getUniformLocation" ? (_p: WebGLProgram, name: string) => name : (...args: unknown[]) => void calls.push(`${key}(${args.map((x) => (x === img ? "img" : String(x))).join()})`),
      },
    );
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => record });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
        }
        observe() {
          this.cb();
        }
        disconnect() {}
      },
    );
    scenes = flowScene({ frag: "", colors: {}, period: 60, backdrop: () => undefined, extra: () => img });
    start().dispose();
    const upload = calls.indexOf("texImage2D(TEXTURE_2D,0,RGBA,RGBA,UNSIGNED_BYTE,img)");
    const units = (from: number, to: number) => calls.slice(from, to).filter((c) => c.startsWith("activeTexture"));
    expect(upload).toBeGreaterThan(-1);
    expect(calls).toContain("uniform1i(uTex2,1)");
    expect(units(0, upload).at(-1)).toBe("activeTexture(TEXTURE1)");
    expect(units(upload, calls.length)[0]).toBe("activeTexture(TEXTURE0)");
  });
});

describe("the painted marker", () => {
  beforeEach(() => void (scenes = samuraiInk));

  it("sits on the chat only while WebGL paints the scene", () => {
    const scene = start();
    expect(layer.parentElement?.hasAttribute("data-scene-painted")).toBe(true);
    scene.dispose();
    expect(layer.parentElement?.hasAttribute("data-scene-painted")).toBe(false);
  });

  it("stays off on the gradient fallback", () => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => null });
    const scene = start();
    expect(layer.parentElement?.hasAttribute("data-scene-painted")).toBe(false);
    scene.dispose();
  });
});

describe("a swipe's peeked chat", () => {
  it("uploads the open chat's plates instead of painting them again", () => {
    const uploads: unknown[] = [];
    const record = new Proxy({}, { get: (_, key) => (key === "getProgramParameter" ? () => true : key === "texImage2D" ? (...args: unknown[]) => void uploads.push(args.at(-1)) : () => null) });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => record });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
        }
        observe() {
          this.cb();
        }
        disconnect() {}
      },
    );
    const backdrop = vi.fn();
    const extra = vi.fn(() => new ImageData(1, 1));
    scenes = flowScene({ frag: "", colors: {}, period: 60, backdrop, extra });
    const open = start();
    const peek = start();
    expect(backdrop).toHaveBeenCalledTimes(1);
    expect(extra).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(4);
    expect(uploads.slice(2)).toEqual(uploads.slice(0, 2));
    // The land releases the outgoing chat; the plates live on with the incoming one.
    open.dispose();
    Object.defineProperty(layer, "clientWidth", { configurable: true, value: 390 });
    const turned = start();
    expect(backdrop).toHaveBeenCalledTimes(2);
    peek.dispose();
    turned.dispose();
    start().dispose();
    expect(backdrop).toHaveBeenCalledTimes(3);
  });
});

function rig() {
  let failPaper = false;
  let failShader = false;
  const callbacks = new Map<HTMLElement, () => void>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private cb: () => void) {}
    layer!: HTMLElement;
    observe(layer: HTMLElement) {
      this.layer = layer;
      callbacks.set(layer, this.cb);
    }
    disconnect() { callbacks.delete(this.layer); }
  });
  const uploads = new Map<HTMLCanvasElement, unknown[]>();
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: function (this: HTMLCanvasElement, kind: string) {
    if (kind === "2d") {
      if (failPaper) {
        failPaper = false;
        return null;
      }
      return { scale() {} };
    }
    const sent: unknown[] = [];
    uploads.set(this, sent);
    return new Proxy({}, { get: (_, key) => {
      if (key === "getProgramParameter") return () => true;
      if (key === "createShader") return () => failShader ? null : {};
      if (key === "shaderSource") return (shader: unknown) => { if (!shader) throw new TypeError("shaderSource requires a WebGLShader"); };
      if (key === "texImage2D") return (...args: unknown[]) => sent.push(args.at(-1));
      return () => null;
    } });
  } });
  const backdrop = vi.fn();
  const extra = vi.fn((): ImageData | null => new ImageData(1, 1));
  const skin = () => flowScene({ frag: "", colors: {}, period: 60, backdrop, extra });
  const module = skin();
  const start = (which = module) => {
    const main = document.createElement("main");
    const layer = document.createElement("div");
    main.append(layer);
    document.body.append(main);
    Object.defineProperty(layer, "clientWidth", { configurable: true, value: 390 });
    Object.defineProperty(layer, "clientHeight", { configurable: true, value: 844 });
    const scene = which.create({ layer, wake() {}, time: () => 0, reduced: () => false, skin: () => "", dark: () => false, rectIn: () => ({ x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 }), after() {} });
    const resize = (w: number, h: number) => {
      Object.defineProperty(layer, "clientWidth", { configurable: true, value: w });
      Object.defineProperty(layer, "clientHeight", { configurable: true, value: h });
      callbacks.get(layer)!();
    };
    resize(390, 844);
    return { sent: uploads.get(layer.querySelector("canvas")!)!, stop: () => { scene.dispose(); main.remove(); } };
  };
  return { start, extra, setPaperFailure: () => { failPaper = true; }, failShader: (value: boolean) => { failShader = value; } };
}

it("recovers a temporarily unavailable 2D canvas on the very next healthy peek", () => {
  const r = rig();
  r.setPaperFailure();
  const open = r.start();
  const peek = r.start();
  expect(peek.sent.some((x) => x instanceof HTMLCanvasElement)).toBe(true);
  peek.stop();
  open.stop();
});

it("does not cache a plate until the requested extra exists", () => {
  const r = rig();
  r.extra.mockReturnValueOnce(null);
  const open = r.start();
  const peek = r.start();
  expect(r.extra).toHaveBeenCalledTimes(2);
  expect(peek.sent.some((x) => x instanceof ImageData)).toBe(true);
  peek.stop();
  open.stop();
});

it("repaints after the last successful scene is disposed following failed shader allocation", () => {
  const r = rig();
  const open = r.start();
  const first = open.sent[0];
  r.failShader(true);
  expect(() => r.start()).toThrow(/WebGLShader/);
  r.failShader(false);
  open.stop();
  const fresh = r.start();
  const retained = fresh.sent[0] === first;
  expect(retained).toBe(false);
  fresh.stop();
});
