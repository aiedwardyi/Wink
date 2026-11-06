// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FitTextarea } from "./BotDetailsRows";

let host: HTMLDivElement;
let root: Root;
let fonts: EventTarget & { ready: Promise<void> };
let loaded: () => void;
let height: number;
let resized: () => void;
const fontProperty = Object.getOwnPropertyDescriptor(document, "fonts");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  height = 1000;
  fonts = Object.assign(new EventTarget(), { ready: new Promise<void>((resolve) => { loaded = resolve; }) });
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  vi.spyOn(HTMLTextAreaElement.prototype, "clientWidth", "get").mockReturnValue(315);
  vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLTextAreaElement.prototype, "clientHeight", "get").mockReturnValue(40);
  vi.spyOn(HTMLTextAreaElement.prototype, "offsetHeight", "get").mockReturnValue(42);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe() {}
    disconnect() {}
  });
  host = document.body.appendChild(document.createElement("div"));
  host.className = "overflow-y-auto";
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.head.querySelectorAll("[data-fit-test]").forEach((element) => element.remove());
  if (fontProperty) Object.defineProperty(document, "fonts", fontProperty);
  else Reflect.deleteProperty(document, "fonts");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (watchMetrics = false) => act(async () => root.render(createElement(FitTextarea, { value: "Long memory\n한국어 메모\nLast line", readOnly: true, watchMetrics })));
const box = () => host.querySelector("textarea")!;

describe("FitTextarea", () => {
  it("refits a head font override without interaction", async () => {
    height = 185;
    vi.spyOn(HTMLTextAreaElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
      return parseInt(this.style.height) - 2 || height;
    });
    vi.spyOn(HTMLTextAreaElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
      return this.clientHeight + 2;
    });
    await render(true);
    await act(async () => loaded());
    expect(box().clientHeight).toBe(185);
    height = 206;
    await act(async () => {
      const style = document.createElement("style");
      style.dataset.fitTest = "";
      style.textContent = "* { font-family: Verdana, sans-serif !important; }";
      document.head.appendChild(style);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(box().clientHeight).toBe(box().scrollHeight);
  });

  it.each(["remove", "text", "media", "href", "load"])("refits after a stylesheet %s change", async (change) => {
    const element = document.createElement(change === "href" || change === "load" ? "link" : "style");
    element.dataset.fitTest = "";
    document.head.appendChild(element);
    await render(true);
    height = 700;
    await act(async () => {
      if (change === "remove") element.remove();
      else if (change === "text") element.textContent = "textarea { font-size: 18px; }";
      else if (change === "load") element.dispatchEvent(new Event("load"));
      else element.setAttribute(change, change === "href" ? "/theme.css" : "screen");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(box().style.height).toBe("702px");
  });

  it("shares one observer and one frame across watching boxes", async () => {
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    const frames = vi.spyOn(window, "requestAnimationFrame");
    let flush: FrameRequestCallback;
    frames.mockImplementation((callback) => { flush = callback; return 1; });
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    await act(async () => root.render(createElement("div", null,
      createElement(FitTextarea, { value: "Memory", readOnly: true, watchMetrics: true }),
      createElement(FitTextarea, { value: "Description", readOnly: true, watchMetrics: true }),
    )));
    expect(observe).toHaveBeenCalledTimes(2);
    height = 700;
    const style = document.createElement("style");
    style.dataset.fitTest = "";
    await act(async () => {
      document.head.appendChild(style);
      style.textContent = "textarea { font-size: 18px; }";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(frames).toHaveBeenCalledTimes(1);
    await act(async () => flush!(0));
    expect([...host.querySelectorAll("textarea")].map((element) => element.style.height)).toEqual(["702px", "702px"]);
    await act(async () => {
      style.remove();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const detached = [...host.querySelectorAll("textarea")];
    await act(async () => root.unmount());
    expect(cancel).toHaveBeenCalledWith(1);
    height = 900;
    await act(async () => flush!(0));
    expect(detached.map((element) => element.style.height)).toEqual(["702px", "702px"]);
    root = createRoot(host);
  });

  it.each(["scroll", "focus", "pointerenter"])("refits a post-open font override on %s", async (event) => {
    await render(true);
    await act(async () => loaded());
    box().style.fontFamily = "Verdana";
    host.scrollTop = 700;
    height = 1400;
    await act(async () => (event === "scroll" ? host : box()).dispatchEvent(new Event(event)));
    expect(box().style.height).toBe("1402px");
    expect(host.scrollTop).toBe(700);
  });

  it.each(["data-skin", "lang", "class", "style"])("refits when %s changes without a font load", async (attribute) => {
    await render(true);
    height = 700;
    const previous = document.documentElement.getAttribute(attribute);
    await act(async () => {
      document.documentElement.setAttribute(attribute, attribute === "lang" ? "ko" : attribute === "style" ? "font-family: Verdana" : "terminal");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    expect(box().style.height).toBe("702px");
    if (previous === null) document.documentElement.removeAttribute(attribute);
    else document.documentElement.setAttribute(attribute, previous);
  });

  it("checks overflow on viewport resize even at the same width", async () => {
    await render(true);
    height = 1400;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(box().style.height).toBe("1402px");
  });

  it("leaves a fitted box alone on repeated safety checks", async () => {
    await render(true);
    await act(async () => loaded());
    vi.spyOn(HTMLTextAreaElement.prototype, "clientHeight", "get").mockReturnValue(height);
    const mutations = vi.fn();
    const observer = new MutationObserver(mutations);
    observer.observe(box(), { attributes: true, attributeFilter: ["style"] });
    await act(async () => {
      for (let i = 0; i < 3; i++) {
        host.dispatchEvent(new Event("scroll"));
        box().dispatchEvent(new Event("focus"));
        box().dispatchEvent(new Event("pointerenter"));
        window.dispatchEvent(new Event("resize"));
        resized();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    observer.disconnect();
    expect(mutations).not.toHaveBeenCalled();
  });

  it("keeps other textarea users unchanged", async () => {
    await render();
    height = 1400;
    await act(async () => {
      host.dispatchEvent(new Event("scroll"));
      box().dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("resize"));
    });
    expect(box().style.height).toBe("1002px");
  });

  it("removes metric listeners on unmount", async () => {
    await render(true);
    const detached = box();
    await act(async () => root.unmount());
    height = 1800;
    await act(async () => {
      host.dispatchEvent(new Event("scroll"));
      detached.dispatchEvent(new Event("focus"));
      detached.dispatchEvent(new Event("pointerenter"));
      window.dispatchEvent(new Event("resize"));
    });
    expect(detached.style.height).toBe("1002px");
    root = createRoot(host);
  });

  it("refits after a font loads without a width or value change", async () => {
    await render();
    expect(box().style.height).toBe("1002px");
    host.scrollTop = 700;
    height = 1400;
    await act(async () => {
      resized();
      fonts.dispatchEvent(new Event("loadingdone"));
    });
    expect(box().style.height).toBe("1402px");
    expect(host.scrollTop).toBe(700);
    height = 1600;
    await act(async () => fonts.dispatchEvent(new Event("loadingdone")));
    expect(box().style.height).toBe("1602px");
  });

  it("refits when fonts ready settles", async () => {
    await render();
    height = 1400;
    await act(async () => loaded());
    expect(box().style.height).toBe("1402px");
  });

  it("ignores font completion after unmount", async () => {
    await render();
    const detached = box();
    await act(async () => root.unmount());
    height = 1800;
    await act(async () => {
      loaded();
      fonts.dispatchEvent(new Event("loadingdone"));
    });
    expect(detached.style.height).toBe("1002px");
    root = createRoot(host);
  });

  it("fits font changes without ResizeObserver", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    await render();
    height = 1400;
    await act(async () => fonts.dispatchEvent(new Event("loadingdone")));
    expect(box().style.height).toBe("1402px");
  });
});
