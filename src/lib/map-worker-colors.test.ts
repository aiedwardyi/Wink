import { expect, it } from "vitest";
import { mapWorkerColor, mapWorkerSlots } from "./map-worker-colors";

it("gives slots in join order and keeps them when workers leave", () => {
  const first = mapWorkerSlots(new Map(), ["a", "b"]);
  expect([...first]).toEqual([["a", 0], ["b", 1]]);
  const later = mapWorkerSlots(first, ["b", "c"]);
  expect([...later]).toEqual([["a", 0], ["b", 1], ["c", 2]]);
  expect(mapWorkerSlots(later, ["c", "b"])).toBe(later);
});

it("colors the first six workers and grays the rest", () => {
  const slots = mapWorkerSlots(new Map(), ["a", "b", "c", "d", "e", "f", "g"]);
  const colors = [...slots.values()].map(mapWorkerColor);
  expect(new Set(colors.slice(0, 6)).size).toBe(6);
  expect(colors[6]).toBe(mapWorkerColor(99));
  expect(colors[0]).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
});
