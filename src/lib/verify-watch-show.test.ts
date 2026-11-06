import { expect, it } from "vitest";
import { chunk } from "../../electron/verify-replay.mjs";
import { createReplay } from "../../server/verify-replay.ts";
import { readReplay } from "./verify-replay";
import type { VerifyIssue } from "../../shared/live-verify";
import { SIXTEENTH_MS } from "./verify-beat";
import type { VerifyReplayChunk } from "./verify-replay";
import { BANNER_MS, FRAME_FLOOR_MS, LIVE_CLOSE_MS, REEL_MS, VerifyWatchShow } from "./verify-watch-show";

const head: VerifyReplayChunk = { kind: "head", head: { v: 1, runId: "r", site: "luna/index.html", page: "index.html", startedAt: 0, tiles: { desktop: [1280, 720], phone: [392, 800] } } };
const frame = (ms: number, tile: "desktop" | "phone" = "desktop"): VerifyReplayChunk => ({ kind: "frame", tile, ms, jpeg: new Uint8Array([ms & 255]) });
const mark = (ms: number, kind: string, extra: Record<string, unknown> = {}): VerifyReplayChunk => ({ kind: "mark", mark: { ms, kind, ...extra } });
const issue = (where: string, tile: VerifyIssue["tile"] = "phone"): VerifyIssue => ({ checker: "NAV", tile, rule: "phone menu gone", where, measured: "m", box: [0, 0, 10, 10] });
const end = (ms: number, issues: VerifyIssue[] = []): VerifyReplayChunk => ({ kind: "end", end: { status: "completed", ms, issues, notChecked: [] } });
const run = (show: VerifyWatchShow, until: number, step = 10) => { while (show.clock < until) show.advance(step); };

it("plays a replay at real speed but holds every frame at least 120 ms", () => {
  const show = new VerifyWatchShow(false);
  show.beginRun();
  for (const c of [head, frame(0), frame(30), frame(60), frame(400), end(500)]) show.feed(c);
  const seen: number[] = [];
  let last: Uint8Array | null = null;
  while (show.clock < 1000) {
    show.advance(5);
    const f = show.frames.desktop?.jpeg ?? null;
    if (f && f !== last) { seen.push(show.clock); last = f; }
  }
  expect(seen).toHaveLength(4);
  for (let i = 1; i < seen.length; i++) expect(seen[i]! - seen[i - 1]!).toBeGreaterThanOrEqual(FRAME_FLOOR_MS - 5);
  expect(seen[3]! - seen[0]!).toBeGreaterThanOrEqual(400);
});

it("lets marks out on the 174 BPM sixteenth grid and ticks parts and counts", () => {
  const show = new VerifyWatchShow(false);
  show.beginRun();
  for (const c of [head, mark(10, "result", { ev: { tile: "desktop", checker: "LINKS", result: "ok", box: { x: 1, y: 2, w: 3, h: 4 } } }), mark(100, "part", { part: "loads" })]) show.feed(c);
  run(show, SIXTEENTH_MS - 20, 5);
  expect(show.checks).toBe(0);
  run(show, SIXTEENTH_MS + 5, 5);
  expect(show.checks).toBe(1);
  expect(show.outlines).toHaveLength(1);
  run(show, 2 * SIXTEENTH_MS + 5, 5);
  expect(show.parts.has("loads")).toBe(true);
});

it("reels each problem for 1.5 s on its tab, then settles; a replay closes at its end", async () => {
  const show = new VerifyWatchShow(false);
  show.beginRun();
  for (const c of [head, frame(0), frame(10, "phone"), end(100, [issue("a"), issue("b", "desktop")])]) show.feed(c);
  run(show, 150);
  expect(show.phase).toBe("reel");
  expect(show.reelIssue()?.where).toBe("a");
  expect(show.tile).toBe("phone");
  run(show, 150 + REEL_MS);
  expect(show.reelIssue()?.where).toBe("b");
  expect(show.tile).toBe("desktop");
  run(show, 200 + 2 * REEL_MS);
  expect(show.phase).toBe("after");
  show.finish();
  expect(show.closeAt).toBe(show.clock);
});

it("closes 3 s after the end when opened live, and shows No problems on a clean run", () => {
  const show = new VerifyWatchShow(true);
  show.beginRun();
  for (const c of [head, frame(0), end(100)]) show.feed(c);
  run(show, 20);
  expect(show.phase).toBe("clean");
  run(show, 40 + BANNER_MS);
  expect(show.phase).toBe("after");
  show.finish();
  expect(show.closeAt - show.clock).toBe(LIVE_CLOSE_MS);
});

it("holds between runs and starts the next run fresh", async () => {
  const show = new VerifyWatchShow(false);
  show.beginRun();
  for (const c of [head, mark(0, "result", { ev: { tile: "phone", checker: "NAV", result: "issue", box: [0, 0, 5, 5] } }), end(50, [issue("a")])]) show.feed(c);
  run(show, 100 + REEL_MS);
  const between = show.between();
  expect(show.phase).toBe("between");
  run(show, show.clock + BANNER_MS + 10);
  await between;
  show.beginRun();
  expect(show.checks).toBe(0);
  expect(show.end).toBeNull();
  expect(show.outlines).toEqual([]);
});

it("puts a late-opened live stream's old marks in the past and keeps the pinned tab", () => {
  const show = new VerifyWatchShow(true);
  show.beginRun();
  show.pin("phone");
  for (const c of [head, frame(4000), mark(1000, "result", { ev: { tile: "desktop", checker: "LINKS", result: "ok", box: [0, 0, 5, 5] } }), mark(4000, "part", { part: "links" })]) show.feed(c);
  run(show, SIXTEENTH_MS + 10);
  expect(show.checks).toBe(1);
  expect(show.outlines).toEqual([]);
  expect(show.tile).toBe("phone");
});

it("spreads a batched checks mark into outlines on the grid, in document px, with detail rows never red", () => {
  const show = new VerifyWatchShow(false);
  show.beginRun();
  const rows = [
    { tile: "desktop", checker: "LINKS", result: "ok", box: [10, 20, 30, 40], scrollY: 600 },
    { tile: "desktop", checker: "LINKS", result: "issue", box: [0, 0, 5, 5], scrollY: 0 },
    { tile: "desktop", checker: "DETAILS", result: "issue", detail: true, box: [0, 0, 5, 5], scrollY: 0 },
  ];
  for (const c of [head, mark(0, "checks", { checks: rows, count: 3 })]) show.feed(c);
  run(show, SIXTEENTH_MS + 5, 5);
  expect(show.checks).toBe(3);
  expect(show.outlines.map(o => [o.box.y, o.issue])).toEqual([[620, false], [0, true], [0, false]]);
});

it.each([false, true])("never treats a blocked end with no issues as clean (live=%s)", async live => {
  const show = new VerifyWatchShow(live);
  show.beginRun();
  show.feed(head);
  show.feed({ kind: "end", end: { status: "blocked", ms: 0, issues: [], notChecked: [] } });
  show.advance(40);
  expect(show.phase).toBe("failed");
  await show.settled();
  expect(show.phase).toBe("failed");
});

it("redraws and updates the caption when 40 ms frames cross a reel boundary", () => {
  const show = new VerifyWatchShow(false);
  show.beginRun();
  show.feed(head);
  show.feed(end(0, [issue("first"), issue("second", "desktop")]));
  show.advance(0);
  run(show, 1480, 40);
  const { version, ui } = show;
  expect(show.advance(40)).toBe(true);
  expect(show.version).toBeGreaterThan(version);
  expect(show.ui).toBeGreaterThan(ui);
  expect(show.reelIssue()?.where).toBe("second");
  expect(show.tile).toBe("desktop");
});

it.each([false, true])("files a frame shot just after a scroll under that scroll, though the mark plays later (live=%s)", live => {
  const show = new VerifyWatchShow(live);
  show.beginRun();
  for (const c of [head, frame(0)]) show.feed(c);
  run(show, 10);
  for (const c of [mark(100, "scroll", { tile: "desktop", y: 600 }), frame(130), end(400, [{ ...issue("far", "desktop"), scrollY: 600 }])]) show.feed(c);
  run(show, 600);
  expect(show.phase).toBe("reel");
  expect(show.frame()?.ms).toBe(130);
  expect(show.frame()?.scrollY).toBe(600);
});

it.each([false, true])("keeps snapshot frames at their captured scroll on open and reconnect (ended=%s)", async ended => {
  const shot = (ms: number, tile = "desktop") => chunk(1, { tile, ms, data: Buffer.alloc(10, 1) });
  const replay = createReplay({ ...head.head });
  replay.add(shot(0));
  replay.add(chunk(2, { kind: "scroll", tile: "desktop", y: 600, ms: 100 }));
  replay.add(shot(130));
  replay.add(chunk(2, { kind: "scroll", tile: "phone", y: 300, ms: 140 }));
  replay.add(shot(150, "phone"));
  replay.add(chunk(2, { kind: "scroll", tile: "desktop", y: 900, ms: 160 }));
  const result = { status: "completed", ms: 1000, notChecked: [], issues: [{ checker: "LINKS", tile: "desktop", rule: "missing target", where: "#apply", measured: "m", box: [0, 20, 50, 20], scrollY: 600 }] };
  if (ended) replay.finish(result);
  const show = new VerifyWatchShow(true);
  for (let i = 0; i < 2; i++) {
    show.beginRun();
    const seen: Buffer[] = [], close = replay.subscribe(bytes => { seen.push(bytes); return true; });
    close();
    const response = new Response(new Blob([Uint8Array.from(Buffer.concat([Buffer.from("LVR1"), ...seen]))]).stream());
    for await (const value of readReplay(response.body!)) show.feed(value);
    for (let j = 0; j < 10; j++) show.advance(10);
    expect(show.frames.desktop?.scrollY).toBe(600);
    expect(show.frames.phone?.scrollY).toBe(300);
    expect(show.scroll.desktop).toBe(900);
    if (ended) expect(show.frame()).toMatchObject({ ms: 130, scrollY: 600 });
  }
});
