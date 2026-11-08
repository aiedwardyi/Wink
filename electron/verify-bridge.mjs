import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { VERIFY_BODY_LIMIT, VERIFY_BRIDGE_ROUTES, VERIFY_GRANT_MAX_MS, VERIFY_GRANT_PREFIX, VERIFY_POLL_MAX_MS, verifyLoopbackUrl } from "./verify-protocol.mjs";

const botPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const runPattern = /^[a-z0-9-]{8,64}$/;
const revisionPattern = /^[a-f0-9]{64}$/;
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const error = (status) => Object.assign(new Error("Invalid verify request"), { status });

function relativeEntry(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\\:%\x00-\x1f]/.test(value) && !value.startsWith("/")
    && value.split("/").every((part) => part && part !== ".." && !part.startsWith(".") && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function canonicalRoot(root) {
  if (verifyLoopbackUrl(root)?.href === root) return true;
  return typeof root === "string" && path.isAbsolute(root) && !/^[\\/]{2}/.test(root) && !/[\x00-\x1f%]/.test(root) && !root.includes(":", 2)
    && path.normalize(root) === root && path.parse(root).root !== root && root.slice(path.parse(root).root.length).split(/[\\/]/).every((p) => p && p !== "." && p !== ".." && !/[. ]$/.test(p));
}

function canonicalSite(root, entry) {
  if (verifyLoopbackUrl(root)?.href === root) return entry === "index.html";
  if (!canonicalRoot(root) || !relativeEntry(entry)) return false;
  try {
    if (fs.realpathSync.native(root) !== root || !fs.statSync(root).isDirectory()) return false;
    const target = fs.realpathSync.native(path.join(root, ...entry.split("/")));
    const relative = path.relative(root, target);
    return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative) && target === path.join(root, ...entry.split("/")) && fs.statSync(target).isFile() && /\.html?$/i.test(entry);
  } catch { return false; }
}

function readBody(req, empty = false) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > VERIFY_BODY_LIMIT) { chunks.length = 0; reject(error(413)); return; }
      chunks.push(chunk);
    });
    req.once("end", () => {
      if (size > VERIFY_BODY_LIMIT) return;
      if (empty && size === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(error(400)); }
    });
    req.once("error", () => reject(error(400)));
    req.once("aborted", () => reject(error(400)));
  });
}

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function routePattern(route) {
  return new RegExp("^" + route.replace(":botId", "([^/]+)").replace(":runId", "([^/]+)") + "$");
}

const routes = Object.entries(VERIFY_BRIDGE_ROUTES).map(([name, route]) => [name, routePattern(route)]);

export function createVerifyBridge({ token, log = () => {}, loadHost = () => import("./verify-host.mjs"), now = Date.now }) {
  const consumed = new Map();
  let loaded;
  let host;
  let closed = false;
  let closing;
  function grant(header, botId, runId) {
    if (typeof header !== "string" || header.length > 16000 || !header.startsWith("Bearer ")) return null;
    const match = header.slice(7).match(/^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]{43})$/);
    if (!match) return null;
    const signature = Buffer.from(match[2], "base64url");
    const expected = createHmac("sha256", token).update(match[1]).digest();
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    let scope;
    try { scope = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")); } catch { return null; }
    if (!Array.isArray(scope) || scope.length !== 7) return null;
    const [domain, owner, id, root, entry, revision, expiry] = scope;
    if (domain !== VERIFY_GRANT_PREFIX || owner !== botId || !botPattern.test(owner) || !runPattern.test(id) || runId && id !== runId || !canonicalRoot(root) || !relativeEntry(entry) || !revisionPattern.test(revision) || !Number.isSafeInteger(expiry) || expiry <= now() || expiry > now() + VERIFY_GRANT_MAX_MS) return null;
    return { botId: owner, runId: id, root, entry, revision, expiry };
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/v1/verify/")) return false;
    const matched = routes.map(([name, regex]) => [name, url.pathname.match(regex)]).find(([, match]) => match);
    if (!matched) { json(res, 404, { error: "not-found" }); return true; }
    const [action, match] = matched;
    const [, botId, runId] = match;
    try {
      if (!botPattern.test(botId) || runId && !runPattern.test(runId)) throw error(400);
      const scope = grant(req.headers.authorization, botId, runId);
      if (!scope) { json(res, 401, { error: "unauthorized" }); return true; }
      if (req.method !== (["poll", "cast"].includes(action) ? "GET" : "POST")) { json(res, 405, { error: "method-not-allowed" }); return true; }
      if (closed) { json(res, 503, { error: "internal" }); return true; }
      for (const [id, previous] of consumed) if (previous.expiry <= now()) consumed.delete(id);
      if (action === "start") {
        const body = await readBody(req);
        if (!record(body) || Object.keys(body).sort().join() !== "entry,revision,root,runId,site,watch" || !runPattern.test(body.runId) || typeof body.site !== "string" || !body.site.trim() || body.site.length > 512 || /[\x00-\x1f]/.test(body.site) || typeof body.watch !== "boolean") throw error(400);
        if (["runId", "root", "entry", "revision"].some((key) => body[key] !== scope[key])) { json(res, 401, { error: "unauthorized" }); return true; }
        if (!canonicalSite(body.root, body.entry)) throw error(400);
        if (scope.expiry <= now()) { json(res, 401, { error: "unauthorized" }); return true; }
        if (consumed.has(body.runId)) { json(res, 409, { error: "busy" }); return true; }
        consumed.set(body.runId, scope);
        loaded ??= loadHost().then((module) => { host = module.createVerifyHost({ log }); return host; });
        const readyHost = await loaded;
        if (closed) { await readyHost.close(); throw error(503); }
        const reply = await readyHost.start({ ...body, botId });
        json(res, 202, reply);
      } else {
        if (!["poll", "cast"].includes(action)) {
          const body = await readBody(req, true);
          if (!record(body) || Object.keys(body).length) throw error(400);
        }
        const stored = consumed.get(runId);
        if (stored && ["botId", "root", "entry", "revision"].some((key) => stored[key] !== scope[key])) { json(res, 401, { error: "unauthorized" }); return true; }
        if (!stored || !host) { json(res, 404, { error: "not-found" }); return true; }
        if (action === "poll") {
          if ([...url.searchParams.keys()].some((key) => !["since", "waitMs"].includes(key))) throw error(400);
          const since = Number(url.searchParams.get("since") ?? -1);
          const waitMs = Number(url.searchParams.get("waitMs") ?? 0);
          if (!Number.isSafeInteger(since) || since < -1 || !Number.isSafeInteger(waitMs) || waitMs < 0) throw error(400);
          json(res, 200, await host.poll(runId, { since, waitMs: Math.min(waitMs, VERIFY_POLL_MAX_MS) }));
        } else if (action === "cast") host.cast(runId, res);
        else json(res, 200, await host[action](runId));
      }
    } catch (err) {
      json(res, err.status ?? 500, { error: err.status === 413 ? "body-too-large" : err.error ?? "invalid-request" });
    }
    return true;
  }
  function close() {
    return closing ??= (async () => {
      closed = true;
      if (!loaded) return;
      let timer;
      try { await Promise.race([loaded.then((value) => value.close()), new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]); }
      catch {} finally { clearTimeout(timer); }
    })();
  }
  return { handle, close };
}
