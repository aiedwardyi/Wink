import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnTerminalPty } from "./terminal-pty.mjs";
import { holdWorkerHostLock, workerHostRecord, writeWorkerHostRecord } from "./worker-host-identity.mjs";
import { WORKER_HOST_PROTOCOL, sameProof, textChunks, workerHostPeer, workerHostProof } from "./worker-host-protocol.mjs";

const RING_BYTES = 256 * 1024;
const MAX_PANES = 64;
const MAX_UNAUTHENTICATED = 4;
const AUTH_MS = 5_000;
const KILL_MS = 5_000;
const LOG_BYTES = 1024 * 1024;
const MARK = /\x1b\]133;([CD])((?:;[^\x07\x1b]{0,200})?)(?:\x07|\x1b\\)/g;

const slot = process.argv[2];
const file = (name) => path.join(slot, name);
const log = (error) => {
  try {
    if (fs.statSync(file("host-errors.log"), { throwIfNoEntry: false })?.size > LOG_BYTES) fs.truncateSync(file("host-errors.log"));
    fs.appendFileSync(file("host-errors.log"), `${new Date().toISOString()} ${error?.stack ?? error}\n`);
  } catch {}
};
const refuse = (reason) => {
  log(reason);
  process.exit(1);
};
process.on("uncaughtException", log);
process.on("unhandledRejection", log);

const config = workerHostRecord(file("launch.json"));
if (!config?.nonce || !config.secret || !config.pipe || !config.ptyModule) refuse("Missing worker host launch record");
const self = fileURLToPath(import.meta.url);
const within = (target, folder) => {
  const relative = path.relative(folder, target);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
};
// An update replaces the app folder while this host is still running.
if (config.install && [process.execPath, self, config.ptyModule].some((target) => within(target, config.install))) refuse("Worker host runtime is inside the app folder");
try { holdWorkerHostLock(file("host.lock")); } catch { refuse("Another worker host holds this slot"); }
// An open file keeps this layer from being renamed away while panes still start from it.
fs.openSync(self, "r");

const panes = new Map();
let controller = null;
let epoch = 0;
let unauthenticated = 0;
let greeted = false;
let exitTimer = null;
let stopTail = Promise.resolve();

const describe = (pane) => ({ id: pane.id, pid: pane.pid, start: pane.start, ready: pane.ready, cols: pane.cols, rows: pane.rows, seq: pane.seq, bytes: pane.bytes, exit: pane.exit, mark: pane.mark, input: pane.input, output: pane.output, tag: pane.tag });
const persist = () => {
  try {
    writeWorkerHostRecord(file("panes.json"), { host: process.pid, nonce: config.nonce, panes: [...panes.values()].map(({ id, pid, start, ready, exit, tag }) => ({ id, pid, start, ready, exit, tag })) });
  } catch (error) {
    log(error);
  }
};
const notify = (name, value) => {
  try { controller?.peer.emit(name, value); } catch {}
};
const settle = () => {
  clearTimeout(exitTimer);
  exitTimer = null;
  if (controller) return;
  const live = [...panes.values()].filter((pane) => !pane.gone);
  // An app in the middle of its hello must not find the host gone.
  if (!live.length) exitTimer = setTimeout(() => unauthenticated ? settle() : process.exit(0), greeted ? 500 : 30_000);
  // A shell that ignores its kill must not hold up a host nobody can reach.
  else if (live.every((pane) => pane.doomed)) exitTimer = setTimeout(() => process.exit(0), 10_000);
};
const find = (id) => {
  const pane = panes.get(id);
  if (!pane || pane.doomed) throw new Error("Unknown pane");
  return pane;
};
const send = (pane, seq, bytes) => {
  try { controller.peer.data(pane.id, seq, bytes); } catch {}
};
const record = (pane, text) => {
  pane.output = Date.now();
  const source = pane.carry + text;
  let last = null;
  for (const match of source.matchAll(MARK)) last = match;
  if (last) pane.mark = { kind: last[1], value: last[2].slice(1), at: pane.output };
  const open = source.lastIndexOf("\x1b]");
  pane.carry = open >= (last ? last.index + last[0].length : 0) && source.length - open <= 256 ? source.slice(open) : source.endsWith("\x1b") ? "\x1b" : "";
  for (const chunk of textChunks(text)) {
    const bytes = Buffer.from(chunk);
    pane.ring.push({ seq: ++pane.seq, bytes });
    pane.bytes += bytes.length;
    while (pane.bytes > RING_BYTES && pane.ring.length - pane.head > 1) pane.bytes -= pane.ring[pane.head++].bytes.length;
    if (pane.head > 1024) {
      pane.ring.splice(0, pane.head);
      pane.head = 0;
    }
    if (pane.attached) send(pane, pane.seq, bytes);
  }
};
// conpty.node edits one unlocked process-wide pty list on every shell exit, so panes stop one at a time.
const stop = (pane) => {
  stopTail = stopTail.then(async () => {
    // ConPTY aborts the whole process when a pane is killed while it is still starting.
    await pane.pty.ready.catch(() => {});
    if (pane.exit === null) await Promise.race([pane.pty.kill(), new Promise((resolve) => setTimeout(resolve, KILL_MS))]);
  }).catch(() => {});
  return stopTail;
};
const clear = () => {
  for (const pane of panes.values()) {
    if (pane.gone) panes.delete(pane.id);
    else if (!pane.doomed) {
      pane.doomed = true;
      void stop(pane);
    }
  }
  persist();
};
const release = (connection) => {
  if (controller !== connection) return;
  controller = null;
  for (const pane of panes.values()) pane.attached = false;
  // Only a controller that can adopt panes later may leave them running.
  if (!connection.adopt) clear();
  settle();
};
const admit = (connection, capabilities) => {
  const previous = controller;
  controller = connection;
  connection.adopt = Array.isArray(capabilities) && capabilities.includes("adopt");
  greeted = true;
  epoch++;
  for (const pane of panes.values()) pane.attached = false;
  if (previous) {
    try { previous.peer.emit("fenced", { epoch }); } catch {}
    setTimeout(() => previous.peer.close(), 1_000);
  }
  if (!connection.adopt) clear();
  settle();
  return { epoch, host: process.pid, capabilities: ["adopt"], panes: [...panes.values()].filter((pane) => !pane.doomed).map(describe) };
};

const commands = {
  list: () => [...panes.values()].filter((pane) => !pane.doomed).map(describe),
  spawn({ id, shell, args, cwd, env, cols, rows, tag = null }) {
    if (!/^[\w-]{1,64}$/.test(String(id)) || panes.has(id)) throw new Error("Invalid pane id");
    if ([...panes.values()].filter((pane) => !pane.gone).length >= MAX_PANES) throw new Error("Worker host is full");
    const pane = { id, tag: tag === null ? null : String(tag).slice(0, 256), pid: null, start: Date.now(), ready: null, cols, rows, seq: 0, ring: [], head: 0, bytes: 0, exit: null, error: null, gone: false, doomed: false, mark: null, carry: "", input: 0, output: 0, attached: true };
    pane.pty = spawnTerminalPty(config.ptyModule, shell, args, { name: "xterm-256color", cols, rows, cwd, env, useConptyDll: process.platform === "win32" });
    panes.set(id, pane);
    settle();
    pane.pty.onData((text) => record(pane, text));
    pane.pty.onError((error) => { pane.error = error.message; });
    pane.pty.onExit(({ exitCode }) => {
      pane.exit = exitCode;
      persist();
      if (!pane.doomed) notify("exit", { id, exitCode, error: pane.error });
    });
    void pane.pty.exited.then(() => {
      pane.gone = true;
      // A pane that never started has nothing to replay.
      if (pane.ready === null || pane.doomed) {
        panes.delete(id);
        persist();
      }
      if (!pane.doomed) notify("gone", { id });
      settle();
    });
    // The reply does not wait for ConPTY, so a slow shell start never looks like a silent host.
    void pane.pty.ready.then(() => {
      pane.pid = pane.pty.pid;
      pane.ready = Date.now();
      persist();
      if (!pane.doomed) notify("ready", { id, pid: pane.pid });
    }, () => {});
    return true;
  },
  attach({ id, fromSeq = 0 }, connection) {
    const pane = find(id);
    const first = pane.ring[pane.head]?.seq ?? pane.seq + 1;
    pane.attached = false;
    // The reply goes out first, then the ring, then live output, all in order.
    setImmediate(() => {
      if (controller !== connection || pane.doomed) return;
      for (let index = pane.head; index < pane.ring.length; index++) {
        if (pane.ring[index].seq > fromSeq) send(pane, pane.ring[index].seq, pane.ring[index].bytes);
      }
      pane.attached = true;
      if (pane.exit !== null) notify("exit", { id, exitCode: pane.exit, error: pane.error });
      if (pane.gone) notify("gone", { id });
    });
    return { pid: pane.pid, seq: pane.seq, first, truncated: fromSeq + 1 < first, exit: pane.exit, cols: pane.cols, rows: pane.rows };
  },
  async resize({ id, cols, rows }) {
    const pane = find(id);
    await pane.pty.resize(cols, rows);
    Object.assign(pane, { cols, rows });
    return true;
  },
  async kill({ id, force = false }) {
    const pane = find(id);
    if (force) await pane.pty.terminate();
    else await stop(pane);
    return true;
  },
  forget({ id }) {
    if (!find(id).gone) throw new Error("Pane is still running");
    panes.delete(id);
    persist();
    return true;
  },
  detach(_input, connection) {
    release(connection);
    setTimeout(() => connection.peer.close(), 1_000);
    return true;
  },
};

const server = net.createServer((socket) => {
  if (unauthenticated >= MAX_UNAUTHENTICATED) {
    socket.destroy();
    return;
  }
  unauthenticated++;
  const connection = { peer: null, adopt: false, authenticated: false, nonce: null, challenge: null };
  const deadline = setTimeout(() => socket.destroy(), AUTH_MS);
  // A failed handshake gets no reply at all, not even an error.
  const reject = () => {
    socket.destroy();
    throw new Error("Worker host unavailable");
  };
  connection.peer = workerHostPeer(socket, {
    request(method, [input]) {
      if (connection.authenticated) {
        if (controller !== connection) throw new Error("fenced");
        if (!Object.hasOwn(commands, method)) throw new Error("Unsupported worker host request");
        return commands[method](input ?? {}, connection);
      }
      if (method === "hello" && !connection.nonce && input?.protocol === WORKER_HOST_PROTOCOL && /^[\w-]{16,64}$/.test(String(input.nonce))) {
        connection.nonce = String(input.nonce);
        connection.challenge = randomUUID();
        return { nonce: connection.challenge, proof: workerHostProof(config.secret, "host", connection.nonce, connection.challenge) };
      }
      if (method !== "auth" || !connection.nonce || !sameProof(input?.proof, workerHostProof(config.secret, "client", connection.nonce, connection.challenge))) return reject();
      connection.authenticated = true;
      unauthenticated--;
      clearTimeout(deadline);
      return admit(connection, input.capabilities);
    },
    write(id, text) {
      if (!connection.authenticated) return reject();
      if (controller !== connection) throw new Error("fenced");
      const pane = find(id);
      pane.input = Date.now();
      return pane.pty.write(text);
    },
  });
  socket.on("close", () => {
    clearTimeout(deadline);
    if (!connection.authenticated) unauthenticated--;
    release(connection);
  });
});
server.on("error", refuse);
server.listen(config.pipe, () => {
  writeWorkerHostRecord(file("host.json"), { protocol: WORKER_HOST_PROTOCOL, pid: process.pid, nonce: config.nonce, secret: config.secret, pipe: config.pipe });
  try { fs.unlinkSync(file("launch.json")); } catch {}
  settle();
});
