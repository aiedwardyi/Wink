import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { setDevicePermissions } = require("./device-permissions.cjs");

function deviceHandlers() {
  const handlers = {};
  setDevicePermissions({
    setPermissionCheckHandler: (fn) => { handlers.check = fn; },
    setPermissionRequestHandler: (fn) => { handlers.request = fn; },
  });
  return handlers;
}

test("main process applies the device permissions to PC windows", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.ok(main.includes('const { setDevicePermissions } = require("./device-permissions.cjs");'));
  assert.ok(main.includes("setDevicePermissions(devices);"));
});

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
