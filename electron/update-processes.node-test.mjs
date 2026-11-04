import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureInstallProcesses, installCleanupTargets, installDescendants, stopInstallProcesses } from "./update-processes.mjs";

const root = { pid: 10, ppid: 1, created: "100", name: "Orbit.exe", exe: "C:\\Wink\\Orbit.exe" };
const row = (pid, ppid, created, name = "Orbit.exe", exe = "C:\\Wink\\Orbit.exe", command = "") => ({ pid, ppid, created: String(created), name, exe, command });

test("cleanup walks through engines outside the install folder and keeps only allowlisted installed images", () => {
  const rows = [root, row(11, 10, 110, "node.exe", "C:\\tools\\node.exe"), row(12, 11, 120),
    row(13, 10, 130, "OpenConsole.exe", "c:\\wink\\resources\\terminal\\OpenConsole.exe"),
    row(14, 10, 140, "unknown.exe", "C:\\Wink\\unknown.exe"), row(15, 10, 150, "Orbit.exe", "C:\\Wink-other\\Orbit.exe"),
    row(16, 1, 160), row(17, 10, 170, "Orbit.exe", "C:\\Wink\\Orbit.exe", "--type=renderer")];
  const tree = installDescendants(rows.reverse(), root);
  assert.deepEqual(installCleanupTargets(tree, "C:\\Wink").map((item) => item.pid).sort(), [12, 13]);
});

test("cleanup rejects PID reuse, unknown creation times, missing roots and unrelated namesakes", () => {
  const rows = [root, row(11, 10, 90), row(12, 11, 120), row(13, 99, 130), { ...row(14, 10, 0), created: null }];
  assert.deepEqual(installDescendants(rows, root), []);
  assert.deepEqual(installDescendants(rows, { ...root, created: "80" }), []);
  assert.deepEqual(installDescendants(rows, { ...root, exe: "C:\\Other\\Orbit.exe" }), []);
});

test("cleanup retains recorded orphans after their engine exits and captures late descendants", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "update-process-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const run = async (_script, args) => {
    calls.push(args);
    if (args[1] === "Snapshot") return JSON.stringify([root, row(15, 10, 150)]);
  };
  const snapshot = { root, tree: [row(11, 10, 110, "node.exe", "C:\\tools\\node.exe"), row(12, 11, 120)] };
  await stopInstallProcesses({ snapshot, script: "script", directory, log: "updater.log", run });
  const manifest = JSON.parse(readFileSync(path.join(directory, "processes.json"), "utf8"));
  assert.deepEqual(manifest.targets.map((item) => item.pid).sort(), [12, 15]);
  assert.equal(manifest.tree.some((item) => item.pid === 11), true);
  assert.equal("command" in manifest.targets[0], false);
  assert.deepEqual(calls[1].slice(0, 2), ["-Mode", "Cleanup"]);
});

test("capture requires the running app's own image and PID", async () => {
  await assert.rejects(captureInstallProcesses({ script: "script", pid: 10, exe: root.exe,
    run: async () => JSON.stringify([row(10, 1, 100, "Orbit.exe", "C:\\Other\\Orbit.exe")]) }), /root unavailable/);
});

test("native cleanup checks ancestry, image, creation time and parent before terminating the opened handle", () => {
  const script = readFileSync(new URL("./update-handoff.ps1", import.meta.url), "utf8");
  assert.match(script, /\$ancestor\.created -lt \[long\]\$parent\.created/);
  assert.match(script, /\$ticks -ne \[long\]\$saved\.created/);
  assert.match(script, /\$live\.ParentProcessId -ne \$saved\.ppid/);
  assert.match(script, /\$live\.ExecutablePath -ine \$saved\.exe/);
  assert.match(script, /\$allowed -inotcontains \$saved\.name/);
  assert.ok(script.indexOf("Add-Content -LiteralPath $Log") < script.indexOf("[UpdateProcess]::TerminateProcess($handle, 1)"));
  assert.doesNotMatch(script, /Stop-Process|taskkill/);
});
