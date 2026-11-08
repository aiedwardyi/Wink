import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createTerminalHost } from "./terminal-host.mjs";
import { spawnTerminalPty } from "./terminal-pty.mjs";
import { createPaneRuns } from "./pane-runs.mjs";
import { createPaneCleanup, readCleanupPins } from "./pane-cleanup.mjs";
import { createTerminalBridge } from "./terminal-bridge.mjs";
import { recoverWorkers } from "./worker-resume.mjs";
import { postPaneNote } from "./terminal-mailbox.mjs";
import { holdWorkerHostLock, workerHostIdentity, workerHostRecord, workerHostWindows, writeWorkerHostRecord } from "./worker-host-identity.mjs";
import { WORKER_HOST_VERSION, WORKER_HOST_CAPABILITIES, workerHostPeer } from "./worker-host-protocol.mjs";
import { workerHostScreen } from "./worker-host-screen.mjs";

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.on("uncaughtException", (error) => {
  if (error?.code !== "EPIPE") {
    try { fs.appendFileSync(path.join(process.argv[2], "host-errors.log"), `${Date.now()} ${error?.stack ?? "Error"}\n`); } catch {}
  }
});

const root = process.argv[2];
const config = workerHostRecord(path.join(root, "launch.json"));
if (!config?.nonce || !config?.secret) throw new Error("Missing worker host configuration");
let published = false;
const startupDeadline = setTimeout(() => { if (!published) process.exit(1); }, 30_000).unref();
if (process.platform === "win32") holdWorkerHostLock(path.join(root, "host.lock"));
const identity = await workerHostIdentity();
const record = { ...identity, nonce: config.nonce, secret: config.secret, version: WORKER_HOST_VERSION, pipe: config.pipe, runtime: config.runtime, state: "ready" };
let controller = null;
let bridgeAccess;
let cachedMailbox = null;
let stopping = false;
let admitted = 0;
let operations = 0;
const sockets = new Set();
const services = (method, ...args) => {
  if (!controller) return Promise.reject(new Error("Background work unavailable"));
  return controller.request(`service:${method}`, args);
};
const broadcast = (channel, value) => {
  for (const peer of sockets) {
    try { peer.emit(channel, value); } catch { peer.close(); }
  }
};
const owner = { id: 1, mainFrame: {}, isDestroyed: () => false, send: broadcast };
const event = { sender: owner, senderFrame: owner.mainFrame };
const runs = createPaneRuns(path.join(root, "pane-runs.json"));
const cleanup = createPaneCleanup({ home: config.home, worktreeRoot: config.worktreeRoot, pinned: () => readCleanupPins(config.dataDir) });
const host = createTerminalHost({
  authorize(caller) { if (caller.sender !== owner) throw new Error("Untrusted worker host caller"); },
  owner: () => owner,
  workerAccountsEnabled: false,
  workerLaunch: (input) => services("workerLaunch", input),
  resolveCwd: (botId) => services("resolveCwd", botId),
  botNames: () => services("botNames"),
  mailbox: async () => {
    if (controller) cachedMailbox = await services("mailbox");
    return cachedMailbox;
  },
  sessionBridge: () => bridgeAccess?.url,
  paneRuns: runs,
  paneCleanup: cleanup,
  paneIdentity: (pid) => ({ pid }),
  snag: (input) => { void services("snag", input).catch(() => {}); },
  loadPty: () => ({ spawn: (shell, args, options) => spawnTerminalPty(config.runtime.ptyModule, shell, args, options) }),
});
const bridge = createTerminalBridge({ host: { ...host, captureWorkerSession(...args) {
  const captured = host.captureWorkerSession(...args);
  if (captured) queueMicrotask(() => broadcast("host:summary", summaries()));
  return captured;
} } });
bridgeAccess = await bridge.start();
const panes = new Map();
const summaries = () => ({ panes: [...panes.values()].map((pane) => ({ ...pane, resumeStatus: host.workerResumeStatus(pane.id) })), labels: host.paneLabels(), accounts: host.liveAccountRuns(), count: host.liveWorkerCount(), recoveryPending: runs.restarted().size > 0 });
let summaryTimer = null;
owner.send = (channel, value) => {
  if (channel === "terminal:opened") { admitted++; panes.set(value.id, value); }
  if (channel === "terminal:closed" || channel === "terminal:exit") panes.delete(value.id);
  broadcast(channel, value);
  if (channel !== "terminal:data") broadcast("host:summary", summaries());
  else if (!summaryTimer) summaryTimer = setTimeout(() => { summaryTimer = null; broadcast("host:summary", summaries()); }, 750).unref();
};
const commands = {
  list: () => summaries(),
  attach: async (input) => {
    const snapshot = await host.open(event, input);
    return { ...snapshot, output: workerHostScreen(snapshot), host: { nonce: record.nonce, ...identity } };
  },
  read: (...args) => host.readBot(...args),
  write: (...args) => host.write(event, ...args),
  resize: (...args) => host.resize(event, ...args),
  acknowledge: (...args) => host.acknowledge(event, ...args),
  spawn: async (...args) => {
    const result = await host.openForBot(...args);
    if (result.sessionId) {
      const snapshot = await host.open(event, { botId: args[0], sessionId: result.sessionId, cols: 120, rows: 30 });
      Object.assign(panes.get(result.sessionId), { cwd: snapshot.cwd, processIdentity: snapshot.processIdentity });
      writeWorkerHostRecord(path.join(root, "panes.json"), { nonce: record.nonce, ...identity, panes: [...panes.values()] });
    }
    return result;
  },
  send: (...args) => host.sendBot(...args),
  close: (...args) => host.close(event, ...args),
  "close-bot": (...args) => host.closeBotPanes(...args),
  "close-pane": (...args) => host.closeForBot(...args),
  attend: (...args) => host.attendBot(...args),
  "enable-accounts": () => host.enableWorkerAccounts(),
  "account-panes": (...args) => host.livePanesForAccount(...args),
  capture: (...args) => host.captureWorkerSession(...args),
  recover: async () => {
    await recoverWorkers({ runs, host, mailbox: () => cachedMailbox, notePane: postPaneNote });
    return summaries();
  },
};
const server = net.createServer((socket) => {
  let authenticated = false;
  let peer;
  const timer = setTimeout(() => socket.destroy(), 5000);
  peer = workerHostPeer(socket, async (method, args) => {
    if (!authenticated) {
      if (!published) throw new Error("Background work unavailable");
      const hello = args[0];
      const secret = Buffer.from(typeof hello?.secret === "string" ? hello.secret : "");
      const expected = Buffer.from(record.secret);
      if (method !== "hello" || hello?.nonce !== record.nonce || secret.length !== expected.length || !timingSafeEqual(secret, expected)
        || hello.version !== WORKER_HOST_VERSION || !Array.isArray(hello.capabilities) || !WORKER_HOST_CAPABILITIES.every((name) => hello.capabilities.includes(name))) {
        setImmediate(() => socket.destroy());
        throw new Error("Background work unavailable");
      }
      if (controller) throw new Error("Background work unavailable");
      authenticated = true;
      clearTimeout(timer);
      controller = peer;
      sockets.add(peer);
      return { version: WORKER_HOST_VERSION, capabilities: WORKER_HOST_CAPABILITIES, nonce: record.nonce, identity, ...summaries() };
    }
    if (method === "detach") { setImmediate(() => peer.close()); return true; }
    if (stopping) throw new Error("Background work unavailable");
    if (!Object.hasOwn(commands, method)) throw new Error("Unsupported worker host request");
    operations++;
    try { return await commands[method](...args); }
    finally { operations--; broadcast("host:summary", summaries()); }
  });
  socket.on("close", () => {
    clearTimeout(timer);
    sockets.delete(peer);
    if (controller === peer) controller = null;
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen({ path: config.pipe, readableAll: false, writableAll: false }, resolve);
});
if (process.platform === "win32") await workerHostWindows("pipe-private", { target: config.pipe });
else fs.chmodSync(config.pipe, 0o600);
writeWorkerHostRecord(path.join(root, "host.json"), record);
published = true;
clearTimeout(startupDeadline);
try { fs.unlinkSync(path.join(root, "launch.json")); } catch {}
const began = Date.now();
setInterval(() => {
  if (stopping || operations || host.liveWorkerCount() || (!admitted && Date.now() - began < 30_000)) return;
  stopping = true;
  void cleanup.flush().then(async () => {
    cleanup.dispose();
    await host.dispose();
    await bridge.close();
    writeWorkerHostRecord(path.join(root, "host.json"), { ...record, state: "exited" });
    for (const peer of sockets) peer.close();
    server.close(() => process.exit(0));
  });
}, 1000).unref();
