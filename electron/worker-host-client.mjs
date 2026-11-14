import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { terminalEnvironment } from "./terminal-host.mjs";
import { holdWorkerHostLock, workerHostLock } from "./worker-host-identity.mjs";
import { WORKER_HOST_PROTOCOL, sameProof, textChunks, workerHostPeer, workerHostProof } from "./worker-host-protocol.mjs";
import { launchWorkerHost } from "./worker-host-runtime.mjs";

const MAX_PANES = 64;
const MAX_OTHER_HOSTS = 2;
const EXITED = "Terminal has exited";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const down = (reason, detail) => Object.assign(new Error(detail), { reason });
const readRecord = async (file) => {
  try { return JSON.parse(await fs.promises.readFile(file, "utf8")); } catch { return null; }
};
// A listener that throws must not tear down the socket every other pane shares.
const fire = (listeners, value) => {
  for (const listener of listeners) {
    try { listener(value); } catch (error) { queueMicrotask(() => { throw error; }); }
  }
};

export function createWorkerHostClient({ root, runtimeRoot = path.join(root, "runtime"), executable = process.execPath, ptyModule, install = path.dirname(executable), adopt = false, platform = process.platform, env = process.env, launch = launchWorkerHost, log = () => {}, answerMs = 2_000, retryMs = 30_000, publishMs = 20_000 }) {
  const slot = path.join(root, `v${WORKER_HOST_PROTOCOL}`);
  const handles = new Map();
  const orphans = new Set();
  const told = new Set();
  let peer = null;
  let host = null;
  let fault = null;
  let connecting = null;
  let retryAt = 0;
  let stalled = false;
  let closed = false;

  const tell = (reason, detail) => {
    if (told.has(reason)) return;
    told.add(reason);
    log(`worker host ${reason} (${detail}): panes open locally`);
  };
  const lost = (connection, detail) => {
    if (peer !== connection) return;
    peer = null;
    host = null;
    stalled = false;
    fault = { reason: "missing", detail };
    if (!closed) tell("missing", detail);
    for (const handle of handles.values()) handle.lost(detail);
    handles.clear();
    orphans.clear();
  };
  const events = {
    ready: ({ id, pid }) => handles.get(id)?.started(pid),
    exit: ({ id, exitCode, error }) => handles.get(id)?.ended(exitCode, error),
    gone({ id }) {
      const handle = handles.get(id);
      if (!handle && !orphans.delete(id)) return;
      handles.delete(id);
      handle?.gone();
      void peer.request("forget", [{ id }]).catch(() => {});
    },
    fenced() {
      const connection = peer;
      retryAt = Infinity;
      lost(connection, "another Wink took over the worker host");
      connection.close();
    },
  };
  // One slow answer sends later panes to the local path at once; a host silent for a whole retry window is dropped.
  const stall = () => {
    if (stalled || !peer) return;
    stalled = true;
    const connection = peer;
    connection.request("list", [], retryMs).then(() => { if (peer === connection) stalled = false; }, () => connection.close());
  };

  const bind = (id, local, begin) => {
    const listeners = { data: new Set(), exit: new Set(), error: new Set() };
    let mode = begin.mode;
    let inner = null;
    let seen = begin.seen;
    // Output in flight from an earlier attach would move `seen` past the replay that follows the reply.
    let replaying = begin.mode === "host";
    let finished = false;
    let timer = null;
    let settle;
    let resolveReady;
    let rejectReady;
    let leave;
    let last = Infinity;
    let caughtUp;
    const replayed = new Promise((resolve) => { caughtUp = resolve; });
    const settled = new Promise((resolve) => { settle = resolve; });
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const exited = new Promise((resolve) => { leave = resolve; });
    ready.catch(() => {});
    const finish = (exitCode, error) => {
      if (finished) return;
      finished = true;
      if (error) fire(listeners.error, new Error(error));
      fire(listeners.exit, { exitCode });
    };
    const fall = (reason, detail) => {
      if (mode) return;
      mode = "local";
      clearTimeout(timer);
      handles.delete(id);
      if (peer) {
        // The host may still start its copy once it catches up; that copy must not run beside the local one.
        orphans.add(id);
        void peer.request("kill", [{ id }], 60_000).catch(() => {});
      }
      tell(reason, detail);
      try {
        inner = local();
        inner.onData((text) => fire(listeners.data, text));
        inner.onExit((event) => { finished = true; fire(listeners.exit, event); });
        inner.onError?.((error) => fire(listeners.error, error));
        Promise.resolve(inner.ready).then(() => { handle.pid = inner.pid; resolveReady(); }, rejectReady);
        void Promise.resolve(inner.exited).then(leave);
      } catch (error) {
        rejectReady(error);
        finish(1, error.message);
        leave();
      }
      settle();
    };
    const hosted = (run) => settled.then(() => {
      if (mode === "local") return inner ? run(inner) : Promise.reject(new Error(EXITED));
      return finished || !peer ? Promise.reject(new Error(EXITED)) : run(null);
    });
    const handle = {
      pid: null,
      onData: (listener) => listeners.data.add(listener),
      onExit: (listener) => listeners.exit.add(listener),
      onError: (listener) => listeners.error.add(listener),
      ready,
      exited,
      write: (input) => hosted((pty) => pty ? pty.write(input) : Promise.all((Buffer.isBuffer(input) ? [input] : textChunks(String(input))).map((chunk) => peer.write(id, chunk))).then(() => undefined)),
      resize: (cols, rows) => hosted((pty) => pty ? pty.resize(cols, rows) : peer.request("resize", [{ id, cols, rows }]).then(() => undefined)),
      kill: () => hosted((pty) => pty ? pty.kill() : peer.request("kill", [{ id }]).then(() => undefined)),
      terminate: () => hosted((pty) => pty ? pty.terminate?.() : peer.request("kill", [{ id, force: true }]).then(() => undefined)).catch(() => {}),
      /** True while the worker host runs this pane, so it can outlive this app. */
      hosted: () => mode === "host" && !finished,
      /** Lets go of a hosted pane without stopping it; false means the pane is local and cannot outlive this app. */
      detach() {
        if (mode !== "host" || finished) return false;
        handles.delete(id);
        leave();
        return true;
      },
    };
    const entry = {
      data(seq, text) {
        if (replaying || seq <= seen) return;
        seen = seq;
        fire(listeners.data, text);
        if (seq >= last) caughtUp();
      },
      replayed,
      // The reply names the last output the pane had made; the replay is over once that has been handed on.
      replays(seq) {
        last = seq;
        if (seen >= last) caughtUp();
      },
      started(pid) {
        if (mode && mode !== begin.mode) return;
        mode = "host";
        replaying = false;
        clearTimeout(timer);
        handle.pid = pid;
        resolveReady();
        settle();
      },
      ended: (exitCode, error) => mode ? finish(exitCode, error) : fall("failed to start a pane", error ?? `exit ${exitCode}`),
      gone: leave,
      lost: (detail) => mode || closed ? entry.failed(new Error(`Worker host lost: ${detail}`)) : fall("not answering", detail),
      fall,
      failed(error) {
        handles.delete(id);
        caughtUp();
        rejectReady(error);
        finish(1, error.message);
        leave();
        settle();
      },
      arm: (ms) => { timer = setTimeout(() => { stall(); fall("not answering", `no answer in ${ms} ms`); }, ms); },
      disarm: () => clearTimeout(timer),
    };
    handles.set(id, entry);
    return handle;
  };

  const open = async (record) => {
    const socket = net.createConnection(record.pipe);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const connection = workerHostPeer(socket, {
      event: (name, value) => { if (peer === connection && Object.hasOwn(events, name)) events[name](value ?? {}); },
      data: (id, seq, text) => handles.get(id)?.data(seq, text),
    });
    try {
      const nonce = randomUUID();
      const hello = await connection.request("hello", [{ protocol: WORKER_HOST_PROTOCOL, nonce }], answerMs);
      if (!sameProof(hello?.proof, workerHostProof(record.secret, "host", nonce, String(hello?.nonce)))) throw down("unknown version", "host proof mismatch");
      const welcome = await connection.request("auth", [{ proof: workerHostProof(record.secret, "client", nonce, hello.nonce), capabilities: adopt ? ["adopt"] : [] }], answerMs);
      socket.on("close", () => lost(connection, "host connection closed"));
      return { connection, welcome };
    } catch (error) {
      connection.close();
      throw error;
    }
  };
  const reach = async (record) => {
    for (let attempt = 0; ; attempt++) {
      try { return await open(record); } catch (error) { if (error.code !== "ENOENT" || attempt === 3) throw error; }
      await wait(50);
    }
  };
  const establish = async () => {
    await fs.promises.mkdir(slot, { recursive: true });
    let launchLock;
    // Probing and launching both happen under this lock, so a probe never collides with a host taking host.lock.
    try { launchLock = holdWorkerHostLock(path.join(slot, "launch.lock")); } catch { throw down("not answering", "another launch is in flight"); }
    try {
      const state = workerHostLock(path.join(slot, "host.lock"));
      if (state === "unknown") throw down("unknown version", "host lock unreadable");
      if (state === "alive") {
        const record = await readRecord(path.join(slot, "host.json"));
        if (record?.protocol !== WORKER_HOST_PROTOCOL || !record.pipe || !record.secret) throw down("unknown version", record ? `protocol ${record.protocol}` : "no host record");
        return await reach(record);
      }
      const slots = await fs.promises.readdir(root, { withFileTypes: true });
      const others = slots.filter((item) => item.isDirectory() && /^v\d+$/.test(item.name) && item.name !== path.basename(slot) && workerHostLock(path.join(root, item.name, "host.lock")) === "alive");
      if (others.length >= MAX_OTHER_HOSTS) throw down("at cap", `${others.length} older hosts still run`);
      const nonce = randomUUID();
      const pipe = `\\\\.\\pipe\\wink-worker-${createHash("sha256").update(path.resolve(slot)).digest("hex").slice(0, 16)}-${nonce}`;
      const began = performance.now();
      const launched = await Promise.resolve().then(() => launch({ root: runtimeRoot, executable, ptyModule: ptyModule(), slot, launch: { nonce, secret: randomBytes(32).toString("hex"), pipe, install }, env: { ...terminalEnvironment(env), ELECTRON_RUN_AS_NODE: "1" } }))
        .catch((error) => { throw down("missing", error.message); });
      for (const deadline = Date.now() + publishMs; Date.now() < deadline; await wait(50)) {
        const record = await readRecord(path.join(slot, "host.json"));
        if (record?.nonce === nonce) return { ...await reach(record), launched: { ms: Math.round(performance.now() - began), staged: launched.staged } };
      }
      throw down("missing", "host did not start");
    } finally {
      fs.closeSync(launchLock);
    }
  };
  const connect = () => {
    if (peer) return Promise.resolve(true);
    if (platform !== "win32" || closed || Date.now() < retryAt) return Promise.resolve(false);
    connecting ??= establish().then(({ connection, welcome, launched = null }) => {
      if (closed) {
        connection.close();
        return false;
      }
      peer = connection;
      fault = null;
      host = { pid: welcome.host, epoch: welcome.epoch, launched };
      log(`worker host ready pid=${welcome.host} ${launched ? `launch=${launched.ms}ms staged=${Object.keys(launched.staged ?? {}).filter((name) => launched.staged[name]).join("+") || "none"}` : "already running"}`);
      return true;
    }, (error) => {
      fault = { reason: error.reason ?? "not answering", detail: error.message };
      tell(fault.reason, fault.detail);
      retryAt = Date.now() + retryMs;
      return false;
    }).finally(() => { connecting = null; });
    return connecting;
  };

  return {
    /** Starts or finds the host in the background; resolves true once connected. */
    prewarm: connect,
    /** A PTY handle when the host can take the pane right now, else null. It never waits for the host. */
    spawn({ id, tag = null, shell, args, options }, local) {
      if (platform !== "win32" || closed) return null;
      if (!peer) void connect();
      if (!peer || stalled || handles.has(id)) return null;
      if (handles.size >= MAX_PANES) {
        tell("at cap", `${MAX_PANES} panes`);
        return null;
      }
      const handle = bind(id, local, { mode: null, seen: 0 });
      const entry = handles.get(id);
      entry.arm(answerMs);
      peer.request("spawn", [{ id, tag, shell, args, cwd: options.cwd, env: options.env, cols: options.cols, rows: options.rows }], 60_000)
        .then(entry.disarm, (error) => entry.fall(error.message === "Worker host is full" ? "at cap" : "failed to start a pane", error.message));
      return handle;
    },
    /** Reattaches a pane the host kept: replays its ring after `fromSeq`, then streams live output. `replayed` settles when the old output is in. */
    attach(id, fromSeq = 0) {
      if (!peer || handles.has(id)) return null;
      const pty = bind(id, null, { mode: "host", seen: fromSeq });
      const entry = handles.get(id);
      const replay = peer.request("attach", [{ id, fromSeq }], 10_000, (reply) => {
        entry.started(reply.pid);
        entry.replays(reply.seq);
      });
      replay.catch(entry.failed);
      return { pty, replay, replayed: entry.replayed };
    },
    /** What an earlier run of the app left: "kept" is a host this app can talk to, "unknown" one it cannot, "none" nothing. */
    left() {
      if (platform !== "win32" || !fs.existsSync(root)) return "none";
      const alive = (name) => fs.existsSync(path.join(root, name)) && workerHostLock(path.join(root, name, "host.lock"));
      const own = alive(path.basename(slot));
      if (own === "alive") return "kept";
      return own === "unknown" || fs.readdirSync(root).some((name) => /^v\d+$/.test(name) && name !== path.basename(slot) && alive(name) === "alive") ? "unknown" : "none";
    },
    panes: () => peer ? peer.request("list") : Promise.resolve([]),
    /** Ends a kept pane nobody will take back: stops it if it still runs, then has the host forget it. */
    drop(id) {
      if (!peer || handles.has(id)) return;
      const connection = peer;
      orphans.add(id);
      void connection.request("kill", [{ id }], 60_000).then(() => connection.request("forget", [{ id }])).then(() => orphans.delete(id), () => {});
    },
    state: () => ({ connected: Boolean(peer), stalled, fault, host, panes: handles.size }),
    close() {
      closed = true;
      const connection = peer;
      if (connection) lost(connection, "client closed");
      connection?.close();
    },
  };
}
