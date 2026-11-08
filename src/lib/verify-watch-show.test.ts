import { expect, it } from "vitest";
import { chunk } from "../../electron/verify-replay.mjs";
import { createReplay } from "../../server/verify-replay.ts";
import { readReplay } from "./verify-replay";
import type { VerifyIssue } from "../../shared/live-verify";
import type { VerifyReplayChunk } from "./verify-replay";
import { BANNER_MS, LIVE_CLOSE_MS, REEL_MS, SHOW_MAX_MS, SHOW_MIN_MS, THING_MS, VerifyWatchShow } from "./verify-watch-show";

const head: VerifyReplayChunk = { kind: "head", head: { v: 1, runId: "r", site: "luna/index.html", page: "index.html", startedAt: 0, tiles: { desktop: [1280, 720], phone: [392, 800] } } };
const frame = (ms: number, tile: "desktop" | "phone" = "desktop"): VerifyReplayChunk => ({ kind: "frame", tile, ms, jpeg: new Uint8Array([ms & 255]) });
const mark = (ms: number, kind: string, extra: Record<string, unknown> = {}): VerifyReplayChunk => ({ kind: "mark", mark: { ms, kind, ...extra } });
const issue = (where: string, tile: VerifyIssue["tile"] = "phone"): VerifyIssue => ({ checker: "NAV", tile, rule: "phone menu gone", where, measured: "m", box: [0, 0, 10, 10] });
const end = (ms: number, issues: VerifyIssue[] = []): VerifyReplayChunk => ({ kind: "end", end: { status: "completed", ms, issues, notChecked: [] } });
const run = (show: VerifyWatchShow, until: number, step = 10) => { while (show.clock < until) show.advance(step); };
const toClock = (show: VerifyWatchShow, until: number, step = 16) => { while (show.clock < until) show.advance(Math.min(step, until - show.clock)); };
const result = (ms: number, x: number, y: number, extra: Record<string, unknown> = {}) => mark(ms, "result", { ev: { tile: "desktop", checker: "LINKS", result: "ok", box: [x, y, 40, 20], where: `a#x${x}y${y}`, ...extra } });
const position = (show: VerifyWatchShow, reduced = false) => show.cursorAt(show.cursors.get(show.live ? "LINKS" : "desktop")!, reduced);
const replay = (...chunks: VerifyReplayChunk[]) => {
  const show = new VerifyWatchShow(false);
  show.beginRun();
  for (const c of [head, ...chunks]) show.feed(c);
  show.advance(0);
  return show;
};
const page = (n: number) => Array.from({ length: n }, (_, i) => result(i, 10, i * 30));

it("waits for the whole replay before it starts the show", () => {
  const show = new VerifyWatchShow(false);
  show.beginRun();
  for (const c of [head, result(0, 0, 0)]) show.feed(c);
  run(show, 200);
  expect(show.phase).toBe("loading");
  show.feed(end(10));
  show.advance(0);
  expect(show.phase).toBe("play");
});

it("spends about 300 ms on each real thing and counts the same real checks", () => {
  const show = replay(...page(20), end(40));
  expect(show.checks).toBe(1);
  toClock(show, 10 * THING_MS - 1);
  expect(show.checks).toBe(10);
  toClock(show, 20 * THING_MS - 1);
  expect(show.checks).toBe(20);
  expect(show.phase).toBe("play");
  toClock(show, 20 * THING_MS);
  expect(show.phase).toBe("clean");
});

it("gives a tiny page a short show of its own, never a 1 s flash", () => {
  const show = replay(...page(2), end(40));
  toClock(show, SHOW_MIN_MS - 1);
  expect(show.phase).toBe("play");
  toClock(show, SHOW_MIN_MS);
  expect(show.phase).toBe("clean");
  expect(show.checks).toBe(2);
});

it("caps a big page at 12 s and still counts every check", () => {
  const show = replay(...page(600), end(700));
  let most = 0;
  while (show.clock + 16 < SHOW_MAX_MS) {
    show.advance(16);
    most = Math.max(most, show.outlines.length);
  }
  expect(show.phase).toBe("play");
  expect(most).toBeLessThanOrEqual(2);
  toClock(show, SHOW_MAX_MS);
  expect(show.phase).toBe("clean");
  expect(show.checks).toBe(600);
});

it("counts every small check on one thing but outlines the thing once", () => {
  const rows = ["placeholder", "lorem", "TODO", "undefined", "NaN"].map(rule => ({ tile: "desktop", checker: "TEXT_A", rule, result: "ok", where: "header:nth-child(1) > button:nth-child(2)", box: [10, 20, 30, 40], scrollY: 0 }));
  const show = replay(mark(0, "checks", { checks: rows, count: 5 }), end(5));
  expect(show.checks).toBe(5);
  expect(show.byChecker.get("TEXT_A")?.done).toBe(5);
  expect(show.outlines).toHaveLength(1);
  expect(show.cursors.size).toBe(1);
});

it("folds the parts of a section into one thing and keeps a problem as its own", () => {
  const row = (where: string, y: number, extra = {}) => ({ tile: "desktop", checker: "TEXT_A", result: "ok", where, box: [0, y, 100, 20], scrollY: 0, ...extra });
  const rows = [row("section:nth-child(2) > h2:nth-child(1)", 100), row("section:nth-child(2) > div:nth-child(2) > span:nth-child(1)", 130), row("section:nth-child(2) > div:nth-child(2) > a:nth-child(2)", 160), row("section:nth-child(2) > p:nth-child(3)", 190, { result: "issue" })];
  const show = replay(mark(0, "checks", { checks: rows, count: 4 }), end(5, [issue("p", "desktop")]));
  toClock(show, SHOW_MIN_MS - 1);
  expect(show.checks).toBe(4);
  expect(show.outlines.filter(o => o.issue).map(o => o.box.y)).toEqual([190]);
  expect(show.byChecker.get("TEXT_A")).toEqual({ done: 4, issues: 1 });
});

it("has no beat: live marks land at once with no grid", () => {
  const show = new VerifyWatchShow(true);
  show.beginRun();
  for (const c of [head, frame(0), result(0, 0, 0)]) show.feed(c);
  show.advance(0);
  expect(show.checks).toBe(1);
});

it("glides between things, stays continuous at 16 ms frames and arrives as the next thing starts", () => {
  const show = replay(result(0, 0, 0), result(1200, 1000, 500), end(1300));
  const at = SHOW_MIN_MS / 2;
  let last = position(show);
  toClock(show, at - 600);
  expect(position(show)).toEqual(last);
  while (show.clock < at) {
    show.advance(Math.min(16, at - show.clock));
    const p = position(show);
    expect(Math.hypot(p.x - last.x, p.y - last.y)).toBeLessThan(60);
    expect(p.x).toBeGreaterThanOrEqual(last.x);
    expect(p.y).toBeGreaterThanOrEqual(last.y);
    last = p;
  }
  expect(position(show)).toEqual({ x: 1012, y: 510 });
  expect(show.checks).toBe(2);
});

it("jumps only on the thing with reduced motion, keeping check timing unchanged", () => {
  const show = replay(result(0, 0, 0), result(1200, 1000, 0), end(1300));
  const at = SHOW_MIN_MS / 2;
  toClock(show, at - 100);
  expect(position(show).x).toBeGreaterThan(900);
  expect(position(show, true)).toEqual({ x: 12, y: 10 });
  expect(show.checks).toBe(1);
  toClock(show, at);
  expect(position(show, true)).toEqual({ x: 1012, y: 10 });
  expect(show.checks).toBe(2);
});

it("aims for the next thing at the scroll stop it plays at", () => {
  const show = replay(frame(0), result(0, 0, 0), mark(1100, "scroll", { tile: "desktop", y: 500 }), frame(1110), result(1200, 600, 700, { scrollY: 500 }), end(1300));
  const at = SHOW_MIN_MS / 2;
  toClock(show, at - 200);
  expect(show.scroll.desktop).toBe(0);
  expect(position(show).y).toBeGreaterThan(100);
  expect(position(show).y).toBeLessThan(210);
  toClock(show, at);
  expect(show.scroll.desktop).toBe(500);
  expect(position(show).y).toBe(210);
});

it("derives the same positions from the clock with 8 ms and 16 ms frames", () => {
  const shows = [8, 16].map(() => replay(result(0, 0, 0), result(1200, 1000, 500), result(2400, 200, 900), end(2500)));
  for (const at of [0, 640, 800, 1000, 1207, 1800, 2200, 2414]) {
    shows.forEach((show, i) => toClock(show, at, i ? 16 : 8));
    expect(position(shows[0]!)).toEqual(position(shows[1]!));
    const { version } = shows[0]!;
    expect(position(shows[0]!)).toEqual(position(shows[0]!));
    expect(shows[0]!.version).toBe(version);
  }
});

it("redraws during a glide before a thing changes the UI", () => {
  const show = replay(result(0, 0, 0), result(2000, 1000, 0), end(2100));
  toClock(show, 1200);
  const { version, ui } = show;
  expect(show.advance(16)).toBe(true);
  expect(show.version).toBeGreaterThan(version);
  expect(show.ui).toBe(ui);
  expect(show.checks).toBe(1);
});

it("has the real page up from the first moment and swaps it at each scroll stop", () => {
  const show = replay(frame(5), result(0, 0, 0), mark(100, "scroll", { tile: "desktop", y: 600 }), frame(110), result(120, 0, 700, { scrollY: 600 }), end(200));
  expect(show.frame()?.ms).toBe(5);
  toClock(show, SHOW_MIN_MS / 2);
  expect(show.frame()).toMatchObject({ ms: 110, scrollY: 600 });
});

it("takes the later frame when two share a scroll stop", () => {
  const show = replay(frame(5), frame(6), result(0, 0, 0), end(20));
  expect(show.frame()?.ms).toBe(6);
});

it("plays desktop and phone on one clock so neither tab sits idle", () => {
  const phone = (i: number) => result(i, 5, i * 30, { tile: "phone", checker: "FIT" });
  const show = replay(frame(0), frame(1, "phone"), ...page(10), phone(0), phone(1), phone(2), phone(3), phone(4), end(60));
  show.pin("phone");
  toClock(show, 1600);
  expect(show.outlines.some(o => o.tile === "phone")).toBe(true);
  expect(show.cursors.get("phone")).toBeDefined();
  expect(show.outlines.some(o => o.tile === "desktop")).toBe(true);
});

it("feeds the card's lanes the same shape and the same real counts", () => {
  const show = replay(...page(4), result(9, 5, 400, { tile: "phone", checker: "FIT" }), end(20));
  expect(show.lanes.LINKS).toEqual({ desktop: [1, 4] });
  expect(show.lanes.FIT).toEqual({ phone: [1, 1] });
  expect(show.showing).toBe(true);
  toClock(show, SHOW_MIN_MS);
  expect(show.lanes.LINKS).toEqual({ desktop: [4, 4] });
  expect(show.showing).toBe(true);
  toClock(show, SHOW_MIN_MS + BANNER_MS + 20);
  expect(show.phase).toBe("after");
  expect(show.showing).toBe(false);
});

it("ticks parts in the order the run reached them", () => {
  const show = replay(mark(1, "part", { part: "loads" }), ...page(10), mark(300, "part", { part: "links" }), ...page(0), end(400));
  expect(show.parts.has("loads")).toBe(true);
  expect(show.parts.has("links")).toBe(false);
  toClock(show, SHOW_MIN_MS);
  expect(show.parts.has("links")).toBe(true);
});

it("keeps the chosen tab through a new show, the reel and a tab with no problems", () => {
  const show = new VerifyWatchShow(false, "phone");
  show.beginRun();
  for (const c of [head, frame(0), frame(1, "phone"), end(10, [issue("a", "desktop"), issue("b")])]) show.feed(c);
  run(show, 50);
  expect(show.phase).toBe("reel");
  expect(show.reelIssue()?.where).toBe("b");
  expect(show.tile).toBe("phone");
  run(show, 50 + REEL_MS);
  expect(show.phase).toBe("after");
  expect(show.tile).toBe("phone");
});

it("settles without a false No problems when the chosen tab has none of them", () => {
  const show = new VerifyWatchShow(false, "phone");
  show.beginRun();
  for (const c of [head, frame(0), frame(1, "phone"), end(10, [issue("a", "desktop")])]) show.feed(c);
  run(show, 50);
  expect(show.phase).toBe("after");
  expect(show.tile).toBe("phone");
});

it("honors a tab picked during the reel", () => {
  const show = replay(frame(0), frame(1, "phone"), end(10, [issue("a", "desktop"), issue("b")]));
  run(show, 50);
  expect(show.tile).toBe("desktop");
  show.pin("phone");
  expect(show.tile).toBe("phone");
  expect(show.reelIssue()?.where).toBe("b");
  show.pin("desktop");
  expect(show.phase).toBe("reel");
  expect(show.reelIssue()?.where).toBe("a");
  expect(show.tile).toBe("desktop");
});

it("keeps a problem's own outline when unboxed or left-out checks count on it", () => {
  const unboxed = mark(0, "result", { ev: { tile: "desktop", checker: "PAGE_ERRORS", result: "issue", where: "/index.html:9" } });
  const broken = mark(1, "result", { ev: { tile: "desktop", checker: "LINKS", result: "issue", box: [10, 20, 80, 30], where: "a#broken" } });
  const show = replay(frame(0), unboxed, broken, end(5, [issue("a#broken", "desktop")]));
  expect(show.outlines.map(o => [o.checker, o.issue, o.box.y])).toEqual([["LINKS", true, 20]]);
  expect(show.checks).toBe(2);
});

it("plays the clicks that follow a tile's checks before the end", () => {
  const click = (ms: number, x: number) => mark(ms, "point", { inp: { tile: "desktop", type: "click", x, y: 30 }, scrollY: 0 });
  const show = replay(frame(0), ...page(4), click(40, 20), click(41, 300), end(50));
  const rings: number[] = [];
  while (show.phase === "play") {
    show.advance(16);
    if (show.phase === "play" && show.ring && rings.at(-1) !== show.ring.x) rings.push(show.ring.x);
  }
  expect(rings).toEqual([20, 300]);
  expect(show.clock).toBeLessThan(SHOW_MIN_MS + 16);
  expect(show.checks).toBe(4);
});

it("offers no Phone tab when the run has no phone view", () => {
  const show = new VerifyWatchShow(false, "phone");
  show.beginRun();
  show.feed(head);
  expect(show.tabs).toEqual(["desktop", "phone"]);
  for (const c of [frame(0), result(1, 0, 0), end(10)]) show.feed(c);
  expect(show.tabs).toEqual(["desktop"]);
  expect(show.tile).toBe("desktop");
});

it("glides a late live target within 250 ms and keeps reduced motion instant", () => {
  const show = new VerifyWatchShow(true);
  show.feed(head);
  show.feed(result(0, 0, 0));
  show.advance(0);
  toClock(show, 1000);
  const before = position(show);
  show.feed(result(1000, 1000, 500));
  show.advance(0);
  const at = show.cursors.get("LINKS")!.at;
  expect(position(show)).toEqual(before);
  show.advance(16);
  expect(position(show).x).toBeGreaterThan(before.x);
  expect(position(show).x).toBeLessThan(before.x + 30);
  expect(position(show, true)).toEqual({ x: 1012, y: 510 });
  toClock(show, at + 250);
  expect(position(show)).toEqual({ x: 1012, y: 510 });
});

it("retargets a live glide from its event time regardless of frame cadence", () => {
  const shows = [8, 16].map(() => new VerifyWatchShow(true));
  for (const show of shows) {
    show.feed(head);
    show.feed(result(0, 0, 0));
    show.advance(0);
  }
  for (const at of [1000, 1100, 1140, 1200, 1400]) {
    shows.forEach((show, i) => toClock(show, at, i ? 16 : 8));
    expect(position(shows[0]!)).toEqual(position(shows[1]!));
    if (at === 1000 || at === 1100) shows.forEach(show => show.feed(result(at, at === 1000 ? 1000 : 100, 500)));
  }
});

it("groups a live batch by thing, in document px, with detail rows never red", () => {
  const show = new VerifyWatchShow(true);
  show.beginRun();
  const rows = [
    { tile: "desktop", checker: "LINKS", result: "ok", where: "a#one", box: [10, 20, 30, 40], scrollY: 600 },
    { tile: "desktop", checker: "TEXT_A", result: "ok", where: "a#one", box: [10, 20, 30, 40], scrollY: 600 },
    { tile: "desktop", checker: "LINKS", result: "issue", where: "a#two", box: [0, 0, 5, 5], scrollY: 0 },
    { tile: "desktop", checker: "DETAILS", result: "issue", detail: true, where: "a#three", box: [0, 0, 5, 5], scrollY: 0 },
  ];
  for (const c of [head, mark(0, "checks", { checks: rows, count: 4 })]) show.feed(c);
  show.advance(0);
  expect(show.checks).toBe(4);
  expect(show.outlines.map(o => [o.box.y, o.issue])).toEqual([[620, false], [0, true], [0, false]]);
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
  run(show, SHOW_MIN_MS + 100 + REEL_MS);
  const between = show.between();
  expect(show.phase).toBe("between");
  run(show, show.clock + BANNER_MS + 10);
  await between;
  show.beginRun();
  expect(show.checks).toBe(0);
  expect(show.end).toBeNull();
  expect(show.outlines).toEqual([]);
  expect(show.lanes).toEqual({});
});

it("puts a late-opened live stream's old marks in the past and keeps the pinned tab", () => {
  const show = new VerifyWatchShow(true);
  show.beginRun();
  show.pin("phone");
  for (const c of [head, frame(4000), mark(1000, "result", { ev: { tile: "desktop", checker: "LINKS", result: "ok", box: [0, 0, 5, 5] } }), mark(4000, "part", { part: "links" })]) show.feed(c);
  run(show, 100);
  expect(show.checks).toBe(1);
  expect(show.outlines).toEqual([]);
  expect(show.tile).toBe("phone");
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
