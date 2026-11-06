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

const render = () => act(async () => root.render(createElement(FitTextarea, { value: "Long memory\n한국어 메모\nLast line", readOnly: true })));
const box = () => host.querySelector("textarea")!;

describe("FitTextarea", () => {
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
