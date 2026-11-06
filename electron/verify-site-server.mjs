import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
};
const PRIVATE = /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig(?:\..*)?\.json|(?:vite|webpack|eslint|postcss|tailwind)\.config\..*|(?:credentials?|secrets?|tokens?)(?:[._-].*)?)$/i;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const error = code => Object.assign(new Error(code), { code });
const inside = (root, path) => path === root || path.startsWith(root + sep);
const identity = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
function safeRelative(path) {
  // Paths enter through the bridge and raw HTTP request boundary.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  return typeof path === "string" && path.length > 0 && !/[\\:%\x00-\x1f\x7f]/.test(path) && path.split("/").every(p => p && !p.startsWith(".") && !/[. ]$/.test(p) && !PRIVATE.test(p));
}
async function canonical(root, entry) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof root !== "string" || !isAbsolute(root) || /^[\\/]{2}/.test(root) || /[\x00-\x1f]/.test(root) || root.slice(2).includes(":") || root.split(/[\\/]/).some(p => p === "." || p === "..")) throw error("not-a-site");
  if (!safeRelative(entry) || !/\.html?$/i.test(entry)) throw error("not-a-site");
  const resolved = resolve(root), path = await realpath(root);
  for (let current = resolved; ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw error("outside-folders");
    if (dirname(current) === current) break;
  }
  if (!(await stat(path)).isDirectory()) throw error("outside-folders");
  return { path, entry };
}
async function opened(root, path) {
  const candidate = join(root, path), canonicalPath = await realpath(candidate);
  if (!inside(root, canonicalPath)) throw error("outside-folders");
  const handle = await open(candidate, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 8 * 1024 * 1024) throw error("resource-limit");
    const now = await stat(await realpath(candidate));
    if (identity(before) !== identity(now) || !inside(root, await realpath(candidate))) throw error("site-changed");
    const bytes = await handle.readFile();
    if (bytes.length > 8 * 1024 * 1024 || identity(before) !== identity(await handle.stat()) || identity(before) !== identity(await stat(candidate))) throw error("site-changed");
    return { bytes, hash: digest(bytes), id: identity(before), canonicalPath };
  } finally { await handle.close(); }
}
async function manifest(root, entry) {
  const { path } = await canonical(root, entry), files = new Map();
  const rootId = identity(await stat(path));
  let total = 0, folders = 0;
  async function walk(dir, prefix = "", ancestors = new Set()) {
    if (++folders > 512) throw error("resource-limit");
    const actual = await realpath(dir);
    if (!inside(path, actual) || ancestors.has(actual)) throw error("outside-folders");
    const next = new Set([...ancestors, actual]);
    for (const name of await readdir(dir)) {
      const rel = prefix + name;
      if (!safeRelative(rel)) throw error("not-a-site");
      const candidate = join(dir, name), real = await realpath(candidate);
      if (!inside(path, real)) throw error("outside-folders");
      const info = await stat(candidate);
      if (info.isDirectory()) { await walk(candidate, rel + "/", next); continue; }
      if (!info.isFile() || !TYPES[extname(name).toLowerCase()]) throw error("not-a-site");
      if (files.size >= 512) throw error("resource-limit");
      const file = await opened(path, rel);
      total += file.bytes.length;
      if (total > 64 * 1024 * 1024) throw error("resource-limit");
      files.set(rel, file);
    }
  }
  await walk(path);
  if (!files.has(entry)) throw error("not-a-site");
  const paths = [...files.keys()].sort();
  return { root: path, rootId, files, revision: digest(JSON.stringify(paths.map(p => [p, files.get(p).hash]))) };
}

export async function siteRevision({ root, entry }) {
  return (await manifest(root, entry)).revision;
}

export async function startSiteServer({ root, entry, revision }) {
  const pinned = await manifest(root, entry);
  if (!/^[a-f0-9]{64}$/.test(revision) || pinned.revision !== revision) throw error("site-changed");
  const fonts = new Set();
  for (const [name, file] of pinned.files) if (/\.(?:html?|css)$/i.test(name)) {
    const text = file.bytes.toString("utf8").replaceAll("&amp;", "&");
    for (const match of text.matchAll(/https:\/\/fonts\.googleapis\.com\/(?:css2?|icon)\?[^\s"'<>)}]+/g)) {
      const url = new URL(match[0]);
      if (url.hostname === "fonts.googleapis.com" && !url.username && !url.password && !url.port && !url.hash) fonts.add(url.href);
    }
  }
  let host, closed = false, changed = false;
  const headers = {
    "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "x-dns-prefetch-control": "off",
    "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
  const server = createServer((req, res) => {
    const reply = (code, extra = {}, bytes) => res.writeHead(code, { ...headers, ...extra }).end(req.method === "HEAD" ? undefined : bytes);
    const serve = async () => {
      if (closed || req.headers.host !== host) return reply(404);
      if (!["GET", "HEAD"].includes(req.method)) return reply(405, { allow: "GET, HEAD" });
      const raw = req.url?.split("?")[0];
      if (!raw?.startsWith("/") || raw.startsWith("//")) return reply(404);
      let rel;
      try { rel = decodeURIComponent(raw.slice(1)); } catch { return reply(404); }
      if (rel === "") rel = entry;
      if (!safeRelative(rel) || !pinned.files.has(rel)) return reply(404);
      const expected = pinned.files.get(rel);
      try {
        if (await realpath(root) !== pinned.root || identity(await stat(root)) !== pinned.rootId) throw error("site-changed");
        const file = await opened(pinned.root, rel);
        if (file.id !== expected.id || file.hash !== expected.hash || file.canonicalPath !== expected.canonicalPath) throw error("site-changed");
        return reply(200, { "content-type": TYPES[extname(rel).toLowerCase()], "content-length": file.bytes.length }, file.bytes);
      } catch { changed = true; return reply(404); }
    };
    serve().catch(() => { changed = true; if (!res.headersSent) reply(404); else res.destroy(); });
  });
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  host = `127.0.0.1:${server.address().port}`;
  const origin = `http://${host}`;
  let closing;
  return {
    origin, url: origin + "/" + entry.split("/").map(encodeURIComponent).join("/"), fontUrls: [...fonts].sort(),
    async revisionUnchanged() {
      try {
        if (changed) return false;
        const current = await manifest(root, entry);
        return current.revision === pinned.revision && current.root === pinned.root && current.rootId === pinned.rootId && [...pinned.files].every(([path, file]) => current.files.get(path)?.id === file.id && current.files.get(path)?.canonicalPath === file.canonicalPath);
      } catch { return false; }
    },
    close() {
      if (!closing) {
        closed = true;
        closing = new Promise(resolve => server.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
      }
      return closing;
    },
  };
}
