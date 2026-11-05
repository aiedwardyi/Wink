import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { prepareVerifyProbe } from "./verify-probe-bootstrap.mjs";

const scratch = path.join(os.tmpdir(), "wink-lv0-host");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    const relative = path.relative(fs.realpathSync.native(scratch), fs.realpathSync.native(root));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Unsafe test cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "bootstrap-test-"));
  roots.push(root);
  const paths = {};
  const app = new EventEmitter();
  app.setPath = (name, value) => { paths[name] = value; };
  const env = { OMB_VERIFY_PROBE_ROOT: root, FAKE_PROVIDER_KEY: "secret", OMB_PORT: "8799", SYSTEMROOT: "C:\\Windows" };
  return { app, env, paths, root };
}

it("isolates app and environment paths before startup and removes inherited credentials", () => {
  const f = fixture();
  const probe = prepareVerifyProbe(f);
  for (const name of ["home", "appData", "userData", "sessionData", "temp", "logs", "crashDumps"]) {
    expect(f.paths[name].startsWith(probe.root + path.sep)).toBe(true);
  }
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "OMB_DATA_DIR"]) {
    expect(f.env[name].startsWith(probe.root + path.sep)).toBe(true);
  }
  expect(f.env.FAKE_PROVIDER_KEY).toBeUndefined();
  expect(f.env.OMB_PORT).toBeUndefined();
  expect(f.env.SYSTEMROOT).toBe("C:\\Windows");
});

it("rejects relative, device and outside-scratch roots", () => {
  for (const root of ["relative", "C:relative", "\\\\server\\share", "\\\\?\\C:\\scratch", path.dirname(scratch)]) {
    expect(() => prepareVerifyProbe({ app: {}, env: {}, root })).toThrow();
  }
});

it("validates the explicit child probe scale", () => {
  for (const scale of ["1", "1.25", "1.5", "2"]) {
    const f = fixture();
    f.env.OMB_VERIFY_PROBE_SCALE = scale;
    expect(prepareVerifyProbe(f).scale).toBe(Number(scale));
  }
  expect(prepareVerifyProbe(fixture()).scale).toBeNull();
  for (const scale of ["", "3", "1.0", "NaN"]) {
    const f = fixture();
    f.env.OMB_VERIFY_PROBE_SCALE = scale;
    expect(() => prepareVerifyProbe(f)).toThrow();
  }
});

it("guards reveal, focus, opacity, bounds and mouse paths before navigation", () => {
  const probe = prepareVerifyProbe(fixture());
  const calls = [];
  const win = new EventEmitter();
  for (const method of ["show", "showInactive", "focus", "moveTop", "restore", "setOpacity", "setBounds", "setPosition", "setFocusable", "setSkipTaskbar", "setIgnoreMouseEvents", "hide"]) {
    win[method] = (...args) => { calls.push([method, ...args]); };
  }
  probe.guardWindow(win);
  calls.length = 0;
  win.show();
  win.focus();
  win.restore();
  win.setOpacity(1);
  win.setBounds({ x: 10, y: 10, width: 1280, height: 720 });
  win.setPosition(1, 2);
  win.setFocusable(true);
  win.setSkipTaskbar(false);
  win.setIgnoreMouseEvents(false);
  expect(calls).toEqual([
    ["setOpacity", 0],
    ["setBounds", { x: -32000, y: -32000, width: 1280, height: 720 }],
    ["setPosition", -32000, -32000],
    ["setFocusable", false],
    ["setSkipTaskbar", true],
    ["setIgnoreMouseEvents", true],
  ]);
});
