import { expect, it } from "vitest";
import { mapWorkerColor, mapWorkerSlots } from "./map-worker-colors";

it("gives hues in join order, keeps them when workers leave, and grays the 7th on", () => {
  const first = mapWorkerSlots(new Map(), ["a", "b"]);
  expect([...first]).toEqual([["a", 1], ["b", 2]]);
  expect(mapWorkerSlots(first, ["b"])).toBe(first);
  const full = mapWorkerSlots(first, ["c", "d", "e", "f", "g", "h"]);
  expect([...full.values()]).toEqual([1, 2, 3, 4, 5, 6, 0, 0]);
  expect(mapWorkerColor(full.get("c"))).toBe("var(--map-w3)");
  expect(mapWorkerColor(undefined)).toBe("var(--map-w0)");
});
