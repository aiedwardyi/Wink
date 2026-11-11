import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COLD_OPEN_FILE, COLD_OPEN_KEEP, COLD_OPEN_MAX_BYTES, receiveColdOpen, traceOpenBots, traceOpenSse } from "./cold-open-diag.ts";
import { startupTiming } from "./startup-timing.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wink-cold-open-"));
  dirs.push(dir);
  return dir;
}

const post = (body: string) => Readable.from([Buffer.from(body)]);

const record = {
  label: "notification",
  t0: -2100,
  nav: { fetchStart: 3, responseEnd: 310, domContentLoadedEventEnd: 951 },
  firstPaint: 700,
  hello: 1590,
  bots: { start: 1600, end: 2401, transferSize: 285111, encodedBodySize: 284811 },
  chatPaint: 2701,
  jsCached: true,
  navigationType: "navigate",
  displayMode: "standalone",
  visibility: "visible",
  build: "index-DNyEQLOj.js",
  userAgent: "Mozilla/5.0 (Linux; Android 14) SamsungBrowser/27.0",
};

const OPEN_ID = "0123456789abcdef";

const traced = {
  ...record,
  openId: OPEN_ID,
  sse: { created: 300, open: 2000, errors: 2, lastError: 1400 },
  bots: { ...record.bots, requestStart: 1611, responseStart: 2300, decodedBodySize: 900000, nextHopProtocol: "h2" },
  cache: { hit: true, paint: 520 },
};

const lines = (dir: string) => readFileSync(join(dir, COLD_OPEN_FILE), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const served = { server: { uptimeS: expect.any(Number) }, serverStart: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/) };

describe("cold-open diagnostics", () => {
  it("releases desktop startup work on hydrated chat paint", async () => {
    const paint = vi.spyOn(startupTiming, "paint").mockImplementation(() => {});
    try {
      expect(await receiveColdOpen(post(JSON.stringify({ ...record, desktop: true, label: "open", nav: { responseStart: 25 } })), freshDir())).toEqual({ status: 200 });
      expect(paint).toHaveBeenCalledWith({ firstResponse: 25, chatPaint: 2701 });
    } finally {
      paint.mockRestore();
    }
  });

  it("appends one line with the server's receive time", async () => {
    const dir = freshDir();
    expect(await receiveColdOpen(post(JSON.stringify(record)), dir, Date.UTC(2026, 9, 11, 1, 2, 3))).toEqual({ status: 200 });
    expect(await receiveColdOpen(post(JSON.stringify({ ...record, label: "warm" })), dir, Date.UTC(2026, 9, 11, 1, 5))).toEqual({ status: 200 });
    expect(lines(dir)).toEqual([
      { receivedAt: "2026-10-11T01:02:03.000Z", ...record, ...served },
      { receivedAt: "2026-10-11T01:05:00.000Z", ...record, label: "warm", ...served },
    ]);
  });

  it("stores the stream, bots and cache fields and drops the page's id", async () => {
    const dir = freshDir();
    expect(await receiveColdOpen(post(JSON.stringify(traced)), dir)).toEqual({ status: 200 });
    const { openId: _id, ...stored } = traced;
    expect(lines(dir)[0]).toMatchObject(stored);
    expect(lines(dir)[0]).not.toHaveProperty("openId");
  });

  it("joins the server's timings for the page's id once, and its own uptime and start over the phone's", async () => {
    const dir = freshDir();
    const now = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(1234.4);
    const res = new EventEmitter();
    traceOpenBots({ headers: { "x-cold-open": OPEN_ID } }, res);
    traceOpenSse(new URL(`http://x/api/events?coldOpen=${OPEN_ID}`), 3);
    res.emit("finish");
    now.mockRestore();
    const lie = { botsMs: 1, sseClients: 99, uptimeS: 1 };
    await receiveColdOpen(post(JSON.stringify({ ...traced, server: lie, serverStart: "1999-01-01T00:00:00.000Z" })), dir);
    await receiveColdOpen(post(JSON.stringify(traced)), dir);
    const [first, second] = lines(dir);
    expect(first.server).toEqual({ botsMs: 1134, sseClients: 3, uptimeS: expect.any(Number) });
    expect(first.serverStart).not.toBe("1999-01-01T00:00:00.000Z");
    expect(second.server).toEqual({ uptimeS: expect.any(Number) });
    expect(second.serverStart).toBe(first.serverStart);
  });

  it("ignores a request id it cannot trust", async () => {
    const dir = freshDir();
    traceOpenBots({ headers: { "x-cold-open": "../etc" } }, new EventEmitter());
    traceOpenBots({ headers: {} }, new EventEmitter());
    traceOpenSse(new URL("http://x/api/events?coldOpen=nope"), 2);
    traceOpenSse(new URL("http://x/api/events"), 2);
    await receiveColdOpen(post(JSON.stringify(traced)), dir);
    expect(lines(dir)[0].server).toEqual({ uptimeS: expect.any(Number) });
  });

  it("stores a phone's resume row", async () => {
    const dir = freshDir();
    const { label, nav, firstPaint, bots, jsCached, navigationType, t0, ...meta } = record;
    const resume = { ...meta, label: "resume", hiddenMs: 300_000, sseOpen: 3_000, hello: 3_010, chatPaint: 3_030 };
    expect(await receiveColdOpen(post(JSON.stringify(resume)), dir)).toEqual({ status: 200 });
    expect(JSON.parse(readFileSync(join(dir, COLD_OPEN_FILE), "utf8"))).toMatchObject({ label: "resume", hiddenMs: 300_000, chatPaint: 3_030 });
  });

  it("keeps a typical traced record under the body cap", () => {
    expect(Buffer.byteLength(JSON.stringify({ ...traced, nav: { fetchStart: 3, connectStart: 10, connectEnd: 120, secureConnectionStart: 40, requestStart: 121, responseStart: 300, responseEnd: 310, domInteractive: 900, domContentLoadedEventEnd: 951 } }))).toBeLessThan(COLD_OPEN_MAX_BYTES);
  });

  it("keeps the newest 200 lines", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, "diag"));
    const old = Array.from({ length: COLD_OPEN_KEEP }, (_, i) => JSON.stringify({ receivedAt: "old", n: i })).join("\n");
    writeFileSync(join(dir, COLD_OPEN_FILE), `${old}\n`);
    await receiveColdOpen(post(JSON.stringify(record)), dir);
    const kept = lines(dir);
    expect(kept).toHaveLength(COLD_OPEN_KEEP);
    expect(kept[0]).toEqual({ receivedAt: "old", n: 1 });
    expect(kept.at(-1)).toMatchObject({ label: "notification", chatPaint: 2701 });
  });

  it("rejects a body over 8 KB", async () => {
    const dir = freshDir();
    const big = JSON.stringify({ ...record, userAgent: "x".repeat(COLD_OPEN_MAX_BYTES) });
    expect(await receiveColdOpen(post(big), dir)).toEqual({ status: 413, error: "body too large" });
    expect(existsSync(join(dir, COLD_OPEN_FILE))).toBe(false);
  });

  it.each([
    ["not JSON", "{label:"],
    ["an unknown field", JSON.stringify({ ...record, threadId: "t-secret" })],
    ["an unknown label", JSON.stringify({ ...record, label: "boot" })],
    ["no display mode", JSON.stringify({ ...record, displayMode: undefined })],
    ["a text timing", JSON.stringify({ ...record, hello: "1590" })],
    ["an unknown request field", JSON.stringify({ ...record, bots: { ...record.bots, url: "/api/bots" } })],
    ["an array", "[]"],
    ["a text error count", JSON.stringify({ ...traced, sse: { ...traced.sse, errors: "2" } })],
    ["a fractional error count", JSON.stringify({ ...traced, sse: { ...traced.sse, errors: 1.5 } })],
    ["no stream creation time", JSON.stringify({ ...traced, sse: { errors: 0 } })],
    ["an unknown stream field", JSON.stringify({ ...traced, sse: { ...traced.sse, url: "/api/events" } })],
    ["a numeric protocol", JSON.stringify({ ...traced, bots: { ...traced.bots, nextHopProtocol: 2 } })],
    ["a negative decoded size", JSON.stringify({ ...traced, bots: { ...traced.bots, decodedBodySize: -1 } })],
    ["a text response start", JSON.stringify({ ...traced, bots: { ...traced.bots, responseStart: "2300" } })],
    ["a text cache hit", JSON.stringify({ ...traced, cache: { hit: "yes" } })],
    ["no cache hit", JSON.stringify({ ...traced, cache: { paint: 520 } })],
    ["a text cache paint", JSON.stringify({ ...traced, cache: { hit: true, paint: "520" } })],
    ["an unknown cache field", JSON.stringify({ ...traced, cache: { hit: true, thread: "t1" } })],
    ["a text server time", JSON.stringify({ ...traced, server: { botsMs: "9" } })],
    ["an unknown server field", JSON.stringify({ ...traced, server: { cpu: 9 } })],
    ["a numeric server start", JSON.stringify({ ...traced, serverStart: 1760000000 })],
    ["a malformed open id", JSON.stringify({ ...traced, openId: "../etc" })],
  ])("rejects %s", async (_name, body) => {
    const dir = freshDir();
    expect((await receiveColdOpen(post(body), dir)).status).toBe(400);
    expect(existsSync(join(dir, COLD_OPEN_FILE))).toBe(false);
  });
});
