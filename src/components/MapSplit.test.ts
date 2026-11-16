// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MapSplit } from "./MapSplit";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let host: HTMLDivElement;
let frames: FrameRequestCallback[];
const el = (selector: string) => host.querySelector<HTMLElement>(selector)!;
const size = (node: HTMLElement, sizes: Record<string, number>) => { for (const [key, value] of Object.entries(sizes)) Object.defineProperty(node, key, { configurable: true, value }); };

function Pane({ rows = true, code = true }: { rows?: boolean; code?: boolean }) {
  const top = useRef<HTMLDivElement>(null);
  return createElement("div", { className: "map-pane" },
    createElement("div", { ref: top, className: "map-top", style: { minHeight: "96px" } }),
    rows && createElement(MapSplit, { target: top, rows: true }),
    createElement("section", { className: "map-flow-rows" }, createElement("div", { className: "map-flow-list" }, ...Array.from({ length: 6 }, (_, i) => createElement("div", { key: i, className: "map-flow-row" })))),
    code && createElement(MapSplit, { target: top }),
    createElement("div", { className: "map-code" }));
}
const mount = async (props: { rows?: boolean; code?: boolean } = {}) => {
  await act(async () => root.render(createElement(Pane, props)));
  size(el(".map-pane"), { clientHeight: 1000 });
  size(el(".map-top"), { scrollHeight: 600, offsetHeight: 201, clientHeight: 200 });
  size(el(".map-flow-list"), { scrollHeight: 228, clientHeight: 158 });
  size(el(".map-code"), { clientHeight: 300 });
  const heights = new Map([[el(".map-top"), 200], [el(".map-flow-rows"), 170], [el(".map-flow-row"), 36]]);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return { height: heights.get(this) ?? 0 } as DOMRect; });
};
const drag = (line: HTMLElement, from: number, to: number) => act(async () => {
  line.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientY: from }));
  line.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: to }));
  for (const frame of frames.splice(0)) frame(0);
});
const drop = (line: HTMLElement) => act(async () => { line.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 })); });
const key = (line: HTMLElement, name: string) => act(async () => { line.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
const rowsLine = () => el('[aria-label="Resize the file tree"]');
const codeLine = () => el('[aria-label="Resize the code view"]');
const share = (node: HTMLElement, name: string) => node.style.getPropertyValue(name);

beforeEach(() => {
  localStorage.clear();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("renders a second line between the tree and the Git rows with the first line's look", async () => {
  await mount();
  const [first, second] = [rowsLine(), codeLine()];
  expect(first.previousElementSibling?.className).toBe("map-top");
  expect(first.nextElementSibling?.className).toBe("map-flow-rows");
  expect(first.getAttribute("role")).toBe("separator");
  expect(first.tabIndex).toBe(0);
  expect(first.className).toBe(second.className);
});

it("drags the tree taller while the Git rows give the same height, and keeps both as shares of the pane", async () => {
  await mount();
  await drag(rowsLine(), 100, 150);
  expect(share(el(".map-top"), "--map-split")).toBe("250px");
  expect(share(el(".map-flow-rows"), "--map-rows")).toBe("120px");
  await drop(rowsLine());
  expect(share(el(".map-top"), "--map-split")).toBe("25.0%");
  expect(share(el(".map-pane"), "--map-rows")).toBe("12.0%");
  expect(share(el(".map-flow-rows"), "--map-rows")).toBe("");
  expect([localStorage.getItem("omb-map-split"), localStorage.getItem("omb-map-rows")]).toEqual(["25.0", "12.0"]);
});

it("hands the Git rows back to their saved share when a drag ends where it began", async () => {
  await mount();
  await drag(rowsLine(), 100, 150);
  await act(async () => { rowsLine().dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientY: 100 })); for (const frame of frames.splice(0)) frame(0); });
  expect(share(el(".map-flow-rows"), "--map-rows")).toBe("170px");
  await drop(rowsLine());
  expect(share(el(".map-flow-rows"), "--map-rows")).toBe("");
  expect(localStorage.getItem("omb-map-rows")).toBe(null);
});

it("keeps one Git row and lets the rows take back only what they hide", async () => {
  await mount();
  await drag(rowsLine(), 100, 900);
  expect(share(el(".map-top"), "--map-split")).toBe("322px");
  expect(share(el(".map-flow-rows"), "--map-rows")).toBe("48px");
  await drop(rowsLine());
  await drag(rowsLine(), 900, -900);
  expect(share(el(".map-top"), "--map-split")).toBe("130px");
  expect(share(el(".map-flow-rows"), "--map-rows")).toBe("240px");
});

it("never shrinks the tree under its minimum", async () => {
  await mount();
  size(el(".map-flow-list"), { scrollHeight: 2000, clientHeight: 158 });
  await drag(rowsLine(), 100, -900);
  expect(share(el(".map-top"), "--map-split")).toBe("96px");
  expect(share(el(".map-flow-rows"), "--map-rows")).toBe("274px");
});

it("moves the line with the arrow keys", async () => {
  await mount();
  await key(rowsLine(), "ArrowDown");
  expect([share(el(".map-top"), "--map-split"), share(el(".map-pane"), "--map-rows")]).toEqual(["22.4%", "14.6%"]);
  await key(rowsLine(), "ArrowUp");
  expect([share(el(".map-top"), "--map-split"), share(el(".map-pane"), "--map-rows")]).toEqual(["17.6%", "19.4%"]);
  expect(localStorage.getItem("omb-map-rows")).toBe("19.4");
});

it("restores the saved sizes when the Map opens", async () => {
  localStorage.setItem("omb-map-split", "40");
  localStorage.setItem("omb-map-rows", "12.5");
  await mount();
  expect(share(el(".map-top"), "--map-split")).toBe("40%");
  expect(share(el(".map-pane"), "--map-rows")).toBe("12.5%");
});

it("leaves the Git rows alone when the code view line moves", async () => {
  localStorage.setItem("omb-map-rows", "12.5");
  await mount({ rows: false });
  expect(share(el(".map-pane"), "--map-rows")).toBe("");
  await drag(codeLine(), 100, 900);
  expect(share(el(".map-top"), "--map-split")).toBe("380px");
  await drop(codeLine());
  expect(share(el(".map-pane"), "--map-rows")).toBe("");
  expect(localStorage.getItem("omb-map-rows")).toBe("12.5");
});
