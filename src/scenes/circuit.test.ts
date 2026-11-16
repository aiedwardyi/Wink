import { describe, expect, it } from "vitest";

import { PLATES, place } from "./circuit";

// A theme tile, desktop at 1440 (sidebar open and shut), wide monitors, a phone on its side, phones upright.
const sizes = [
  ["wide", 587, 380],
  ["wide", 1100, 900],
  ["wide", 1120, 900],
  ["wide", 1440, 900],
  ["wide", 1600, 1000],
  ["wide", 2200, 1300],
  ["wide", 844, 392],
  ["tall", 392, 844],
  ["tall", 430, 932],
  ["tall", 360, 740],
] as const;

// The chat column: 960 px at most, centred, 20 px padding; bot rows reach min(42rem, 78%) of it (chat-column.ts, ChatBubble.tsx).
const botRight = (width: number) => {
  const col = Math.min(width, 960);
  return (width - col) / 2 + 20 + Math.min(672, 0.78 * (col - 40));
};

// Plate px under a screen point, folded and mirrored as tex() in circuit.ts does.
function platePoint(p: (typeof PLATES)["wide"], s: number, ox: number, oy: number, x: number, y: number) {
  let u = (x - ox) / (s * p.w);
  let v = (y - oy) / (s * p.h);
  const [fl, fb] = p.fold;
  if (u < 0) u = fl * (1 - Math.abs(1 - ((-u / fl) % 2)));
  if (v > 1) v = 1 - fb * (1 - Math.abs(1 - (((v - 1) / fb) % 2)));
  const mirror = (t: number) => 1 - Math.abs(1 - (((t % 2) + 2) % 2));
  u = mirror(u);
  v = mirror(v);
  return [u * p.w, v * p.h];
}

describe("circuit plate placement", () => {
  it.each(sizes)("%s plate on %i x %i shows one chip, clear of the chat column", (kind, width, height) => {
    const p = PLATES[kind];
    const { s, ox, oy } = place(p, width, height);
    const cx = ox + p.ax * s;
    const cy = oy + p.ay * s;
    // The camera eases in 3% on the chip while working.
    const r = p.cr * s * 1.03;
    expect(cx + r).toBeLessThanOrEqual(width);
    expect(cy - r).toBeGreaterThanOrEqual(0);
    expect(cy + r).toBeLessThanOrEqual(height);
    expect(cx - r).toBeGreaterThanOrEqual(botRight(width));
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        if (Math.abs(x - cx) <= r && Math.abs(y - cy) <= r) continue;
        const [px, py] = platePoint(p, s, ox, oy, x, y);
        const inChip = Math.abs(px - p.ax) < p.cr && Math.abs(py - p.ay) < p.cr;
        if (inChip) expect.fail(`a second chip shows at ${x}, ${y}`);
      }
    }
  });
});
