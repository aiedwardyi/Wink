import type { VerifyChecker, VerifyCounts, VerifyIssue, VerifyReplayEnd, VerifyReplayHead, VerifyTile } from "../../shared/live-verify";
import type { VerifyReplayChunk, VerifyReplayMark } from "./verify-replay";
import { verifyEndTab, verifyReel } from "./verify-watch";

export const REEL_MS = 1500;
export const BANNER_MS = 1500;
export const LIVE_CLOSE_MS = 3000;
export const THING_MS = 300;
export const SHOW_MIN_MS = 3000;
export const SHOW_MAX_MS = 12_000;
const MAX_THINGS = SHOW_MAX_MS / THING_MS;
const LIVE_OUTLINE_MS = 700;
const FADE_MS = 90;
const RING_MS = 220;
const GLIDE_MS = 600;
const LIVE_GLIDE_MS = 250;

type Row = Record<string, unknown> & { result?: unknown; box: number[] | null };

// A batched check row's box is viewport px at its scrollY; outlines keep document px.
function checkRow(value: unknown): Row {
  const row = (value ?? {}) as Record<string, unknown>;
  const box = Array.isArray(row.box) && row.box.length === 4 && row.box.every(Number.isFinite) ? row.box as number[] : null;
  const y = typeof row.scrollY === "number" ? row.scrollY : 0;
  return { ...row, result: row.result === "issue" && !row.detail ? "issue" : "ok", box: box && [box[0], box[1]! + y, box[2], box[3]] };
}

export type Rect = { x: number; y: number; w: number; h: number };
export type Part = "loads" | "links" | "phone";
export type ShowPhase = "loading" | "play" | "reel" | "clean" | "after" | "between" | "done" | "expired" | "failed";

export interface Outline { tile: VerifyTile; checker: string; issue: boolean; box: Rect; pin: boolean; mscroll: number; at: number; hold: number }
export interface Cursor { checker: string; tile: VerifyTile; from: { x: number; y: number }; to: { x: number; y: number }; at: number; duration: number }
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

interface Thing { tile: VerifyTile; rows: Row[]; box: number[] | null; y: number; scrollY: number; issue: boolean }
const OWN_THING = /^(a|button|img|input|select|textarea|summary|label)\b/;
const SECTION = /^(section|header|footer|nav|article|aside)\b/;

function thingKey(where: unknown) {
  const path = String(where ?? "page").split(" > ");
  if (OWN_THING.test(path.at(-1)!)) return path.join(" > ");
  const section = path.findIndex(part => SECTION.test(part));
  return path.slice(0, section < 0 ? 1 : section + 1).join(" > ");
}

function union(a: number[], b: number[]) {
  const x = Math.min(a[0]!, b[0]!), y = Math.min(a[1]!, b[1]!);
  return [x, y, Math.max(a[0]! + a[2]!, b[0]! + b[2]!) - x, Math.max(a[1]! + a[3]!, b[1]! + b[3]!) - y];
}

/** Checks grouped by the real thing they looked at; a problem stays its own thing. */
function thingsOf(rows: Row[]): Thing[] {
  const found = new Map<string, Thing>();
  for (const row of rows) {
    const issue = row.result === "issue", tile = tileOf(row.tile), box = row.box;
    const key = issue ? `issue:${found.size}` : `${tile}|${thingKey(row.where)}`;
    const thing = found.get(key);
    if (!thing) found.set(key, { tile, rows: [row], box, y: box?.[1] ?? 0, scrollY: typeof row.scrollY === "number" ? row.scrollY : 0, issue });
    else {
      thing.rows.push(row);
      if (box) thing.box = thing.box ? union(thing.box, box) : box;
      thing.y = thing.box?.[1] ?? 0;
    }
  }
  return [...found.values()];
}

/** One outline for the thing; every other check only counts. */
const outlineOnce = (thing: Thing, extra: object = {}): Row[] => thing.rows.map((row, i) => ({ ...row, ...extra, box: i ? null : thing.box }));

/** At most MAX_THINGS, top to bottom; the things left out still count on the next one shown. */
function shownThings(all: Thing[]): Thing[] {
  const boxed = all.filter(thing => thing.box).sort((a, b) => a.y - b.y);
  if (!boxed.length) return all;
  const step = Math.max(1, boxed.length / MAX_THINGS), kept: Thing[] = [];
  let carry = all.filter(thing => !thing.box).flatMap(thing => thing.rows), next = 0;
  boxed.forEach((thing, i) => {
    if (i + 1e-6 < next && !thing.issue) { carry.push(...thing.rows); return; }
    kept.push({ ...thing, rows: [...thing.rows, ...carry] });
    carry = [];
    if (i + 1e-6 >= next) next += step;
  });
  kept.at(-1)!.rows.push(...carry);
  return kept;
}

const nearest = (list: Stored[], y: number) => list.reduce((best, f) => Math.abs(f.scrollY - y) <= Math.abs(best.scrollY - y) ? f : best);

/** One watch session. Live chunks play as they come; a replay is paced one real thing at a time. */
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
  /** [done, planned] per checker and tile, the shape the card's lanes read while a check runs */
  lanes: NonNullable<VerifyCounts["by"]> = {};
  private queue: Array<{ due: number; chunk: VerifyReplayChunk; at: number; scrollY: number }> = [];
  private held: VerifyReplayChunk[] = [];
  private planned = false;
  /** scroll in stream order, so each frame knows the stop it was shot at */
  private fedScroll: Record<VerifyTile, number> = { desktop: 0, phone: 0 };
  private history: Record<VerifyTile, Stored[]> = { desktop: [], phone: [] };
  private liveMs = 0;
  private phaseAt = 0;
  private reelIndex = 0;
  private waits: Array<{ at: number; resolve: () => void }> = [];

  constructor(readonly live: boolean, pinned: VerifyTile | null = null) {
    this.pinned = pinned;
  }

  /** Starts the next run of a replay chain, or a fresh live stream after the gate reopens. */
  beginRun() {
    Object.assign(this, { head: null, end: null, checks: 0, ms: 0, outlines: [], ring: null, reel: [], liveMs: 0, held: [], planned: false, lanes: {} });
    this.parts = new Set();
    this.byChecker = new Map();
    this.cursors = new Map();
    this.scroll = { desktop: 0, phone: 0 };
    this.fedScroll = { desktop: 0, phone: 0 };
    this.frames = { desktop: null, phone: null };
    this.history = { desktop: [], phone: [] };
    this.queue = [];
    this.set("loading");
  }

  get tile(): VerifyTile {
    if (this.phase === "reel" && this.reel.length) return this.reelIssue()!.tile;
    if (this.pinned && this.tabs.includes(this.pinned)) return this.pinned;
    return this.end ? verifyEndTab(this.end.issues) : "desktop";
  }

  get tabs(): VerifyTile[] {
    return (this.planned || this.end) && !this.history.phone.length ? ["desktop"] : ["desktop", "phone"];
  }

  /** A replay still playing, which is when the chat card shows its lanes. */
  get showing() {
    return !this.live && !["after", "done", "expired", "failed"].includes(this.phase);
  }

  pin(tile: VerifyTile) {
    this.pinned = tile;
    if (this.phase === "reel") {
      this.reel = verifyReel((this.end?.issues ?? []).filter(issue => issue.tile === tile));
      this.phaseAt = this.clock;
      this.reelIndex = 0;
      if (!this.reel.length) this.set("after");
    }
    this.version++;
    this.ui++;
  }

  feed(chunk: VerifyReplayChunk) {
    if (chunk.kind === "mark" && chunk.mark.kind === "checks" && Array.isArray(chunk.mark.checks)) {
      const { ms } = chunk.mark, rows = chunk.mark.checks.map(checkRow);
      for (const ev of this.live ? thingsOf(rows).flatMap(thing => outlineOnce(thing)) : rows) this.feed({ kind: "mark", mark: { ms, kind: "result", ev } });
      return;
    }
    if (!this.live) {
      this.held.push(chunk);
      if (chunk.kind === "end") this.plan();
      return;
    }
    if (chunk.kind === "mark" && chunk.mark.kind === "scroll" && Number.isFinite(chunk.mark.y)) this.fedScroll[tileOf(chunk.mark.tile)] = chunk.mark.y as number;
    const scrollY = chunk.kind === "frame" ? this.fedScroll[chunk.tile] : 0;
    const ms = chunk.kind === "frame" ? chunk.ms : chunk.kind === "mark" ? chunk.mark.ms : chunk.kind === "end" ? chunk.end.ms : 0;
    this.liveMs = Math.max(this.liveMs, ms);
    this.queue.push({ due: this.clock, chunk, at: this.clock - Math.max(0, this.liveMs - ms), scrollY });
  }

  /** The whole replay is here: frames up front, then each tile's things evenly over one show length. */
  private plan() {
    const rows: Row[] = [], marks: Array<{ mark: VerifyReplayMark; seen: number; tileSeen: number }> = [], seen = { desktop: 0, phone: 0 };
    let end: VerifyReplayChunk | undefined;
    for (const chunk of this.held) {
      if (chunk.kind === "head") this.head = chunk.head;
      else if (chunk.kind === "end") end = chunk;
      else if (chunk.kind === "frame") this.history[chunk.tile].push({ jpeg: chunk.jpeg, scrollY: this.fedScroll[chunk.tile], ms: chunk.ms });
      else if (chunk.mark.kind === "scroll" && Number.isFinite(chunk.mark.y)) this.fedScroll[tileOf(chunk.mark.tile)] = chunk.mark.y as number;
      else if (chunk.mark.kind === "result") {
        const ev = (chunk.mark.ev ?? {}) as Record<string, unknown>, box = rect(ev.box), row: Row = { ...ev, ms: chunk.mark.ms, box: box && [box.x, box.y, box.w, box.h] };
        rows.push(row);
        seen[tileOf(row.tile)]++;
        if (row.result !== "skip") ((this.lanes[(row.checker ?? "CHECK") as VerifyChecker] ??= {})[tileOf(row.tile)] ??= [0, 0])[1]++;
      } else if (chunk.mark.kind === "part" || chunk.mark.kind === "point") {
        const tile = tileOf((chunk.mark.inp as { tile?: unknown } | undefined)?.tile);
        marks.push({ mark: chunk.mark, seen: rows.length, tileSeen: seen[tile] });
      }
    }
    this.held = [];
    this.planned = true;
    const lists = (["desktop", "phone"] as const).map(tile => ({ tile, things: shownThings(thingsOf(rows.filter(row => tileOf(row.tile) === tile))) }));
    const count = Math.max(...lists.map(list => list.things.length));
    const total = count ? Math.min(SHOW_MAX_MS, Math.max(SHOW_MIN_MS, count * THING_MS)) : 0, start = this.clock;
    // A tile's clicks come after its checks, so they get their own time or the end swallows them.
    const pointTile = (m: typeof marks[number]) => tileOf((m.mark.inp as { tile?: unknown } | undefined)?.tile);
    const atEnd = (m: typeof marks[number]) => m.mark.kind === "point" && m.tileSeen === seen[pointTile(m)];
    const tail = Math.max(...(["desktop", "phone"] as const).map(tile => marks.filter(m => atEnd(m) && pointTile(m) === tile).length)) * RING_MS;
    const play = Math.max(0, total - tail), clicks = { desktop: 0, phone: 0 };
    const add = (at: number, chunk: VerifyReplayChunk) => this.queue.push({ due: start + at, chunk, at: start + at, scrollY: 0 });
    const view = (at: number, tile: VerifyTile, y: number) => {
      if (this.history[tile].length) add(at, { kind: "mark", mark: { ms: 0, kind: "view", tile, frame: nearest(this.history[tile], y) } });
    };
    for (const { tile, things } of lists) {
      if (this.history[tile].length) {
        const first = nearest(this.history[tile], 0);
        this.frames[tile] = first;
        this.scroll[tile] = first.scrollY;
      }
      const slot = things.length ? play / things.length : 0;
      things.forEach((thing, i) => {
        view(i * slot, tile, thing.scrollY);
        for (const ev of outlineOnce(thing, { hold: slot })) add(i * slot, { kind: "mark", mark: { ms: ev.ms as number, kind: "result", ev } });
      });
    }
    for (const m of marks) {
      const { mark, seen: before, tileSeen } = m, tile = pointTile(m);
      const at = atEnd(m) ? play + clicks[tile]++ * RING_MS : (mark.kind === "point" ? tileSeen / seen[tile]! : rows.length ? before / rows.length : 0) * play;
      if (mark.kind === "point") view(at, tile, typeof mark.scrollY === "number" ? mark.scrollY : 0);
      add(at, { kind: "mark", mark });
    }
    if (end) add(play + tail, end);
    this.set("play");
  }

  expire() { this.set("expired"); }
  fail() { this.set("failed"); }

  /** Moves the clock; false while nothing changed. */
  advance(ms: number): boolean {
    const before = this.version;
    this.clock += Math.max(0, Math.min(ms, 250));
    this.queue.sort((a, b) => a.due - b.due);
    while (this.queue.length && this.queue[0]!.due <= this.clock) {
      const { chunk, at, scrollY, due } = this.queue.shift()!;
      this.apply(chunk, at, scrollY, due);
    }
    this.step();
    for (const wait of this.waits.filter(w => w.at <= this.clock)) wait.resolve();
    this.waits = this.waits.filter(w => w.at > this.clock);
    if (this.outlines.some(o => !o.issue && this.clock - o.at > o.hold + FADE_MS)) {
      this.outlines = this.outlines.filter(o => o.issue || this.clock - o.at <= o.hold + FADE_MS);
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
    return list.length ? nearest(list, issue.scrollY ?? 0) : null;
  }

  /** Box in tile CSS px for the current scroll. */
  view(outline: Outline): Rect {
    const top = outline.pin ? outline.mscroll : this.scroll[outline.tile];
    return { ...outline.box, y: outline.box.y - top };
  }

  cursorAt(cursor: Cursor, reduced = false, clock = this.clock) {
    if (reduced) return cursor.to;
    const move = this.cursorMove(cursor);
    const k = move.duration ? Math.min(1, Math.max(0, (clock - move.at) / move.duration)) : 1;
    const e = k * k * k * (10 + k * (-15 + 6 * k));
    return { x: move.from.x + (move.to.x - move.from.x) * e, y: move.from.y + (move.to.y - move.from.y) * e };
  }

  private cursorMove(cursor: Cursor): Cursor {
    if (this.live) return cursor;
    let next: { due: number; index: number; ev: Record<string, unknown>; box: Rect } | null = null;
    for (const [index, item] of this.queue.entries()) {
      if (item.due <= cursor.at || item.chunk.kind !== "mark" || item.chunk.mark.kind !== "result") continue;
      const ev = (item.chunk.mark.ev ?? {}) as Record<string, unknown>;
      const box = rect(ev.box);
      if (!box || ev.result === "skip" || tileOf(ev.tile) !== cursor.tile) continue;
      if (!next || item.due <= next.due) next = { due: item.due, index, ev, box };
    }
    if (!next) return cursor;
    let scrollY = this.scroll[cursor.tile];
    for (const item of this.queue.slice(0, next.index)) {
      if (item.chunk.kind !== "mark") continue;
      const mark = item.chunk.mark;
      if (mark.kind === "view" && tileOf(mark.tile) === cursor.tile) scrollY = (mark.frame as Stored).scrollY;
    }
    const top = next.ev.pin ? typeof next.ev.mscroll === "number" ? next.ev.mscroll : 0 : scrollY;
    const to = { x: next.box.x + Math.min(next.box.w * 0.3, 12), y: next.box.y - top + Math.min(next.box.h * 0.6, 10) };
    const at = Math.max(cursor.at, next.due - GLIDE_MS);
    return { ...cursor, from: cursor.to, to, at, duration: next.due - at };
  }

  outlineAlpha(outline: Outline): number {
    if (outline.issue) return 1;
    const age = this.clock - outline.at;
    return age <= outline.hold ? 1 : Math.max(0, 1 - (age - outline.hold) / FADE_MS);
  }

  private moving() {
    return [...this.cursors.values()].some(c => { const move = this.cursorMove(c); return this.clock >= move.at && this.clock < move.at + move.duration; }) || (this.ring !== null && this.clock - this.ring.at < RING_MS) || this.outlines.some(o => !o.issue && this.clock - o.at > o.hold - 20);
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

  private apply(chunk: VerifyReplayChunk, at: number, scrollY: number, due: number) {
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
      this.reel = verifyReel(this.pinned ? chunk.end.issues.filter(issue => issue.tile === this.pinned) : chunk.end.issues);
      this.set(chunk.end.status === "blocked" ? "failed" : this.reel.length ? "reel" : chunk.end.issues.length ? "after" : "clean");
      return;
    }
    this.mark(chunk.mark, at, due);
  }

  private mark(mark: VerifyReplayMark, at: number, due: number) {
    if (mark.kind === "part" && (mark.part === "loads" || mark.part === "links" || mark.part === "phone")) this.parts.add(mark.part);
    else if (mark.kind === "view") {
      const frame = mark.frame as Stored, tile = tileOf(mark.tile);
      this.frames[tile] = frame;
      this.scroll[tile] = frame.scrollY;
    } else if (mark.kind === "scroll" && Number.isFinite(mark.y)) this.scroll[tileOf(mark.tile)] = mark.y as number;
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
      const pair = this.lanes[checker as VerifyChecker]?.[tileOf(ev.tile)];
      if (pair) pair[0]++;
      const box = rect(ev.box);
      if (!box) return;
      const outline: Outline = { tile: tileOf(ev.tile), checker, issue, box, pin: Boolean(ev.pin), mscroll: typeof ev.mscroll === "number" ? ev.mscroll : 0, at, hold: typeof ev.hold === "number" ? ev.hold : LIVE_OUTLINE_MS };
      this.outlines.push(outline);
      if (this.outlines.length > 400) this.outlines.splice(this.outlines.findIndex(o => !o.issue), 1);
      const key = this.live ? checker : outline.tile, target = this.view(outline), last = this.cursors.get(key);
      const to = { x: target.x + Math.min(target.w * 0.3, 12), y: target.y + Math.min(target.h * 0.6, 10) };
      const start = this.live ? due : at;
      const from = this.live && last?.tile === outline.tile ? this.cursorAt(last, false, start) : to;
      this.cursors.set(key, { checker, tile: outline.tile, from, to, at: start, duration: this.live && last?.tile === outline.tile ? LIVE_GLIDE_MS : 0 });
    }
  }
}
