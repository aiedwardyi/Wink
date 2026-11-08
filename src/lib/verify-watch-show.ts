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
const LIVE_GLIDE_MS = 250;
const CURSOR_MS = 900;
const CURSOR_REST_MS = 180;
const CURSOR_GAP = 110;
const CURSOR_NEAR = 40;
const CURSOR_REACH = 1100;
const CURSOR_ALONG = [0, 0.6, 0.3];
const CURSOR_MAX = 6;
const CURSOR_EXTRA = 3;
const CURSOR_ROOM = 4;

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
export interface Cursor { checker: string; tile: VerifyTile; extra?: number; from: { x: number; y: number }; to: { x: number; y: number }; at: number; duration: number }
/** Where a cursor's tag sits (arrow units, 14 tall); none on a spare, and it flips to stay inside the view. */
export function tagSpot(c: Cursor, p: { x: number; y: number }, width: number, view: readonly [number, number], px: number) {
  if (c.extra) return null;
  return { x: p.x + (11 + width) * px > view[0] ? -width : 11, y: p.y + 29 * px > view[1] ? -16 : 15 };
}
const cursorKey = (c: Cursor) => `${c.tile}:${c.extra ? `+${c.extra}` : c.checker}`;
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

interface Spot { x: number; y: number; w: number; thing: number; top: number | null; visits: number }

function spotsOf(things: Thing[], [w, h]: readonly number[]) {
  const spots = new Map<string, Map<string, Spot>>();
  things.forEach((thing, i) => {
    for (const row of thing.rows) {
      if (row.result === "skip") continue;
      const checker = typeof row.checker === "string" ? row.checker : "CHECK", own = spots.get(checker) ?? new Map<string, Spot>(), box = row.box;
      spots.set(checker, own);
      if (!box) continue;
      const x = box[0]! + Math.min(box[2]! * 0.3, 12), y = box[1]! + Math.min(box[3]! * 0.6, 10);
      own.set(`${x},${y}`, { x, y, w: box[2]!, thing: i, top: row.pin ? typeof row.mscroll === "number" ? row.mscroll : 0 : null, visits: 0 });
    }
  });
  // A check with no box looked at the page as a whole.
  for (const own of spots.values()) {
    if (own.size) continue;
    for (const [x, y] of [[0.35, 0.4], [0.65, 0.6]] as const) own.set(`${x}`, { x: w! * x, y: h! * y, w: 0, thing: 0, top: 0, visits: 0 });
  }
  return new Map([...spots].map(([checker, own]) => [checker, [...own.values()]]));
}

interface Lane { id: string; checker: string; extra: number }

/** Each checker's glides over its own checks in view, arriving one cursor at a time; spare cursors join the checker with the most boxes left to visit. */
function cursorRoutes(tile: VerifyTile, things: Thing[], size: readonly number[], slot: number, play: number, scrollAt: (at: number) => number): Cursor[] {
  const spots = spotsOf(things, size), route: Cursor[] = [], h = size[1]!;
  const lanes: Lane[] = [...spots.keys()].map(checker => ({ id: checker, checker, extra: 0 }));
  if (!lanes.length) return route;
  const shown = (spot: Spot, top: number) => { const y = spot.y - (spot.top ?? top); return y >= 0 && y <= h - 16; };
  const richest = [...spots].map(([checker, own]) => ({ checker, n: own.filter(s => s.w).length })).sort((a, b) => b.n - a.n)[0]!;
  // A spare cursor needs boxes of its own to visit, so a check with no box (or a few) lends none.
  const spare = Math.min(CURSOR_EXTRA, CURSOR_MAX - lanes.length, Math.floor(richest.n / CURSOR_ROOM));
  for (let extra = 1; extra <= spare; extra++) lanes.push({ id: `+${extra}`, checker: richest.checker, extra });
  const now = new Map<string, { x: number; y: number }>(), arrived = new Map<string, number>(), last = new Map<string, Spot>();
  const aim = (lane: Lane, at: number) => {
    const top = scrollAt(at), lit = slot ? Math.floor(at / slot) : 0, others = [...now].filter(([id]) => id !== lane.id).map(([, p]) => p), from = now.get(lane.id);
    if (lane.extra) {
      const fresh = (checker: string) => spots.get(checker)!.filter(s => s.w && !s.visits && shown(s, top)).length;
      const pick = [...spots.keys()].sort((a, b) => fresh(b) - fresh(a))[0]!;
      if (!fresh(lane.checker) && fresh(pick)) lane.checker = pick;
    }
    let best: { spot: Spot; x: number; y: number; score: number } | null = null;
    for (const spot of spots.get(lane.checker)!) {
      if (!shown(spot, top) || (lane.extra && !spot.w)) continue;
      const y = spot.y - (spot.top ?? top);
      const x = spot.x + Math.max(0, spot.w - 30) * CURSOR_ALONG[spot.visits % CURSOR_ALONG.length]!;
      const gap = Math.min(Infinity, ...others.map(p => Math.hypot(p.x - x, p.y - y)));
      if (gap < CURSOR_NEAR) continue;
      const far = from ? Math.max(0, Math.hypot(x - from.x, y - from.y) - CURSOR_REACH) : 0;
      const score = (gap < CURSOR_GAP ? 1e6 - gap : 0) + spot.visits * 1000 + Math.abs(spot.thing - lit) + far * 10;
      if (!best || score < best.score) best = { spot, x, y, score };
    }
    if (best) { best.spot.visits++; last.set(lane.id, best.spot); return { x: best.x, y: best.y }; }
    // Nothing free of its own in this view: it waits just off the page, on the side its last check went.
    const gone = last.get(lane.id) ?? spots.get(lane.checker)![0]!;
    return { x: gone.x, y: gone.y - (gone.top ?? top) < 0 ? -40 : h + 8 };
  };
  const cursor = (lane: Lane, fields: Pick<Cursor, "from" | "to" | "at" | "duration">): Cursor => ({ checker: lane.checker, tile, ...(lane.extra ? { extra: lane.extra } : {}), ...fields });
  for (const lane of lanes) {
    const to = aim(lane, 0);
    now.set(lane.id, to);
    arrived.set(lane.id, 0);
    route.push(cursor(lane, { from: to, to, at: 0, duration: 0 }));
  }
  const step = CURSOR_MS / lanes.length, lead = Math.max(0, CURSOR_MS * 2 / 3 - step);
  // Everyone is under way within one rest of the start, and the route runs past the end so nobody sits still waiting for the show to close.
  for (let turn = 1; lead + turn * step < play + CURSOR_MS; turn++) {
    const lane = lanes[(turn - 1) % lanes.length]!, due = lead + turn * step, from = now.get(lane.id)!;
    const free = due - (CURSOR_MS - CURSOR_REST_MS), at = Math.max(arrived.get(lane.id)!, turn <= lanes.length ? Math.min(free, CURSOR_REST_MS) : free), to = aim(lane, due);
    now.set(lane.id, to);
    arrived.set(lane.id, due);
    route.push(cursor(lane, { from, to, at, duration: due - at }));
  }
  return route;
}

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
  /** a replay's cursor glides, by start time */
  private route: Cursor[] = [];
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
    this.route = [];
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
    const views: Record<VerifyTile, Array<{ at: number; y: number }>> = { desktop: [], phone: [] };
    const view = (at: number, tile: VerifyTile, y: number) => {
      if (!this.history[tile].length) return;
      const frame = nearest(this.history[tile], y);
      views[tile].push({ at, y: frame.scrollY });
      add(at, { kind: "mark", mark: { ms: 0, kind: "view", tile, frame } });
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
    this.route = lists.flatMap(({ tile, things }) => {
      const size = this.head?.tiles[tile] ?? (tile === "phone" ? [392, 800] : [1280, 720]), scrollAt = (at: number) => views[tile].filter(v => v.at <= at).sort((a, b) => a.at - b.at).at(-1)?.y ?? this.scroll[tile];
      return cursorRoutes(tile, things, size, things.length ? play / things.length : 0, play, scrollAt);
    }).map(c => ({ ...c, at: start + c.at })).sort((a, b) => a.at - b.at);
    this.set("play");
  }

  expire() { this.set("expired"); }
  fail() { this.set("failed"); }

  /** Moves the clock; false while nothing changed. */
  advance(ms: number): boolean {
    const before = this.version, from = this.clock;
    this.clock += Math.max(0, Math.min(ms, 250));
    this.queue.sort((a, b) => a.due - b.due);
    while (this.queue.length && this.queue[0]!.due <= this.clock) {
      const { chunk, at, scrollY, due } = this.queue.shift()!;
      this.apply(chunk, at, scrollY, due);
    }
    while (this.route.length && this.route[0]!.at <= this.clock) {
      const cursor = this.route.shift()!;
      this.cursors.set(cursorKey(cursor), cursor);
      this.version++;
    }
    this.step();
    for (const wait of this.waits.filter(w => w.at <= this.clock)) wait.resolve();
    this.waits = this.waits.filter(w => w.at > this.clock);
    if (this.outlines.some(o => !o.issue && this.clock - o.at > o.hold + FADE_MS)) {
      this.outlines = this.outlines.filter(o => o.issue || this.clock - o.at <= o.hold + FADE_MS);
      this.version++;
    }
    if (this.moving(from)) this.version++;
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
    if (reduced) return this.live || clock >= cursor.at + cursor.duration ? cursor.to : cursor.from;
    const k = cursor.duration ? Math.min(1, Math.max(0, (clock - cursor.at) / cursor.duration)) : 1;
    const e = k * k * k * (10 + k * (-15 + 6 * k));
    return { x: cursor.from.x + (cursor.to.x - cursor.from.x) * e, y: cursor.from.y + (cursor.to.y - cursor.from.y) * e };
  }

  outlineAlpha(outline: Outline): number {
    if (outline.issue) return 1;
    const age = this.clock - outline.at;
    return age <= outline.hold ? 1 : Math.max(0, 1 - (age - outline.hold) / FADE_MS);
  }

  private moving(from: number) {
    return [...this.cursors.values()].some(c => this.clock >= c.at && from < c.at + c.duration) || (this.ring !== null && this.clock - this.ring.at < RING_MS) || this.outlines.some(o => !o.issue && this.clock - o.at > o.hold - 20);
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
      this.route = [];
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
      if (!this.live) return;
      const target = this.view(outline), last = this.cursors.get(checker);
      const to = { x: target.x + Math.min(target.w * 0.3, 12), y: target.y + Math.min(target.h * 0.6, 10) };
      const from = last?.tile === outline.tile ? this.cursorAt(last, false, due) : to;
      this.cursors.set(checker, { checker, tile: outline.tile, from, to, at: due, duration: last?.tile === outline.tile ? LIVE_GLIDE_MS : 0 });
    }
  }
}
