// Laps the worker host's start (entry and its first import) into the log named by argv[2].
import fs from "node:fs";
const log = process.argv[2];
const lap = (what) => `try { __fs.appendFileSync(${JSON.stringify(log)}, new Date().toISOString() + " " + process.pid + " " + ${JSON.stringify(what)} + "\\n"); } catch {}`;
const patch = (file, pairs) => {
  let text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  for (const [a, b] of pairs) { if (!text.includes(a)) throw new Error(file + " anchor: " + a.slice(0, 60)); text = text.replace(a, () => b); }
  fs.writeFileSync(file, text);
};
const gateHead = "export const spawnGate";
patch("electron/spawn-gate.mjs", [[gateHead, 'import __fs from "node:fs";\nif (process.argv[1]?.endsWith("worker-host-entry.mjs")) { ' + lap("gate module") + ' }\n' + gateHead]]);
const imports = 'import { WORKER_HOST_PROTOCOL, keepRing, sameProof, textChunks, workerHostPeer, workerHostProof } from "./worker-host-protocol.mjs";\n';
patch("electron/worker-host-entry.mjs", [
  [imports, imports + 'const __fs = fs;\n' + lap("entry body") + "\n"],
  ['const config = workerHostRecord(file("launch.json"));\n', 'const config = workerHostRecord(file("launch.json"));\n' + lap("config read") + "\n"],
  ['try { holdWorkerHostLock(file("host.lock")); } catch { refuse("Another worker host holds this slot"); }\n', 'try { holdWorkerHostLock(file("host.lock")); } catch { ' + lap("lock refused") + ' refuse("Another worker host holds this slot"); }\n' + lap("locked") + "\n"],
  ['server.listen(config.pipe, () => {\n', lap("listen") + '\nserver.listen(config.pipe, () => {\n  ' + lap("listening") + "\n"],
]);
console.log("host laps ->", log);
