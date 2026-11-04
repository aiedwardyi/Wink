import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ALLOWED = new Set(["orbit.exe", "openconsole.exe", "conhost.exe", "node.exe", "pwsh.exe", "powershell.exe", "cloudflared.exe"]);
const normalized = (file) => path.win32.resolve(file).toLowerCase();

export function installDescendants(rows, root) {
  const anchor = rows.find((row) => row.pid === root.pid && row.created === root.created && normalized(row.exe || "") === normalized(root.exe));
  if (!anchor) return [];
  const tree = new Map([[anchor.pid, anchor]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      const parent = tree.get(row.ppid);
      if (!parent || tree.has(row.pid) || !row.created || BigInt(row.created) < BigInt(parent.created)) continue;
      tree.set(row.pid, row);
      grew = true;
    }
  }
  return [...tree.values()].filter((row) => row.pid !== root.pid);
}

export function installCleanupTargets(tree, installDir) {
  const prefix = normalized(installDir) + "\\";
  return tree.filter((row) => row.exe && normalized(row.exe).startsWith(prefix) && ALLOWED.has(row.name.toLowerCase())
    // Electron owns these until app.quit; killing them drops the updating page.
    && !/--type=/.test(row.command || "")).reverse();
}

function powershellFile(file, args) {
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    execFile(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
      { windowsHide: true, cwd: path.dirname(file), timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export function stageUpdateScript(directory) {
  const script = path.join(directory, "update-handoff.ps1");
  writeFileSync(script, readFileSync(new URL("./update-handoff.ps1", import.meta.url)));
  return script;
}

export async function captureInstallProcesses({ script, pid = process.pid, exe = process.execPath, run = powershellFile }) {
  const rows = JSON.parse(await run(script, ["-Mode", "Snapshot"]));
  const root = rows.find((row) => row.pid === pid && row.exe && normalized(row.exe) === normalized(exe));
  if (!root) throw new Error("Update cleanup root unavailable");
  return { root, tree: installDescendants(rows, root) };
}

export async function stopInstallProcesses({ snapshot, script, directory, log, run = powershellFile }) {
  const rows = JSON.parse(await run(script, ["-Mode", "Snapshot"]));
  const tree = [...snapshot.tree, ...installDescendants(rows, snapshot.root)];
  const targets = [...new Map(installCleanupTargets(tree, path.win32.dirname(snapshot.root.exe)).map((row) => [`${row.pid}:${row.created}`, row])).values()];
  const manifest = path.join(directory, "processes.json");
  const identity = ({ pid, ppid, name, exe, created }) => ({ pid, ppid, name, exe, created });
  writeFileSync(manifest, JSON.stringify({ root: identity(snapshot.root), tree: tree.map(identity), targets: targets.map(identity) }));
  await run(script, ["-Mode", "Cleanup", "-Manifest", manifest, "-Log", log]);
}
