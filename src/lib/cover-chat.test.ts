// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCoverChat } from "./cover-chat";

type Pass = { finished: Promise<void>; done: () => void; cancel: ReturnType<typeof vi.fn>; id: string; effect: { target: Element } };

let root: Root;
let host: HTMLDivElement;
let chat: number;
let passes: Pass[];
let observers: (() => void)[];
const aside = () => host.querySelector<HTMLElement>("aside")!;

function Probe({ closing }: { closing: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const style = useCoverChat(panel, true, closing);
  return createElement("div", null, createElement("main"), createElement("aside", { ref: panel, style }, createElement("div")));
}

const render = (closing: boolean) => act(async () => root.render(createElement(Probe, { closing })));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  chat = 560;
  passes = [];
  observers = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(private fn: () => void) { observers.push(fn); }
    observe() {}
    disconnect() { observers = observers.filter((each) => each !== this.fn); }
  });
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: !query.includes("reduced-motion") } as MediaQueryList));
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.tagName === "MAIN" ? chat : 0; });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value(this: Element, _: Keyframe[], options: KeyframeAnimationOptions) {
      let done = () => undefined as void;
      const finished = new Promise<void>((resolve) => { done = resolve; });
      const pass = { finished, done, cancel: vi.fn(), id: String(options.id), effect: { target: this } };
      passes.push(pass);
      return pass;
    },
  });
  Object.defineProperty(document, "getAnimations", { configurable: true, value: () => passes });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useCoverChat", () => {
  it("keeps its own width and its last frame while it closes", async () => {
    await render(false);
    await act(async () => { for (const each of passes) each.done(); });
    expect(aside().style.width).toBe("960px");
    passes = [];
    await render(true);
    chat = 960;
    await act(async () => { for (const each of observers) each(); });
    expect(aside().style.width).toBe("960px");
    await act(async () => { for (const each of passes) each.done(); });
    expect(aside().dataset.coverMotion).toBe("");
    expect(passes.every((each) => each.cancel.mock.calls.length === 0)).toBe(true);
  });
});
