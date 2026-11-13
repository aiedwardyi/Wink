// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { measurer, widths } from "./MapTree";

it("keeps the text width cache bounded across many repos", () => {
  const measure = measurer(document.body, false);
  for (let i = 0; i < 20_000; i++) measure(`file-${i}.ts`, "file");
  expect(widths.size).toBeLessThanOrEqual(4096);
  expect(measure("file-19999.ts", "file")).toBeGreaterThan(0);
});
