import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { setDevicePermissions } = require("./device-permissions.cjs");

const HOME = "https://home.tail1234.ts.net";
const device = { id: "device" };
const other = { id: "other" };

function deviceHandlers(micAllowed = () => true) {
  const handlers = {};
  setDevicePermissions({
    setPermissionCheckHandler: (fn) => { handlers.check = fn; },
    setPermissionRequestHandler: (fn) => { handlers.request = fn; },
  }, { origin: (contents) => (contents === device ? HOME : undefined), micAllowed });
  return handlers;
}

function request(handler, contents, permission, details) {
  const decisions = [];
  handler(contents, permission, (decision) => decisions.push(decision), details);
  return decisions;
}

test("main process applies the device permissions to PC windows", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.ok(main.includes('const { setDevicePermissions } = require("./device-permissions.cjs");'));
  assert.equal(main.split("setDevicePermissions(devices, { origin: deviceOrigin, micAllowed });").length, 3);
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

test("device window's own page gets the microphone", () => {
  const { check, request: req } = deviceHandlers();
  assert.equal(check(device, "media", HOME, { mediaType: "audio" }), true);
  assert.deepEqual(request(req, device, "media", { mediaTypes: ["audio"], requestingUrl: `${HOME}/chat/atlas` }), [true]);
});

for (const [name, contents, details] of [
  ["camera", device, { mediaTypes: ["video"], requestingUrl: `${HOME}/` }],
  ["camera with mic", device, { mediaTypes: ["audio", "video"], requestingUrl: `${HOME}/` }],
  ["no media types", device, { mediaTypes: [], requestingUrl: `${HOME}/` }],
  ["another origin", device, { mediaTypes: ["audio"], requestingUrl: "https://work.tail1234.ts.net/" }],
  ["another window", other, { mediaTypes: ["audio"], requestingUrl: `${HOME}/` }],
]) {
  test(`device session refuses media for ${name}`, () => {
    assert.deepEqual(request(deviceHandlers().request, contents, "media", details), [false]);
  });
}

test("device session checks refuse video, other origins and other windows", () => {
  const { check } = deviceHandlers();
  assert.equal(check(device, "media", HOME, { mediaType: "video" }), false);
  assert.equal(check(device, "media", "https://work.tail1234.ts.net", { mediaType: "audio" }), false);
  assert.equal(check(other, "media", HOME, { mediaType: "audio" }), false);
});

test("Windows mic privacy off refuses the device window", () => {
  assert.deepEqual(request(deviceHandlers(() => false).request, device, "media", { mediaTypes: ["audio"], requestingUrl: `${HOME}/` }), [false]);
});
