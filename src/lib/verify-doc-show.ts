import { VERIFY_DOC_KINDS, type VerifyDocKind } from "../../shared/verify-doc";
import type { VerifyReplayMark } from "./verify-replay";
import { CURSOR_MS, CURSOR_REST_MS } from "./verify-watch-show";

export const DOC_SHOW_MIN_MS = 6_000;
export const DOC_SHOW_MAX_MS = 8_000;
const LINE_MS = 40;
// Run ms: a chunk opened this early was open when the numbering rules ran, and a longer wait after the last chunk is the names comparison.
const EARLY_MS = 250;
const COMPARE_MS = 250;
const SKIM = 3;
const SKIM_ALONG = [0.1, 0.6, 0.3];
const READ = 0.7;
const HOP = 0.618;
const QUICK_MS = 250;
const DRAIN_MS = 2_000;
// One model call per chunk reads for all four; numbering is rules, run once before the first chunk.
const READERS: VerifyDocKind[] = ["spelling", "grammar", "translation", "names"];
const KINDS = new Set<unknown>(VERIFY_DOC_KINDS);
const GLIDE_MS = CURSOR_MS - CURSOR_REST_MS;
const int = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Where a checker's cursor points: a spot along a line's text, or a finding's quote. */
export interface DocCursor { id: string; kind: VerifyDocKind; /** first line of its chunk, 0 for the names comparison */ band: number; line: number; along: number; quote?: string; duration: number }
export interface DocEnd { ms: number; blocked: boolean }
export interface DocStep { marks: VerifyReplayMark[]; moved: DocCursor[]; left: string[]; end: DocEnd | null }

interface Lane { kind: VerifyDocKind; i: number; turn: number; next: number; queue: VerifyReplayMark[]; landing?: { at: number; mark: VerifyReplayMark } }
interface Band { from: number; to: number; at: number; rows: number[]; rounds: number; lanes: Lane[]; /** a cursor rests on the quote it just marked until then */ hold: number; compare?: boolean; closing?: number; done?: VerifyReplayMark }
interface Due { at: number; mark?: VerifyReplayMark; until?: number; compare?: boolean; end?: DocEnd }
interface Chunk { from: number; to: number; start: number; done: number; s: number; e: number }

const findingOf = (mark: VerifyReplayMark) => {
  const f = mark.kind === "doc-finding" && mark.finding && typeof mark.finding === "object" ? mark.finding as Record<string, unknown> : null;
  return f && KINDS.has(f.kind) && int(f.line) && typeof f.quote === "string" ? { kind: f.kind as VerifyDocKind, line: f.line, quote: f.quote } : null;
};
const chunkOf = (mark: VerifyReplayMark) => mark.kind === "doc-chunk" && int(mark.from) && int(mark.to) ? { from: mark.from, to: mark.to, done: mark.state === "done" } : null;

/** One document watch. Live marks play as they come; a replay is the same marks paced into one show. */
export class VerifyDocShow {
  clock = 0;
  cursors = new Map<string, DocCursor>();
  ended = false;
  private lines: string[] = [];
  private queue: Due[] = [];
  private bands: Band[] = [];
  private end: DocEnd | null = null;
  /** live: since when no chunk is open after one was */
  private idle = Infinity;
  private marks: VerifyReplayMark[] = [];
  private moved = new Map<string, DocCursor>();
  private left: string[] = [];

  /** `still`: no cursors, for reduced motion. `view`: the lines on screen, where the names comparison shows. */
  constructor(readonly live: boolean, private still = false, private view: () => readonly [number, number] | null = () => null) {}

  /** `after`: ms since the last advance, so a mark is timed by its arrival. */
  feed(mark: VerifyReplayMark, after = 0) { this.queue.push({ at: this.clock + after, mark }); }
  finish(ms: number, blocked: boolean, after = 0) { this.queue.push({ at: this.clock + after, end: { ms, blocked } }); }

  plan(marks: VerifyReplayMark[], ms: number, blocked: boolean) {
    const total = Math.max(ms, marks.at(-1)?.ms ?? 0), text = marks.find(mark => mark.kind === "doc-text"), chunks = new Map<number, Chunk>();
    for (const mark of marks) {
      const c = chunkOf(mark);
      if (c && !c.done) chunks.set(c.from, { from: c.from, to: c.to, start: mark.ms, done: total, s: 0, e: 0 });
      else if (c && chunks.has(c.from)) chunks.get(c.from)!.done = mark.ms;
    }
    const first = Math.min(total, ...[...chunks.values()].map(c => c.start)), last = Math.max(first, ...[...chunks.values()].map(c => c.done));
    const length = chunks.size ? Math.min(DOC_SHOW_MAX_MS, DOC_SHOW_MIN_MS + (Array.isArray(text?.lines) ? text.lines.length : 0) * LINE_MS) : 0;
    const compare = chunks.size && total - last >= COMPARE_MS ? Math.min(length / 3, Math.max(2 * CURSOR_MS, (total - last) / total * length)) : 0;
    const body = length - compare, room = Math.min(body, 3 * CURSOR_MS);
    // A check answered from cache took no time: its chunks get the whole show.
    const at = (run: number) => last > first ? Math.max(0, Math.min(run, last) - first) / (last - first) * body : 0;
    for (const c of chunks.values()) {
      c.s = Math.min(at(c.start), body - room);
      c.e = last > first ? Math.max(at(c.done), c.s + room) : body;
    }
    const found = new Map<string, VerifyReplayMark[]>(), merged: VerifyReplayMark[] = [];
    for (const mark of marks) {
      const c = chunkOf(mark), f = findingOf(mark);
      const home = f && [...chunks.values()].find(row => mark.ms >= row.start && mark.ms <= row.done && f.line >= row.from && f.line <= row.to);
      if (c && chunks.has(c.from)) this.queue.push(c.done ? { at: chunks.get(c.from)!.e, mark } : { at: chunks.get(c.from)!.s, mark, until: chunks.get(c.from)!.e });
      else if (f && home) found.set(`${home.from}:${f.kind}`, [...found.get(`${home.from}:${f.kind}`) ?? [], mark]);
      else if (f && compare && mark.ms >= last) merged.push(mark);
      else this.queue.push({ at: mark.kind === "doc-text" ? 0 : mark.ms >= last ? length : at(mark.ms), mark });
    }
    for (const [key, list] of found) {
      const c = chunks.get(Number(key.split(":")[0]))!, lineOf = (mark: VerifyReplayMark) => findingOf(mark)!.line;
      // A finding lands as its checker reads past it: numbering while it skims, or as its chunk closes when it was not open for the rules.
      const [a, b] = !key.endsWith(":numbering") ? [c.s, c.e - 2 * CURSOR_MS] : c.start <= EARLY_MS ? [c.s, c.s + (SKIM - 1) * CURSOR_MS] : [c.e, c.e];
      list.sort((x, y) => lineOf(x) - lineOf(y)).forEach((mark, k) => {
        const reached = a + (lineOf(mark) - c.from) / Math.max(1, c.to - c.from) * Math.max(0, b - a);
        this.queue.push({ at: Math.max(c.s, Math.min(reached, c.e - (list.length - k + 1) * CURSOR_MS)), mark });
      });
    }
    if (compare) this.queue.push({ at: body, compare: true });
    merged.forEach((mark, k) => this.queue.push({ at: body + CURSOR_REST_MS + k * Math.min(CURSOR_MS, (compare - CURSOR_MS) / merged.length), mark }));
    this.queue.push({ at: length, end: { ms, blocked } });
    this.queue.sort((x, y) => x.at - y.at);
  }

  advance(ms: number): DocStep {
    this.clock += Math.max(0, ms);
    for (let busy = true; busy;) {
      busy = false;
      while (this.queue.length && this.queue[0]!.at <= this.clock) { this.take(this.queue.shift()!); busy = true; }
      if (this.live && !this.end && this.clock - this.idle >= COMPARE_MS) { this.compare(this.idle + COMPARE_MS); busy = true; }
      for (const band of [...this.bands]) {
        for (const lane of band.lanes) {
          if (lane.landing && (lane.landing.at <= this.clock || this.clock - (band.closing ?? Infinity) >= DRAIN_MS)) {
            this.marks.push(lane.landing.mark);
            band.hold = Math.min(this.clock, lane.landing.at) + QUICK_MS / 2;
            lane.landing = undefined;
            busy = true;
          }
          if (band.closing !== undefined && this.clock - band.closing >= DRAIN_MS) this.marks.push(...lane.queue.splice(0));
          if (lane.next <= this.clock) { this.turn(band, lane); busy = true; }
        }
        if (band.closing === undefined || band.hold > this.clock || band.lanes.some(lane => lane.landing || lane.queue.length)) continue;
        for (const lane of band.lanes) this.away(band, lane);
        if (band.done) this.marks.push(band.done);
        this.bands.splice(this.bands.indexOf(band), 1);
        if (!band.compare && !this.bands.length) this.idle = this.clock;
        busy = true;
      }
    }
    const end = this.end && !this.bands.length && !this.ended ? this.end : null;
    if (end) this.ended = true;
    const step = { marks: this.marks, moved: [...this.moved.values()], left: this.left, end };
    this.marks = [];
    this.moved = new Map();
    this.left = [];
    return step;
  }

  /** ms until something is due; Infinity while a live stream has nothing to show. */
  due(): number {
    let at = this.queue[0]?.at ?? Infinity;
    if (this.live && !this.end) at = Math.min(at, this.idle + COMPARE_MS);
    for (const band of this.bands) {
      if (band.closing !== undefined) at = Math.min(at, band.closing + DRAIN_MS, band.hold > this.clock ? band.hold : Infinity);
      for (const lane of band.lanes) at = Math.min(at, lane.next, lane.landing?.at ?? Infinity);
    }
    return Math.max(0, at - this.clock);
  }

  private take(due: Due) {
    if (due.end) {
      this.end = due.end;
      for (const band of this.bands) this.close(band, due.at);
      return;
    }
    if (due.compare) return this.compare(due.at);
    const mark = due.mark!, c = this.still ? null : chunkOf(mark), f = this.still ? null : findingOf(mark);
    if (mark.kind === "doc-text" && Array.isArray(mark.lines)) this.lines = mark.lines.map(line => typeof line === "string" ? line : "");
    const open = c && this.bands.find(band => band.from === c.from && !band.compare);
    if (c?.done && open) {
      open.done = mark;
      return this.close(open, due.at);
    }
    const band = f && this.bands.findLast(row => row.closing === undefined && f.line >= row.from && f.line <= row.to);
    let lane = band?.lanes.find(row => row.kind === f!.kind);
    // Numbering in a chunk it never skimmed, there only to mark what the rules found.
    if (band && !lane && !band.compare) band.lanes.push(lane = { kind: f!.kind, i: band.lanes.length, turn: SKIM, next: Infinity, queue: [] });
    if (lane) {
      lane.queue.push(mark);
      if (lane.next === Infinity) lane.next = due.at;
      return;
    }
    this.marks.push(mark);
    if (c && !c.done && !open) this.open(c.from, Math.min(c.to, this.lines.length), due.at, mark.ms <= EARLY_MS, due.until);
  }

  private rows(from: number, to: number) {
    const rows: number[] = [];
    for (let n = from; n <= to; n++) if (this.lines[n - 1]?.trim()) rows.push(n);
    return rows.length ? rows : [from];
  }

  private open(from: number, to: number, at: number, early: boolean, until?: number) {
    const kinds: VerifyDocKind[] = early ? [...READERS, "numbering"] : READERS, step = CURSOR_MS / kinds.length, rows = this.rows(from, to);
    // A replay reads the chunk once, top to bottom, in the time it has; live keeps reading it over until the done mark.
    const reads = until === undefined ? 0 : Math.floor(Math.max(0, until - at - CURSOR_REST_MS) / CURSOR_MS) + 2;
    const rounds = until === undefined ? Math.min(8, Math.max(2, Math.ceil(rows.length / READERS.length))) : Math.ceil(reads / 2);
    const band: Band = { from, to, at, rows, rounds, hold: 0, lanes: kinds.map((kind, i) => ({ kind, i, turn: 0, next: at + CURSOR_REST_MS + i * step, queue: [] })) };
    this.bands.push(band);
    this.idle = Infinity;
    for (const lane of band.lanes) this.read(band, lane, 0);
  }

  /** The cross-document names and dates call: its cursor works alone. */
  private compare(at: number) {
    this.idle = Infinity;
    if (this.still || !this.lines.length) return;
    const band: Band = { from: 1, to: this.lines.length, at, rows: this.rows(1, this.lines.length), rounds: 1, hold: 0, compare: true, lanes: [{ kind: "names", i: 0, turn: 0, next: at + CURSOR_REST_MS, queue: [] }] };
    this.bands.push(band);
    this.read(band, band.lanes[0]!, 0);
  }

  private close(band: Band, at: number) {
    if (band.closing !== undefined) return;
    band.closing = at;
    // Opened and closed in one go: marks that were waiting when a live watch joined.
    const late = at - band.at < CURSOR_REST_MS;
    for (const lane of band.lanes) {
      if (late) this.marks.push(...lane.queue.splice(0));
      else if (lane.queue.length && !lane.landing) lane.next = Math.min(lane.next, at);
    }
  }

  private turn(band: Band, lane: Lane) {
    const at = lane.next, hit = lane.queue.shift(), quick = band.closing !== undefined, glide = quick ? QUICK_MS : GLIDE_MS;
    if (!hit && (quick || lane.kind === "numbering" && lane.turn >= SKIM)) {
      this.away(band, lane);
      lane.next = Infinity;
      return;
    }
    if (hit) {
      const f = findingOf(hit)!;
      this.point(band, lane, { line: f.line, along: 0, quote: f.quote, duration: glide });
      lane.landing = { at: at + glide, mark: hit };
    } else this.read(band, lane, glide);
    lane.next = at + glide + (quick ? QUICK_MS / 2 : CURSOR_REST_MS);
  }

  private read(band: Band, lane: Lane, duration: number) {
    const turn = lane.turn++, n = band.rows.length;
    if (band.compare) {
      const [top, bottom] = this.view() ?? [1, this.lines.length], seen = band.rows.filter(row => row >= top && row <= bottom), rows = seen.length ? seen : band.rows;
      return this.point(band, lane, { line: rows[Math.floor((turn >> 1) * HOP % 1 * rows.length)]!, along: turn % 2 ? READ : 0, duration });
    }
    if (lane.kind === "numbering") return this.point(band, lane, { line: band.rows[Math.min(n - 1, Math.floor((turn + 0.5) / SKIM * n))]!, along: SKIM_ALONG[turn % SKIM_ALONG.length]!, duration });
    // Each reader takes its own line of the next few, reads along it, then all move down together: never two on one spot.
    const slots = band.rounds * READERS.length, round = (turn >> 1) % band.rounds;
    const p = n >= slots ? Math.floor(round * n / band.rounds) + lane.i : (round * READERS.length + lane.i) / slots * n, start = n >= slots ? 0 : p % 1;
    this.point(band, lane, { line: band.rows[Math.min(n - 1, Math.floor(p))]!, along: turn % 2 ? Math.min(1, start + Math.min(1, n / slots) * READ) : start, duration });
  }

  private point(band: Band, lane: Lane, to: Pick<DocCursor, "line" | "along" | "quote" | "duration">) {
    const id = `${band.compare ? 0 : band.from}:${lane.kind}`, cursor: DocCursor = { id, kind: lane.kind, band: band.compare ? 0 : band.from, ...to };
    this.cursors.set(id, cursor);
    this.moved.set(id, cursor);
  }

  private away(band: Band, lane: Lane) {
    const id = `${band.compare ? 0 : band.from}:${lane.kind}`;
    if (!this.cursors.delete(id)) return;
    this.moved.delete(id);
    this.left.push(id);
  }
}
