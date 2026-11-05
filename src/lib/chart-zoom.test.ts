import { describe, expect, it } from "vitest";
import { FULL_ZOOM, doubleTapZoom, inZoom, panZoom, zoomAt, zoomRange } from "./chart-zoom";

describe("chart zoom", () => {
  it("keeps the point under the fingers fixed", () => {
    const start = zoomAt(FULL_ZOOM, 2, { x: 0.7, y: 0.4 });
    const next = zoomAt(start, 5, { x: 0.3, y: 0.6 });
    expect(next.x + 0.3 / next.scale).toBeCloseTo(start.x + 0.3 / start.scale);
    expect(next.y + 0.6 / next.scale).toBeCloseTo(start.y + 0.6 / start.scale);
  });

  it("clamps scale from 1 to 8 and settles below 1", () => {
    expect(zoomAt(FULL_ZOOM, 20, { x: 0.5, y: 0.5 }).scale).toBe(8);
    expect(zoomAt(FULL_ZOOM, 0.5, { x: 0.5, y: 0.5 })).toEqual(FULL_ZOOM);
  });

  it("clamps panning to the data area", () => {
    const zoom = zoomAt(FULL_ZOOM, 4, { x: 0.5, y: 0.5 });
    expect(panZoom(zoom, { x: 20, y: -20 })).toEqual({ scale: 4, x: 0, y: 0.75 });
  });

  it("zooms 2x at a double tap and returns to the full view", () => {
    const zoom = doubleTapZoom(FULL_ZOOM, { x: 0.6, y: 0.4 });
    expect(zoom).toEqual({ scale: 2, x: 0.3, y: 0.2 });
    expect(doubleTapZoom(zoom, { x: 0, y: 0 })).toEqual(FULL_ZOOM);
  });

  it("keeps both ranges at the same scale", () => {
    const zoom = zoomAt(FULL_ZOOM, 4, { x: 0.5, y: 0.5 });
    expect(zoomRange([0, 100], zoom.x, zoom.scale)).toEqual([37.5, 62.5]);
    expect(zoomRange([1, 5], zoom.y, zoom.scale)).toEqual([2.5, 3.5]);
  });

  it("hides points outside the range instead of clamping them to an edge", () => {
    const zoom = { scale: 2, x: 0.25, y: 0.25 };
    expect(inZoom(zoom, { x: 0.5, y: 0.5 })).toBe(true);
    expect(inZoom(zoom, { x: 0.1, y: 0.5 })).toBe(false);
    expect(inZoom(zoom, { x: 0.5, y: 0.9 })).toBe(false);
  });
});
