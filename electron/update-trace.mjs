import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 32768;

export function formatUpdateTrace(event, { pid, ppid, version, packaged, uptime, argv }) {
  if (!["start", "lock won", "lock lost"].includes(event)) return null;
  const args = argv.slice(packaged ? 1 : 2);
  const updated = args.includes("--updated");
  const forcerun = args.includes("--force-run");
  const otherArgs = args.filter((arg) => arg !== "--updated" && arg !== "--force-run").length;
  const safeVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)?.[0] ?? "unknown";
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const seconds = Number.isFinite(uptime) && uptime >= 0 ? uptime.toFixed(3) : "0.000";
  return `update ${event} pid=${integer(pid)} ppid=${integer(ppid)} version=${safeVersion} packaged=${Number(Boolean(packaged))} uptime=${seconds} updated=${Number(updated)} forcerun=${Number(forcerun)} otherArgs=${otherArgs}`;
}

export function appendUpdateTrace(app, runtime, event, io = fs) {
  try {
    const logs = app.getPath("logs");
    const file = path.join(logs, "update-trace.log");
    const text = formatUpdateTrace(event, { pid: runtime.pid, ppid: runtime.ppid, version: app.getVersion(), packaged: app.isPackaged, uptime: runtime.uptime(), argv: runtime.argv });
    if (!text) return;
    io.mkdirSync(logs, { recursive: true });
    // Rotate by rename so a concurrent launch's append is never truncated away.
    try { if (io.statSync(file).size > MAX_BYTES) io.renameSync(file, path.join(logs, "update-trace.1.log")); } catch {}
    io.appendFileSync(file, `[${new Date().toISOString()}] ${text}\n`, "utf8");
  } catch {}
}
