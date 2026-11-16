import { describe, expect, it } from "vitest";

import { PLATES, place } from "./circuit";

// A theme tile, desktop at 1440, wide monitors, a phone on its side, phones upright.
const sizes = [
  ["wide", 587, 380],
  ["wide", 1100, 900],
  ["wide", 1600, 1000],
  ["wide", 2200, 1300],
  ["wide", 844, 392],
  ["tall", 392, 844],
  ["tall", 430, 932],
  ["tall", 360, 740],
] as const;

describe("circuit plate placement", () => {
  it.each(sizes)("%s plate on %i x %i shows one chip", (kind, width, height) => {
    const p = PLATES[kind];
    const { s, ox } = place(p, width, height);
    expect(ox + (p.ax + p.cr) * s).toBeLessThanOrEqual(width);
    // Left of the plate the board is mirrored, chip included.
    if (ox > 0) expect(ox - (p.ax - p.cr) * s).toBeLessThanOrEqual(0);
  });
});
