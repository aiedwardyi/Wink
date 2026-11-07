import { expect, it } from "vitest";
import { check } from "./phone-scroll.mjs";

it("reports page overflow at 392 px and permits internal scroll regions", () => {
  expect(check({ width: 392, scrollWidth: 440, where: "div#wide" }).problems).toHaveLength(1);
  expect(check({ width: 392, scrollWidth: 392 }).problems).toEqual([]);
  expect(check({ width: 392, scrollWidth: 393 }).problems).toEqual([]);
});
