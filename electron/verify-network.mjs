import fs from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { createVerifyFonts } from "./verify-fonts.mjs";

const installed = new WeakSet();
export const VERIFY_PAGE_PREFERENCES = Object.freeze({
  sandbox: true, contextIsolation: true, webSecurity: true, nodeIntegration: false,
  nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false,
  allowRunningInsecureContent: false, spellcheck: false, devTools: false, backgroundThrottling: false,
});

function localUrl(raw, origin) {
  try { const url = new URL(raw); return url.origin === origin && !url.username && !url.password && url.protocol === "http:"; }
  catch { return false; }
}

function denyPermissions(ses, contents, listen) {
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: false });
  const device = (event, _details, callback) => { event.preventDefault(); callback(); };
  listen(ses, "select-hid-device", device);
  listen(ses, "select-serial-port", device);
  listen(contents, "select-bluetooth-device", (event, _devices, callback) => { event.preventDefault(); callback(""); });
  listen(ses, "will-download", (event) => event.preventDefault());
  listen(ses, "login", (event, _details, _info, callback) => { event.preventDefault(); callback(); });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  listen(contents, "will-prevent-unload", (event) => event.preventDefault());
  contents.setAudioMuted(true);
}

export async function isolatePage(ses, contents, { origin, fontUrls = [], logLookup = () => {}, fonts: sharedFonts }) {
  if (installed.has(ses) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || ses.getPreloadScripts().length) throw new Error("Invalid verify session");
  installed.add(ses);
  const listeners = [];
  const listen = (target, name, handler) => { target.on(name, handler); listeners.push(() => target.off(name, handler)); };
  const blocked = new Set();
  const fonts = sharedFonts ?? createVerifyFonts({ fontUrls, logLookup });
  const sockets = new Set();
  const deny = createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); socket.destroy(); });
  let closing;
  const close = () => closing ??= (async () => {
    for (const remove of listeners.splice(0)) remove();
    for (const name of ["onBeforeRequest", "onBeforeSendHeaders", "onHeadersReceived"]) ses.webRequest[name](null);
    try { await ses.protocol.unhandle("https"); } catch {}
    if (!sharedFonts) fonts.close();
    for (const socket of sockets) socket.destroy();
    if (deny.listening) await new Promise((resolve) => deny.close(resolve));
    installed.delete(ses);
  })();
  try {
    denyPermissions(ses, contents, listen);
    for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"]) listen(contents, name, (event, target) => {
      if (!localUrl(typeof target === "string" ? target : target?.url ?? event.url, origin)) event.preventDefault();
    });
    ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      const allow = localUrl(details.url, origin) && ["GET", "HEAD"].includes(details.method) || details.method === "GET" && fonts.allowed(details.url);
      if (!allow && blocked.size < 2000) blocked.add(details.url.slice(0, 4096));
      callback({ cancel: !allow });
    });
    ses.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => callback({ requestHeaders: Object.fromEntries(Object.entries(details.requestHeaders).filter(([key]) => !["cookie", "authorization", "proxy-authorization", "referer"].includes(key.toLowerCase()))) }));
    ses.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
      const allowEval = localUrl(details.url, origin) && Object.entries(details.responseHeaders ?? {}).some(([key, value]) => key.toLowerCase() === "x-orbit-verify-loopback" && value.length === 1 && value[0] === "1");
      if (allowEval && Object.entries(details.responseHeaders ?? {}).some(([key, value]) => key.toLowerCase() === "x-orbit-verify-blocked" && value[0] === "1")) {
        if (blocked.size < 2000) blocked.add(details.url.slice(0, 4096));
        callback({ cancel: true }); return;
      }
      const headers = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([key]) => !["set-cookie", "x-dns-prefetch-control", "content-security-policy"].includes(key.toLowerCase())));
      headers["X-DNS-Prefetch-Control"] = ["off"];
      headers["Content-Security-Policy"] = [`default-src 'none'; script-src 'self' 'unsafe-inline'${allowEval ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; media-src 'self' blob:; manifest-src 'self'; connect-src 'self'; font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; frame-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`];
      callback({ responseHeaders: headers });
    });
    await ses.protocol.handle("https", async (request) => {
      const response = await fonts.handle(request);
      if (response.status !== 200 && blocked.size < 2000) blocked.add(request.url.slice(0, 4096));
      return response;
    });
    await new Promise((resolve, reject) => { deny.once("error", reject); deny.listen(0, "127.0.0.1", resolve); });
    await ses.setProxy({ mode: "fixed_servers", proxyRules: `http://127.0.0.1:${deny.address().port}`, proxyBypassRules: `<-loopback>;${origin}` });
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.setZoomFactor(1);
    await contents.setVisualZoomLevelLimits(1, 1);
    for (const url of [origin, "http://127.0.0.1:9", "http://169.254.169.254", "https://fixture.invalid", "ws://fixture.invalid"]) {
      const proxy = await ses.resolveProxy(url);
      if (url === origin ? proxy !== "DIRECT" : proxy.includes("DIRECT") || !proxy.includes("PROXY")) throw new Error("Verify proxy is not fail closed");
    }
    return { blockedUrls: () => [...blocked], close, counts: () => ({ sockets: sockets.size, servers: deny.listening ? 1 : 0, listeners: listeners.length }) };
  } catch (err) { await close(); throw err; }
}

export async function isolateWall(ses, contents, stageUrl) {
  if (installed.has(ses) || ses.getPreloadScripts().length) throw new Error("Invalid wall session");
  installed.add(ses);
  const base = new URL("./", stageUrl);
  const types = { "stage.html": "text/html", "stage.js": "text/javascript", "overlay.js": "text/javascript", "overlay.css": "text/css", "geometry.js": "text/javascript", "strings.js": "text/javascript", "camera.js": "text/javascript", "beat.wav": "audio/wav", "CascadiaMono.ttf": "font/ttf" };
  const files = new Map(Object.entries(types).map(([name, type]) => [new URL(name, base).href, type]));
  const csp = "default-src 'none'; script-src file:; style-src file: 'unsafe-inline'; font-src file:; media-src file:; img-src data:; connect-src file:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const listeners = [];
  const listen = (target, name, handler) => { target.on(name, handler); listeners.push(() => target.off(name, handler)); };
  denyPermissions(ses, contents, listen);
  contents.setAudioMuted(false);
  for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"]) listen(contents, name, (event, target) => {
    if ((typeof target === "string" ? target : target?.url ?? event.url) !== stageUrl) event.preventDefault();
  });
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => callback({ cancel: details.method !== "GET" || !files.has(details.url) && !/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(details.url) }));
  await ses.protocol.handle("file", async (request) => {
    if (request.method !== "GET" || !files.has(request.url)) return new Response(null, { status: 403 });
    try { return new Response(await fs.readFile(fileURLToPath(request.url)), { headers: { "content-type": files.get(request.url), "content-security-policy": csp, "cache-control": "no-store" } }); }
    catch { return new Response(null, { status: 404 }); }
  });
  let closing;
  return { close: () => closing ??= (async () => {
    for (const remove of listeners.splice(0)) remove();
    ses.webRequest.onBeforeRequest(null);
    await ses.protocol.unhandle("file");
    installed.delete(ses);
  })() };
}
