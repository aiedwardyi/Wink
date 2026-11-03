import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const { watchDeviceLoad } = require("./device-window.cjs");
const { sameDesktopViewerOrigin } = require("./desktop-viewer.cjs");
const ORIGIN = "https://home.tail1234.ts.net";
const OTHER = "https://work.tail1234.ts.net";
const DEVICE_URL = `${ORIGIN}/`;

function completionFixture() {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = main.indexOf("devices.webRequest.onCompleted(");
  const end = main.indexOf('win.on("page-title-updated"', start);
  assert.ok(start >= 0 && end > start);
  const deviceWindows = new Map();
  const deviceLinkPages = new WeakMap();
  const deviceLoads = new WeakMap();
  const windows = [ORIGIN, OTHER].map((origin, id) => {
    const win = {
      loads: [],
      isDestroyed: () => false,
      webContents: { id, getURL: () => `${origin}/` },
      loadURL(target) { this.loads.push(target); return Promise.resolve(); },
    };
    deviceWindows.set(origin, win);
    deviceLinkPages.set(win, `data:pairing-${id}`);
    return win;
  });
  let complete;
  runInNewContext(main.slice(start, end), {
    devices: { webRequest: { onCompleted: (_filter, listener) => { complete = listener; } } },
    deviceWindows, deviceLinkPages, deviceLoads, sameDesktopViewerOrigin,
    url: new URL(`${OTHER}/`),
  });
  return { complete, windows, deviceLoads };
}

test("a 401 from another origin never replaces the device page with pairing", () => {
  const { complete, windows } = completionFixture();
  for (const resourceType of ["image", "xhr", "fetch", "subFrame"]) {
    complete({ statusCode: 401, webContentsId: 0, resourceType, url: "https://images.example/private.png" });
  }
  assert.deepEqual(windows.flatMap((win) => win.loads), []);
  complete({ statusCode: 401, webContentsId: 0, resourceType: "mainFrame", url: DEVICE_URL });
  assert.deepEqual(windows[0].loads, ["data:pairing-0"]);
});

test("a device-origin API 401 redirects a stale session to pairing", () => {
  for (const resourceType of ["fetch", "xhr"]) {
    const { complete, windows } = completionFixture();
    complete({ statusCode: 401, webContentsId: 0, resourceType, url: `${ORIGIN}/api/threads` });
    assert.deepEqual(windows[0].loads, ["data:pairing-0"]);
    assert.deepEqual(windows[1].loads, []);
  }
});

test("pairing uses the requesting window's stored device origin", () => {
  const { complete, windows, deviceLoads } = completionFixture();
  const refused = [];
  deviceLoads.set(windows[0], { refused: (url) => refused.push(url) });
  for (const url of [`${OTHER}/`, `${ORIGIN}:8443/`, "https://foreign.example/", "not a URL"]) {
    complete({ statusCode: 401, webContentsId: 0, resourceType: "mainFrame", url });
  }
  assert.deepEqual(windows.flatMap((win) => win.loads), []);
  for (const [webContentsId, url] of [[0, DEVICE_URL], [1, `${OTHER}/remote?key=test`]]) {
    complete({ statusCode: 401, webContentsId, resourceType: "mainFrame", url });
  }
  assert.deepEqual(windows[0].loads, ["data:pairing-0"]);
  assert.deepEqual(windows[1].loads, ["data:pairing-1"]);
  complete({ statusCode: 403, webContentsId: 0, resourceType: "image", url: DEVICE_URL });
  assert.deepEqual(refused, []);
  complete({ statusCode: 403, webContentsId: 0, resourceType: "mainFrame", url: DEVICE_URL });
  assert.deepEqual(refused, [DEVICE_URL]);
});

function recoveryFixture() {
  const timeouts = new Map();
  const intervals = new Map();
  let nextTimer = 0;
  const contents = new EventEmitter();
  contents.url = "";
  contents.loads = [];
  contents.isDestroyed = () => false;
  contents.isCrashed = () => false;
  contents.getURL = () => contents.url;
  const navigate = (url, mainFrame = true, inPlace = false) => {
    contents.emit("did-start-navigation", {}, url, inPlace, mainFrame);
  };
  const commit = (url, code = 200) => {
    contents.url = url;
    contents.emit("did-navigate", {}, url, code);
  };
  contents.loadURL = (url) => {
    contents.loads.push(url);
    navigate(url);
    if (url.startsWith("data:")) commit(url, -1);
    return Promise.resolve();
  };
  const watch = watchDeviceLoad(contents, {
    host: new URL(DEVICE_URL).hostname,
    url: DEVICE_URL,
    failurePage: "data:failure",
    log() {},
    setTimeout: (fn, ms) => { const id = ++nextTimer; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn, ms) => { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => intervals.delete(id),
  });
  const tick = () => {
    assert.equal(intervals.size, 1);
    const [{ fn, ms }] = intervals.values();
    assert.equal(ms, 10_000);
    fn();
  };
  const fail = () => contents.emit("did-fail-load", {}, -118, "ERR_CONNECTION_TIMED_OUT", DEVICE_URL, true);
  const expire = () => {
    assert.equal(timeouts.size, 1);
    const [id, { fn, ms }] = timeouts.entries().next().value;
    assert.equal(ms, 8_000);
    timeouts.delete(id);
    fn();
  };
  const exhaust = () => {
    fail();
    for (let i = 0; i < 12; i += 1) { tick(); fail(); }
    assert.equal(intervals.size, 0);
    assert.equal(contents.loads.filter((url) => url === DEVICE_URL).length, 12);
  };
  return { contents, watch, timeouts, intervals, navigate, commit, tick, fail, expire, exhaust };
}

test("reopening an exhausted device starts a fresh bounded retry cycle", () => {
  const f = recoveryFixture();
  f.exhaust();
  f.watch.reloadIfStuck();
  f.fail();
  assert.equal(f.intervals.size, 1);
  for (let i = 0; i < 12; i += 1) { f.tick(); f.fail(); }
  assert.equal(f.intervals.size, 0);
  assert.equal(f.contents.loads.filter((url) => url === DEVICE_URL).length, 25);
});

test("the failure page's manual retry gets a new budget and an 8 s watchdog", () => {
  const f = recoveryFixture();
  f.exhaust();
  f.navigate(DEVICE_URL);
  f.expire();
  assert.equal(f.contents.loads.at(-1), "data:failure");
  assert.equal(f.intervals.size, 1);
});

test("a manual retry during recovery resets the automatic retry budget", () => {
  const f = recoveryFixture();
  f.fail();
  for (let i = 0; i < 8; i += 1) { f.tick(); f.fail(); }
  f.navigate(DEVICE_URL);
  f.fail();
  for (let i = 0; i < 11; i += 1) { f.tick(); f.fail(); }
  assert.equal(f.intervals.size, 1);
  f.tick();
  f.fail();
  assert.equal(f.intervals.size, 0);
});

test("each automatic attempt gets a fresh cancellable commit timeout", () => {
  const f = recoveryFixture();
  f.fail();
  for (let i = 0; i < 3; i += 1) {
    f.tick();
    f.expire();
    assert.equal(f.contents.loads.at(-1), "data:failure");
  }
  f.tick();
  assert.equal(f.timeouts.size, 1);
  f.commit(DEVICE_URL);
  assert.equal(f.timeouts.size, 0);
  assert.equal(f.intervals.size, 0);
  f.navigate(DEVICE_URL);
  assert.equal(f.timeouts.size, 1);
  f.contents.emit("destroyed");
  assert.equal(f.timeouts.size, 0);
});

test("only remote main-frame navigations replace the current attempt's timeout", () => {
  const f = recoveryFixture();
  f.commit(DEVICE_URL);
  f.navigate(`${ORIGIN}/remote?key=test`);
  assert.equal(f.timeouts.size, 1);
  const timer = [...f.timeouts.keys()];
  f.navigate(DEVICE_URL, false);
  f.navigate(`${DEVICE_URL}#chat`, true, true);
  assert.deepEqual([...f.timeouts.keys()], timer);
  f.navigate("data:pairing");
  assert.equal(f.timeouts.size, 0);
});
