import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

import { createVerifyFonts } from "./verify-fonts.mjs";
import { isolatePage, isolateWall, VERIFY_PAGE_PREFERENCES } from "./verify-network.mjs";

const cleanup = [];
afterEach(async () => { vi.useRealTimers(); for (const fn of cleanup.splice(0)) await fn(); });
function fixture() {
  const handlers = {}, calls = [];
  const ses = new EventEmitter();
  for (const name of ["setPermissionCheckHandler", "setPermissionRequestHandler", "setDevicePermissionHandler", "setDisplayMediaRequestHandler"]) ses[name] = (...args) => { handlers[name] = args[0]; calls.push([name, ...args]); };
  ses.webRequest = {};
  for (const name of ["onBeforeRequest", "onBeforeSendHeaders", "onHeadersReceived"]) ses.webRequest[name] = (...args) => { handlers[name] = args.at(-1); calls.push([name]); };
  ses.getPreloadScripts = () => [];
  ses.protocol = { handle: async (scheme, fn) => { handlers[scheme] = fn; }, unhandle: async (scheme) => { delete handlers[scheme]; } };
  ses.setProxy = async (value) => { handlers.proxy = value; calls.push(["setProxy"]); };
  ses.resolveProxy = async (url) => url === "http://127.0.0.1:12345" ? "DIRECT" : "PROXY 127.0.0.1:1";
  const contents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: (fn) => { handlers.popup = fn; }, setAudioMuted: (v) => calls.push(["mute", v]),
    setWebRTCIPHandlingPolicy: (v) => calls.push(["rtc", v]), setZoomFactor: (v) => calls.push(["zoom", v]), setVisualZoomLevelLimits: async (...v) => calls.push(["visualZoom", ...v]),
  });
  return { ses, contents, handlers, calls };
}
function callback(fn, ...args) { let value; fn(...args, (v) => { value = v; }); return value; }

it("S01-S08/S10/S16 installs denial, headers, proxy and audio policies before load", async () => {
  const f = fixture(); const guard = await isolatePage(f.ses, f.contents, { origin: "http://127.0.0.1:12345" }); cleanup.push(guard.close);
  expect(VERIFY_PAGE_PREFERENCES).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false, spellcheck: false, devTools: false, backgroundThrottling: false });
  expect(f.handlers.setPermissionCheckHandler(null, "clipboard-read")).toBe(false);
  expect(callback(f.handlers.setPermissionRequestHandler, null, "media")).toBe(false);
  expect(f.handlers.setDevicePermissionHandler({})).toBe(false);
  expect(callback(f.handlers.setDisplayMediaRequestHandler, {})).toEqual({});
  expect(f.calls.find((c) => c[0] === "setDisplayMediaRequestHandler")[2]).toEqual({ useSystemPicker: false });
  const prevented = vi.fn(), selected = vi.fn();
  f.ses.emit("select-hid-device", { preventDefault: prevented }, {}, selected);
  f.ses.emit("select-serial-port", { preventDefault: prevented }, {}, selected);
  f.contents.emit("select-bluetooth-device", { preventDefault: prevented }, [], selected);
  expect(selected.mock.calls).toEqual([[], [], [""]]);
  f.ses.emit("will-download", { preventDefault: prevented });
  expect(prevented).toHaveBeenCalledTimes(4);
  expect(f.handlers.popup({ url: "https://example.invalid" })).toEqual({ action: "deny" });
  for (const url of ["file:///C:/secret", "data:text/html,x", "blob:http://127.0.0.1:12345/x", "orbit:install", "http://127.0.0.1:12346/"]) {
    f.contents.emit("will-navigate", { preventDefault: prevented }, url);
    expect(callback(f.handlers.onBeforeRequest, { url, method: "GET" })).toEqual({ cancel: true });
  }
  expect(callback(f.handlers.onBeforeRequest, { url: "http://127.0.0.1:12345/a#hash", method: "GET" })).toEqual({ cancel: false });
  expect(callback(f.handlers.onBeforeRequest, { url: "http://127.0.0.1:12345/", method: "POST" })).toEqual({ cancel: true });
  expect(callback(f.handlers.onBeforeSendHeaders, { requestHeaders: { Cookie: "fake", AUTHORIZATION: "fake", "Proxy-Authorization": "fake", Referer: "fake", Accept: "ok" } })).toEqual({ requestHeaders: { Accept: "ok" } });
  const headers = callback(f.handlers.onHeadersReceived, { responseHeaders: { "Set-Cookie": ["fake"] } }).responseHeaders;
  expect(headers["Set-Cookie"]).toBeUndefined(); expect(headers["X-DNS-Prefetch-Control"]).toEqual(["off"]);
  expect(f.handlers.proxy).toMatchObject({ mode: "fixed_servers", proxyBypassRules: "<-loopback>;http://127.0.0.1:12345" });
  expect(f.calls).toContainEqual(["mute", true]); expect(f.calls).toContainEqual(["rtc", "disable_non_proxied_udp"]);
  expect(f.calls).toContainEqual(["visualZoom", 1, 1]);
  expect(guard.blockedUrls()).toHaveLength(6);
  await guard.close(); expect(f.ses.listenerCount("will-download")).toBe(0);
});

it("rejects preloads, duplicate partition policies and a DIRECT proxy fallback", async () => {
  const f = fixture(); f.ses.getPreloadScripts = () => [{}];
  await expect(isolatePage(f.ses, f.contents, { origin: "http://127.0.0.1:12345" })).rejects.toThrow();
  const g = fixture(); g.ses.resolveProxy = async () => "DIRECT";
  await expect(isolatePage(g.ses, g.contents, { origin: "http://127.0.0.1:12345" })).rejects.toThrow(/fail closed/);
  expect(g.ses.listenerCount("will-download")).toBe(0);
});

function fontFixture({ status = 200, type = "text/css", body = "@font-face{src:url(https://fonts.gstatic.com/s/pinned.woff2)}", pending = false, length } = {}) {
  const requests = [], lookups = [];
  const fonts = createVerifyFonts({ fontUrls: ["https://fonts.googleapis.com/css2?family=Roboto"], logLookup: (name) => lookups.push(name), lookup: (_name, _options, callback) => callback(null, "127.0.0.1", 4), request(url, options, cb) {
    const req = new EventEmitter(); requests.push({ url, options });
    req.end = () => { if (!pending) queueMicrotask(() => {
      const res = new PassThrough(); res.statusCode = status; res.headers = { "content-type": type, ...(length ? { "content-length": length } : {}) };
      cb(res); if (!res.destroyed) res.end(body);
    }); };
    req.destroy = (err) => req.emit("error", err);
    return req;
  } });
  cleanup.push(fonts.close);
  return { fonts, requests, lookups, request: () => fonts.handle(new Request("https://fonts.googleapis.com/css2?family=Roboto")) };
}

it("S09 admits exact declared sheets and their pinned gstatic URLs without forwarding headers", async () => {
  const f = fontFixture(); expect((await f.request()).status).toBe(200);
  expect(f.fonts.allowed("https://fonts.gstatic.com/s/pinned.woff2")).toBe(true);
  expect(f.fonts.allowed("https://fonts.gstatic.com/s/pinned.woff2?changed")).toBe(false);
  expect((await f.fonts.handle(new Request("https://fonts.googleapis.com/css2?family=Other"))).status).toBe(403);
  expect(f.requests[0].options.headers).toEqual({});
  let error;
  f.requests[0].options.lookup("attacker.invalid", {}, (err) => { error = err; }); expect(error).toBeInstanceOf(Error);
  f.requests[0].options.lookup("fonts.googleapis.com", {}, () => {}); expect(f.lookups).toEqual(["fonts.googleapis.com"]);
});

it.each([{ status: 302 }, { type: "text/html" }, { body: "x".repeat(128 * 1024 + 1) }, { body: "a{src:url(https://attacker.invalid/font.woff2)}" }, { length: 999999 }])("S09 refuses redirect, MIME and byte/URL escapes", async (options) => {
  const f = fontFixture(options); expect((await f.request()).status).toBe(403);
});

it("S09 bounds a stalled request at five seconds", async () => {
  vi.useFakeTimers(); const f = fontFixture({ pending: true }); const request = f.request();
  await vi.advanceTimersByTimeAsync(5001); expect((await request).status).toBe(403);
});

it("S09 shares the eight MiB budget and reports denied pinned URLs", async () => {
  const sheet = "https://fonts.googleapis.com/css2?family=Roboto";
  const urls = Array.from({ length: 4 }, (_, n) => `https://fonts.gstatic.com/s/${n}.woff2`);
  const fonts = createVerifyFonts({ fontUrls: [sheet], request(url, _options, callback) {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response = new PassThrough(); response.statusCode = 200;
      response.headers = { "content-type": url === sheet ? "text/css" : "font/woff2" };
      callback(response); response.end(url === sheet ? urls.map((value) => `a{src:url(${value})}`).join("") : Buffer.alloc(2 * 1024 * 1024));
    });
    req.destroy = (err) => req.emit("error", err); return req;
  } });
  cleanup.push(fonts.close);
  expect((await fonts.handle(new Request(sheet))).status).toBe(200);
  const statuses = [];
  for (const url of urls) statuses.push((await fonts.handle(new Request(url))).status);
  expect(statuses).toEqual([200, 200, 200, 403]);
  const f = fixture();
  const close = vi.fn();
  const guard = await isolatePage(f.ses, f.contents, { origin: "http://127.0.0.1:12345", fonts: { allowed: () => true, handle: async () => new Response(null, { status: 403 }), close } });
  cleanup.unshift(guard.close);
  await f.handlers.https(new Request(sheet)); expect(guard.blockedUrls()).toContain(sheet);
  await guard.close(); expect(close).not.toHaveBeenCalled();
});

it("S14 allows only exact shipped wall files and a restrictive CSP", async () => {
  const f = fixture();
  const scratch = path.join(os.tmpdir(), "wink-lv0-host"); fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "wall-policy-test-")); cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "stage.html"), "<html></html>");
  const url = pathToFileURL(path.join(root, "stage.html")).href;
  const policy = await isolateWall(f.ses, f.contents, url); cleanup.unshift(policy.close);
  const response = await f.handlers.file(new Request(url)); expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("script-src file:");
  expect(response.headers.get("content-security-policy")).toContain("connect-src file:");
  expect(response.headers.get("content-security-policy")).not.toContain("unsafe-eval");
  for (const bad of [url + "?alias", new URL("../secret", url).href, "https://example.invalid/"]) expect(callback(f.handlers.onBeforeRequest, { url: bad, method: "GET" }).cancel).toBe(true);
});
