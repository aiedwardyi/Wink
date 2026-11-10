import { expect, it } from "vitest";
import type { VerifyDocKind } from "../../shared/verify-doc";
import { DOC_SHOW_MAX_MS, DOC_SHOW_MIN_MS, VerifyDocShow } from "./verify-doc-show";
import type { VerifyReplayMark } from "./verify-replay";

const lines = (n: number) => Array.from({ length: n }, (_, i) => i % 6 === 5 ? "" : `Line ${i + 1} of the worker card, long enough to read along.`);
const text = (n: number): VerifyReplayMark => ({ ms: 0, kind: "doc-text", lines: lines(n), pageStarts: [] });
const band = (ms: number, from: number, to: number, state: "start" | "done"): VerifyReplayMark => ({ ms, kind: "doc-chunk", from, to, state });
const hit = (ms: number, kind: VerifyDocKind, line: number, quote = "worker"): VerifyReplayMark => ({ ms, kind: "doc-finding", finding: { kind, line, page: 1, quote, fix: "x" } });
const short = (took: number, ...found: VerifyReplayMark[]) => [text(22), band(1, 1, 22, "start"), ...found, band(Math.max(1, took - 1), 1, 22, "done")];

/** Steps a show to its end; `seen` gets each step with the chunks open after it. */
function play(show: VerifyDocShow, seen: (step: ReturnType<VerifyDocShow["advance"]>, open: Map<number, number>) => void = () => {}, limit = 60_000) {
  const open = new Map<number, number>();
  for (let ms = 0; !show.ended && show.clock < limit; ms = 20) {
    const step = show.advance(ms);
    for (const mark of step.marks) if (mark.kind === "doc-chunk") mark.state === "done" ? open.delete(mark.from as number) : open.set(mark.from as number, mark.to as number);
    seen(step, open);
  }
  return show.clock;
}

it("plays a 22-line, one-chunk replay for 6 to 8 s whatever the check took", () => {
  for (const took of [0, 2_000, 60_000]) {
    const show = new VerifyDocShow(false);
    show.plan(short(took), took, false);
    const length = play(show);
    expect(length).toBeGreaterThanOrEqual(DOC_SHOW_MIN_MS);
    expect(length).toBeLessThanOrEqual(DOC_SHOW_MAX_MS + 20);
  }
});

it("keeps every cursor on a line of a chunk being checked, one per checker, each on its own spot", () => {
  const show = new VerifyDocShow(false), kinds = new Map<number, Set<string>>();
  show.plan([text(60), band(1, 1, 30, "start"), band(10_000, 1, 30, "done"), band(10_001, 31, 60, "start"), hit(19_990, "numbering", 40), band(20_000, 31, 60, "done")], 20_000, false);
  play(show, (_, open) => {
    const cursors = [...show.cursors.values()];
    expect(new Set(cursors.map(c => c.id)).size).toBe(cursors.length);
    for (const c of cursors) {
      expect(c.line).toBeGreaterThanOrEqual(c.band);
      expect(c.line).toBeLessThanOrEqual(open.get(c.band) ?? 0);
      expect(lines(60)[c.line - 1]).not.toBe("");
      kinds.set(c.band, (kinds.get(c.band) ?? new Set()).add(c.quote ? `${c.kind}!` : c.kind));
    }
    const readers = cursors.filter(c => !c.quote && c.kind !== "numbering");
    expect(new Set(readers.map(c => `${c.line}:${c.along}`)).size).toBe(readers.length);
  });
  // Numbering's rules ran once at the start: it reads only the chunk open then, and visits the later one just to mark its hit.
  expect([...kinds.get(1)!].sort()).toEqual(["grammar", "names", "numbering", "spelling", "translation"]);
  expect([...kinds.get(31)!].sort()).toEqual(["grammar", "names", "numbering!", "spelling", "translation"]);
});

it("lands a finding when its checker's cursor reaches the quote, before the chunk closes", () => {
  const show = new VerifyDocShow(false), landed: string[] = [];
  show.plan(short(2_000, hit(1_990, "spelling", 5, "card"), hit(1_990, "grammar", 16), hit(1_990, "numbering", 9)), 2_000, false);
  play(show, (step, open) => {
    for (const mark of step.marks) if (mark.kind === "doc-finding") {
      const { kind, line, quote } = mark.finding as { kind: string; line: number; quote: string };
      expect(show.cursors.get(`1:${kind}`)).toMatchObject({ line, quote });
      expect(open.has(1)).toBe(true);
      landed.push(`${kind} ${Math.round(show.clock / 1000)}`);
    }
  });
  expect(landed).toEqual(["numbering 2", "spelling 2", "grammar 5"]);
});

it("keeps the names cursor alone for the comparison, only when the check really ran one", () => {
  const after = (gap: number) => {
    const show = new VerifyDocShow(false), alone = new Set<string>();
    let lands = "";
    show.plan([...short(4_000), hit(4_000 + gap, "names", 3, "Line")], 4_000 + gap, false);
    play(show, (step, open) => {
      if (!open.size && show.clock > 1_000) for (const c of show.cursors.values()) alone.add(c.id);
      if (step.marks.some(mark => mark.kind === "doc-finding")) lands = show.cursors.get("0:names")?.quote ?? "none";
    });
    return [...alone, lands];
  };
  expect(after(3_000)).toEqual(["0:names", "Line"]);
  expect(after(20)).toEqual(["none"]);
});

it("keeps reading a live chunk until its done mark, then lands what the reply found and leaves", () => {
  const show = new VerifyDocShow(true);
  let moves = 0;
  show.feed(text(22));
  show.feed(band(5, 1, 22, "start"));
  for (let ms = 0; ms < 30_000; ms += 20) {
    const step = show.advance(20);
    moves += step.moved.length;
    if (ms > 3_000) expect([...show.cursors.keys()].sort()).toEqual(["1:grammar", "1:names", "1:spelling", "1:translation"]);
    if (ms > 3_000 && ms % 1_000 === 0) expect(moves).toBeGreaterThan(0), moves = 0;
  }
  show.feed(hit(30_000, "spelling", 5));
  show.feed(band(30_001, 1, 22, "done"));
  show.finish(30_002, false);
  const marks: string[] = [];
  play(show, step => { for (const mark of step.marks) marks.push(`${mark.kind}${mark.kind === "doc-finding" ? ` ${show.cursors.get("1:spelling")?.quote}` : ""}`); }, 40_000);
  expect(marks).toEqual(["doc-finding worker", "doc-chunk"]);
  expect(show.clock).toBeGreaterThan(30_200);
  expect(show.cursors.size).toBe(0);
  expect(show.due()).toBe(Infinity);
});

it("shows marks that were waiting when a live watch joined at once", () => {
  const show = new VerifyDocShow(true);
  for (const mark of [text(22), band(5, 1, 22, "start"), hit(900, "spelling", 5), band(901, 1, 22, "done")]) show.feed(mark);
  expect(show.advance(0).marks).toHaveLength(4);
  expect(show.cursors.size).toBe(0);
});

it("moves no cursor with reduced motion and keeps the same length", () => {
  const show = new VerifyDocShow(false, true);
  show.plan(short(2_000, hit(1_990, "spelling", 5)), 2_000, false);
  const kinds: string[] = [];
  const length = play(show, step => {
    expect(show.cursors.size + step.moved.length).toBe(0);
    kinds.push(...step.marks.map(mark => mark.kind));
  });
  expect(kinds).toEqual(["doc-text", "doc-chunk", "doc-finding", "doc-chunk"]);
  expect(length).toBeGreaterThanOrEqual(DOC_SHOW_MIN_MS);
});

it("ends a replay with no chunk at once", () => {
  const show = new VerifyDocShow(false);
  show.plan([text(2)], 9_000, true);
  expect(show.advance(0)).toMatchObject({ marks: [{ kind: "doc-text" }], end: { ms: 9_000, blocked: true } });
});
