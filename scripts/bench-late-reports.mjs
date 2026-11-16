import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { mailboxGrant } from "../electron/terminal-mailbox.mjs";

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const split = arg.indexOf("=");
  return [arg.slice(2, split), arg.slice(split + 1)];
}));
if (!options.old || !options.new || !options.scratch) throw new Error("usage: node scripts/bench-late-reports.mjs --old=<ref> --new=<ref> --scratch=<throwaway parent>");
await mkdir(options.scratch, { recursive: true });
const root = await mkdtemp(path.join(path.resolve(options.scratch), "mailbox-pairs-"));
const children = [];
const repo = fileURLToPath(new URL("../", import.meta.url));

async function checkout(ref, name) {
  const sha = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
  const dir = path.join(root, `${name}-checkout`);
  await mkdir(dir);
  const archive = path.join(root, `${name}.tar`);
  await writeFile(archive, execFileSync("git", ["archive", "--format=tar", sha], { cwd: repo, windowsHide: true, maxBuffer: 256 * 1024 * 1024 }));
  execFileSync("tar", ["-xf", archive, "-C", dir], { windowsHide: true });
  await symlink(path.join(repo, "node_modules"), path.join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return { dir, sha };
}

async function start(checkout, name) {
  const home = path.join(root, name);
  const data = path.join(home, "data");
  const profile = path.join(home, "profile");
  await mkdir(data, { recursive: true });
  await mkdir(profile, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const secret = randomBytes(32).toString("hex");
  await writeFile(path.join(profile, "mailbox-secret"), secret, { mode: 0o600 });
  await writeFile(path.join(data, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }));
  await writeFile(path.join(data, "bots.json"), JSON.stringify([{ id: "bench", threadId: "bench-thread", name: "Bench", title: "", description: "", notifications: false, color: "purple", unread: false, modelSelection: { instanceId: "ghost", model: "ghost" }, resumeCursors: {}, computer: "off" }]));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|ComSpec|PATHEXT|WINDIR)$/i.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata"), TEMP: home, TMP: home, OMB_DATA_DIR: data, OMB_USER_DATA: profile, OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0", OMB_COMMS_TOKEN: token });
  const child = spawn(process.execPath, [path.join(path.resolve(checkout), "server", "index.ts")], { cwd: path.resolve(checkout), env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  let errors = "";
  child.stderr.on("data", chunk => { errors += chunk; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch {}
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`${name} did not start: ${errors}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return async () => {
    const started = performance.now();
    const response = await fetch(`${url}/api/mailbox`, {
      method: "POST", headers: { authorization: `Bearer ${mailboxGrant(secret, "bench-pane", "bench", "bench")}`, "content-type": "application/json", "x-orbit-pane": "bench-pane", "x-orbit-bot": "bench", "x-orbit-teacher": "bench" },
      body: JSON.stringify({ text: "DONE BENCH branch=bench sha=bench dirty=no\nfinished", kind: "report", messageId: randomUUID(), sentAt: Date.now() }),
      signal: AbortSignal.timeout(10_000),
    });
    await response.text();
    if (!response.ok) throw new Error(`${name} mailbox returned ${response.status}`);
    return performance.now() - started;
  };
}

try {
  const old = await checkout(options.old, "old");
  const current = await checkout(options.new, "new");
  const oldPost = await start(old.dir, "old");
  const newPost = await start(current.dir, "new");
  for (let index = 0; index < 5; index++) { await oldPost(); await newPost(); }
  const pairs = [];
  for (let index = 0; index < 30; index++) {
    let oldMs, newMs;
    if (index % 2) { newMs = await newPost(); oldMs = await oldPost(); }
    else { oldMs = await oldPost(); newMs = await newPost(); }
    pairs.push({ oldMs, newMs });
  }
  const p95 = values => values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const oldP95 = p95(pairs.map(pair => pair.oldMs));
  const newP95 = p95(pairs.map(pair => pair.newMs));
  const result = { old: old.sha, new: current.sha, pairs, oldP95, newP95, ratio: newP95 / oldP95, pass: newP95 <= oldP95 * 1.05 };
  await writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ root, pairs: 30, oldP95, newP95, ratio: result.ratio, pass: result.pass }));
  if (!result.pass) process.exitCode = 1;
} finally {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
}
