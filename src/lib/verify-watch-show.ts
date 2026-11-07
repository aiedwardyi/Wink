import type { VerifyIssue, VerifyReplayEnd, VerifyReplayHead, VerifyTile } from "../../shared/live-verify";
import { BEAT_MS, SIXTEENTH_MS } from "./verify-beat";
import type { VerifyReplayChunk, VerifyReplayMark } from "./verify-replay";
import { verifyEndTab, verifyReel } from "./verify-watch";

export const FRAME_FLOOR_MS = 120;
export const REEL_MS = 1500;
export const BANNER_MS = 1500;
export const LIVE_CLOSE_MS = 3000;
const OUTLINE_MS = 2 * BEAT_MS;
const GLIDE_MS = BEAT_MS / 2;
const ROW_MS = SIXTEENTH_MS / 8;

// A batched check row's box is viewport px at its scrollY; outlines keep document px.
function checkRow(value: unknown) {
  const row = (value ?? {}) as Record<string, unknown>;
  const box = Array.isArray(row.box) && row.box.length === 4 && row.box.every(Number.isFinite) ? row.box as number[] : null;
  const y = typeof row.scrollY === "number" ? row.scrollY : 0;
  return { ...row, result: row.result === "issue" && !row.detail ? "issue" : "ok", box: box && [box[0], box[1]! + y, box[2], box[3]] };
}

export type Rect = { x: number; y: number; w: number; h: number };
export type Part = "loads" | "links" | "phone";
export type ShowPhase = "loading" | "play" | "reel" | "clean" | "after" | "between" | "done" | "expired" | "failed";

export interface Outline { tile: VerifyTile; checker: string; issue: boolean; box: Rect; pin: boolean; mscroll: number; at: number }
export interface Cursor { tile: VerifyTile; from: { x: number; y: number }; to: { x: number; y: number }; at: number }
export interface Ring { tile: VerifyTile; x: number; y: number; at: number }
interface Stored { jpeg: Uint8Array; scrollY: number; ms: number }

const rect = (value: unknown): Rect | null => {
  if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)) return { x: value[0], y: value[1], w: value[2], h: value[3] };
  if (value && typeof value === "object") {
    const { x, y, w, h } = value as Record<string, unknown>;
    if ([x, y, w, h].every(n => typeof n === "number" && Number.isFinite(n))) return { x, y, w, h } as Rect;
  }
  return null;
};
const tileOf = (value: unknown): VerifyTile => value === "phone" ? "phone" : "desktop";
const up16 = (ms: number) => Math.ceil(ms / SIXTEENTH_MS - 1e-6) * SIXTEENTH_MS;

/** One watch session: chunks come in, a virtual clock lets them out at their show time. */
export class VerifyWatchShow {
  clock = 0;
  phase: ShowPhase = "loading";
  head: VerifyReplayHead | null = null;
  end: VerifyReplayEnd | null = null;
  fixed = false;
  pinned: VerifyTile | null = null;
  parts = new Set<Part>();
  checks = 0;
  byChecker = new Map<string, { done: number; issues: number }>();
  outlines: Outline[] = [];
  cursors = new Map<string, Cursor>();
  ring: Ring | null = null;
  scroll: Record<VerifyTile, number> = { desktop: 0, phone: 0 };
  frames: Record<VerifyTile, Stored | null> = { desktop: null, phone: null };
  reel: VerifyIssue[] = [];
  /** set when the panel should close */
  closeAt = Infinity;
  /** run ms of the latest chunk let out */
  ms = 0;
  /** bumps on every change the canvas draws */
  version = 0;
  /** bumps when the text around the canvas changes */
  ui = 0;
  private queue: Array<{ due: number; chunk: VerifyReplayChunk; at: number; scrollY: number }> = [];
  /** scroll in stream order; marks play later on the grid than the frames shot after them */
  private fedScroll: Record<VerifyTile, number> = { desktop: 0, phone: 0 };
  private history: Record<VerifyTile, Stored[]> = { desktop: [], phone: [] };
  private runStart = 0;
  private shift = 0;
  private lastFrame: Record<VerifyTile, number> = { desktop: -Infinity, phone: -Infinity };
  private lastDue = 0;
  private liveMs = 0;
  private phaseAt = 0;
  private reelIndex = 0;
  private waits: Array<{ at: number; resolve: () => void }> = [];

  constructor(readonly live: boolean) {}

  /** Starts the next run of a replay chain, or a fresh live stream after the gate reopens. */
  beginRun() {
    Object.assign(this, { head: null, end: null, checks: 0, ms: 0, outlines: [], ring: null, reel: [], liveMs: 0, shift: 0 });
    this.parts = new Set();
    this.byChecker = new Map();
    this.cursors = new Map();
    this.scroll = { desktop: 0, phone: 0 };
    this.fedScroll = { desktop: 0, phone: 0 };
    this.frames = { desktop: null, phone: null };
    this.history = { desktop: [], phone: [] };
    this.lastFrame = { desktop: -Infinity, phone: -Infinity };
    this.queue = [];
    this.runStart = this.lastDue = up16(this.clock);
    this.set("loading");
  }

  get tile(): VerifyTile {
    if (this.phase === "reel" && this.reel.length) return this.reelIssue()!.tile;
    if (this.pinned) return this.pinned;
    return this.end ? verifyEndTab(this.end.issues) : "desktop";
  }

  pin(tile: VerifyTile) {
    this.pinned = tile;
    this.version++;
    this.ui++;
  }

  feed(chunk: VerifyReplayChunk) {
    if (chunk.kind === "mark" && chunk.mark.kind === "checks" && Array.isArray(chunk.mark.checks)) {
      const { ms } = chunk.mark;
      chunk.mark.checks.forEach((row: unknown, i: number) => this.feed({ kind: "mark", mark: { ms: ms + i * ROW_MS, kind: "result", ev: checkRow(row) } }));
      return;
    }
    if (chunk.kind === "mark" && chunk.mark.kind === "scroll" && Number.isFinite(chunk.mark.y)) this.fedScroll[tileOf(chunk.mark.tile)] = chunk.mark.y as number;
    const scrollY = chunk.kind === "frame" ? this.fedScroll[chunk.tile] : 0;
    if (this.live) {
      const ms = chunk.kind === "frame" ? chunk.ms : chunk.kind === "mark" ? chunk.mark.ms : chunk.kind === "end" ? chunk.end.ms : 0;
      this.liveMs = Math.max(this.liveMs, ms);
      const at = this.clock - Math.max(0, this.liveMs - ms);
      this.queue.push({ due: chunk.kind === "mark" ? this.runStart + up16(this.clock - this.runStart) : this.clock, chunk, at, scrollY });
      return;
    }
    let due = this.lastDue;
    if (chunk.kind === "frame") {
      due = this.runStart + chunk.ms + this.shift;
      const floor = this.lastFrame[chunk.tile] + FRAME_FLOOR_MS;
      if (due < floor) {
        if (chunk.tile === this.tile) this.shift += floor - due;
        due = floor;
      }
      this.lastFrame[chunk.tile] = due;
    } else if (chunk.kind === "mark") due = this.runStart + up16(chunk.mark.ms + this.shift);
    else if (chunk.kind === "end") due = Math.max(this.lastDue, this.runStart + chunk.end.ms + this.shift);
    due = Math.max(due, this.runStart);
    if (chunk.kind !== "frame") this.lastDue = Math.max(this.lastDue, due);
    this.queue.push({ due, chunk, at: due, scrollY });
  }

  expire() { this.set("expired"); }
  fail() { this.set("failed"); }

  /** Moves the clock; false while nothing changed. */
  advance(ms: number): boolean {
    const before = this.version;
    this.clock += Math.max(0, Math.min(ms, 250));
    this.queue.sort((a, b) => a.due - b.due);
    while (this.queue.length && this.queue[0]!.due <= this.clock) {
      const { chunk, at, scrollY } = this.queue.shift()!;
      this.apply(chunk, at, scrollY);
    }
    this.step();
    for (const wait of this.waits.filter(w => w.at <= this.clock)) wait.resolve();
    this.waits = this.waits.filter(w => w.at > this.clock);
    if (this.outlines.some(o => !o.issue && this.clock - o.at > OUTLINE_MS + SIXTEENTH_MS)) {
      this.outlines = this.outlines.filter(o => o.issue || this.clock - o.at <= OUTLINE_MS + SIXTEENTH_MS);
      this.version++;
    }
    if (this.moving()) this.version++;
    return this.version !== before;
  }

  /** Resolves when the run's end has played out (reel or "No problems"). */
  async settled(): Promise<void> {
    while (!["after", "expired", "failed"].includes(this.phase)) await this.waitFor(50);
  }

  waitFor(ms: number): Promise<void> {
    return new Promise(resolve => this.waits.push({ at: this.clock + ms, resolve }));
  }

  async between(fixed = false) {
    this.fixed = fixed;
    this.set("between");
    await this.waitFor(BANNER_MS);
  }

  finish() {
    this.set("done");
    this.closeAt = this.live ? this.clock + LIVE_CLOSE_MS : this.clock;
  }

  reelIssue(): VerifyIssue | undefined {
    if (this.phase !== "reel") return undefined;
    return this.reel[Math.min(this.reel.length - 1, Math.floor((this.clock - this.phaseAt) / REEL_MS))];
  }

  /** The frame to draw: in the reel, the one taken nearest the problem's scroll. */
  frame(): Stored | null {
    const issue = this.reelIssue();
    if (!issue) return this.frames[this.tile];
    const list = this.history[issue.tile];
    if (!list.length) return null;
    const y = issue.scrollY ?? 0;
    return list.reduce((best, f) => Math.abs(f.scrollY - y) <= Math.abs(best.scrollY - y) ? f : best);
  }

  /** Box in tile CSS px for the current scroll. */
  view(outline: Outline): Rect {
    const top = outline.pin ? outline.mscroll : this.scroll[outline.tile];
    return { ...outline.box, y: outline.box.y - top };
  }

  cursorAt(cursor: Cursor) {
    const k = Math.min(1, Math.max(0, (this.clock - cursor.at) / GLIDE_MS)), e = 1 - (1 - k) ** 3;
    return { x: cursor.from.x + (cursor.to.x - cursor.from.x) * e, y: cursor.from.y + (cursor.to.y - cursor.from.y) * e };
  }

  outlineAlpha(outline: Outline): number {
    if (outline.issue) return 1;
    const age = this.clock - outline.at;
    return age <= OUTLINE_MS ? 1 : Math.max(0, 1 - (age - OUTLINE_MS) / SIXTEENTH_MS);
  }

  private moving() {
    return [...this.cursors.values()].some(c => this.clock - c.at < GLIDE_MS) || (this.ring !== null && this.clock - this.ring.at < 2 * SIXTEENTH_MS + 50) || this.outlines.some(o => !o.issue && this.clock - o.at > OUTLINE_MS - 20);
  }

  private set(phase: ShowPhase) {
    this.phase = phase;
    this.phaseAt = this.clock;
    this.reelIndex = 0;
    this.version++;
    this.ui++;
  }

  private step() {
    if (this.phase === "reel" && this.clock - this.phaseAt >= this.reel.length * REEL_MS) this.set("after");
    else if (this.phase === "reel") {
      const i = Math.floor((this.clock - this.phaseAt) / REEL_MS);
      if (i !== this.reelIndex) { this.reelIndex = i; this.version++; this.ui++; }
    } else if (this.phase === "clean" && this.clock - this.phaseAt >= BANNER_MS) this.set("after");
  }

  private apply(chunk: VerifyReplayChunk, at: number, scrollY: number) {
    this.version++;
    if (chunk.kind !== "frame") this.ui++;
    const ms = chunk.kind === "frame" ? chunk.ms : chunk.kind === "mark" ? chunk.mark.ms : chunk.kind === "end" ? chunk.end.ms : 0;
    this.ms = Math.max(this.ms, ms);
    if (chunk.kind === "head") { this.head = chunk.head; if (this.phase === "loading") this.set("play"); return; }
    if (this.phase === "loading") this.set("play");
    if (chunk.kind === "frame") {
      const stored = { jpeg: chunk.jpeg, scrollY, ms: chunk.ms };
      this.frames[chunk.tile] = stored;
      this.history[chunk.tile].push(stored);
      return;
    }
    if (chunk.kind === "end") {
      this.end = chunk.end;
      this.outlines = this.outlines.filter(o => o.issue);
      this.cursors.clear();
      this.reel = verifyReel(chunk.end.issues);
      this.set(chunk.end.status === "blocked" ? "failed" : this.reel.length ? "reel" : "clean");
      return;
    }
    this.mark(chunk.mark, at);
  }

  private mark(mark: VerifyReplayMark, at: number) {
    if (mark.kind === "part" && (mark.part === "loads" || mark.part === "links" || mark.part === "phone")) this.parts.add(mark.part);
    else if (mark.kind === "scroll" && Number.isFinite(mark.y)) this.scroll[tileOf(mark.tile)] = mark.y as number;
    else if (mark.kind === "point") {
      const inp = (mark.inp ?? {}) as Record<string, unknown>;
      if (typeof inp.x === "number" && typeof inp.y === "number") {
        const tile = tileOf(inp.tile);
        this.ring = { tile, x: inp.x, y: inp.doc ? inp.y - this.scroll[tile] : inp.y, at };
      }
    } else if (mark.kind === "result") {
      const ev = (mark.ev ?? {}) as Record<string, unknown>;
      if (ev.result === "skip") return;
      const checker = typeof ev.checker === "string" ? ev.checker : "CHECK";
      const issue = ev.result === "issue";
      const row = this.byChecker.get(checker) ?? { done: 0, issues: 0 };
      row.done++;
      if (issue) row.issues++;
      this.byChecker.set(checker, row);
      this.checks++;
      const box = rect(ev.box);
      if (!box) return;
      const outline: Outline = { tile: tileOf(ev.tile), checker, issue, box, pin: Boolean(ev.pin), mscroll: typeof ev.mscroll === "number" ? ev.mscroll : 0, at };
      this.outlines.push(outline);
      if (this.outlines.length > 400) this.outlines.splice(this.outlines.findIndex(o => !o.issue), 1);
      const target = this.view(outline), last = this.cursors.get(checker);
      const to = { x: target.x + Math.min(target.w * 0.3, 12), y: target.y + Math.min(target.h * 0.6, 10) };
      this.cursors.set(checker, { tile: outline.tile, from: last && last.tile === outline.tile ? this.cursorAt(last) : to, to, at });
    }
  }
}
