import { expect, it } from "vitest";
import { mapWorkerColor, mapWorkerSlots } from "./map-worker-colors";

it("gives slots in join order, keeps a live worker's slot and frees a leaver's", () => {
  const first = mapWorkerSlots(new Map(), ["a", "b"]);
  expect([...first]).toEqual([["a", 0], ["b", 1]]);
  const later = mapWorkerSlots(first, ["b", "c"]);
  expect([...later]).toEqual([["b", 1], ["c", 0]]);
  expect(mapWorkerSlots(later, ["c", "b"])).toBe(later);
});

it("colors the first six workers, grays the rest, and colors a gray one once a slot frees", () => {
  const slots = mapWorkerSlots(new Map(), ["a", "b", "c", "d", "e", "f", "g"]);
  const colors = [...slots.values()].map(mapWorkerColor);
  expect(new Set(colors.slice(0, 6)).size).toBe(6);
  expect(colors[6]).toBe(mapWorkerColor(99));
  expect(colors[0]).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
  const after = mapWorkerSlots(slots, ["b", "g"]);
  expect([...after]).toEqual([["b", 1], ["g", 0]]);
});

it("never grays a live worker while six or fewer are live over a long session", () => {
  let slots: ReadonlyMap<string, number> = new Map();
  for (let i = 0; i < 40; i++) {
    const live = [`w${i}`, `w${i + 1}`];
    slots = mapWorkerSlots(slots, live);
    for (const id of live) expect(slots.get(id)).toBeLessThan(6);
  }
});
