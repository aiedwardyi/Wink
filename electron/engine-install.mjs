import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBlankTerminal, openInstallTerminal } from "./terminal-launch.mjs";

export function registerEngineInstall(ipcMain, { trusted, server, copy, fetch = globalThis.fetch, open = openInstallTerminal, blank = openBlankTerminal, markers = join(tmpdir(), "wink-install") }) {
  const inFlight = new Map();
  // One marker per launched window ("+" is outside the id charset), so an older window's late failure never marks a newer attempt.
  const current = new Map();
  const sweep = (instanceId) => {
    let names = [];
    try { names = readdirSync(markers); } catch {}
    for (const name of names) {
      const path = join(markers, name);
      if (name.startsWith(`${instanceId}+`) && path !== current.get(instanceId)) try { rmSync(path, { force: true }); } catch {}
    }
  };
  const check = (event, instanceId) => {
    if (!trusted(event)) throw new Error("Untrusted install caller");
    if (typeof instanceId !== "string" || !/^[\w.-]+$/.test(instanceId)) throw new Error("Invalid engine id");
  };
  ipcMain.handle("engine:install", async (event, instanceId, installOnly) => {
    check(event, instanceId);
    const pending = inFlight.get(instanceId);
    if (pending instanceof Promise) return pending;
    if (pending > Date.now()) return "running";
    const failMarker = join(markers, `${instanceId}+${randomUUID()}.failed`);
    current.set(instanceId, failMarker);
    try { mkdirSync(markers, { recursive: true }); } catch {}
    sweep(instanceId);
    // Defer work until the pending promise is stored, including synchronous server failures.
    const result = Promise.resolve().then(async () => {
      let running = false;
      try {
        const { port, token } = server();
        const response = await fetch(`http://127.0.0.1:${port}/api/instances/${encodeURIComponent(instanceId)}/install`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Could not resolve engine install");
        const install = await response.json();
        if (!install?.command) throw new Error("Unknown engine install");
        try {
          running = await open(installOnly === true ? { ...install, signInCommand: undefined, failMarker } : { ...install, failMarker });
          if (running) return "running";
        } catch (error) {
          console.error("[engine-install] terminal launch failed:", error);
        }
        copy(install.command);
        return await blank() ? "opened" : "copied";
      } finally {
        // Launchers report spawn, not completion; 10 seconds covers repeat taps without blocking later retries.
        if (running) inFlight.set(instanceId, Date.now() + 10000);
        else inFlight.delete(instanceId);
      }
    });
    inFlight.set(instanceId, result);
    return result;
  });
  // The install window writes the marker when a step fails; the row's probe asks here.
  ipcMain.handle("engine:install-failed", async (event, instanceId) => {
    check(event, instanceId);
    const marker = current.get(instanceId);
    const failed = Boolean(marker && existsSync(marker));
    sweep(instanceId);
    // A failed window offers Try Again, so it must not wait out the repeat-tap window.
    if (failed && !(inFlight.get(instanceId) instanceof Promise)) inFlight.delete(instanceId);
    return failed;
  });
}
