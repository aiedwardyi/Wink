/* oxlint-disable anti-slop/no-runtime-typeof -- Queue records are untyped JSON from disk. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const WEEK = 7 * 86_400_000;
// Node omits libuv's Windows exclusive-sharing flag from its public constants.
const EXLOCK = process.platform === "win32" ? 0x10000000 : 0;
const active = new Map();
const localUrl = value => /^http:\/\/127\.0\.0\.1:\d+$/.test(value);
const id = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

async function snapshot(profile) {
  const dir = path.join(profile, "mailbox-outbox");
  try { if (!(await fs.lstat(dir)).isDirectory()) return []; } catch { return []; }
  const lockPath = path.join(profile, "mailbox-outbox.lock");
  let lock;
  const until = Date.now() + 5_000;
  while (!lock) {
    try { lock = await fs.open(lockPath, constants.O_CREAT | constants.O_RDWR | EXLOCK, 0o600); }
    catch (error) {
      if (!["EACCES", "EPERM", "EBUSY"].includes(error.code)) throw error;
      if (Date.now() >= until) return [];
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    const keep = [];
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name);
      const stat = await fs.lstat(file).catch(() => null);
      if (!stat || !stat.isFile() || !/^\d+-[a-f0-9-]{36}\.json$/.test(name) || stat.size > 32_768) {
        if (stat && !stat.isDirectory()) await fs.unlink(file);
        continue;
      }
      const at = Number(name.split("-")[0]);
      if (at < Date.now() - WEEK) await fs.unlink(file);
      else keep.push({ file, at });
    }
    keep.sort((a, b) => b.at - a.at || b.file.localeCompare(a.file));
    for (const entry of keep.slice(500)) await fs.unlink(entry.file);
    return keep.slice(0, 500).toReversed();
  } finally {
    await lock.close();
  }
}

function valid(entry) {
  const payload = entry?.payload;
  const headers = entry?.headers;
  if (!payload || typeof payload.text !== "string" || !/^[a-f0-9-]{36}$/.test(payload.messageId)
    || !Number.isSafeInteger(payload.sentAt) || payload.sentAt < Date.now() - WEEK || payload.queued !== true) return false;
  if (!headers || typeof (headers.Authorization ?? headers.authorization) !== "string") return false;
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return ["x-orbit-pane", "x-orbit-bot", "x-orbit-teacher"].every(key => id(lower[key]));
}

async function drain(profile, url) {
  const files = await snapshot(profile);
  let delivered = 0;
  const reports = [];
  for (const { file } of files) {
    const entry = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
    if (!valid(entry)) { await fs.unlink(file).catch(() => {}); continue; }
    try {
      const response = await fetch(`${url}/api/mailbox`, {
        method: "POST", headers: { ...entry.headers, "content-type": "application/json" },
        body: JSON.stringify(entry.payload), redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      await response.arrayBuffer();
      if (!response.ok) continue;
      if (entry.payload.kind === "report") {
        const headers = Object.fromEntries(Object.entries(entry.headers).map(([key, value]) => [key.toLowerCase(), value]));
        reports.push({ pane: headers["x-orbit-pane"], bot: headers["x-orbit-bot"], teacher: headers["x-orbit-teacher"] });
      }
      await fs.unlink(file);
      delivered++;
    } catch {}
  }
  return { delivered, reports };
}

export function deliverMailboxOutbox(profile, url, runs) {
  if (!localUrl(url)) return Promise.reject(new Error("Mailbox delivery requires a loopback URL"));
  const key = path.resolve(profile);
  if (active.has(key)) return active.get(key);
  const pending = new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { mailboxOutbox: true, profile: key, url } });
    let result;
    worker.on("message", value => { result = value; });
    worker.once("error", reject);
    worker.once("exit", code => code === 0 && result ? resolve(result) : reject(new Error(`Mailbox outbox worker exited ${code}`)));
    worker.unref();
  }).then(result => {
    if (runs) {
      for (const report of result.reports) {
        const prior = runs.restarted().get(report.bot)?.find(run => run.id === report.pane && (run.teacher ?? run.botId) === report.teacher);
        if (prior) runs.closed(prior.id);
      }
    }
    return result;
  }).finally(() => active.delete(key));
  active.set(key, pending);
  return pending;
}

if (!isMainThread && workerData?.mailboxOutbox) {
  try { parentPort.postMessage(await drain(workerData.profile, workerData.url)); }
  finally { parentPort.close(); }
}
