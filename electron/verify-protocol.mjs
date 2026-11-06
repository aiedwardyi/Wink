// Live Verify v0 main-process protocol. Frozen by Orbit-cards/live-verify/V0.md;
// change it only in LV0-INTEGRATE. Mirrors shared/live-verify.ts where they overlap.

/** Scoped signed grant; see the bridge auth rule below. */
export const VERIFY_GRANT_PREFIX = "orbit-verify-v1";

/** Server -> main, on the terminal bridge (electron/terminal-bridge.mjs). */
export const VERIFY_BRIDGE_ROUTES = {
  /** POST { runId, root, entry, revision, site, watch } -> 202 { runId } | 409 { error: "busy" } | 400 { error } */
  start: "/v1/verify/bots/:botId/runs",
  /** GET ?since=<revision>&waitMs=<0..25000> -> 200 VerifyRunState | 404 */
  poll: "/v1/verify/bots/:botId/runs/:runId",
  cast: "/v1/verify/bots/:botId/runs/:runId/cast",
  /** POST -> 200 { shown: true } | 404 ; opens or focuses the window */
  watch: "/v1/verify/bots/:botId/runs/:runId/watch",
  /** POST -> 200 { cancelled: boolean } */
  cancel: "/v1/verify/bots/:botId/runs/:runId/cancel",
};
export const VERIFY_BODY_LIMIT = 64 * 1024;
export const VERIFY_POLL_MAX_MS = 25_000;
export const VERIFY_RUN_MS = 60_000;
export const VERIFY_GRANT_MAX_MS = 230_000;
export const VERIFY_RUN_STATES = ["preparing", "running", "completed", "blocked"];

/** Main <-> wall IPC. The wall is the Wink-owned overlay view; pages get no IPC at all. */
export const VERIFY_IPC = {
  /** wall -> main, invoke: the wall loaded; returns a VerifySnapshot */
  ready: "verify:ready",
  /** main -> wall, send: one VerifyWallEvent */
  event: "verify:event",
  /** wall -> main, send: { muted: boolean } */
  mute: "verify:mute",
  /** wall -> main, send: the wall's close button */
  close: "verify:close",
};

/** 174 BPM, 16 bars: Scan 1-2, Read 3-6, Use 7-10, Fit 11-12, Converge 13-14, Result 15-16. */
export const VERIFY_BPM = 174;
export const VERIFY_BEAT_MS = 60_000 / VERIFY_BPM;
export const VERIFY_BAR_MS = VERIFY_BEAT_MS * 4;
export const VERIFY_BARS = 16;
export const VERIFY_FINALIZE_BAR = 12;

export function verifyShowTime(clock, now, loaded) {
  const raw = Math.max(0, now - clock.t0);
  return loaded ? Math.max(0, raw - clock.holds * VERIFY_BAR_MS) : Math.min(raw, 2 * VERIFY_BAR_MS - 1);
}

/** Page viewports, and their fixed tiles in the wall's 1280x720 design space.
 * Both tiles are 468 design px tall. They never move in v0. */
export const VERIFY_GEOMETRY = {
  design: { w: 1280, h: 720 },
  desktop: { cssW: 1280, cssH: 720, dpr: 1, mobile: false, tile: { x: 16, y: 72, s: 0.65 } },
  phone: { cssW: 392, cssH: 800, dpr: 2, mobile: true, tile: { x: 950, y: 72, s: 0.585 } },
};

/** Letterbox the 1280x720 design space into a w x h DIP window: one uniform scale, centered. */
export function fitDesign(w, h) {
  const { design } = VERIFY_GEOMETRY;
  const s = Math.min(w / design.w, h / design.h);
  return { s, ox: (w - design.w * s) / 2, oy: (h - design.h * s) / 2 };
}

/** A page tile in window DIP, rounded the way view bounds are, and its CSS px -> DIP scale
 * (Emulation.setDeviceMetricsOverride `scale`). HOST sets view bounds from it; the wall cuts its holes from it;
 * ENGINE applies `scale`. The wall keeps a copy in electron/verify/geometry.js with a parity test. */
export function tileRect(tile, w, h) {
  const g = VERIFY_GEOMETRY[tile];
  const f = fitDesign(w, h);
  const width = Math.round(g.cssW * g.tile.s * f.s);
  const scale = width / g.cssW;
  return { x: Math.round(f.ox + g.tile.x * f.s), y: Math.round(f.oy + g.tile.y * f.s), w: width, h: Math.round(g.cssH * scale), scale };
}
