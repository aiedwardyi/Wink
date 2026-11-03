import path from "node:path";

export async function resolveWorkerLaunch(access, bridge, input, fetchImpl = fetch) {
  if (!access?.token || !bridge?.token) throw new Error("Worker launch service is unavailable");
  const response = await fetchImpl(`${access.url}/api/internal/worker-launch`, {
    method: "POST", redirect: "error",
    headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json", "x-orbit-terminal-host": bridge.token },
    body: JSON.stringify(input), signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Worker launch was refused");
  return body.launch;
}

export function managedWorkerCommand(worker, environment, platform, binDir) {
  const quote = platform === "win32"
    ? (value) => `'${value.replace(/'/g, "''")}'`
    : (value) => `'${value.replace(/'/g, "'\\''")}'`;
  const args = worker.args.map((arg) => arg.replace(/\u0000(ORBIT_[A-Z_]+)\u0000/g, (_, name) => environment[name] ?? ""));
  if (worker.workerSettings && binDir) args.push("--settings", path.join(binDir, "claude-worker.json"));
  return `${platform === "win32" ? "& " : ""}${[worker.executable, ...args].map(quote).join(" ")}`;
}
