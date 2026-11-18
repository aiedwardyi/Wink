// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n";

import { FoldClip } from "./FoldClip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => {
  await unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});

async function mount(full: { height: number }) {
  const watched: Element[] = [];
  const callbacks: (() => void)[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { callbacks.push(callback); }
    observe(target: Element) { watched.push(target); }
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get(this: HTMLElement) { return this.hasAttribute("data-fold") ? full.height : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute("data-fold") ? Math.min(full.height, 60) : 0; },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  await act(async () => root.render(createElement(I18nProvider, null, createElement(FoldClip, null, "text"))));
  return { host, watched, callbacks };
}

describe("FoldClip", () => {
  it("watches its content, so growth inside the capped box still shows the toggle", async () => {
    const full = { height: 60 };
    const { host, watched, callbacks } = await mount(full);
    const clip = host.querySelector("[data-fold]")!;
    expect(watched).toHaveLength(1);
    expect(watched[0]).not.toBe(clip);
    expect(clip.contains(watched[0])).toBe(true);
    expect(host.querySelector("button")).toBeNull();
    full.height = 120;
    await act(async () => callbacks.forEach((callback) => callback()));
    expect(host.querySelector("button")?.textContent).toBe("Show full message");
  });

  it("gives the toggle a button type", async () => {
    const { host } = await mount({ height: 120 });
    expect(host.querySelector("button")?.getAttribute("type")).toBe("button");
  });
});
