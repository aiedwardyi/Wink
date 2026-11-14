// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startIdleMotion } from "@/lib/idle-motion";
import { startScene, type SceneEvent, type SceneHost, type SceneModule } from "./scene-host";

const root = document.documentElement;
let frames: FrameRequestCallback[] = [];
let host: SceneHost | undefined;
let reduce = false;

function flush(n = 1) {
  for (let i = 0; i < n; i++) {
    const due = frames;
    frames = [];
    for (const run of due) run(performance.now());
  }
}

function scene(pauseOnBlur = false, lasts = Infinity) {
  const drawn: number[] = [];
  const seen: SceneEvent["name"][] = [];
  const module: SceneModule = {
    pauseOnBlur,
    create: (api) => ({
      frame: (t) => (drawn.push(t), drawn.length < lasts),
      event: (event) => {
        seen.push(event.name);
        if (event.name === "busy") api.wake();
      },
      dispose: () => undefined,
    }),
  };
  host = startScene(document.createElement("div"), module, root);
  return { drawn, seen };
}

beforeEach(() => {
  reduce = false;
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => frames.push(run));
  vi.stubGlobal("cancelAnimationFrame", () => (frames = []));
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") && reduce, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  host?.stop();
  host = undefined;
  frames = [];
  root.removeAttribute("data-orbit-idle");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat scene host", () => {
  it("runs no frames until an event asks, and stops when the scene is done", () => {
    const { drawn } = scene(false, 3);
    flush(3);
    expect(drawn).toHaveLength(0);
    host!.emit({ name: "busy" });
    flush(10);
    expect(drawn).toHaveLength(3);
    expect(host!.running()).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it("halts in the same frame the window goes hidden and resumes when shown", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const stopIdle = startIdleMotion(root);
    const { drawn } = scene();
    host!.emit({ name: "busy" });
    flush(2);
    expect(drawn).toHaveLength(2);
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(host!.running()).toBe(false);
    expect(frames).toHaveLength(0);
    flush(5);
    expect(drawn).toHaveLength(2);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    flush(1);
    expect(drawn).toHaveLength(3);
    stopIdle();
  });

  it("pauses on blur only for scenes that ask", async () => {
    const { drawn } = scene(true);
    host!.emit({ name: "busy" });
    flush(1);
    root.setAttribute("data-orbit-idle", "blur");
    await Promise.resolve();
    flush(3);
    expect(drawn).toHaveLength(1);
    host!.stop();
    root.removeAttribute("data-orbit-idle");
    const other = scene(false);
    host!.emit({ name: "busy" });
    root.setAttribute("data-orbit-idle", "blur");
    await Promise.resolve();
    flush(3);
    expect(other.drawn).toHaveLength(3);
  });

  it("reads the skin where it is told to and still rests with the window", async () => {
    const look = document.createElement("div");
    look.dataset.skin = "snow";
    root.dataset.skin = "precision";
    let skin = "";
    const module: SceneModule = {
      pauseOnBlur: false,
      create: (api) => ({ frame: () => true, event: () => ((skin = api.skin()), api.wake()), dispose: () => undefined }),
    };
    host = startScene(document.createElement("div"), module, root, look);
    host.emit({ name: "loop" });
    delete root.dataset.skin;
    expect(skin).toBe("snow");
    flush(1);
    expect(host.running()).toBe(true);
    root.setAttribute("data-orbit-idle", "hidden");
    await Promise.resolve();
    expect(host.running()).toBe(false);
  });

  it("never starts a loop under reduced motion", () => {
    reduce = true;
    const { drawn, seen } = scene();
    host!.emit({ name: "busy" });
    flush(3);
    expect(seen).toEqual(["busy"]);
    expect(drawn).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });
});
