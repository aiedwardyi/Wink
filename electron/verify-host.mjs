import { app, BrowserWindow, screen } from "electron";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPreference, resolveLocale } from "./i18n.mjs";
import { activeVerifyProbe, registerVerifyProbe } from "./verify-probe-bootstrap.mjs";
import { CHILD_PATHS, createChildLink, RESOLVER_RULES, SYSTEM_ENV } from "./verify-child-link.mjs";
import { VERIFY_POLL_MAX_MS } from "./verify-protocol.mjs";
import { createCastStream } from "./verify-stream.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const zero = () => ({ planned: 0, completed: 0, passed: 0, failed: 0, blocked: 0, notRun: 0 });
const terminal = (v) => v.state === "completed" || v.state === "blocked";
const fault = (error, status = 500) => Object.assign(new Error(error), { error, status });

export function createVerifyHost({ log = () => {}, probe = activeVerifyProbe(), dependencies = {} } = {}) {
  const d = { app, BrowserWindow, screen, spawn, execFile, createServer, setPriority: os.setPriority, env: process.env, tmpdir: os.tmpdir(), now: Date.now, ...dependencies };
  const runs = new Map();
  const waiters = new Set();
  let current;
  let active;
  let muted = false;
  let closed = false;
  let closing;
  let generation = 0;
  function publish() { for (const wake of [...waiters]) wake(); }
  function markBlocked(record, errorCode) {
    if (!record || terminal(record.state)) return;
    const counts = record.state.counts ?? zero();
    record.state = { runId: record.input.runId, revision: record.state.revision + 1, state: "blocked", counts, result: { v: 1, runId: record.input.runId, site: record.input.site, counts, issues: [], issueTotal: 0, durationMs: Math.max(0, d.now() - record.started), errorCode }, errorCode };
    record.cast.finish(record.state.result);
    if (active === record) active = null;
    publish();
  }
  function inputs() {
    const focused = d.BrowserWindow.getFocusedWindow();
    const display = focused && !focused.isDestroyed() ? d.screen.getDisplayMatching(focused.getBounds()) : d.screen.getDisplayNearestPoint(d.screen.getCursorScreenPoint());
    return { locale: resolveLocale(readPreference(d.app.getPath("userData")), d.app.getLocale()), muted, display: { ...display.workArea } };
  }
  async function removeRoot(root) {
    for (let n = 0; n < 5; n++) {
      try { await fs.rm(root, { recursive: true, force: true }); return; }
      catch { if (n < 4) await new Promise((resolve) => setTimeout(resolve, 200)); }
    }
    log("verify scratch cleanup deferred");
  }
  function stopTimers(c) {
    clearTimeout(c.readyTimer); clearTimeout(c.quitTimer); clearInterval(c.pingTimer);
    for (const ack of c.acks.values()) { clearTimeout(ack.timer); ack.reject(fault("internal")); }
    c.acks.clear();
  }
  function quit(c) {
    if (c.quitting) return;
    c.quitting = true;
    clearInterval(c.pingTimer);
    c.link?.send({ type: "quit" });
  }
  async function kill(c, code = "internal") {
    if (c.killing) return c.killing;
    c.dead = true;
    if (current === c) current = null;
    markBlocked(active?.child === c ? active : null, code);
    c.rejectReady(fault(code));
    stopTimers(c);
    c.killing = (async () => {
      if (c.proc?.pid && !c.exited) {
        await new Promise((resolve) => { try { d.execFile("taskkill", ["/PID", String(c.proc.pid), "/T", "/F"], { windowsHide: true, timeout: 1000 }, () => resolve()); } catch { resolve(); } });
        try { c.proc.kill(); } catch {}
      }
      c.socket?.destroy();
      c.server?.close();
    })();
    return c.killing;
  }
  function ack(c, frame, expected, ms = 5000) {
    const key = `${expected}:${frame.runId ?? JSON.stringify(frame.q)}`;
    if (c.acks.has(key)) return c.acks.get(key).promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => { void kill(c, frame.type === "cancel" ? "cancelled" : "internal"); }, ms);
    c.acks.set(key, { resolve, reject, promise, timer });
    if (!c.link.send(frame)) void kill(c);
    return promise;
  }
  function receive(c, frame) {
    if (c.dead || current !== c) return;
    if (frame.type === "ready") {
      if (c.ready || frame.rules !== RESOLVER_RULES || frame.userDataDir !== path.join(c.root, "userData") || CHILD_PATHS.some((name) => frame.paths[name] !== path.join(c.root, name))) return void kill(c, "isolation-failed");
      c.ready = true;
      clearTimeout(c.readyTimer);
      c.readyMs = d.now() - c.spawned;
      c.resolveReady();
      return;
    }
    if (frame.type === "fatal") return void kill(c, "isolation-failed");
    if (frame.type === "pong") { if (frame.n <= c.ping && frame.n > c.lastPong) { c.lastPong = frame.n; c.pongAt = d.now(); } return; }
    if (frame.type === "muted") { muted = frame.muted; return; }
    if (frame.type === "idle") {
      c.idle = true; quit(c);
      c.quitTimer = setTimeout(() => void kill(c), 1500);
      return;
    }
    if (frame.type === "state") {
      const record = runs.get(frame.runId);
      if (!record || record.child !== c || terminal(record.state)) return void kill(c);
      if (frame.result && frame.result.site !== record.input.site) return void kill(c);
      const { type: _type, ...value } = frame;
      const before = { ...record.state }; delete before.revision;
      if (JSON.stringify(before) !== JSON.stringify(value)) {
        record.state = { ...value, revision: record.state.revision + 1 };
        if (terminal(value)) record.cast.finish(value.result);
        if (terminal(value) && active === record) active = null;
        publish();
      }
      return;
    }
    if (frame.type === "cast" || frame.type === "mark") {
      const record = runs.get(frame.runId);
      if (!record || record.child !== c || terminal(record.state)) return;
      if (frame.type === "cast") record.cast.frame(frame);
      else record.cast.mark(frame.event);
      return;
    }
    if (frame.type === "timing") { if (probe) log(`verify timing ${frame.name} ${frame.epochMs}`); return; }
    const expected = { rejected: "accepted", unknown: "shown" }[frame.type] ?? frame.type;
    if (frame.type === "accepted") c.stdoutLink?.resetLogs();
    const key = `${expected}:${frame.runId ?? JSON.stringify(frame.q)}`;
    const pending = c.acks.get(key);
    if (!pending) return void kill(c);
    clearTimeout(pending.timer); c.acks.delete(key);
    if (frame.type === "rejected") pending.reject(fault(frame.error, frame.error === "busy" ? 409 : 500));
    else if (frame.type === "unknown") pending.reject(fault("not-found", 404));
    else pending.resolve(frame);
  }
  async function ensureChild() {
    if (current?.idle && !current.exited) await current.exitPromise;
    if (current && !current.dead && !current.idle) { const live = current; return live.readyPromise.then(() => live); }
    const c = { generation: ++generation, acks: new Map(), ping: 0, lastPong: -1, pongAt: d.now(), stderr: Buffer.alloc(0), ready: false, dead: false };
    current = c;
    c.readyPromise = new Promise((resolve, reject) => { c.resolveReady = resolve; c.rejectReady = reject; });
    c.readyPromise.catch(() => {});
    try {
      const userData = d.app.getPath("userData");
      const hash = createHash("sha256").update(userData).digest("hex").slice(0, 8);
      const base = path.join(probe?.root ?? d.tmpdir, `orbit-verify-${hash}`);
      await fs.mkdir(base, { recursive: true });
      for (const entry of await fs.readdir(base, { withFileTypes: true })) if (entry.isDirectory() && /^[a-zA-Z0-9_-]{6,64}$/.test(entry.name)) await removeRoot(path.join(base, entry.name));
      c.root = await fs.mkdtemp(path.join(base, "child-"));
      const nonce = randomBytes(24).toString("hex");
      const env = Object.fromEntries(Object.entries(d.env).filter(([name]) => SYSTEM_ENV.includes(name.toUpperCase())));
      for (const [name, directory] of Object.entries({ HOME: "home", USERPROFILE: "home", APPDATA: "appData", LOCALAPPDATA: "appData", TEMP: "temp", TMP: "temp" })) { env[name] = path.join(c.root, directory); await fs.mkdir(env[name], { recursive: true }); }
      Object.assign(env, { ORBIT_VERIFY_CHILD: nonce, ORBIT_VERIFY_ROOT: c.root });
      c.server = d.createServer();
      await new Promise((resolve, reject) => { c.server.once("error", reject); c.server.listen(`\\\\.\\pipe\\orbit-verify-${nonce}`, resolve); });
      c.server.on("error", () => void kill(c));
      c.server.on("connection", (socket) => {
        if (c.socket || c.dead) { socket.destroy(); return; }
        c.socket = socket;
        c.server.close();
        c.link = createChildLink({ nonce, direction: "parent", input: socket, output: socket, onFrame: (f) => receive(c, f), onError: (err) => { log(`verify transport: ${err.message}`); void kill(c); }, onLog: (s) => log(s) });
        socket.once("end", () => { if (!c.exited && !c.idle && !closed) void kill(c); });
        c.link.send({ type: "hello", v: 1, nonce, parentPid: process.pid, probe: !!probe, probeRoot: probe?.root ?? null });
      });
      const args = d.app.isPackaged ? [] : [repo];
      if (probe?.appPath) args.splice(0, args.length, probe.appPath);
      if (probe?.exe && !probe.appPath) args.length = 0;
      args.push("--headless", "--mute-audio", "--orbit-verify-child", `--host-resolver-rules=${RESOLVER_RULES}`, `--user-data-dir=${path.join(c.root, "userData")}`);
      if (probe) {
        args.push("--mute-audio", "--remote-debugging-port=0", `--log-net-log=${path.join(c.root, "net.json")}`);
        if (probe.scale != null) args.push(`--force-device-scale-factor=${probe.scale}`);
      }
      if (closed) throw fault("cancelled");
      c.spawned = d.now();
      c.proc = d.spawn(probe?.exe ?? process.execPath, args, { cwd: c.root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      c.proc.stdin.on("error", () => {});
      c.stdoutLink = createChildLink({ nonce, direction: "parent", input: c.proc.stdout, output: c.proc.stdin, onFrame: () => void kill(c), onError: () => void kill(c), onLog: (msg) => log(msg) });
      c.proc.stderr.on("data", (bytes) => { c.stderr = Buffer.concat([c.stderr, bytes]).subarray(-16384); });
      c.proc.on("error", () => void kill(c));
      c.exitPromise = new Promise((resolve) => c.proc.once("exit", (code) => {
        if (!closed && !c.idle) log(`verify child exited ${code}`);
        c.exited = true;
        c.dead = true;
        if (current === c) current = null;
        stopTimers(c);
        c.rejectReady(fault(code === 3 ? "isolation-failed" : "internal"));
        markBlocked(active?.child === c ? active : null, closed ? "cancelled" : code === 3 ? "isolation-failed" : "internal");
        c.link?.close(); c.stdoutLink.close(); c.socket?.destroy(); c.server.close();
        resolve();
        void (async () => {
          if (probe) await fs.copyFile(path.join(c.root, "net.json"), path.join(probe.root, `child-net-${c.generation}.json`)).catch(() => {});
          await removeRoot(c.root);
        })();
      }));
      if (c.proc.pid) d.setPriority(c.proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      c.readyTimer = setTimeout(() => void kill(c), 10000);
      c.pingTimer = setInterval(() => {
        if (d.now() - c.pongAt >= 10000) return void kill(c);
        c.link?.send({ type: "ping", n: ++c.ping });
      }, 2000);
      await c.readyPromise;
      return c;
    } catch (error) {
      await kill(c, error.error === "cancelled" ? "cancelled" : "internal");
      if (!c.proc && c.root) await removeRoot(c.root);
      throw error;
    }
  }
  function start(input) {
    if (closed) throw fault("internal");
    if (active) throw fault("busy", 409);
    for (const [id, record] of runs) if (terminal(record.state) && d.now() - record.started > 230000) runs.delete(id);
    const record = { input, started: d.now(), watched: input.watch, state: { runId: input.runId, revision: 1, state: "preparing", counts: null, result: null } };
    record.cast = createCastStream(input, record.started);
    runs.set(input.runId, record); active = record;
    record.starting = (async () => {
      try {
        const c = await ensureChild(); record.child = c;
        if (terminal(record.state)) {
          if (!active && ![...runs.values()].some((previous) => previous !== record && previous.child === c && previous.watched && terminal(previous.state))) {
            c.idle = true; quit(c); c.quitTimer = setTimeout(() => void kill(c), 1500);
          }
          return;
        }
        await ack(c, { type: "start", ...input, ...inputs(), ...(d.recording === false ? { recording: false } : {}) }, "accepted");
      } catch (error) { markBlocked(record, error.error === "isolation-failed" ? "isolation-failed" : "internal"); }
    })();
    return { runId: input.runId };
  }
  async function poll(runId, { since = -1, waitMs = 0 } = {}) {
    const record = runs.get(runId);
    if (!record) throw fault("not-found", 404);
    if (record.state.revision === since && !closed && waitMs > 0) {
      await new Promise((resolve) => {
        const wake = () => { if (record.state.revision === since && !closed) return; clearTimeout(timer); waiters.delete(wake); resolve(); };
        const timer = setTimeout(() => { waiters.delete(wake); resolve(); }, Math.min(waitMs, VERIFY_POLL_MAX_MS));
        waiters.add(wake);
      });
    }
    return structuredClone(record.state);
  }
  async function watch(runId) {
    const record = runs.get(runId);
    if (record && !record.child && !terminal(record.state)) await record.starting;
    if (!record || !record.child || record.child !== current || record.child.dead || record.child.idle || terminal(record.state) && !record.watched) throw fault("not-found", 404);
    await ack(record.child, { type: "watch", runId, ...inputs() }, "shown");
    record.watched = true;
    return { shown: true };
  }
  async function cancel(runId) {
    const record = runs.get(runId);
    if (!record || terminal(record.state)) return { cancelled: false };
    if (!record.child) { markBlocked(record, "cancelled"); return { cancelled: true }; }
    try { return { cancelled: (await ack(record.child, { type: "cancel", runId }, "cancelled")).cancelled }; }
    catch { markBlocked(record, "cancelled"); return { cancelled: true }; }
  }
  function close() {
    return closing ??= (async () => {
      closed = true; publish(); markBlocked(active, "cancelled");
      const c = current;
      if (!c) return;
      quit(c);
      let timer;
      await Promise.race([c.exitPromise ?? Promise.resolve(), new Promise((resolve) => { timer = setTimeout(resolve, 1400); })]);
      clearTimeout(timer);
      if (!c.exited) void kill(c, "cancelled");
    })().catch(() => {});
  }
  const probeQuery = async (q) => {
    if (!probe || !current?.ready) throw fault("not-found", 404);
    return (await ack(current, { type: "probe", q }, "probe")).data;
  };
  if (probe) registerVerifyProbe(probeQuery, () => current ? { pid: current.proc?.pid, root: current.root, readyMs: current.readyMs, transport: "pipe" } : null);
  function cast(runId, res) {
    const record = runs.get(runId);
    if (!record) throw fault("not-found", 404);
    record.cast.open(res);
  }
  return { start, poll, cast, watch, cancel, quit: close, close, ...(probe ? { probe: probeQuery, child: () => current ? { pid: current.proc?.pid, root: current.root, readyMs: current.readyMs, transport: "pipe" } : null } : {}) };
}
