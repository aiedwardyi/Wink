import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { expect, it, vi } from "vitest";

import { createChildLink, validFrame } from "./verify-child-link.mjs";
import { startCast } from "./verify-cast.mjs";
import { chunk, decodeChunks } from "./verify-replay.mjs";
import { createCastStream } from "./verify-stream.mjs";

it("validates cast frames and drops before the transport caps", () => {
  const frame = { type: "cast", runId: "run-123456", tile: "desktop", ms: 0, data: Buffer.from([255, 216, 255, 217]).toString("base64") };
  expect(validFrame(frame, "child")).toBe(true);
  for (const patch of [{ tile: "nav" }, { ms: -1 }, { data: "not base64" }, { data: "A".repeat(192 * 1024) }]) expect(validFrame({ ...frame, ...patch }, "child")).toBe(false);
  const errors = [], output = new Writable({ write() {} });
  const link = createChildLink({ nonce: "a".repeat(48), direction: "child", input: new PassThrough(), output, onFrame() {}, onError: e => errors.push(e) });
  const large = { ...frame, data: Buffer.alloc(100_000).toString("base64") };
  for (let i = 0; i < 30; i++) link.send(large);
  expect(link.stats().dropped).toBeGreaterThan(0);
  expect(link.stats().queuedBytes).toBeLessThan(450 * 1024);
  expect(errors).toEqual([]);
  link.close();
});

it("records through the existing adapter and holds acks to four fps", async () => {
  vi.useFakeTimers();
  const events = new EventEmitter(), send = vi.fn(async () => {}), frames = [];
  const cdp = { send, on: (name, cb) => { events.on(name, cb); return () => events.off(name, cb); } };
  const cast = startCast({ cdp, page: {}, tile: "desktop", started: Date.now(), frame: f => frames.push(f) });
  await Promise.resolve();
  expect(send).toHaveBeenCalledWith("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 640 });
  events.emit("Page.screencastFrame", { data: "/9j/2Q==", sessionId: 1 });
  expect(frames).toHaveLength(1);
  expect(send.mock.calls.some(([method]) => method === "Page.screencastFrameAck")).toBe(false);
  await vi.advanceTimersByTimeAsync(250);
  expect(send).toHaveBeenCalledWith("Page.screencastFrameAck", { sessionId: 1 });
  cast.stop();
  expect(send).toHaveBeenCalledWith("Page.stopScreencast");
  vi.useRealTimers();
});

it("uses nonblocking JPEG fallback only without screencast frames", async () => {
  const frame = vi.fn(), capturePage = vi.fn(async () => ({ resize: () => ({ toJPEG: () => Buffer.from([255, 216, 255, 217]) }) }));
  const cast = startCast({ cdp: { send: async () => {}, on: () => () => {} }, page: { capturePage }, tile: "phone", started: Date.now(), frame });
  expect(cast.readerStop()).toBeUndefined();
  await new Promise(setImmediate);
  expect(frame).toHaveBeenCalledWith(expect.objectContaining({ tile: "phone", data: "/9j/2Q==" }));
  cast.stop();
});

it("round trips binary chunks across arbitrary input boundaries", () => {
  const values = [], read = decodeChunks(value => values.push(value));
  const encoded = Buffer.concat([chunk(0, { v: 1, runId: "run-123456" }), chunk(1, { tile: "phone", ms: 250, data: Buffer.from([255, 216, 255, 217]) }), chunk(2, { ms: 10, kind: "part", part: "phone" }), chunk(3, { status: "completed", ms: 500, issues: [], notChecked: [] })]);
  for (const byte of encoded) read.push(Buffer.from([byte]));
  read.end();
  expect(values.map(v => v.kind)).toEqual([0, 1, 2, 3]);
  expect(values[1]).toMatchObject({ tile: "phone", ms: 250, data: Buffer.from([255, 216, 255, 217]) });
  expect(() => decodeChunks(() => {}).push(Buffer.from([255, 255, 255, 255]))).toThrow();
});

it("drops backed-up live frames, seeds late readers and ends without Watch", () => {
  const input = { runId: "run-123456", site: "site/index.html", entry: "index.html" }, pipe = createCastStream(input, 1000);
  const make = () => Object.assign(new EventEmitter(), { values: [], busy: false, writeHead: vi.fn(), write(value) { this.values.push(value); return !this.busy; }, end(value) { if (value) this.values.push(value); this.writableEnded = true; } });
  const first = make(); pipe.open(first);
  pipe.mark({ kind: "start", seq: 1, emittedAt: 1100 });
  first.busy = true;
  const frame = { tile: "desktop", ms: 10, data: "/9j/2Q==" };
  pipe.frame(frame); pipe.frame({ ...frame, ms: 20 });
  expect(first.values.filter(bytes => bytes[4] === 1)).toHaveLength(1);
  const late = make(); pipe.open(late);
  expect(late.values.map(bytes => bytes[4])).toEqual([0, 1, 2]);
  expect(() => pipe.open(make())).toThrow("busy");
  first.busy = false; first.emit("drain"); pipe.frame({ ...frame, ms: 30 });
  expect(first.values.filter(bytes => bytes[4] === 1)).toHaveLength(2);
  pipe.finish({ issues: [], durationMs: 40 });
  expect(first.writableEnded).toBe(true); expect(late.writableEnded).toBe(true);
  const rows = [], decoder = decodeChunks(row => rows.push(row)); decoder.push(Buffer.concat(first.values)); decoder.end();
  expect(rows.at(-1)).toMatchObject({ kind: 3, ms: 140 });
});
