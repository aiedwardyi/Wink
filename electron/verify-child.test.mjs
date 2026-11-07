import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, dialog: {}, session: {} }));
import { bootVerifyChild, validateChildLaunch, watchdogSource } from "./verify-child.mjs";
import { CHILD_PATHS, RESOLVER_RULES } from "./verify-child-link.mjs";

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.useRealTimers(); });
function fixture() {
  const scratch = path.join(os.tmpdir(), "wink-lv0-host"); fs.mkdirSync(scratch, { recursive: true });
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(scratch, "child-test-")));
  cleanup.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "orbit-verify-1234abcd", "child-123456");
  const nonce = "a".repeat(48);
  const env = { ORBIT_VERIFY_ROOT: root, ORBIT_VERIFY_CHILD: nonce };
  for (const [key, name] of Object.entries({ HOME: "home", USERPROFILE: "home", APPDATA: "appData", LOCALAPPDATA: "appData", TEMP: "temp", TMP: "temp" })) env[key] = path.join(root, name);
  const paths = {};
  const app = Object.assign(new EventEmitter(), {
    commandLine: { getSwitchValue: (key) => key === "host-resolver-rules" ? RESOLVER_RULES : path.join(root, "userData") },
    setPath: vi.fn((name, value) => { paths[name] = value; }), getPath: (name) => paths[name], whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: vi.fn(), setAppUserModelId: vi.fn(), setAsDefaultProtocolClient: vi.fn(),
  });
  const session = { fromPartition: vi.fn(() => ({ resolveHost: () => Promise.reject(new Error("NOTFOUND")), closeAllConnections: async () => {} })) };
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const frames = [];
  stdout.on("data", (bytes) => { for (const line of bytes.toString().trim().split("\n")) frames.push(JSON.parse(line.slice(53))); });
  const exit = vi.fn();
  const dog = Object.assign(new EventEmitter(), { postMessage() {}, terminate: async () => {} });
  const options = { app, session, stdin, stdout, stderr, env, argv: ["--orbit-verify-child"], priority: vi.fn(), worker: () => dog, exit };
  return { options, frames, paths, nonce, root, hello: () => stdin.write(`lv0:${nonce}:${JSON.stringify({ type: "hello", v: 1, nonce, parentPid: 42, probe: false, probeRoot: null })}\n`) };
}

it("rejects bad markers, switches, environment and root before setPath", () => {
  for (const mutate of [(f) => { f.options.env.ORBIT_VERIFY_CHILD = "bad"; }, (f) => { f.options.env.ORBIT_VERIFY_ROOT = "C:relative"; }, (f) => { f.options.env.OMB_TOKEN = "fake"; }, (f) => { f.options.app.commandLine.getSwitchValue = () => "bad"; }]) {
    const f = fixture(); mutate(f);
    expect(() => validateChildLaunch({ ...f.options, commandLine: f.options.app.commandLine })).toThrow();
    const boot = bootVerifyChild(f.options); cleanup.unshift(() => boot.dispose());
    expect(f.options.exit).toHaveBeenCalledWith(3);
    expect(f.options.app.setPath).not.toHaveBeenCalled();
  }
});

it("sets all paths, attests after hello, and never claims Wink identity", async () => {
  const f = fixture(); const boot = bootVerifyChild(f.options); cleanup.unshift(() => boot.dispose());
  expect(Object.keys(f.paths)).toEqual(CHILD_PATHS);
  f.hello(); await new Promise(setImmediate);
  expect(f.frames[0]).toMatchObject({ type: "ready", rules: RESOLVER_RULES, canary: "rejected" });
  expect(f.options.app.requestSingleInstanceLock).not.toHaveBeenCalled();
  expect(f.options.app.setAppUserModelId).not.toHaveBeenCalled();
  expect(f.options.app.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  f.options.stdin.end(); await new Promise(setImmediate);
  expect(f.options.exit).toHaveBeenCalledWith(0);
});

it("fails a resolving canary and a missing hello", async () => {
  const f = fixture(); f.options.session.fromPartition = () => ({ resolveHost: async () => ({}), closeAllConnections: async () => {} });
  vi.useFakeTimers(); const boot = bootVerifyChild(f.options); cleanup.unshift(() => boot.dispose());
  f.hello(); await vi.advanceTimersByTimeAsync(25);
  expect(f.frames).toContainEqual({ type: "fatal", reason: "Resolver canary resolved" });
  expect(f.options.exit).toHaveBeenCalledWith(3);
  const g = fixture(); const pending = bootVerifyChild(g.options); cleanup.unshift(() => pending.dispose());
  await vi.advanceTimersByTimeAsync(5025);
  expect(g.frames).toContainEqual({ type: "fatal", reason: "Hello timeout" });
});

it("watchdog kills on a dead parent or a silent main thread", () => {
  for (const dead of [true, false]) {
    let tick, now = 0;
    const calls = [];
    vm.runInNewContext(watchdogSource, { require: () => ({ parentPort: { on() {} }, workerData: { ppid: 7 } }), Date: { now: () => now }, setInterval: (fn) => { tick = fn; }, process: { pid: 8, kill(pid, signal) { calls.push([pid, signal]); if (dead && pid === 7) throw new Error("gone"); } } });
    now = dead ? 1000 : 30001; tick();
    expect(calls).toEqual([[7, 0], [8, undefined]]);
  }
});
