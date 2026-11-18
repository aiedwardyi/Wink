// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";

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
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get(this: HTMLElement) { return this.hasAttribute("data-fold-clip") ? full.height : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute("data-fold-clip") ? Math.min(full.height, 60) : 0; },
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
    const clip = host.querySelector("[data-fold-clip]")!;
    expect(watched).toHaveLength(1);
    expect(watched[0]).not.toBe(clip);
    expect(clip.contains(watched[0])).toBe(true);
    expect(host.querySelector("button")).toBeNull();
    full.height = 120;
    await act(async () => callbacks.forEach((callback) => callback()));
    expect(host.querySelector("button")?.textContent).toBe("Show full message");
  });

  // a shared rule (Fold's [data-fold] grid) pinned the content at the cap, so the observer went quiet mid-stream
  it("keeps the capped box free of shared motion rules", async () => {
    const { watched } = await mount({ height: 60 });
    const clip = watched[0].parentElement!;
    const css = readFileSync("src/motion.css", "utf8");
    const styled = new Set([...css.matchAll(/\[(data-[\w-]+)/g)].map((m) => m[1]));
    expect(styled.has("data-fold")).toBe(true);
    for (const name of clip.getAttributeNames()) expect(styled.has(name), name).toBe(false);
  });

  it("gives the toggle a button type", async () => {
    const { host } = await mount({ height: 120 });
    expect(host.querySelector("button")?.getAttribute("type")).toBe("button");
  });
});
