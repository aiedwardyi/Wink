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
  if (fontProperty) Object.defineProperty(document, "fonts", fontProperty);
  else Reflect.deleteProperty(document, "fonts");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (watchMetrics = false) => act(async () => root.render(createElement(FitTextarea, { value: "Long memory\n한국어 메모\nLast line", readOnly: true, watchMetrics })));
const box = () => host.querySelector("textarea")!;

describe("FitTextarea", () => {
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

  it.each(["data-skin", "lang"])("refits when %s changes without a font load", async (attribute) => {
    await render(true);
    height = 700;
    const previous = document.documentElement.getAttribute(attribute);
    await act(async () => {
      document.documentElement.setAttribute(attribute, attribute === "lang" ? "ko" : "terminal");
      await new Promise((resolve) => setTimeout(resolve, 0));
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
