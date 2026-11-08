// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import { Fold } from "./Fold";

let host: HTMLDivElement;
let root: Root;

function stubReducedMotion(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

const render = (open: boolean, id?: string) =>
  act(async () => root.render(createElement(Fold, { open, id, children: createElement("p", { "data-body": "" }, "Notes") })));
const fold = () => host.querySelector<HTMLElement>("[data-fold]");
const body = () => host.querySelector("[data-body]");
const settle = (name = "fold-open") =>
  act(async () => {
    const end = new Event("animationend", { bubbles: true });
    Object.defineProperty(end, "animationName", { value: name });
    fold()!.dispatchEvent(end);
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  stubReducedMotion(false);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Fold", () => {
  it("shows content that is open at mount at once, with no fold motion", async () => {
    await render(true);
    expect(fold()?.dataset.fold).toBe("open");
    expect(body()?.textContent).toBe("Notes");
  });

  it("shows the last open content while a keep fold closes", async () => {
    const keep = (open: boolean, label: string) =>
      act(async () => root.render(createElement(Fold, { open, keep: true, children: createElement("p", { "data-body": "" }, label) })));
    await keep(true, "Notes");
    await keep(false, "");
    expect(fold()?.dataset.fold).toBe("closing");
    expect(body()?.textContent).toBe("Notes");
    await act(async () => { vi.advanceTimersByTime(PRESENCE_EXIT_MS); });
    expect(fold()).toBeNull();
  });

  it("renders nothing while closed, or an empty hidden box that keeps its id", async () => {
    await render(false);
    expect(host.innerHTML).toBe("");
    await render(false, "more");
    expect(host.innerHTML).toBe('<div id="more" hidden=""></div>');
    await render(true, "more");
    expect(fold()?.id).toBe("more");
    expect(fold()?.hidden).toBe(false);
  });

  it("folds open on the shared motion and settles when its fold-open ends", async () => {
    await render(false);
    await render(true);
    expect(fold()?.dataset.fold).toBe("opening");
    expect(body()).not.toBeNull();
    await settle("fade-in");
    expect(fold()?.dataset.fold).toBe("opening");
    await settle();
    expect(fold()?.dataset.fold).toBe("open");
  });

  it("keeps closing content in place, inert, for the exit, then unmounts it", async () => {
    await render(true);
    await render(false);
    expect(fold()?.dataset.fold).toBe("closing");
    expect(fold()?.hasAttribute("inert")).toBe(true);
    expect(body()).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS - 1));
    expect(body()).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(host.innerHTML).toBe("");
  });

  it("takes a click during the motion: reopening mid-close keeps the same content", async () => {
    await render(true);
    const shown = body();
    await render(false);
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS / 2));
    await render(true);
    expect(body()).toBe(shown);
    expect(fold()?.dataset.fold).toBe("opening");
    expect(fold()?.hasAttribute("inert")).toBe(false);
    await act(async () => vi.advanceTimersByTime(PRESENCE_EXIT_MS * 2));
    expect(body()).toBe(shown);
  });

  it("opens and closes at once when instant", async () => {
    const instant = (open: boolean) => act(async () => root.render(createElement(Fold, { open, instant: true, children: createElement("p", { "data-body": "" }, "Notes") })));
    await instant(false);
    await instant(true);
    expect(fold()?.dataset.fold).toBe("open");
    await instant(false);
    expect(host.innerHTML).toBe("");
  });

  it("opens and closes at once under reduced motion", async () => {
    stubReducedMotion(true);
    await render(false);
    await render(true);
    expect(fold()?.dataset.fold).toBe("open");
    await render(false);
    expect(host.innerHTML).toBe("");
  });
});
