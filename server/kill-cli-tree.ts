import { execFile, type ChildProcess } from "node:child_process";

export function killCliTree(child: ChildProcess, stopped?: () => void): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) { stopped?.(); return; }

  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err, _stdout, stderr) => {
      if (!err) { stopped?.(); return; }
      // The CLI can finish before taskkill starts.
      if (child.exitCode !== null && err.code === 128 && /not found|not exist/i.test(String(stderr))) { stopped?.(); return; }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
    stopped?.();
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
