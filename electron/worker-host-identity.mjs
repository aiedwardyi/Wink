import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function workerHostWindows(operation, { pid = process.pid, target = "" } = {}) {
  const source = fs.readFileSync(fileURLToPath(new URL("./worker-host-windows.ps1", import.meta.url)), "utf8");
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const encoded = Buffer.from(`& { ${source} } -Operation ${quote(operation)} -TargetPid ${Number(pid)} -TargetPath ${quote(target)}`, "utf16le").toString("base64");
  return new Promise((resolve, reject) => execFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true, timeout: 15_000, env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules") } },
    (error, stdout, stderr) => error ? reject(new Error(`Worker host ${operation} check failed: ${stderr.trim().slice(0, 1500)}`)) : resolve(stdout.trim())));
}

export async function workerHostIdentity(pid = process.pid) {
  if (process.platform === "win32") return JSON.parse(await workerHostWindows("identity", { pid }));
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return { pid, created: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19], boot };
  } catch (error) {
    if (error.code === "ENOENT") return { pid, created: null, boot };
    throw error;
  }
}

export async function workerHostLiveness(record, inspect = workerHostIdentity) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0 || typeof record.created !== "string" || !record.created || typeof record.boot !== "string" || !record.boot) return "unknown";
  try {
    const actual = await inspect(record.pid);
    if (!actual || typeof actual.boot !== "string" || (actual.created !== null && typeof actual.created !== "string")) return "unknown";
    if (actual.boot !== record.boot || actual.created === null || actual.created !== record.created) return "dead";
    return "alive";
  } catch { return "unknown"; }
}

export async function privateWorkerHostDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Background work unavailable");
  if (process.platform === "win32") await workerHostWindows("directory", { target: directory });
  else fs.chmodSync(directory, 0o700);
}

export function workerHostRecord(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid worker host record");
    return record;
  }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("Background work unavailable"); }
}

export function writeWorkerHostRecord(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
