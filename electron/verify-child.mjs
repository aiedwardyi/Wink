import { app, session } from "electron";
import fs from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

import { CHILD_PATHS, createChildLink, RESOLVER_RULES } from "./verify-child-link.mjs";

export const watchdogSource = `
const { parentPort, workerData } = require("node:worker_threads");
let beat = Date.now();
parentPort.on("message", () => { beat = Date.now(); });
setInterval(() => {
  let alive = true;
  try { process.kill(workerData.ppid, 0); } catch { alive = false; }
  if (!alive || Date.now() - beat >= 30000) process.kill(process.pid);
}, 1000);
`;

export function validateChildLaunch({ env, argv, commandLine }) {
  const root = env.ORBIT_VERIFY_ROOT;
  const nonce = env.ORBIT_VERIFY_CHILD;
  if (!/^[a-f0-9]{48}$/.test(nonce ?? "") || !argv.includes("--orbit-verify-child")) throw new Error("Invalid child markers");
  if (typeof root !== "string" || !path.isAbsolute(root) || /^[\\/]{2}/.test(root) || root.includes("\0") || root.includes(":", 2)
    || path.normalize(root) !== root || !/^orbit-verify-[a-f0-9]{8}$/.test(path.basename(path.dirname(root))) || !/^[a-zA-Z0-9_-]{6,64}$/.test(path.basename(root))) throw new Error("Invalid child root");
  if (commandLine.getSwitchValue("host-resolver-rules") !== RESOLVER_RULES || commandLine.getSwitchValue("user-data-dir") !== path.join(root, "userData")) throw new Error("Invalid child switches");
  const pointed = { HOME: "home", USERPROFILE: "home", APPDATA: "appData", LOCALAPPDATA: "appData", TEMP: "temp", TMP: "temp" };
  if (Object.keys(env).some((key) => /^(OMB_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$)/i.test(key))) throw new Error("Invalid child environment");
  for (const [key, directory] of Object.entries(pointed)) if (env[key] !== path.join(root, directory)) throw new Error("Invalid child data path");
  return { root, nonce, paths: Object.fromEntries(CHILD_PATHS.map((name) => [name, path.join(root, name)])) };
}

export function bootVerifyChild({ app, session, stdin, stdout, stderr = process.stderr, env = process.env, argv = process.argv, priority = os.setPriority, worker = (source, options) => new Worker(source, options), exit = (code) => app.exit(code) }) {
  let link;
  let ending = false;
  let host;
  let dog;
  let heartbeat;
  let helloTimer;
  const log = (level, msg) => { try { link?.send({ type: "log", level, msg: String(msg).slice(0, 1800) }); } catch {} };
  const panic = (err) => { log("error", err?.message ?? err); exit(70); };
  process.on("uncaughtException", panic);
  process.on("unhandledRejection", panic);
  const pipeError = () => exit(70);
  process.stdin.on("error", pipeError);
  process.stdout.on("error", pipeError);
  stderr.on("error", pipeError);
  let launch;
  try { launch = validateChildLaunch({ env, argv, commandLine: app.commandLine }); }
  catch (err) {
    stderr.write(err.message + "\n"); exit(3);
    return { dispose() { process.off("uncaughtException", panic); process.off("unhandledRejection", panic); process.stdin.off("error", pipeError); process.stdout.off("error", pipeError); stderr.off("error", pipeError); } };
  }
  if (!stdin) stdin = stdout = createConnection(`\\\\.\\pipe\\orbit-verify-${launch.nonce}`);
  stdin.on("error", pipeError);
  if (stdout !== stdin) stdout.on("error", pipeError);
  for (const [name, value] of Object.entries(launch.paths)) { fs.mkdirSync(value, { recursive: true }); app.setPath(name, value); }
  priority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
  app.on("window-all-closed", () => {});
  let hello = false;
  let dispatch = Promise.resolve();
  async function shutdown() {
    if (ending) return;
    ending = true;
    clearTimeout(helloTimer);
    clearInterval(heartbeat);
    const deadline = setTimeout(() => exit(0), 1200);
    try { await Promise.race([Promise.resolve().then(() => host?.close()), new Promise((resolve) => setTimeout(resolve, 1100).unref())]); } catch {}
    try { await dog?.terminate(); } catch {}
    clearTimeout(deadline);
    exit(0);
  }
  function fatal(reason) {
    link.send({ type: "fatal", reason });
    setTimeout(() => exit(3), 20);
  }
  async function initialize(frame) {
    if (frame.nonce !== launch.nonce || (frame.probe && (!frame.probeRoot || !launch.root.startsWith(frame.probeRoot + path.sep))) || (!frame.probe && frame.probeRoot !== null)) return fatal("Invalid hello");
    dog = worker(watchdogSource, { eval: true, workerData: { ppid: frame.parentPid } });
    dog.on("error", panic);
    heartbeat = setInterval(() => dog.postMessage("beat"), 1000);
    await app.whenReady();
    const canarySession = session.fromPartition(`verify:canary:${launch.nonce}`, { cache: false });
    let rejected = false;
    try { await canarySession.resolveHost(`verify-canary-${launch.nonce}.localhost`); } catch { rejected = true; }
    await canarySession.closeAllConnections();
    if (!rejected) return fatal("Resolver canary resolved");
    if (ending) return;
    link.send({ type: "ready", versions: { ...process.versions }, rules: app.commandLine.getSwitchValue("host-resolver-rules"), userDataDir: app.commandLine.getSwitchValue("user-data-dir"), paths: Object.fromEntries(CHILD_PATHS.map((name) => [name, app.getPath(name)])), canary: "rejected" });
  }
  let probeMode = false;
  link = createChildLink({ nonce: launch.nonce, direction: "child", input: stdin, output: stdout, onError: panic, onFrame(frame) {
    if (!hello) {
      if (frame.type !== "hello") return fatal("Hello required");
      hello = true;
      probeMode = frame.probe;
      clearTimeout(helloTimer);
      dispatch = initialize(frame).catch(() => fatal("Child attestation failed"));
      return;
    }
    if (frame.type === "ping") { link.send({ type: "pong", n: frame.n }); return; }
    if (frame.type === "quit") { void shutdown(); return; }
    if (frame.type === "hello") return fatal("Duplicate hello");
    if (frame.type === "probe" && !probeMode) return;
    dispatch = dispatch.then(async () => {
      if (ending) return;
      if (!host) {
        const { createVerifyChildHost } = await import("./verify-child-host.mjs");
        if (ending) return;
        host = createVerifyChildHost({ send: (v) => link.send(v), probe: probeMode ? { root: launch.root } : null, log });
      }
      await host.handle(frame);
    }).catch(panic);
  } });
  helloTimer = setTimeout(() => fatal("Hello timeout"), 5000);
  stdin.once("end", shutdown);
  return {
    log, shutdown,
    dispose() {
      clearTimeout(helloTimer); clearInterval(heartbeat);
      process.off("uncaughtException", panic); process.off("unhandledRejection", panic);
      stdin.off("error", pipeError); stdout.off("error", pipeError); stderr.off("error", pipeError);
      process.stdin.off("error", pipeError); process.stdout.off("error", pipeError);
      stdin.off("end", shutdown); link.close();
      void dog?.terminate();
    },
  };
}

if (process.argv.includes("--orbit-verify-child")) {
  const child = bootVerifyChild({ app, session });
  for (const name of ["log", "info", "debug", "warn", "error"]) console[name] = (...values) => child.log?.(name === "log" ? "info" : name, values.map(String).join(" "));
}
