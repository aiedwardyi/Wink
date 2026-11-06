// Types for electron/verify-protocol.mjs and the main <-> wall stream. Frozen by V0.md.
import type { VerifyCounts, VerifyErrorCode, VerifyResult, VerifyTile } from "../shared/live-verify";

export declare const VERIFY_GRANT_PREFIX: "orbit-verify-v1";
export declare const VERIFY_BRIDGE_ROUTES: { start: string; poll: string; cast: string; watch: string; cancel: string };
export declare const VERIFY_BODY_LIMIT: number;
export declare const VERIFY_POLL_MAX_MS: number;
export declare const VERIFY_RUN_MS: number;
export declare const VERIFY_GRANT_MAX_MS: number;
export declare const VERIFY_RUN_STATES: readonly VerifyRunState["state"][];
export declare const VERIFY_IPC: { ready: string; event: string; mute: string; close: string };
export declare const VERIFY_BPM: number;
export declare const VERIFY_BEAT_MS: number;
export declare const VERIFY_BAR_MS: number;
export declare const VERIFY_BARS: number;
export declare const VERIFY_FINALIZE_BAR: number;
export declare function verifyShowTime(clock: VerifyClock, now: number, loaded: boolean): number;
export interface VerifyTileGeometry { cssW: number; cssH: number; dpr: number; mobile: boolean; tile: { x: number; y: number; s: number } }
export declare const VERIFY_GEOMETRY: { design: { w: number; h: number }; desktop: VerifyTileGeometry; phone: VerifyTileGeometry };
export declare function fitDesign(w: number, h: number): { s: number; ox: number; oy: number };
export declare function tileRect(tile: VerifyTile, w: number, h: number): { x: number; y: number; w: number; h: number; scale: number };

/** Bridge poll reply. revision goes up on every state or count change. */
export interface VerifyRunState {
  runId: string;
  revision: number;
  state: "preparing" | "running" | "completed" | "blocked";
  counts: VerifyCounts | null;
  /** Set once, when state is completed or blocked. */
  result: VerifyResult | null;
  errorCode?: VerifyErrorCode;
}

/** Use verifyShowTime(clock, performance.timeOrigin + performance.now(), score !== null).
 * Main publishes load at a whole-bar scan boundary; holds is final at load. */
export interface VerifyClock { t0: number; holds: number }

/** Everything a wall needs to draw at any moment. Drawing is a pure function of it plus t. */
export interface VerifySnapshot {
  runId: string;
  site: string;
  muted: boolean;
  locale: "en" | "ko";
  lastSeq: number;
  finalFrames?: Partial<Record<VerifyTile, string>>;
  /** null until the scan starts */
  clock: VerifyClock | null;
  /** live/conduct.mjs scanScore() output, unchanged */
  scan: unknown | null;
  /** live/conduct.mjs conduct() output, unchanged */
  score: unknown | null;
  /** every event so far, in seq order */
  events: VerifyWallEvent[];
  result: VerifyResult | null;
}

/** main -> wall. They mirror the working checker's stage calls (live/live.mjs -> live/stage.html window.stage). */
export interface VerifyCheck {
  tile: VerifyTile;
  checker: string;
  rule: string;
  where: string;
  box?: [number, number, number, number];
  scrollY: number;
  result: "ok" | "issue" | "blocked";
  detail: boolean;
  count: number;
}

export type VerifyWallEvent = (
  | { kind: "start"; seq: number; scan: unknown; clock: VerifyClock }                      // stage.start(scanScore(...))
  | { kind: "hold"; seq: number; text: string }                                             // stage.progress("123 done")
  | { kind: "load"; seq: number; score: unknown; clock: VerifyClock }                       // stage.load(score); clock.holds is final here
  | { kind: "scroll"; seq: number; tile: VerifyTile; y: number }                            // real page scrollY while live input owns the tile
  | { kind: "part"; seq: number; part: "loads" | "links" | "phone" }
  | { kind: "checks"; seq: number; checks: VerifyCheck[]; count: number }
  | { kind: "point"; seq: number; inp: unknown; scrollY: number }                           // S.full.point(inp, scrollY): the cursor's real target
  | { kind: "result"; seq: number; key: string; ev: unknown; t: number }                    // stage.result(key, ev), stamped at show time t
  | { kind: "opened"; seq: number; key: string; t: number }                                 // stage.opened(key)
  | { kind: "finalize"; seq: number; fin: unknown; t: number }                              // stage.finalize(finalize(score, events))
  | { kind: "end"; seq: number; result: VerifyResult; finalFrames?: Partial<Record<VerifyTile, string>> }
) & { emittedAt: number };                                     // run over; the wall stays on the result

/** window.verifyWall, exposed by electron/verify-wall-preload.cjs to the wall view only. */
export interface VerifyWallApi {
  ready(): Promise<VerifySnapshot>;
  onEvent(cb: (event: VerifyWallEvent) => void): () => void;
  setMuted(muted: boolean): void;
  close(): void;
}

/** electron/verify/camera.js (ENGINE) defines globalThis.LiveVerifyCamera, a pure function with no DOM,
 * used by the page (in its isolated world) and by the wall. null = live input owns the tile now; use the last scroll event. */
export interface LiveVerifyCamera {
  scrollAt(score: unknown, tile: VerifyTile, t: number): number | null;
}

/** electron/verify-run.mjs (ENGINE) entry point, called by electron/verify-host.mjs (HOST). */
export interface VerifyRunInput {
  hidden?: boolean;
  frame?(frame: { tile: VerifyTile; ms: number; data: string }): void;
  runId: string;
  site: string;
  /** http://127.0.0.1:<port>/<entry> from startSiteServer() */
  url: string;
  pages: { desktop: Electron.WebContents; phone: Electron.WebContents };
  /** Current CSS px -> DIP scale per tile: tileRect(tile, windowW, windowH).scale. ENGINE passes it as the
   * Emulation.setDeviceMetricsOverride `scale` and re-reads it when HOST calls rescale(). ENGINE owns every CDP call on pages. */
  scale(tile: VerifyTile): number;
  /** every wall event, in order; HOST stores it in the snapshot and forwards it to an open wall */
  emit(event: VerifyWallEvent): void;
  /** counts changed (HOST throttles bridge revisions) */
  progress(counts: VerifyCounts): void;
  /** network requests the session cancelled, for the FONT rule's "sheet blocked" skip */
  blockedUrls(): string[];
  revisionUnchanged: () => Promise<boolean>;
  signal: AbortSignal;
  onTiming?(name: "run-start" | "first-check", epochMs: number): void;
}
/** done never rejects: errors become a blocked VerifyResult with honest partial counts. rescale() re-applies input.scale() after a window resize. */
export type RunVerify = (input: VerifyRunInput) => { done: Promise<VerifyResult>; rescale(): void };
export type StartSiteServer = (input: { root: string; entry: string; revision: string }) => Promise<{ origin: string; url: string; fontUrls: string[]; revisionUnchanged(): Promise<boolean>; close(): Promise<void> }>;
