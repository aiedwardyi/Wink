import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

function bridge(invoke, events = {}) {
  let api;
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, ipcRenderer: { on() {}, invoke, ...events }, webUtils: {} }),
    process: { platform: "win32" }, Error,
  });
  return api;
}

test("updater pushes win over an older subscription snapshot and stop silences late snapshots", async () => {
  let resolve;
  let handler;
  const seen = [];
  const api = bridge(() => new Promise((done) => { resolve = done; }), {
    on(_channel, listener) { handler = listener; }, removeListener() {},
  });
  const stop = api.updater.onState((state) => seen.push(state.status));
  handler(null, { status: "available" });
  resolve({ status: "idle" });
  await Promise.resolve();
  assert.deepEqual(seen, ["available"]);
  stop();
  const stopAgain = api.updater.onState((state) => seen.push(state.status));
  stopAgain();
  resolve({ status: "idle" });
  await Promise.resolve();
  assert.deepEqual(seen, ["available"]);
});

for (const name of ["open", "prestart", "cancelOpen", "write", "acknowledge", "resize", "readBot", "paneLabels", "sendBot", "openBot", "close", "appearance"]) {
  test(`terminal ${name} strips the IPC wrapper`, async () => {
    const api = bridge(async (channel) => { throw new Error(`Error invoking remote method '${channel}': Error: No terminal shell is available`); });
    await assert.rejects(api.terminal[name]("id"), { message: "No terminal shell is available" });
  });
}

test("desktop diagnostics strips the IPC wrapper", async () => {
  const api = bridge(async () => { throw new Error("Error invoking remote method 'desktop:export-diagnostics': Error: Access denied"); });
  await assert.rejects(api.exportDiagnostics(), { message: "Access denied" });
});

test("successful terminal calls keep their arguments and result", async () => {
  const api = bridge(async (...args) => args);
  assert.deepEqual(Array.from(await api.terminal.resize("pane", 80, 24)), ["terminal:resize", "pane", 80, 24]);
});

for (const [name, channel, args] of [
  ["permOpenSettings", "perm:open-settings", ["mic"]],
  ["openEngineInstall", "engine:install", ["engine", true]],
  ["deviceWindow.open", "device-window:open", ["host", "device"]],
  ["openPeerFile", "desktop:open-peer-file", ["host", "thread", "C:/a.docx"]],
  ["readMediaImage", "desktop:read-media-image", ["https://images.example.test/a.png"]],
  ["saveMediaImage", "desktop:save-media-image", ["https://images.example.test/a.png", "photo.png"]],
  ["errorReportConsent", "error-reports:get", []],
  ["setErrorReportConsent", "error-reports:set", [true]],
  ["setCredential", "credential:set", ["provider", "value"]],
  ["getBrand", "desktop:brand", []],
]) {
  const call = (api) => name.split(".").reduce((value, key) => value[key], api)(...args);
  test(`${name} strips the IPC wrapper`, async () => {
    const api = bridge(async () => { throw new Error(`Error invoking remote method '${channel}': Error: Access denied`); });
    await assert.rejects(call(api), { message: "Access denied" });
  });
  test(`${name} keeps its arguments and result`, async () => {
    const api = bridge(async (...input) => input);
    assert.deepEqual(Array.from(await call(api)), [channel, ...args]);
  });
}
