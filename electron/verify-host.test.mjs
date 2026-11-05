import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: {}, screen: {} }));
import { createVerifyHost } from "./verify-host.mjs";
import { CHILD_PATHS, createChildLink, RESOLVER_RULES } from "./verify-child-link.mjs";

const hosts = [];
const roots = [];
const counts = { planned: 1, completed: 1, passed: 1, failed: 0, blocked: 0, notRun: 0 };
const input = (runId = "run-123456") => ({ runId, botId: "bot-1", root: "C:\\site", entry: "index.html", revision: "a".repeat(64), site: "site", watch: false });
afterEach(async () => { vi.useRealTimers(); for (const host of hosts.splice(0)) await host.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function pair() {
  let a, b;
  a = new Duplex({ read() {}, write(chunk, _encoding, done) { b.push(chunk); done(); } });
  b = new Duplex({ read() {}, write(chunk, _encoding, done) { a.push(chunk); done(); } });
  return [a, b];
}

function fixture({ ready = true, respond = true, probe = null, packaged = true } = {}) {
  const scratch = path.join(os.tmpdir(), "wink-lv0-host"); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(scratch, "supervisor-test-"))); roots.push(root);
  const calls = [], frames = [], children = [], links = [], raws = [];
  const controls = { pong: true, quit: true, cancel: true, watch: true };
  let server;
  const host = createVerifyHost({ probe: probe ? { root, ...probe } : null, dependencies: {
    app: { isPackaged: packaged, getPath: () => root, getLocale: () => "ko-KR" },
    BrowserWindow: { getFocusedWindow: () => null }, screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    tmpdir: root, now: () => Date.now(), env: { SYSTEMROOT: "C:\\Windows", PATH: "system", OMB_SECRET: "secret", NODE_OPTIONS: "bad", ELECTRON_RUN_AS_NODE: "1", PROVIDER_KEY: "secret" },
    setPriority: (...args) => calls.push(["priority", ...args]),
    createServer() { server = new EventEmitter(); server.listen = (_name, cb) => cb(); server.close = () => {}; return server; },
    execFile(exe, args, options, callback) { calls.push([exe, args]); callback(); },
    spawn(exe, args, options) {
      calls.push(["spawn", exe, args, options]);
      const child = Object.assign(new EventEmitter(), { pid: 1000 + children.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { calls.push(["kill"]); child.emit("exit", 1); } });
      children.push(child);
      const [parent, remote] = pair();
      const nonce = options.env.ORBIT_VERIFY_CHILD;
      raws.push((frame) => remote.write(`lv0:${nonce}:${JSON.stringify(frame)}\n`));
      const link = createChildLink({ nonce, direction: "child", input: remote, output: remote, onError: (e) => { throw e; }, onFrame(frame) {
        frames.push(frame);
        if (frame.type === "hello" && ready) link.send({ type: "ready", versions: { electron: "43" }, rules: RESOLVER_RULES, userDataDir: path.join(options.cwd, "userData"), paths: Object.fromEntries(CHILD_PATHS.map((name) => [name, path.join(options.cwd, name)])), canary: "rejected" });
        if (frame.type === "start" && respond) link.send({ type: "accepted", runId: frame.runId });
        if (frame.type === "ping" && respond && controls.pong) link.send({ type: "pong", n: frame.n });
        if (frame.type === "quit" && respond && controls.quit) queueMicrotask(() => child.emit("exit", 0));
        if (frame.type === "cancel" && respond && controls.cancel) link.send({ type: "cancelled", runId: frame.runId, cancelled: true });
        if (frame.type === "watch" && respond && controls.watch) link.send({ type: "shown", runId: frame.runId });
      } });
      links.push(link);
      queueMicrotask(() => server.emit("connection", parent));
      return child;
    },
  } });
  hosts.push(host);
  return { host, root, calls, frames, children, links, controls, send: (frame) => links.at(-1).send(frame), raw: (frame) => raws.at(-1)(frame) };
}

async function until(check) { for (let n = 0; n < 200; n++) { if (check()) return; await delay(10); } throw new Error("Fixture did not settle"); }

it("reserves before spawn, starts lazily, scrubs env and pins production argv", async () => {
  const f = fixture();
  expect(f.calls).toEqual([]);
  expect(f.host.start(input())).toEqual({ runId: input().runId });
  expect((await f.host.poll(input().runId)).state).toBe("preparing");
  expect(() => f.host.start(input("run-234567"))).toThrow("busy");
  await until(() => f.frames.some((v) => v.type === "start"));
  const spawn = f.calls.find((v) => v[0] === "spawn");
  expect(spawn[2]).toEqual(["--orbit-verify-child", `--host-resolver-rules=${RESOLVER_RULES}`, `--user-data-dir=${path.join(spawn[3].cwd, "userData")}`]);
  expect(spawn[3]).not.toHaveProperty("windowsHide");
  expect(Object.keys(spawn[3].env).sort()).toEqual(["APPDATA", "HOME", "LOCALAPPDATA", "ORBIT_VERIFY_CHILD", "ORBIT_VERIFY_ROOT", "PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"].sort());
  expect(f.frames.find((v) => v.type === "start").locale).toBe("ko");
});

it("mirrors once per changing frame, long polls and reuses a live child", async () => {
  const f = fixture(); f.host.start(input());
  await until(() => f.frames.some((v) => v.type === "start"));
  const state = { type: "state", runId: input().runId, state: "running", counts, result: null };
  const pending = f.host.poll(input().runId, { since: 1, waitMs: 25000 });
  f.send(state);
  expect((await pending).revision).toBe(2);
  f.send(state);
  expect((await f.host.poll(input().runId)).revision).toBe(2);
  f.send({ ...state, state: "completed", result: { v: 1, runId: input().runId, site: "site", counts, issues: [], issueTotal: 0, durationMs: 1 } });
  await new Promise(setImmediate);
  expect((await f.host.poll(input().runId)).state).toBe("completed");
  await expect(f.host.watch(input().runId)).rejects.toMatchObject({ status: 404 });
  f.host.start(input("run-234567"));
  await until(() => f.frames.filter((v) => v.type === "start").length === 2);
  expect(f.children).toHaveLength(1);
});

it.each([[false, true, "internal", 10001], [true, false, "internal", 5001]])("kills a child with no ready or no ack", async (ready, respond, code, ms) => {
  const f = fixture({ ready, respond });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); f.host.start(input());
  await until(() => f.frames.some((v) => v.type === (ready ? "start" : "hello")));
  await vi.advanceTimersByTimeAsync(ms);
  await until(() => f.calls.some((v) => v[0] === "kill"));
  expect((await f.host.poll(input().runId)).errorCode).toBe(code);
  expect(f.calls.map((v) => v[0]).slice(-2)).toEqual(["taskkill", "kill"]);
});

it("maps attestation failure, exit and malformed frames to blocked", async () => {
  for (const kind of ["fatal", "exit", "bad"]) {
    const f = fixture(); f.host.start(input());
    await until(() => f.frames.some((v) => v.type === "start"));
    if (kind === "fatal") f.send({ type: "fatal", reason: "canary" });
    if (kind === "exit") f.children[0].emit("exit", 1);
    if (kind === "bad") f.raw({ type: "unknown-frame" });
    await until(() => f.calls.some((v) => v[0] === "kill") || kind === "exit");
    expect((await f.host.poll(input().runId)).errorCode).toBe(kind === "fatal" ? "isolation-failed" : "internal");
  }
});

it("adds only probe flags and quits on idle", async () => {
  const f = fixture({ probe: { scale: 1.5 }, packaged: false }); f.host.start(input());
  await until(() => f.frames.some((v) => v.type === "start"));
  const args = f.calls.find((v) => v[0] === "spawn")[2];
  expect(args[0].replaceAll("\\", "/")).toContain("/lv0-host/");
  expect(args).toContain("--mute-audio"); expect(args).toContain("--force-device-scale-factor=1.5");
  f.send({ type: "idle" });
  await until(() => f.frames.some((v) => v.type === "quit"));
});

it("cancels before ready without leaving an idle child", async () => {
  const f = fixture(); f.host.start(input());
  expect(await f.host.cancel(input().runId)).toEqual({ cancelled: true });
  await until(() => f.frames.some((v) => v.type === "quit"));
  expect(f.frames.some((v) => v.type === "start")).toBe(false);
  expect((await f.host.poll(input().runId)).errorCode).toBe("cancelled");
});

it("waits for a known preparing run before Watch", async () => {
  const f = fixture(); f.host.start(input());
  await expect(f.host.watch(input().runId)).resolves.toEqual({ shown: true });
  expect(f.frames.filter((v) => ["start", "watch"].includes(v.type)).map((v) => v.type)).toEqual(["start", "watch"]);
});

it("sweeps stale roots and kills a live child after missed pongs", async () => {
  const f = fixture();
  const base = path.join(f.root, "orbit-verify-" + createHash("sha256").update(f.root).digest("hex").slice(0, 8));
  const stale = path.join(base, "stale-123"); fs.mkdirSync(stale, { recursive: true }); fs.writeFileSync(path.join(stale, "old"), "fixture");
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  f.host.start(input()); await until(() => f.frames.some((v) => v.type === "start"));
  expect(fs.existsSync(stale)).toBe(false);
  f.controls.pong = false;
  await vi.advanceTimersByTimeAsync(12001);
  expect((await f.host.poll(input().runId)).errorCode).toBe("internal");
  expect(f.calls.map((v) => v[0]).slice(-2)).toEqual(["taskkill", "kill"]);
});

it("bounds close for an unresponsive child and kills a malformed result", async () => {
  const f = fixture(); f.host.start(input()); await until(() => f.frames.some((v) => v.type === "start"));
  f.controls.quit = false;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const started = Date.now(); const closing = f.host.close();
  await vi.advanceTimersByTimeAsync(1401); await closing;
  expect(Date.now() - started).toBeLessThanOrEqual(1500);
  expect((await f.host.poll(input().runId)).errorCode).toBe("cancelled");
  vi.useRealTimers();
  const g = fixture(); g.host.start(input()); await until(() => g.frames.some((v) => v.type === "start"));
  g.raw({ type: "state", runId: input().runId, state: "completed", counts: { ...counts, passed: -1 }, result: null });
  await until(() => g.calls.some((v) => v[0] === "kill"));
  expect((await g.host.poll(input().runId)).errorCode).toBe("internal");
});
