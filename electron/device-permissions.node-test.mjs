import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);

function deviceHandlers() {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = main.indexOf("    const devices = win.webContents.session;");
  const end = main.indexOf("    // One listener per session:", start);
  assert.ok(start >= 0 && end > start, "device permission setup not found");
  const handlers = {};
  const session = {
    setPermissionCheckHandler: (fn) => { handlers.check = fn; },
    setPermissionRequestHandler: (fn) => { handlers.request = fn; },
  };
  const imports = main.match(/^const \{ setDevicePermissions \} = require\("\.\/device-permissions.cjs"\);$/m)?.[0] ?? "";
  runInNewContext(`${imports}\n${main.slice(start, end)}`, { require, win: { webContents: { session } } });
  return handlers;
}

for (const [permission, allowed] of [
  ["fullscreen", true],
  ["clipboard-sanitized-write", true],
  ["media", false],
  ["geolocation", false],
  ["notifications", false],
  ["display-capture", false],
  ["clipboard-read", false],
  ["automatic-fullscreen", false],
  ["unknown", false],
]) {
  test(`device session ${allowed ? "allows" : "denies"} ${permission} in both handlers`, () => {
    const { check, request } = deviceHandlers();
    const checked = check(null, permission, "https://home.tail1234.ts.net", {});
    const decisions = [];
    request(null, permission, (decision) => decisions.push(decision), {});
    assert.deepEqual([checked, ...decisions], [allowed, allowed]);
  });
}
