import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureInstallProcesses, stageUpdateScript, stopInstallProcesses } from "./update-processes.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startUpdateProgress(script, manifest) {
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-File", script, "-Mode", "Progress", "-Manifest", manifest],
    { windowsHide: true, detached: true, stdio: "ignore", cwd: path.dirname(script) });
  child.unref();
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
}

export function createUpdateHandoff({ userData, version, message, log, platform = process.platform, packaged = true,
  stage = stageUpdateScript, capture = captureInstallProcesses, stop = stopInstallProcesses, start = startUpdateProgress,
  temporary = os.tmpdir(), sleep = wait, now = Date.now }) {
  const record = () => path.join(userData(), "update-progress.json");
  let running = null;

  function completeProgress(cancelled = false) {
    if (platform !== "win32" || !packaged) return;
    try {
      const saved = JSON.parse(readFileSync(record(), "utf8"));
      const directory = path.resolve(saved.directory);
      if ((!cancelled && saved.from === version()) || path.dirname(directory) !== path.resolve(temporary) || !path.basename(directory).startsWith("wink-update-")) return;
      writeFileSync(path.join(directory, "complete"), "");
      unlinkSync(record());
    } catch {
      // No update handoff on an ordinary launch.
    }
  }

  async function prepare() {
    const directory = mkdtempSync(path.join(temporary, "wink-update-"));
    const ready = path.join(directory, "ready");
    const complete = path.join(directory, "complete");
    const manifest = path.join(directory, "progress.json");
    let started = false;
    try {
      const script = stage(directory);
      writeFileSync(manifest, JSON.stringify({ directory, ready, complete, message: message() }));
      await start(script, manifest);
      started = true;
      const deadline = now() + 15_000;
      while (!existsSync(ready)) {
        if (now() >= deadline) throw new Error("Update progress window unavailable");
        await sleep(50);
      }
      let snapshot = null;
      try { snapshot = await capture({ script }); }
      catch (error) { log(`update snapshot unavailable: ${error.message}`); }
      writeFileSync(record(), JSON.stringify({ directory, from: version() }));
      return { directory, script, snapshot, complete };
    } catch (error) {
      if (started) writeFileSync(complete, "");
      else rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  return {
    run(updating, cleanup) {
      if (!updating || platform !== "win32" || !packaged) return cleanup();
      // A repeated app.quit joins the same handoff rather than starting another installer.
      running ??= (async () => {
        let handoff;
        try { handoff = await prepare(); } catch (error) { log(`update handoff unavailable: ${error.message}`); }
        await cleanup();
        if (handoff?.snapshot) {
          try { await stop({ ...handoff, log: path.join(userData(), "logs", "updater.log") }); }
          catch (error) { log(`update cleanup incomplete: ${error.message}`); }
        }
        log("update handoff ready; starting installer");
      })();
      return running;
    },
    finish() {
      completeProgress();
    },
    cancel() {
      completeProgress(true);
    },
  };
}
