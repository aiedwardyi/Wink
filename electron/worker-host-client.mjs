import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { holdWorkerHostLock, workerHostIdentity, workerHostLiveness, workerHostLock, workerHostRecord, privateWorkerHostDirectory, writeWorkerHostRecord } from "./worker-host-identity.mjs";
import { WORKER_HOST_VERSION, WORKER_HOST_CAPABILITIES, workerHostPeer } from "./worker-host-protocol.mjs";
import { pinWorkerHostRuntime } from "./worker-host-runtime.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const windows = process.platform === "win32";

export function createWorkerHostClient({ root, runtimeRoot = path.join(root, "runtime"), ptyModule, executable, home, dataDir, worktreeRoot, service, event = () => {} }) {
  let peer = null;
  let connecting = null;
  let disposed = false;
  let summary = { panes: [], labels: {}, accounts: [], count: 0 };
  let record = null;
  let recovered = false;
  const connectRecord = async (stored) => {
    if (stored.version !== WORKER_HOST_VERSION) throw new Error("Background work unavailable");
    const socket = net.createConnection(stored.pipe);
    let failure;
    socket.once("error", (error) => { failure = error; });
    const connection = workerHostPeer(socket, async (method, args) => {
      if (!method.startsWith("service:")) throw new Error("Unsupported worker host callback");
      return service(method.slice(8), args);
    }, (channel, value) => {
      if (channel === "host:summary") summary = value;
      else event(channel, value);
    });
    socket.on("close", () => { if (peer === connection) peer = null; });
    try {
      const hello = await connection.request("hello", [{ secret: stored.secret, nonce: stored.nonce, version: WORKER_HOST_VERSION, capabilities: WORKER_HOST_CAPABILITIES }], 5000);
      if (hello.version !== WORKER_HOST_VERSION || hello.nonce !== stored.nonce || !WORKER_HOST_CAPABILITIES.every((name) => hello.capabilities?.includes(name))) throw new Error("Background work unavailable");
      summary = hello;
      record = stored;
      peer = connection;
      return connection;
    } catch (error) { connection.close(); throw failure ?? error; }
  };
  const establish = async (create) => {
    if (disposed) throw new Error("Background work unavailable");
    const stored = workerHostRecord(path.join(root, "host.json"));
    if (stored) {
      for (let attempt = 0; ; attempt++) {
        const liveness = windows ? workerHostLock(path.join(root, "host.lock")) : await workerHostLiveness(stored);
        if (liveness === "dead") break;
        if (liveness !== "alive") throw new Error("Background work unavailable");
        try { return await connectRecord(stored); }
        catch (error) { if (!windows || error.code !== "ENOENT" || attempt === 3) throw error; }
        await wait(50);
      }
      recovered = true;
    }
    if (!stored && fs.existsSync(path.join(root, "pane-runs.json"))) throw new Error("Background work unavailable");
    if (!create) return null;
    await privateWorkerHostDirectory(root);
    const lockFile = path.join(root, windows ? "launch.lock" : "launch-lock.json");
    let identity;
    let launchLock;
    if (windows) {
      launchLock = holdWorkerHostLock(lockFile);
      if (workerHostLock(path.join(root, "host.lock")) !== "dead") { fs.closeSync(launchLock); throw new Error("Background work unavailable"); }
    } else {
      const priorLock = workerHostRecord(lockFile);
      if (priorLock) {
        if (await workerHostLiveness(priorLock) !== "dead" || !priorLock.child) throw new Error("Background work unavailable");
        if (await workerHostLiveness(priorLock.child) !== "dead") throw new Error("Background work unavailable");
        fs.unlinkSync(lockFile);
      }
      identity = await workerHostIdentity();
      const lock = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(lock, JSON.stringify(identity));
      fs.closeSync(lock);
    }
    const runtime = await pinWorkerHostRuntime({ root: runtimeRoot, executable, ptyModule });
    const nonce = randomUUID();
    const secret = randomBytes(32).toString("hex");
    const key = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
    const pipe = process.platform === "win32" ? `\\\\.\\pipe\\wink-worker-${key}-${nonce}` : path.join(root, "host.sock");
    writeWorkerHostRecord(path.join(root, "launch.json"), { nonce, secret, pipe, runtime, home, dataDir, worktreeRoot });
    const child = spawn(runtime.executable, [runtime.entry, root], { detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    let launchError;
    child.once("error", (error) => { launchError = error; });
    child.unref();
    if (!child.pid) throw new Error("Background work unavailable");
    if (!windows) writeWorkerHostRecord(lockFile, { ...identity, child: await workerHostIdentity(child.pid) });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (launchError) throw new Error("Background work unavailable");
      const published = workerHostRecord(path.join(root, "host.json"));
      if (published?.nonce === nonce) {
        const connected = await connectRecord(published);
        if (windows) fs.closeSync(launchLock);
        else fs.unlinkSync(lockFile);
        return connected;
      }
      await wait(50);
    }
    throw new Error("Background work unavailable");
  };
  const connect = (create = true) => {
    if (peer) return Promise.resolve(peer);
    if (connecting) return connecting;
    connecting = establish(create).catch((error) => { throw new Error("Background work unavailable", { cause: error }); }).finally(() => { connecting = null; });
    return connecting;
  };
  return {
    connect,
    async request(method, args = []) {
      const connection = await connect();
      if (!connection) throw new Error("Background work unavailable");
      return connection.request(method, args);
    },
    summary: () => summary,
    identity: () => record,
    needsRecovery: () => recovered,
    async detach() {
      disposed = true;
      try { await peer?.request("detach", [], 1000); } catch {}
      peer?.close();
      peer = null;
    },
  };
}
