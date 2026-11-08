import { app, clipboard, dialog } from "electron";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createVerifyHost } from "../electron/verify-host.mjs";
import { siteRevision } from "../electron/verify-site-server.mjs";

const scratch = resolve(os.tmpdir(), "wink-LV-DONE-CHECK");
const repo = fileURLToPath(new URL("../", import.meta.url));
const output = join(scratch, "eval.json");
app.setPath("userData", join(scratch, "eval-user-data"));
app.setPath("sessionData", join(scratch, "eval-session-data"));
app.commandLine.appendSwitch("mute-audio");
app.commandLine.appendSwitch("headless");
dialog.showErrorBox = () => {};
const log = value => process.stdout.write(JSON.stringify(value) + "\n");
let host, clipboardBefore;
const restore = () => {
  if (!clipboardBefore) return;
  if (!clipboardBefore.every(([format, bytes]) => clipboard.readBuffer(format).equals(bytes))) for (const [format, bytes] of clipboardBefore) clipboard.writeBuffer(format, bytes);
};
const fatal = async error => { try { log({ error: String(error?.stack ?? error) }); } catch {} await host?.close(); restore(); app.exit(1); };
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
process.stdout.on("error", error => { if (error.code === "EPIPE") app.exit(1); });
process.stderr.on("error", () => app.exit(1));
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
clipboardBefore = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]);
const names = (process.env.LV_PROBE_SITES || "muse,flash,luna,opus,haiku,grok,getwink,headlinereport,clean").split(",");
const samples = Number(process.env.LV_PROBE_SAMPLES || "2");
if (names.some(name => !/^[a-z-]+$/.test(name)) || !Number.isInteger(samples) || samples < 1 || samples > 3) throw new Error("Invalid probe selection");
const admitted = process.env.LV_PROBE_ADMISSION ? JSON.parse(await readFile(process.env.LV_PROBE_ADMISSION, "utf8")) : null;
let canary, escapes = 0;
if (names.includes("guards")) {
  canary = createServer((_req, res) => { escapes++; res.end("escaped"); });
  canary.on("upgrade", (_req, socket) => { escapes++; socket.destroy(); });
  await new Promise(resolve => canary.listen(0, "127.0.0.1", resolve));
  const folder = join(scratch, "sites", "guards");
  await mkdir(folder, { recursive: true });
  const template = await readFile(new URL("./fixtures/verify-done/guards/index.html", import.meta.url), "utf8");
  await writeFile(join(folder, "index.html"), template.replace("__CANARY__", `http://127.0.0.1:${canary.address().port}`));
}
const results = [];
for (const name of names) for (let sample = 1; sample <= samples; sample++) {
  const root = await realpath(join(scratch, "sites", name));
  if (!root.startsWith(await realpath(join(scratch, "sites")) + sep)) throw new Error("Fixture escaped scratch");
  const admissionStart = performance.now();
  const admission = admitted?.find(row => row.name === name && row.sample === sample);
  const revision = admission?.revision ?? await siteRevision({ root, entry: "index.html" });
  const admissionMs = admission?.admissionMs ?? Math.round(performance.now() - admissionStart);
  const pids = [];
  host = createVerifyHost({ log: message => log({ name, sample, message }), dependencies: {
    spawn(exe, argv, options) {
      const child = spawn(exe, argv, { ...options, windowsHide: true });
      pids.push(child.pid); log({ name, sample, childPid: child.pid, startedAt: new Date().toISOString() });
      return child;
    },
  } });
  const runId = randomUUID(), started = performance.now();
  await host.start({ runId, botId: "probe", root, entry: "index.html", revision, site: `${name}/index.html`, watch: false });
  let state, since = -1;
  do {
    state = await host.poll(runId, { since, waitMs: 1000 });
    since = state.revision;
    if (performance.now() - started > 65000) throw new Error(`Probe timeout: ${name}`);
  } while (!["completed", "blocked"].includes(state.state));
  await host.close(); host = null;
  const elapsedMs = Math.round(performance.now() - started) + admissionMs;
  results.push({ name, sample, revision, admissionMs, elapsedMs, pids, result: state.result });
  log({ name, sample, elapsedMs, status: state.state, error: state.errorCode, problems: state.result.issues, notChecked: state.result.notChecked });
  await writeFile(output, JSON.stringify({ sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim(), electron: process.versions.electron, results }, null, 2));
}
restore();
if (canary) { await new Promise(resolve => canary.close(resolve)); log({ escapes, clipboardRestored: clipboardBefore.every(([format, bytes]) => clipboard.readBuffer(format).equals(bytes)) }); }
log({ output, sha256: createHash("sha256").update(await readFile(output)).digest("hex") });
app.exit(results.some(row => row.result.errorCode) ? 1 : 0);
}).catch(fatal);
