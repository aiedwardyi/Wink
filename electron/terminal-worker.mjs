import path from "node:path";
import { claudeSessionArgs, codexSessionArgs } from "./worker-session.mjs";

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

const quoteWindows = (value) => `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, (mark) => mark + mark)}'`;

export function managedWorkerCommand(worker, environment, platform, binDir) {
  const quote = platform === "win32" ? quoteWindows : (value) => `'${value.replace(/'/g, "'\\''")}'`;
  let args = worker.args.map((arg) => arg.replace(/\u0000(ORBIT_[A-Z_]+)\u0000/g, (placeholder, name) => /^ORBIT_MSG_(?:AUTH|TOKEN)$/.test(name) ? placeholder : environment[name] ?? ""));
  if (worker.workerSettings && binDir) args.push("--settings", path.join(binDir, "claude-worker.json"));
  if (worker.session && binDir && platform === "win32") {
    if (worker.session.engine === "claude" && !worker.workerSettings) args = claudeSessionArgs(args, binDir);
    if (worker.session.engine === "codex") args.push(...codexSessionArgs(binDir, platform));
  }
  const quoted = args.map((arg) => {
    const parts = arg.split(/\u0000(ORBIT_MSG_(?:AUTH|TOKEN))\u0000/g);
    if (parts.length === 1) return quote(arg);
    const values = parts.map((part, index) => index % 2 ? platform === "win32" ? `$env:${part}` : `"$${part}"` : quote(part));
    return platform === "win32" ? `(${values.join(" + ")})` : values.join("");
  });
  const command = `${platform === "win32" ? "& " : ""}${[quote(worker.executable), ...quoted].join(" ")}`;
  // The pane shell outlives the worker, so a launch-only secret leaves its environment on any exit.
  const clear = (worker.clearEnv ?? []).filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));
  if (!clear.length) return command;
  return platform === "win32" ? `try { ${command} } finally { ${clear.map((name) => `Remove-Item Env:${name} -ErrorAction SilentlyContinue`).join("; ")} }`
    : `${command}; unset ${clear.join(" ")}`;
}

export function unroutedWorkerCommand(worker, command, binDir) {
  if (!binDir) return command;
  let args = [...worker.args];
  if (worker.session.engine === "claude" && !worker.workerSettings) args = claudeSessionArgs(args, binDir);
  if (worker.session.engine === "codex") args.push(...codexSessionArgs(binDir, "win32"));
  return args.length ? [command.trimEnd(), ...args.map(quoteWindows)].join(" ") : command;
}
