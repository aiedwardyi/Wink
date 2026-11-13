import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented";

let root: Root;
let host: HTMLDivElement;
let resize: () => void;
let available: number;
let phone: boolean;
const options = Array.from({ length: 7 }, (_, i) => ({ id: String(i), label: `Tab ${i}` }));
const group = () => host.querySelector<HTMLElement>('[role="radiogroup"]')!;
const render = (value = "0", peek = true) => act(() => root.render(createElement(Segmented, { label: "Benchmark", value, options, onChange: () => undefined, peek })));

beforeEach(() => {
  available = 300;
  phone = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(window, "matchMedia").mockImplementation(() => ({ matches: phone }) as MediaQueryList);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this === host ? available : Number.parseFloat(this.style.maxWidth) || available; });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(468);
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) { return this.tagName === "BUTTON" ? 3 + options.findIndex((option) => option.label === this.textContent) * 66 : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(64);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("scroll cue", () => {
  it("reveals a selected tab on mount and when selection changes", () => {
    render("6");
    expect(group().scrollLeft).toBeGreaterThan(160);
    render("0");
    expect(group().scrollLeft).toBe(0);
    render("5");
    expect(group().scrollLeft).toBe(100);
  });

  it("leaves a partial next tab visible without a fade", () => {
    available = 270;
    render();
    expect(group().style.maxWidth).toBe("233px");
    expect(group().style.maskImage).toBe("");
  });

  it("keeps enough of an already partial next tab", () => {
    render();
    expect(group().style.maxWidth).toBe("300px");
    expect(group().style.maskImage).toBe("");
  });

  it("rechecks selection and the cue after resizing", () => {
    render("6");
    available = 220;
    act(() => resize());
    act(() => resize());
    expect(group().style.maxWidth).toBe("167px");
    expect(group().scrollLeft).toBeGreaterThan(200);
  });

  it("leaves desktop dimensions and its fade unchanged", () => {
    phone = false;
    render();
    expect(group().style.maxWidth).toBe("");
    expect(group().style.maskImage).toContain("linear-gradient");
  });

  it("leaves other segmented controls unchanged", () => {
    render("6", false);
    expect(group().scrollLeft).toBe(0);
    expect(group().style.maxWidth).toBe("");
    expect(group().style.maskImage).toContain("linear-gradient");
  });
});

describe("selected ring", () => {
  it("draws the ring inside the selected thumb in place of its hairline", () => {
    act(() => root.render(createElement(Segmented, { label: "Chat Box", value: "1", options, onChange: () => undefined, ring: createElement("i", { "data-ring": "" }) })));
    const thumb = () => group().querySelector<HTMLElement>("[data-segmented-thumb]")!;
    expect(thumb().querySelector("[data-ring]")).not.toBeNull();
    expect(thumb().className).not.toContain("ring-1");
    render("1", false);
    expect(group().querySelector("[data-ring]")).toBeNull();
    expect(thumb().className).toContain("ring-1");
  });
});
