import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateWorkerHostDirectory } from "./worker-host-identity.mjs";

const source = fileURLToPath(new URL("./", import.meta.url));
const modules = ["worker-host-entry.mjs", "worker-host-protocol.mjs", "worker-host-identity.mjs", "worker-host-windows.ps1", "worker-host-screen.mjs", "terminal-host.mjs", "terminal-pty.mjs", "terminal-screen.mjs", "terminal-worker.mjs", "terminal-mailbox.mjs", "worker-session.mjs", "worker-resume.mjs", "pane-runs.mjs", "pane-cleanup.mjs", "terminal-bridge.mjs", "error-report-capture.mjs"];

export async function pinWorkerHostRuntime({ root, executable = process.execPath, ptyModule }) {
  const hash = createHash("sha256").update(process.arch).update(process.versions.modules);
  for (const file of modules) hash.update(file).update(fs.readFileSync(path.join(source, file)));
  hash.update(fs.readFileSync(path.join(source, "../shared/error-report.mjs")));
  hash.update(fs.readFileSync(executable));
  const runtimeFiles = process.platform === "win32" ? fs.readdirSync(path.dirname(executable), { withFileTypes: true })
    .filter((item) => item.isFile() && /\.(?:dll|dat|bin)$/i.test(item.name)).map((item) => item.name).sort() : [];
  for (const file of runtimeFiles) hash.update(file).update(fs.readFileSync(path.join(path.dirname(executable), file)));
  const ptyRoot = path.dirname(ptyModule);
  const ptyPackage = path.basename(ptyRoot) === "lib" ? path.dirname(ptyRoot) : ptyRoot;
  const inventory = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) inventory(file);
      else if (item.isFile()) hash.update(path.relative(ptyPackage, file)).update(fs.readFileSync(file));
    }
  };
  inventory(ptyPackage);
  const fingerprint = hash.digest("hex");
  const destination = path.join(root, `r-${fingerprint.slice(0, 12)}`);
  const result = { executable: path.join(destination, process.platform === "win32" ? "WinkWorker.exe" : "worker-node"), entry: path.join(destination, "electron", "worker-host-entry.mjs"), ptyModule: path.join(destination, "node-pty", "lib", "index.js"), fingerprint };
  if (fs.existsSync(path.join(destination, "complete.json"))) {
    if (JSON.parse(fs.readFileSync(path.join(destination, "complete.json"), "utf8")).fingerprint !== fingerprint) throw new Error("Background work unavailable");
    return result;
  }
  await privateWorkerHostDirectory(root);
  const staging = path.join(root, `staging-${randomUUID()}`);
  fs.mkdirSync(path.join(staging, "electron"), { recursive: true });
  fs.mkdirSync(path.join(staging, "shared"));
  for (const file of modules) fs.copyFileSync(path.join(source, file), path.join(staging, "electron", file));
  fs.copyFileSync(path.join(source, "../shared/error-report.mjs"), path.join(staging, "shared", "error-report.mjs"));
  fs.copyFileSync(executable, path.join(staging, path.basename(result.executable)));
  for (const file of runtimeFiles) fs.copyFileSync(path.join(path.dirname(executable), file), path.join(staging, file));
  if (process.platform !== "win32") fs.chmodSync(path.join(staging, path.basename(result.executable)), 0o700);
  fs.cpSync(ptyPackage, path.join(staging, "node-pty"), { recursive: true, dereference: true });
  fs.writeFileSync(path.join(staging, "complete.json"), JSON.stringify({ fingerprint }), { mode: 0o600 });
  fs.renameSync(staging, destination);
  return result;
}
