import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { conduct } from "./verify-conduct.mjs";

const fixture = JSON.parse(readFileSync(new URL("../scripts/fixtures/verify/muse-hidden.json", import.meta.url)));
const context = {};
runInNewContext(readFileSync(new URL("./verify/camera.js", import.meta.url), "utf8"), context);
const { scrollAt } = context.LiveVerifyCamera;

describe("verify camera", () => {
  it("matches the checker camera at 50 samples and leaves its input unchanged", () => {
    const score = conduct(fixture), before = JSON.stringify(score);
    for (let i = 0; i < 50; i++) for (const tile of ["desktop", "phone"]) {
      const t = i * score.duration_ms / 50;
      const live = score.hops.some(h => h.tile === tile && h.live && !h.skip && t >= h.t && (t < h.ts + h.hold || (h.pending && t < 44 * score.beat)));
      const c = score.camera[tile];
      let k = c.length - 1;
      while (k > 0 && c[k].t > t) k--;
      const q = c[k], u = Math.max(0, Math.min(1, (t - q.t) / q.d));
      const y = k === 0 || !q.d ? q.y : Math.round(c[k - 1].y + (q.y - c[k - 1].y) * (1 - (1 - u) ** 3));
      expect(scrollAt(score, tile, t)).toBe(live ? null : y);
      expect(scrollAt(score, tile, t)).toBe(scrollAt(score, tile, t));
    }
    expect(JSON.stringify(score)).toBe(before);
  });

  it("yields during a live hop and resumes on its exact boundary", () => {
    const score = { camera: { desktop: [{ t: 0, y: 12, d: 0 }] }, hops: [{ tile: "desktop", live: "x", t: 10, ts: 20, hold: 5 }] };
    expect(scrollAt(score, "desktop", 10)).toBeNull();
    expect(scrollAt(score, "desktop", 24)).toBeNull();
    expect(scrollAt(score, "desktop", 25)).toBe(12);
  });
});
