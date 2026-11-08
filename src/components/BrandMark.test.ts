// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function render() {
  const { BrandMark } = await import("./BrandMark");
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(createElement(BrandMark)));
  return { host, unmount: () => act(async () => root.unmount()) };
}

it("renders only the spacer without a brand override", async () => {
  vi.stubGlobal("ogb", { getBrand: async () => null });
  const view = await render();
  expect(view.host.innerHTML).toBe("<div></div>");
  await view.unmount();
});

it("renders only the spacer in a browser", async () => {
  const view = await render();
  expect(view.host.innerHTML).toBe("<div></div>");
  await view.unmount();
});

it("shows the override's logo and name", async () => {
  vi.stubGlobal("ogb", { getBrand: async () => ({ name: "커맨더", icon: "data:image/png;base64,AA==" }) });
  const view = await render();
  expect(view.host.querySelector("[data-brand-override]")?.textContent).toBe("커맨더");
  expect(view.host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
  await view.unmount();
});

it("falls back to the spacer when the bridge fails", async () => {
  vi.stubGlobal("ogb", { getBrand: async () => { throw new Error("no handler"); } });
  const view = await render();
  expect(view.host.innerHTML).toBe("<div></div>");
  await view.unmount();
});

it("starts on the search box's left edge", async () => {
  vi.stubGlobal("ogb", { getBrand: async () => ({ name: "커맨더", icon: "data:image/png;base64,AA==" }) });
  const view = await render();
  const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
  const spacing = (source: string, pattern: RegExp) => Number(source.match(pattern)?.[1]) * 4;
  const headerEdge = spacing(sidebar, /justify-between px-(\d+)"/);
  const searchEdge = spacing(sidebar, /className="px-(\d+) pt-2 pb-3"/);
  const shift = spacing(view.host.querySelector("[data-brand-override]")?.className ?? "", /-ml-(\d+)/);
  expect(headerEdge - shift).toBe(searchEdge);
  await view.unmount();
});
