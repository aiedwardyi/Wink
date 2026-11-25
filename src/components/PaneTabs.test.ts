// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement, useRef, type CSSProperties } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useI18n } from "@/lib/i18n";
import { closeShow, paneTabs, showCheck, showMap, showMedia, showTimeline, showWorkers, usePaneTabs, type PaneTool } from "@/lib/show-pane";
import { PANE_WIDTH_KEY, PaneEdge, PaneTabs, PaneToolMenu, TOOL_ICON, TOOL_LABEL, usePaneWidth, type TabView } from "./PaneTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

function Strip({ threadId, onSay }: { threadId: string; onSay: (said: string) => void }) {
  const { t } = useI18n();
  const row = useRef<HTMLDivElement>(null);
  const tabs = usePaneTabs(threadId).filter((entry): entry is PaneTool => typeof entry === "string").map((entry): TabView => ({ key: entry, entry, name: t(TOOL_LABEL[entry]), icon: TOOL_ICON[entry] }));
  return createElement("div", { ref: row, role: "tablist" }, createElement(PaneTabs, { row, threadId, tabs, active: tabs[0]?.key ?? null, onOpen() {}, onClose() {}, onSay }));
}

function Edge() {
  const pane = useRef<HTMLElement>(null);
  const [width, setWidth] = usePaneWidth();
  return createElement("aside", { ref: pane, style: { "--pane-width": width ? `${width}px` : undefined } as CSSProperties }, createElement(PaneEdge, { pane, width, onWidth: setWidth }));
}

const tabs = () => [...host.querySelectorAll<HTMLElement>("[data-pane-tab]")];
const label = (key: string) => host.querySelector(`[data-pane-tab="${key}"] [role="tab"]`)!;
const point = (el: Element, type: string, clientX: number) => act(async () => { el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: "mouse", clientX })); });
const press = (el: EventTarget, key: string) => act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

// happy-dom has no layout, so each tab gets a 100 px box by hand, and the row the width it scrolls in.
const layOut = (scrollLeft: number, clientWidth: number) => {
  tabs().forEach((tab, i) => Object.defineProperties(tab, { offsetLeft: { configurable: true, value: i * 100 }, offsetWidth: { configurable: true, value: 100 } }));
  Object.defineProperties(host.querySelector("[role=tablist]")!, { scrollLeft: { configurable: true, value: scrollLeft }, clientWidth: { configurable: true, value: clientWidth } });
};

async function liftMedia(threadId: string, onSay: (said: string) => void) {
  await act(async () => { showMedia(threadId); showMap(threadId); showTimeline(threadId); });
  await act(async () => root.render(createElement(Strip, { threadId, onSay })));
  layOut(0, 300);
  await point(label("media"), "pointerdown", 50);
  await point(label("media"), "pointermove", 200);
  expect(document.querySelector("[data-ghost]")).not.toBeNull();
  expect(tabs().map((tab) => tab.style.translate)).toEqual(["", "-100px 0", ""]);
}

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); act(() => closeShow()); host.remove(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("Esc cancels a tab drag and puts every tab back where it was", async () => {
  const said = vi.fn();
  await liftMedia("t1", said);
  await press(window, "Escape");
  expect(document.querySelector("[data-ghost]")).toBeNull();
  expect(tabs().map((tab) => [tab.style.translate, tab.style.transition, tab.hasAttribute("data-slot")])).toEqual([["", "", false], ["", "", false], ["", "", false]]);
  expect(document.documentElement.hasAttribute("data-pane-dragging")).toBe(false);
  await point(label("media"), "pointerup", 200);
  expect(paneTabs("t1")).toEqual(["media", "map", "timeline"]);
  expect(said).not.toHaveBeenCalled();
});

it("a released drag moves the tab past the neighbour it crossed", async () => {
  const said = vi.fn();
  await liftMedia("t2", said);
  await point(label("media"), "pointerup", 200);
  expect(document.querySelector("[data-ghost]")).toBeNull();
  expect(paneTabs("t2")).toEqual(["map", "media", "timeline"]);
  expect(tabs().map((tab) => tab.dataset.paneTab)).toEqual(["map", "media", "timeline"]);
  expect(said).toHaveBeenCalledWith("Media moved to position 2 of 3");
});

it.each([[-1000, -108], [1000, 8]])("a dragged tab in a row that scrolls stays inside the strip you can see (to %i)", async (to, end) => {
  const threadId = `t5${to}`;
  await act(async () => { showWorkers(threadId); showMedia(threadId); showCheck(threadId); showMap(threadId); showTimeline(threadId); });
  await act(async () => root.render(createElement(Strip, { threadId, onSay() {} })));
  // 500 px of tabs scrolled 200 px into a 200 px strip: Map, at 300, is the last one in view.
  layOut(200, 200);
  await point(label("map"), "pointerdown", 350);
  await point(label("map"), "pointermove", 350 + to);
  const x = parseFloat(document.querySelector<HTMLElement>("[data-ghost]")!.style.translate);
  expect(Math.abs(x)).toBeLessThanOrEqual(Math.abs(end));
  expect(Math.abs(x)).toBeGreaterThan(Math.abs(end) - 8);
  await point(label("map"), "pointerup", 350 + to);
});

it("Esc cancels an edge resize, the arrow keys step the width and a double-click resets it", async () => {
  vi.stubGlobal("innerWidth", 1440);
  localStorage.setItem(PANE_WIDTH_KEY, "520");
  await act(async () => root.render(createElement(Edge)));
  const aside = host.querySelector("aside")!;
  const width = () => aside.style.getPropertyValue("--pane-width");
  aside.getBoundingClientRect = () => ({ width: parseFloat(width()) || 500 }) as DOMRect;
  const edge = host.querySelector<HTMLElement>("[data-pane-edge]")!;
  const kept = vi.spyOn(localStorage, "setItem");
  await point(edge, "pointerdown", 1000);
  await point(edge, "pointermove", 900);
  await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
  expect(width()).toBe("620px");
  await press(window, "Escape");
  expect(width()).toBe("520px");
  expect(edge.hasAttribute("data-drag")).toBe(false);
  expect(kept).not.toHaveBeenCalled();
  expect(localStorage.getItem(PANE_WIDTH_KEY)).toBe("520");
  await press(edge, "ArrowLeft");
  expect([width(), localStorage.getItem(PANE_WIDTH_KEY)]).toEqual(["544px", "544"]);
  await press(edge, "ArrowRight");
  expect([width(), localStorage.getItem(PANE_WIDTH_KEY)]).toEqual(["520px", "520"]);
  await act(async () => { edge.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  expect([width(), localStorage.getItem(PANE_WIDTH_KEY)]).toEqual(["", null]);
});

it("opens the + menu above the phone sheet", async () => {
  const sheet = Number(readFileSync("src/components/ShowPane.css", "utf8").match(/\.verify-watch\.show-pane \{[^}]*z-index: (\d+)/)![1]);
  await act(async () => root.render(createElement(PaneToolMenu, { rows: [{ tool: "media" }], onPick() {} })));
  await act(async () => host.querySelector<HTMLButtonElement>("[data-pane-add]")!.click());
  const menu = document.querySelector("[data-pane-tools-menu]")!;
  expect(Number(menu.className.match(/\bz-\[?(\d+)\]?/)![1])).toBeGreaterThan(sheet);
});
