// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { usePhoneHeaderNameFloor } from "./use-phone-header-name";

let root: Root;
let host: HTMLElement;
let available = 40;
let phone = true;
let crowded: "cluster" | "child" | null = null;

function Harness() {
  const cluster = useRef<HTMLDivElement>(null);
  const name = useRef<HTMLButtonElement>(null);
  usePhoneHeaderNameFloor(cluster, name, "A long bot name", false);
  return createElement("header", null,
    createElement("div", { ref: cluster, "data-cluster": true },
      createElement("button", { "data-avatar": true }),
      createElement("button", { ref: name, "data-name": true }, "A long bot name"),
    ),
    createElement("div", { "data-controls": true },
      createElement("button", { "data-chip": true },
        createElement("span", { "data-model-label": true }, "Opus 5.5"),
        createElement("span", { "data-model-effort": true }, "Max"),
      ),
    ),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  available = 40;
  phone = true;
  crowded = null;
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation(query => {
    const media = matchMedia(query);
    Object.defineProperty(media, "matches", { get: () => phone });
    return media;
  });
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    let left = 0;
    let width = 392;
    if (this.hasAttribute("data-name")) width = this.style.width === "max-content" ? 120 : Math.max(64, Number.parseFloat(this.style.minWidth) || 120);
    else if (this.hasAttribute("data-avatar")) width = 40;
    else if (this.hasAttribute("data-cluster")) width = 180;
    else if (this.hasAttribute("data-controls") || this.hasAttribute("data-chip")) {
      const overlaps = crowded === "cluster" && this.hasAttribute("data-controls") || crowded === "child" && this.hasAttribute("data-chip");
      const controls = this.hasAttribute("data-controls") ? this : this.parentElement;
      left = overlaps && !controls?.style.columnGap ? 150 : 260;
      width = 132;
    }
    else if (this.hasAttribute("data-model-label")) {
      left = 392 - available;
      width = this.style.display === "none" ? 0 : this.style.minWidth === "max-content" ? 80 : Math.min(40, available);
    } else if (this.hasAttribute("data-model-effort")) { left = 370; width = this.style.display === "none" ? 0 : 30; }
    return { x: left, y: 0, left, right: left + width, top: 0, bottom: 30, width, height: 30, toJSON() {} };
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-model-label") ? 80 : 0; });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-model-label") ? this.getBoundingClientRect().width : 0; });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps a positive model label width when only a truncated name fits", async () => {
  await act(async () => root.render(createElement(Harness)));
  const label = host.querySelector<HTMLElement>("[data-model-label]")!;
  expect(label.style.display).not.toBe("none");
  expect(label.style.textOverflow).toBe("ellipsis");
  expect(label.getBoundingClientRect().width).toBeGreaterThan(0);
});

it("shows the full short model name when the header has room", async () => {
  available = 100;
  await act(async () => root.render(createElement(Harness)));
  const label = host.querySelector<HTMLElement>("[data-model-label]")!;
  expect(label.style.display).not.toBe("none");
  expect(label.getBoundingClientRect().width).toBe(80);
  expect(host.querySelector("header")!.style.columnGap).toBe("");
  expect(host.querySelector<HTMLElement>("[data-controls]")!.style.columnGap).toBe("");
});

it.each(["cluster", "child"] as const)("compacts an overlapping %s and restores spacing when it fits", async (overlap) => {
  crowded = overlap;
  await act(async () => root.render(createElement(Harness)));
  const header = host.querySelector("header")!;
  const controls = host.querySelector<HTMLElement>("[data-controls]")!;
  expect(header.style.columnGap).toBe("4px");
  expect(controls.style.columnGap).toBe("4px");
  expect(host.querySelector<HTMLElement>("[data-name]")!.style.minWidth).toBe("64px");
  expect(host.querySelector<HTMLElement>("[data-model-label]")!.getBoundingClientRect().width).toBeGreaterThan(0);
  crowded = null;
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(header.style.columnGap).toBe("");
  expect(controls.style.columnGap).toBe("");
});

it("leaves desktop sizing alone", async () => {
  phone = false;
  await act(async () => root.render(createElement(Harness)));
  for (const element of host.querySelectorAll<HTMLElement>("[data-name], [data-cluster], [data-chip], [data-model-label]")) {
    expect(element.getAttribute("style") ?? "").toBe("");
  }
});

it("clears phone fitting styles when the window becomes desktop width", async () => {
  await act(async () => root.render(createElement(Harness)));
  phone = false;
  await act(async () => window.dispatchEvent(new Event("resize")));
  for (const element of host.querySelectorAll<HTMLElement>("[data-name], [data-cluster], [data-controls], [data-chip], [data-model-label]")) {
    expect(element.getAttribute("style") ?? "").toBe("");
  }
});

it("refits the label when attention clears on the separate menu button", async () => {
  const menu = document.body.appendChild(document.createElement("button"));
  menu.dataset.phoneMenu = "";
  menu.className = "needs-you-glow";
  Object.defineProperty(menu, "getBoundingClientRect", { configurable: true, value: () => ({ x: 396, y: 0, left: 396, right: 426, top: 0, bottom: 30, width: 30, height: 30, toJSON() {} }) });
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => computed(element));
  try {
    await act(async () => root.render(createElement(Harness)));
    expect(host.querySelector("header")!.getBoundingClientRect().width).toBe(392);
    const label = host.querySelector<HTMLElement>("[data-model-label]")!;
    expect(label.style.textOverflow).toBe("ellipsis");
    available = 100;
    await act(async () => {
      menu.classList.remove("needs-you-glow");
      await new Promise(done => setTimeout(done, 0));
    });
    expect(label.getBoundingClientRect().width).toBe(80);
    expect(label.style.textOverflow).toBe("clip");
  } finally {
    menu.remove();
  }
});
