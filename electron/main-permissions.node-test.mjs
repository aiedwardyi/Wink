import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { setMainPermissions } = require("./main-permissions.cjs");
const { setDevicePermissions } = require("./device-permissions.cjs");

const APP = "http://127.0.0.1:4317";
const main = { id: "main" };
const other = { id: "other" };

function mainHandlers(micAllowed = () => true) {
  const handlers = {};
  setMainPermissions({
    setPermissionCheckHandler: (fn) => { handlers.check = fn; },
    setPermissionRequestHandler: (fn) => { handlers.request = fn; },
  }, { contents: () => main, origin: () => APP, micAllowed });
  return handlers;
}

function request(handler, contents, permission, details) {
  const decisions = [];
  handler(contents, permission, (decision) => decisions.push(decision), details);
  return decisions;
}

test("main process applies the main permissions to the default session", () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('const { setMainPermissions } = require("./main-permissions.cjs");'));
  assert.ok(/setMainPermissions\(session\.defaultSession, \{\s*contents: \(\) => mainWindow\?\.webContents,\s*origin: rendererOrigin,/.test(source));
});

test("main window's app origin gets the microphone", () => {
  const { check, request: req } = mainHandlers();
  assert.equal(check(main, "media", APP, { mediaType: "audio" }), true);
  assert.deepEqual(request(req, main, "media", { mediaTypes: ["audio"], requestingUrl: `${APP}/chat/atlas` }), [true]);
});

for (const [name, contents, details] of [
  ["camera", main, { mediaTypes: ["video"], requestingUrl: `${APP}/` }],
  ["camera with mic", main, { mediaTypes: ["audio", "video"], requestingUrl: `${APP}/` }],
  ["no media types", main, { mediaTypes: [], requestingUrl: `${APP}/` }],
  ["another origin", main, { mediaTypes: ["audio"], requestingUrl: "https://example.com/" }],
  ["another window", other, { mediaTypes: ["audio"], requestingUrl: `${APP}/` }],
  ["no window", null, { mediaTypes: ["audio"], requestingUrl: `${APP}/` }],
]) {
  test(`main session refuses media for ${name}`, () => {
    assert.deepEqual(request(mainHandlers().request, contents, "media", details), [false]);
  });
}

test("main session checks refuse video and other windows", () => {
  const { check } = mainHandlers();
  assert.equal(check(main, "media", APP, { mediaType: "video" }), false);
  assert.equal(check(other, "media", APP, { mediaType: "audio" }), false);
  assert.equal(check(main, "media", "https://example.com", { mediaType: "audio" }), false);
});

test("Windows mic privacy off refuses the main window", () => {
  assert.deepEqual(request(mainHandlers(() => false).request, main, "media", { mediaTypes: ["audio"], requestingUrl: `${APP}/` }), [false]);
});

test("main session keeps every other permission as before", () => {
  const { check, request: req } = mainHandlers();
  assert.equal(check(other, "notifications", APP, {}), true);
  assert.deepEqual(request(req, other, "clipboard-sanitized-write", {}), [true]);
});

test("device windows and verify sessions still refuse the main window's microphone", () => {
  const handlers = {};
  setDevicePermissions({
    setPermissionCheckHandler: (fn) => { handlers.check = fn; },
    setPermissionRequestHandler: (fn) => { handlers.request = fn; },
  }, { origin: () => undefined, micAllowed: () => true });
  assert.equal(handlers.check(main, "media", APP, { mediaType: "audio" }), false);
  assert.deepEqual(request(handlers.request, main, "media", { mediaTypes: ["audio"], requestingUrl: `${APP}/` }), [false]);
  const verify = readFileSync(new URL("./verify-network.mjs", import.meta.url), "utf8");
  assert.ok(verify.includes("ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));"));
});
