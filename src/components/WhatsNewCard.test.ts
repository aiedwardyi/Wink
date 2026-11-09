// @vitest-environment happy-dom
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { WHATS_NEW } from "@/lib/whats-new";

const api = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true }));
const dispatch = vi.fn();
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args), useStore: () => ({ dispatch }) }));

let observers: { see: IntersectionObserverCallback; node?: Element }[] = [];
vi.stubGlobal(
  "IntersectionObserver",
  class {
    node?: Element;
    constructor(public see: IntersectionObserverCallback) {
      observers.push(this);
    }
    observe(node: Element) {
      this.node = node;
    }
    disconnect() {}
  },
);

const { default: WhatsNewCard } = await import("./WhatsNewCard");

const RELEASE = Object.keys(WHATS_NEW)[0];

describe("whats new card", () => {
  let host: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  const onClose = vi.fn();

  beforeEach(() => {
    applyLocale("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    api.mockClear();
    dispatch.mockClear();
    onClose.mockClear();
    observers = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (release: string) => act(() => root.render(createElement(WhatsNewCard, { release, closing: false, onClose })));
  const scrollIntoView = () =>
    act(() => {
      for (const observer of observers.filter((o) => o.node?.classList.contains("whats-new"))) {
        observer.see([{ isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
      }
    });
  const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name)!;

  it("renders nothing and records nothing for a release with no entry", () => {
    render("0.0.1");
    expect(host.innerHTML).toBe("");
    expect(api).not.toHaveBeenCalled();
  });

  it("records the shown release as seen once, only after it scrolls into view", () => {
    render(RELEASE);
    render(RELEASE);
    expect(host.querySelectorAll(".whats-new-tile")).toHaveLength(2);
    expect(api).not.toHaveBeenCalled();
    scrollIntoView();
    scrollIntoView();
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/api/whats-new/seen", { method: "POST", body: JSON.stringify({ release: RELEASE }) });
  });

  it("closes from Got it, the X and Escape", () => {
    render(RELEASE);
    act(() => button("Got it").click());
    act(() => button("Close what's new").click());
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("opens Memory from its Show me and explains the one that starts on its own", () => {
    render(RELEASE);
    const [memory, verify] = [...host.querySelectorAll<HTMLButtonElement>(".whats-new-show")];
    act(() => verify.click());
    expect(verify.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain((WHATS_NEW[RELEASE].tiles[1].show as { en: string }).en);
    expect(onClose).not.toHaveBeenCalled();
    act(() => memory.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, memory: { line: "" } });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ships every string in Korean", () => {
    applyLocale("ko");
    render(RELEASE);
    expect(button("확인")).toBeTruthy();
    expect(host.textContent).toContain(WHATS_NEW[RELEASE].title.ko);
    for (const entry of Object.values(WHATS_NEW)) {
      for (const copy of [entry.title, entry.more, ...entry.tiles.flatMap((tile) => [tile.title, tile.line, ...(tile.show === "memory" ? [] : [tile.show])])]) {
        expect(copy.ko.trim()).not.toBe("");
      }
    }
  });

  it("keeps the previews small", () => {
    const dir = "src/assets/whats-new";
    const bytes = readdirSync(dir).reduce((sum, file) => sum + statSync(join(dir, file)).size, 0);
    expect(bytes).toBeLessThan(1.5 * 1024 * 1024);
  });
});
