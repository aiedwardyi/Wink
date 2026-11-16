// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { measurer, widths } from "./MapTree";

afterEach(() => { vi.restoreAllMocks(); });

it("keeps the text width cache bounded across many repos", () => {
  const measure = measurer(document.body, false);
  for (let i = 0; i < 20_000; i++) measure(`file-${i}.ts`, "file");
  expect(widths.size).toBeLessThanOrEqual(4096);
  expect(measure("file-19999.ts", "file")).toBeGreaterThan(0);
});

it("measures a box count in the page once the tree has layout, where its tabular digits are drawn, and other text on the canvas", async () => {
  // A canvas draws a proportional 1 (4px here); the page draws every tabular digit 6px wide.
  const wide = (text: string, one: number) => [...text].reduce((sum, letter) => sum + (letter === "1" ? one : 6), 0);
  // SAFETY: the measurer only sets font and calls measureText on its canvas.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ measureText: (text: string) => ({ width: wide(text, 4) }) } as never);
  const computed = window.getComputedStyle.bind(window);
  let hidden = true;
  // SAFETY: the measurer reads only width from the probe's style.
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => element.matches(".map-tree .map-tree-probe") ? { width: hidden ? "auto" : `${wide(element.textContent ?? "", 6)}px` } as CSSStyleDeclaration : computed(element));
  vi.resetModules();
  const fresh = await import("./MapTree");
  const tree = Object.assign(document.createElement("div"), { className: "map-tree" });
  document.body.append(tree);
  const measure = fresh.measurer(tree, false);
  expect(measure("1,111", "count")).toBe(22);
  hidden = false;
  expect(measure("1,111", "count")).toBe(30);
  expect(measure("174", "count")).toBe(18);
  expect(measure("+111 files", "hidden")).toBe(54);
  expect(measure("docs/", "dir")).toBe(30);
  tree.remove();
  expect(readFileSync("src/components/MapTree.css", "utf8")).toMatch(/\.map-tree-box span, \.map-tree-probe \{ font: 10px\/1 var\(--font-sans, sans-serif\); [^}]*font-variant-numeric: tabular-nums; \}/);
});
