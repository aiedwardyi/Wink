import { PassThrough } from "node:stream";
import { expect, it } from "vitest";

import { CHILD_PATHS, createChildLink, validCounts, validFrame, validResult } from "./verify-child-link.mjs";

const nonce = "a".repeat(48);
const counts = { planned: 1, completed: 1, passed: 1, failed: 0, blocked: 0, notRun: 0 };

it("admits cast and check batches without widening parent frames", () => {
  const cast = { type: "cast", runId: "run-123456", tile: "phone", ms: 10, data: "/9j/2Q==" };
  expect(validFrame(cast, "child")).toBe(true);
  expect(validFrame(cast, "parent")).toBe(false);
  expect(validFrame({ ...cast, extra: true }, "child")).toBe(false);
  expect(validFrame({ type: "mark", runId: cast.runId, event: { kind: "checks", seq: 1, emittedAt: 100, checks: [], count: 0 } }, "child")).toBe(true);
  const issue = { checker: "LINKS", tile: "phone", rule: "missing target", where: "a", measured: "missing", box: [1, 2, 3, 4], scrollY: 200 };
  const result = { v: 1, runId: cast.runId, site: "index.html", counts: { ...counts, passed: 0, failed: 1 }, issues: [issue], issueTotal: 1, durationMs: 1 };
  expect(validResult(result)).toBe(true);
  expect(validResult({ ...result, issues: [{ ...issue, box: [1, 2, -1, 4] }] })).toBe(false);
});

it("round trips split frames and bounds logs", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  const errors = [];
  const logs = [];
  const link = createChildLink({ nonce, direction: "parent", input, output, onFrame: (v) => frames.push(v), onError: (e) => errors.push(e), onLog: (s) => logs.push(s) });
  const line = `lv0:${nonce}:{"type":"pong","n":1}\n`;
  for (const byte of Buffer.from(line)) input.write(Buffer.from([byte]));
  for (let n = 0; n < 205; n++) input.write("runtime log\n");
  expect(frames).toEqual([{ type: "pong", n: 1 }]);
  expect(errors).toEqual([]);
  expect(logs).toHaveLength(200);
  expect(link.stats().dropped).toBe(5);
  const written = [];
  output.on("data", (v) => written.push(v.toString()));
  expect(link.send({ type: "ping", n: 3 })).toBe(true);
  expect(written).toEqual([`lv0:${nonce}:{"type":"ping","n":3}\n`]);
  link.close();
});

it.each([["nonce", `lv0:${"b".repeat(48)}:{}\n`], ["json", `lv0:${nonce}:{\n`], ["type", `lv0:${nonce}:{"type":"unknown"}\n`], ["schema", `lv0:${nonce}:{"type":"pong","n":-1}\n`], ["cap", "x".repeat(256 * 1024 + 1)]])("refuses invalid child framing: %s", (_name, line) => {
  const input = new PassThrough();
  let error;
  const link = createChildLink({ nonce, direction: "parent", input, output: new PassThrough(), onFrame() {}, onError: (e) => { error = e; } });
  input.write(line);
  expect(error).toBeInstanceOf(Error);
  link.close();
});

it("checks parent caps, extra fields and count identities", () => {
  const input = new PassThrough();
  let error;
  const link = createChildLink({ nonce, direction: "child", input, output: new PassThrough(), onFrame() {}, onError: (e) => { error = e; } });
  input.write("x".repeat(65537));
  expect(error.message).toMatch(/Oversize/);
  expect(validFrame({ type: "quit", extra: true }, "parent")).toBe(false);
  expect(validCounts(counts)).toBe(true);
  expect(validCounts({ ...counts, notRun: 1 })).toBe(false);
  expect(validCounts({ ...counts, passed: NaN })).toBe(false);
  const result = { v: 1, runId: "run-123456", site: "fixture", counts, issues: [], issueTotal: 0, durationMs: 1 };
  expect(validResult(result)).toBe(true);
  expect(validResult({ ...result, issues: Array(41).fill({}) })).toBe(false);
  expect(validFrame({ type: "state", runId: result.runId, state: "completed", counts, result }, "child")).toBe(true);
  expect(validFrame({ type: "state", runId: "other-run", state: "completed", counts, result }, "child")).toBe(false);
  link.close();
});

it("pins every private frame schema", () => {
  const run = { runId: "run-123456" };
  const viewing = { locale: "en", muted: true, display: { x: 0, y: 0, width: 1280, height: 720 } };
  const schemas = {
    parent: [
      { type: "hello", v: 1, nonce, parentPid: 1, probe: false, probeRoot: null },
      { type: "start", ...run, ...viewing, botId: "bot-1", root: "C:\\site", entry: "index.html", revision: "a".repeat(64), site: "site", watch: false },
      { type: "watch", ...run, ...viewing }, { type: "cancel", ...run }, { type: "ping", n: 1 }, { type: "quit" }, { type: "probe", q: "metrics" },
    ],
    child: [
      { type: "ready", versions: { electron: "43" }, rules: "rule", userDataDir: "root", paths: Object.fromEntries(CHILD_PATHS.map((key) => [key, "root"])), canary: "rejected" },
      { type: "fatal", reason: "canary" }, { type: "accepted", ...run }, { type: "rejected", ...run, error: "busy" }, { type: "shown", ...run }, { type: "unknown", ...run },
      { type: "cancelled", ...run, cancelled: true }, { type: "pong", n: 1 }, { type: "muted", muted: true }, { type: "idle" }, { type: "log", level: "info", msg: "fixture" },
      { type: "state", ...run, state: "preparing", counts: null, result: null }, { type: "timing", ...run, name: "first-check", epochMs: 1 }, { type: "probe", q: "counts", data: {} },
    ],
  };
  for (const [direction, frames] of Object.entries(schemas)) for (const frame of frames) {
    expect(validFrame(frame, direction), frame.type).toBe(true);
    expect(validFrame({ ...frame, extra: true }, direction), frame.type).toBe(false);
  }
});

it("caps UTF-8 log bytes and resets the per-run quota", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const lines = [], errors = [];
  output.on("data", (value) => lines.push(value));
  const link = createChildLink({ nonce, direction: "child", input, output, onFrame() {}, onError: (err) => errors.push(err) });
  for (let n = 0; n < 201; n++) link.send({ type: "log", level: "info", msg: "가".repeat(1800) });
  link.send({ type: "accepted", runId: "run-123456" });
  link.send({ type: "log", level: "info", msg: "next run" });
  await new Promise(setImmediate);
  expect(lines).toHaveLength(202); expect(lines.every((line) => line.length <= 2049)).toBe(true);
  expect(link.stats().dropped).toBe(1); expect(errors).toEqual([]); link.close();
});
