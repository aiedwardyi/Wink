export type ChartZoom = { scale: number; x: number; y: number };
export type ChartSpot = { x: number; y: number };

export const FULL_ZOOM: ChartZoom = { scale: 1, x: 0, y: 0 };

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

export function zoomAt(zoom: ChartZoom, scale: number, anchor: ChartSpot): ChartZoom {
  scale = Math.max(1, Math.min(8, scale));
  const x = clamp(anchor.x, 1);
  const y = clamp(anchor.y, 1);
  return {
    scale,
    x: clamp(zoom.x + x / zoom.scale - x / scale, 1 - 1 / scale),
    y: clamp(zoom.y + y / zoom.scale - y / scale, 1 - 1 / scale),
  };
}

export function panZoom(zoom: ChartZoom, delta: ChartSpot): ChartZoom {
  return {
    scale: zoom.scale,
    x: clamp(zoom.x - delta.x / zoom.scale, 1 - 1 / zoom.scale),
    y: clamp(zoom.y - delta.y / zoom.scale, 1 - 1 / zoom.scale),
  };
}

export function doubleTapZoom(zoom: ChartZoom, anchor: ChartSpot): ChartZoom {
  return zoom.scale > 1 ? FULL_ZOOM : zoomAt(zoom, 2, anchor);
}

export function zoomRange(domain: [number, number], offset: number, scale: number): [number, number] {
  const span = domain[1] - domain[0];
  return [domain[0] + offset * span, domain[0] + (offset + 1 / scale) * span];
}

export function inZoom(zoom: ChartZoom, point: ChartSpot): boolean {
  return point.x >= zoom.x && point.x <= zoom.x + 1 / zoom.scale && point.y >= zoom.y && point.y <= zoom.y + 1 / zoom.scale;
}
