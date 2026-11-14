import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { spawnGate, startProcess } from "./spawn-gate.mjs";
import { writeWorkerHostRecord } from "./worker-host-identity.mjs";

const SOURCES = ["worker-host-entry.mjs", "worker-host-protocol.mjs", "worker-host-identity.mjs", "terminal-pty.mjs", "spawn-gate.mjs"];
const STALE_STAGING_MS = 60 * 60_000;
const digest = (parts) => createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
const complete = (layer) => fs.existsSync(path.join(layer, "complete.json"));

async function tree(base, folder) {
  const files = [];
  const items = await fs.promises.readdir(path.join(base, folder), { withFileTypes: true }).catch(() => []);
  for (const item of items.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(folder, item.name);
    if (item.isDirectory()) files.push(...await tree(base, relative));
    else if (item.isFile() && !/\.(?:map|pdb|test\.js)$/i.test(item.name)) files.push(relative);
  }
  return files;
}

async function layer(root, final, write) {
  if (complete(final)) return false;
  const staging = path.join(root, `staging-${randomUUID()}`);
  await fs.promises.mkdir(staging, { recursive: true });
  try {
    await write(staging);
    await fs.promises.writeFile(path.join(staging, "complete.json"), "{}");
    if (!complete(final)) {
      await fs.promises.rm(final, { recursive: true, force: true });
      await fs.promises.rename(staging, final);
    }
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  return true;
}

/** Copies the runtime out of the app folder. The key comes from names and sizes, never file contents. */
export async function stageWorkerHostRuntime({ root, executable, ptyModule, sources }) {
  const exeFolder = path.dirname(executable);
  const ptyFolder = path.dirname(ptyModule);
  const ptyPackage = path.basename(ptyFolder) === "lib" ? path.dirname(ptyFolder) : ptyFolder;
  const siblings = (await fs.promises.readdir(exeFolder)).filter((name) => /\.(?:dll|dat|bin)$/i.test(name)).sort();
  const pty = ["package.json", ...await tree(ptyPackage, "lib"), ...await tree(ptyPackage, "build"), ...await tree(ptyPackage, path.join("prebuilds", `${process.platform}-${process.arch}`))];
  const copies = [
    [executable, "WinkWorker.exe"],
    ...siblings.map((name) => [path.join(exeFolder, name), name]),
    ...pty.map((name) => [path.join(ptyPackage, name), path.join("node-pty", name)]),
  ];
  const sizes = await Promise.all(copies.map(async ([from, to]) => `${to} ${(await fs.promises.stat(from)).size}`));
  const version = process.versions.electron ? `e${process.versions.electron}` : `n${process.versions.node}`;
  const bin = path.join(root, `bin-${version}-${process.arch}-${digest(sizes)}`);
  const js = path.join(root, `js-${digest(sources.flat())}`);
  await fs.promises.mkdir(root, { recursive: true });
  const staged = {
    bin: await layer(root, bin, async (staging) => {
      for (const [from, to] of copies) {
        await fs.promises.mkdir(path.dirname(path.join(staging, to)), { recursive: true });
        await fs.promises.copyFile(from, path.join(staging, to));
      }
    }),
    js: await layer(root, js, async (staging) => {
      for (const [name, text] of sources) await fs.promises.writeFile(path.join(staging, name), text);
    }),
  };
  return { bin, js, staged, executable: path.join(bin, "WinkWorker.exe"), entry: path.join(js, SOURCES[0]), ptyModule: path.join(bin, "node-pty", path.relative(ptyPackage, ptyModule)) };
}

/** Removes layers nobody runs from: a rename fails while a live host still uses one. */
export async function sweepWorkerHostRuntime(root, keep) {
  for (const name of await fs.promises.readdir(root).catch(() => [])) {
    const target = path.join(root, name);
    if (keep.includes(target) || !/^(?:bin|js|staging|trash)-/.test(name)) continue;
    try {
      if (name.startsWith("staging-") && Date.now() - (await fs.promises.stat(target)).mtimeMs < STALE_STAGING_MS) continue;
      const trash = name.startsWith("trash-") ? target : path.join(root, `trash-${randomUUID()}`);
      if (trash !== target) await fs.promises.rename(target, trash);
      await fs.promises.rm(trash, { recursive: true, force: true });
    } catch {}
  }
}

/** Stages and starts the host from a worker thread, so the main thread never copies or spawns. */
export async function launchWorkerHost({ root, executable, ptyModule, slot, launch, env }) {
  const sources = await Promise.all(SOURCES.map(async (name) => [name, await fs.promises.readFile(fileURLToPath(new URL(name, import.meta.url)), "utf8")]));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { workerHostLaunch: { root, executable, ptyModule, slot, launch, env, sources, gate: spawnGate } } });
    worker.once("message", (message) => message.error ? reject(new Error(message.error)) : resolve(message));
    worker.once("error", reject);
    worker.once("exit", () => reject(new Error("Worker host launch stopped")));
  });
}

if (!isMainThread && workerData?.workerHostLaunch) {
  const { root, slot, launch, env, gate, ...input } = workerData.workerHostLaunch;
  try {
    const runtime = await stageWorkerHostRuntime({ root, ...input });
    writeWorkerHostRecord(path.join(slot, "launch.json"), { ...launch, ptyModule: runtime.ptyModule });
    // A freshly copied exe takes seconds to start once; that run happens here, so no terminal waits for it at the gate.
    await new Promise((resolve) => spawn(runtime.executable, ["--version"], { windowsHide: true, stdio: "ignore", cwd: runtime.bin, env }).once("exit", resolve).once("error", resolve));
    const child = startProcess(gate, () => spawn(runtime.executable, [runtime.entry, slot], { detached: true, windowsHide: true, stdio: "ignore", cwd: runtime.bin, env }));
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    parentPort.postMessage({ pid: child.pid, staged: runtime.staged });
    await sweepWorkerHostRuntime(root, [runtime.bin, runtime.js]);
  } catch (error) {
    parentPort.postMessage({ error: error?.message ?? String(error) });
  }
}
