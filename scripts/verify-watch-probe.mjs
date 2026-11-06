import { app, BaseWindow, clipboard, dialog } from "electron";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import os from "node:os";

import { createVerifyHost } from "../electron/verify-host.mjs";
import { decodeChunks } from "../electron/verify-replay.mjs";
import { siteRevision } from "../electron/verify-site-server.mjs";

const scratch = resolve(os.tmpdir(), "wink-LV-WATCH-REC"), repo = fileURLToPath(new URL("../", import.meta.url));
const self = fileURLToPath(import.meta.url);
dialog.showErrorBox = () => {};
if (process.argv.includes("--orbit-verify-child")) {
  const trace = process.argv.find(arg => arg.startsWith("--lv-trace="))?.slice(11);
  if (trace) app.on("web-contents-created", (_event, contents) => {
    const send = contents.debugger.sendCommand.bind(contents.debugger);
    contents.debugger.sendCommand = async (...args) => {
      const reply = await send(...args), value = reply?.result?.value;
      if (value?.viewport) await appendFile(trace, JSON.stringify({ tile: value.viewport.height, viewport: value.viewport, images: value.images?.length, links: value.links?.length, texts: value.texts?.map(row => row.where), rows: value.rows?.reduce((counts, row) => { counts[row.rule] = (counts[row.rule] ?? 0) + 1; return counts; }, {}) }) + "\n");
      return reply;
    };
  });
  for (const name of ["show", "showInactive", "focus", "moveTop", "restore"]) BaseWindow.prototype[name] = () => { throw new Error(`Window shown: ${name}`); };
  for (const name of ["setPosition", "setBounds"]) {
    const original = BaseWindow.prototype[name];
    BaseWindow.prototype[name] = function (...args) {
      const x = name === "setBounds" ? args[0].x : args[0], y = name === "setBounds" ? args[0].y : args[1];
      if (x > -30000 || y > -30000) throw new Error(`Window moved on screen: ${name}`);
      return original.apply(this, args);
    };
  }
  await import("../electron/verify-child.mjs");
} else {
  await mkdir(join(scratch, "eval-user-data"), { recursive: true });
  await mkdir(join(scratch, "eval-session-data"), { recursive: true });
  app.setPath("userData", join(scratch, "eval-user-data"));
  app.setPath("sessionData", join(scratch, "eval-session-data"));
  app.commandLine.appendSwitch("headless"); app.commandLine.appendSwitch("mute-audio");
  app.on("window-all-closed", () => {});
  let host, before;
  const log = value => process.stdout.write(JSON.stringify(value) + "\n");
  const restore = () => {
    if (!before) return;
    const changed = !before.every(([format, bytes]) => clipboard.readBuffer(format).equals(bytes)) || clipboard.availableFormats().length !== before.length;
    if (changed) { clipboard.clear(); for (const [format, bytes] of before) clipboard.writeBuffer(format, bytes); }
  };
  const fatal = async error => { try { log({ error: String(error?.stack ?? error) }); } catch {} await host?.close(); restore(); app.exit(1); };
  process.on("uncaughtException", fatal); process.on("unhandledRejection", fatal);
  process.stdout.on("error", error => { if (error.code === "EPIPE") app.exit(1); else void fatal(error); });
  process.stderr.on("error", () => app.exit(1));
  app.whenReady().then(async () => {
    await mkdir(scratch, { recursive: true });
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
    before = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]);
    const names = (process.env.LV_PROBE_SITES || "muse,flash,luna,opus,haiku,grok,getwink,headlinereport,clean").split(",");
    const samples = Number(process.env.LV_PROBE_SAMPLES || "2"), results = [];
    const recorder = process.env.LV_WATCH_RECORDER ? await import(process.env.LV_WATCH_RECORDER) : null;
    if (names.some(name => !/^[a-z-]+$/.test(name)) || !Number.isInteger(samples) || samples < 1 || samples > 3) throw new Error("Invalid probe selection");
    for (const name of names) for (let sample = 1; sample <= samples; sample++) for (const recording of sample % 2 ? [false, true] : [true, false]) {
      const root = await realpath(join(os.tmpdir(), "wink-LV-DONE-CHECK", "sites", name));
      if (!root.startsWith(await realpath(join(os.tmpdir(), "wink-LV-DONE-CHECK", "sites")) + sep)) throw new Error("Fixture escaped scratch");
      const started = performance.now(), revision = await siteRevision({ root, entry: "index.html" }), logs = [], pids = [];
      host = createVerifyHost({ log: message => { logs.push(message); log({ name, sample, recording, message }); }, dependencies: {
        recording,
        spawn(exe, argv, options) {
          const child = spawn(exe, [self, ...argv.slice(1), ...(process.env.LV_WATCH_TRACE === "1" ? [`--lv-trace=${join(scratch, `${name}-${recording}-${sample}.trace.jsonl`)}`] : [])], { ...options, windowsHide: true });
          pids.push(child.pid);
          const row = { name, sample, recording, pid: child.pid, startedAt: new Date().toISOString() };
          log(row); void appendFile(join(scratch, "pids.log"), JSON.stringify(row) + "\n");
          return child;
        },
      } });
      const runId = randomUUID(), bytes = [], rows = [], counts = { desktop: 0, phone: 0 };
      await host.start({ runId, botId: "probe", root, entry: "index.html", revision, site: `${name}/index.html`, watch: false });
      const stream = new PassThrough(); stream.writeHead = () => {};
      const decoder = decodeChunks(row => { rows.push(row); if (row.kind === 1) counts[row.tile]++; });
      stream.on("data", value => { bytes.push(value); decoder.push(value); });
      const drained = new Promise(resolve => stream.once("end", () => { decoder.end(); resolve(); }));
      host.cast(runId, stream);
      let state, since = -1;
      do { state = await host.poll(runId, { since, waitMs: 1000 }); since = state.revision; } while (!["completed", "blocked"].includes(state.state));
      await drained;
      const elapsedMs = Math.round(performance.now() - started);
      await host.close(); host = null;
      let fileBytes = 0;
      if (recording) {
        if (recorder) {
          const replay = recorder.createReplay(rows[0].value);
          for (const row of rows.slice(1)) if (row.kind < 3) replay.add(row.raw);
          replay.finish(rows.at(-1).value);
          const file = replay.file(); fileBytes = file.length;
          await writeFile(join(scratch, `${name}-${sample}.lvr`), file);
        } else {
          const file = Buffer.concat([Buffer.from("LVR1"), ...bytes]); fileBytes = file.length;
          await writeFile(join(scratch, `${name}-${sample}.lvr`), file);
        }
      }
      const marks = rows.filter(row => row.kind === 2), recordedChecks = marks.reduce((n, row) => n + (row.value.kind === "checks" ? row.value.checks.length : 0), 0);
      const result = { name, sample, recording, revision, elapsedMs, frames: counts, fileBytes, marks: marks.length, recordedChecks, points: marks.filter(row => row.value.kind === "point").length, parts: marks.filter(row => row.value.kind === "part").map(row => row.value.part), windows: 0, pids, logs, result: state.result };
      results.push(result); log(result);
      await writeFile(join(scratch, "eval.json"), JSON.stringify({ sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim(), electron: process.versions.electron, results }, null, 2));
    }
    restore();
    log({ clipboardRestored: before.every(([format, bytes]) => clipboard.readBuffer(format).equals(bytes)) });
    app.exit(results.some(row => row.result.errorCode) ? 1 : 0);
  }).catch(fatal);
}
