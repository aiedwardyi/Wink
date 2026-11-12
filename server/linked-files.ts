// Linked media may leave the bot's output roots, excluding private and system folders.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, join, parse, relative } from "node:path";
import { pipeline } from "node:stream";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { windowsPathLinks } from "../shared/windows-path-links.ts";
import { apiRequestAuthorized } from "./remote-access.ts";

const MEDIA = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  pdf: "application/pdf",
} as const;

type MediaExt = keyof typeof MEDIA;

function isMediaExt(value: string): value is MediaExt {
  return Object.hasOwn(MEDIA, value);
}

const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const GRANT_KEY = randomBytes(32);
const GRANT_MS = 60 * 60_000;
const FOLDER_FILES = 200;
const SYSTEM_NAMES = new Set(["desktop.ini", "thumbs.db"]);

export interface LinkedMessage {
  id: string;
  role?: string;
  text?: string;
  fromBotId?: string;
}

export interface ServeLinkedFileOptions {
  bearerOk: boolean;
  remoteKey: string | undefined;
  /** A valid phone session on a relay request; see requestCredentials. */
  phoneSession?: boolean;
  threadId: string;
  messages: readonly LinkedMessage[];
  deviceId: string;
  writerDeviceId(messageId: string): string | null;
  rootsFor(message: LinkedMessage): readonly string[];
}

interface LinkedFolderFile {
  name: string;
  path: string;
  size: number;
  modified: number;
}

function sendJson(res: ServerResponse, status: number, body: { error: string; deviceId?: string; reason?: "outside" } | { files: LinkedFolderFile[]; more: number }): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "private, no-store",
  });
  res.end(data);
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function mediaType(filePath: string): (typeof MEDIA)[MediaExt] | null {
  const name = basename(filePath);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return isMediaExt(ext) ? MEDIA[ext] : null;
}

function absolutePath(value: string): string | null {
  if (value.startsWith("/") && WINDOWS_PATH.test(value.slice(1))) return value.slice(1);
  if (value.startsWith("/") || WINDOWS_PATH.test(value)) return value;
  return null;
}

function decodeHref(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function localFilePath(href: string): string | null {
  if (/^file:\/\//i.test(href)) {
    try {
      return absolutePath(decodeURIComponent(new URL(href).pathname));
    } catch {
      return null;
    }
  }
  return absolutePath(decodeHref(href.replace(/[#?].*$/, "")));
}

function resolveRelativePath(href: string, base: string): string | null {
  const root = absolutePath(base);
  if (!root || /^[#?]/.test(href)) return null;
  let rel = href.replace(/[#?].*$/, "");
  try {
    rel = decodeURIComponent(rel);
  } catch { /* keep the raw target */ }
  const win = WINDOWS_PATH.test(root);
  const drive = win ? `${root.slice(0, 2)}\\` : "/";
  const parts = root.slice(win ? 3 : 1).split(/[\\/]+/).filter(Boolean);
  const depth = parts.length;
  for (const seg of rel.split(/[\\/]+/)) {
    if (seg === "..") {
      if (parts.length === depth) return null;
      parts.pop();
    } else if (seg && seg !== ".") parts.push(seg);
  }
  return drive + parts.join(win ? "\\" : "/");
}

function linkUrls(text: string): string[] {
  let tree: ReturnType<typeof fromMarkdown>;
  try {
    tree = fromMarkdown(text, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown(), windowsPathLinks],
    });
  } catch {
    return [];
  }
  const defs = new Map<string, string>();
  const urls: string[] = [];
  const refs: string[] = [];
  const walk = (node: typeof tree | (typeof tree)["children"][number]) => {
    if (node.type === "code" || node.type === "inlineCode") return;
    if (node.type === "definition") defs.set(node.identifier, node.url);
    else if (node.type === "link" || node.type === "image") urls.push(node.url);
    else if (node.type === "linkReference" || node.type === "imageReference") refs.push(node.identifier);
    if ("children" in node) for (const child of node.children) walk(child);
  };
  walk(tree);
  for (const id of refs) {
    const url = defs.get(id);
    if (url) urls.push(url);
  }
  return urls;
}

function linkTargets(text: string, roots: readonly string[]): string[] {
  const targets: string[] = [];
  for (const dest of linkUrls(text)) {
    const local = localFilePath(dest);
    if (local) {
      targets.push(local);
      continue;
    }
    if (SCHEME.test(dest)) continue;
    for (const root of roots) {
      const resolved = resolveRelativePath(dest, root);
      if (resolved) targets.push(resolved);
    }
  }
  return targets;
}

function nameForms(filePath: string): string[] {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  return name ? [...new Set([name, encodeURI(name), encodeURIComponent(name)])] : [];
}

// A bot may escape only the spaces of a Korean name, which is none of nameForms.
function decodedRuns(text: string): string {
  return text.includes("%") ? text.replace(/(?:%[0-9a-f]{2})+/gi, decodeHref) : text;
}

function contentDisposition(name: string, attachment: boolean): string {
  const fallback = name.replace(/[^\x20-\x7E]/g, "_").replaceAll("\\", "_").replaceAll("\"", "") || "file";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${attachment ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function samePath(a: string, b: string): boolean {
  const slash = (value: string) => value.replaceAll("\\", "/");
  const left = slash(a);
  const right = slash(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function insideRoot(real: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    if (/^[\\/]{2}/.test(root)) return false;
    try {
      const from = relative(realpathSync(root), real);
      return from !== "" && !from.startsWith("..") && !isAbsolute(from);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) console.warn("linked file: root check failed", root, error);
      return false;
    }
  });
}

function outsideMedia(real: string): boolean {
  if (!mediaType(real) || /^[\\/]{2}/.test(real)) return false;
  const normalized = real.replaceAll("\\", "/").toLowerCase();
  if (normalized.split("/").some((part) => part.startsWith(".") || part === "appdata")) return false;
  return !systemFolder(real);
}

function systemFolder(real: string): boolean {
  const normalized = real.replaceAll("\\", "/").toLowerCase();
  const system = [
    process.env.WINDIR, process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData,
    ...["Windows", "Program Files", "Program Files (x86)", "ProgramData"].map((folder) => join(parse(real).root, folder)),
  ];
  return system.some((root) => {
    if (!root) return false;
    let canonical = root;
    try { canonical = realpathSync(root); } catch { /* folder may not exist */ }
    const prefix = canonical.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

function listable(name: string): boolean {
  return name !== "" && !name.startsWith(".") && !name.startsWith("~$") && !SYSTEM_NAMES.has(name.toLowerCase());
}

/** The real path of a linked folder inside one of its message's roots, or null. */
function folderGrant(folder: string, roots: readonly string[]): string | null {
  try {
    const real = realpathSync(folder);
    const root = roots.find((root) => insideRoot(real, [root]));
    if (!root || !statSync(real).isDirectory() || systemFolder(real)) return null;
    // A root may be a whole home folder, whose dot folders and AppData stay private.
    const from = relative(realpathSync(root), real).split(/[\\/]/);
    return from.some((part) => part.startsWith(".") || part.toLowerCase() === "appdata") ? null : real;
  } catch {
    return null;
  }
}

function linkingMessages(options: ServeLinkedFileOptions, target: string, folder = false): { id: string; roots: readonly string[] }[] {
  const forms = nameForms(target);
  const hits: { id: string; roots: readonly string[] }[] = [];
  for (const message of options.messages) {
    if (message.role !== undefined && message.role !== "bot") continue;
    const text = message.text ?? "";
    // Parsing every message of a long chat took seconds; only a message naming the file can link it.
    if (!forms.some((form) => text.includes(form)) && !(forms[0] && decodedRuns(text).includes(forms[0]))) continue;
    const roots = options.rootsFor(message);
    if (!linkTargets(text, roots).some((link) => samePath(folder ? link.replace(/[\\/]+$/, "") : link, target))) continue;
    hits.push({ id: message.id, roots });
  }
  return hits;
}

function byteRange(header: string | undefined, size: number): { start: number; end: number } | "all" | "bad" {
  if (!header) return "all";
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return "bad";
  let start: number;
  let end: number;
  if (match[1] === "" && match[2] !== "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return "bad";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (match[1] !== "") {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  } else return "bad";
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return "bad";
  return { start, end: Math.min(end, size - 1) };
}

function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string, size: number, mime: string, attachment = false, scope?: string): void {
  const range = byteRange(header(req.headers.range), size);
  if (range === "bad") {
    res.writeHead(416, { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });
    res.end();
    return;
  }
  const start = range === "all" ? 0 : range.start;
  const end = range === "all" ? size - 1 : range.end;
  const status = range === "all" ? 200 : 206;
  const shared: OutgoingHttpHeaders = {
    "content-type": mime,
    "content-length": String(end - start + 1),
    "accept-ranges": "bytes",
    "cache-control": "private",
    "x-content-type-options": "nosniff",
    "content-disposition": contentDisposition(basename(filePath), attachment),
  };
  if (scope && mime === "text/html; charset=utf-8") shared["content-security-policy"] = htmlPolicy(req, scope);
  else if (scope) {
    // Fonts and module scripts load in CORS mode from the page's opaque origin.
    shared["content-security-policy"] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
    shared["access-control-allow-origin"] = "*";
  }
  res.writeHead(status, status === 206 ? { ...shared, "content-range": `bytes ${start}-${end}/${size}` } : shared);
  if (size === 0) {
    res.end();
    return;
  }
  // An unread 'error' from the file stream is uncaught and kills the utility process.
  pipeline(createReadStream(filePath, { start, end }), res, (error) => {
    if (error) res.destroy();
  });
}

function grant(threadId: string, filePath: string, expires = Date.now() + GRANT_MS): string {
  return `${expires.toString(36)}.${createHmac("sha256", GRANT_KEY).update(`${threadId}\n${filePath}\n${expires}`).digest("base64url")}`;
}

function grantValid(threadId: string, filePath: string, value: string): boolean {
  const expires = Number.parseInt(value, 36);
  if (!(expires > Date.now())) return false;
  const got = Buffer.from(value);
  const want = Buffer.from(grant(threadId, filePath, expires));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** `path` must be the parsed pathname the router matches, so `..` cannot carry a grant to another route. */
export function linkedFileGrant(method: string | undefined, path: string): boolean {
  const match = /^\/api\/threads\/([\w-]+)\/linked-file\/([^/]+)\/([^/]+)\//.exec(path);
  if (method !== "GET" || !match) return false;
  try {
    return grantValid(match[1]!, decodeURIComponent(match[2]!), match[3]!);
  } catch {
    return false;
  }
}

export function serveLinkedFile(req: IncomingMessage, res: ServerResponse, options: ServeLinkedFileOptions): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const prefix = `/api/threads/${encodeURIComponent(options.threadId)}/linked-file/`;
  const scoped = url.pathname.startsWith(prefix);
  if (!scoped && !options.phoneSession && !apiRequestAuthorized(options.bearerOk, header(req.headers.cookie), options.remoteKey, url.pathname)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  let requested = url.searchParams.get("path") ?? "";
  let key = "";
  let asset = "";
  if (scoped) {
    try {
      const parts = (req.url ?? "").split("?")[0]!.slice(prefix.length).split("/");
      requested = decodeURIComponent(parts.shift() ?? "");
      key = parts.shift() ?? "";
      asset = parts.map(decodeURIComponent).join("/");
      if (!/\.html?$/i.test(requested) || !grantValid(options.threadId, requested, key) || asset.split(/[\\/]/).some((part) => part.startsWith(".")) ||
          /[\\:\0]/.test(asset) || asset.startsWith("/") || (asset !== "" && !(mediaType(asset) ?? assetType(asset)))) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
    } catch {
      sendJson(res, 404, { error: "not found" });
      return;
    }
  }
  // UNC and device paths can block realpath on a network share.
  if (!requested || /^[\\/]{2}/.test(requested) || requested.startsWith("\\\\?\\") || requested.startsWith("\\\\.\\")) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  let hits = linkingMessages(options, requested);
  // A file directly inside a linked folder counts as linked.
  const folder = hits.length || !listable(basename(requested)) ? "" : dirname(requested);
  if (folder) hits = linkingMessages(options, folder, true);
  if (!hits.length) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  let real: string | null = null;
  try {
    real = realpathSync(requested);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
  }
  if (!real) {
    const writer = hits.map((hit) => options.writerDeviceId(hit.id)).find((id) => id && id !== options.deviceId && DEVICE_ID.test(id));
    sendJson(res, 404, writer ? { error: "not found", deviceId: writer } : { error: "not found" });
    return;
  }
  const roots = hits.flatMap((hit) => hit.roots);
  if (folder) {
    const parent = folderGrant(folder, roots);
    if (!parent || !samePath(dirname(real), parent) || !listable(basename(real))) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
  }
  const inRoot = insideRoot(real, roots);
  if (!inRoot && !outsideMedia(real)) {
    let file = false;
    try { file = statSync(real).isFile(); } catch { /* file disappeared */ }
    sendJson(res, 404, file ? { error: "not found", reason: "outside" } : { error: "not found" });
    return;
  }
  const html = /\.html?$/i.test(requested) && /\.html?$/i.test(real);
  if (scoped) {
    let file = false;
    try { file = statSync(real).isFile(); } catch { /* file disappeared */ }
    if (!html || !file) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (asset) {
      const folder = dirname(real);
      try {
        real = realpathSync(join(folder, asset));
      } catch {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (!insideRoot(real, [folder]) || !insideRoot(real, roots) ||
          relative(folder, real).split(/[\\/]/).some((part) => part.startsWith(".") && part !== ".pnpm")) {
        sendJson(res, 404, { error: "not found" });
        return;
      }
    }
  }
  let size = 0;
  try {
    const stat = statSync(real);
    if (!stat.isFile()) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    size = stat.size;
  } catch {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  if (html && !scoped) {
    res.writeHead(302, { location: `${prefix}${encodeURIComponent(requested)}/${grant(options.threadId, requested)}/`, "cache-control": "private, no-store" });
    res.end();
    return;
  }
  const filePath = asset || requested;
  const mime = (inRoot ? mediaType(filePath) : mediaType(real)) ?? (html || asset ? assetType(filePath) : null);
  sendFile(req, res, real, size, mime ?? "application/octet-stream", mime === null, scoped ? `${prefix}${encodeURIComponent(requested)}/${key}/` : undefined);
}

export function serveLinkedFolder(req: IncomingMessage, res: ServerResponse, options: ServeLinkedFileOptions): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!options.phoneSession && !apiRequestAuthorized(options.bearerOk, header(req.headers.cookie), options.remoteKey, url.pathname)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  const requested = (url.searchParams.get("path") ?? "").replace(/(?<=.)[\\/]+$/, "");
  // UNC and device paths can block realpath on a network share.
  const roots = /^[\\/]{2}/.test(requested) ? [] : linkingMessages(options, requested, true).flatMap((hit) => hit.roots);
  const real = roots.length ? folderGrant(requested, roots) : null;
  let entries: Dirent[] | null = null;
  try {
    if (real) entries = readdirSync(real, { withFileTypes: true });
  } catch { /* folder disappeared */ }
  if (!real || !entries) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const files: LinkedFolderFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !listable(entry.name)) continue;
    try {
      const stat = statSync(join(real, entry.name));
      files.push({ name: entry.name, path: join(requested, entry.name), size: stat.size, modified: stat.mtimeMs });
    } catch { /* file disappeared */ }
  }
  files.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  sendJson(res, 200, { files: files.slice(0, FOLDER_FILES), more: Math.max(0, files.length - FOLDER_FILES) });
}

function htmlPolicy(req: IncomingMessage, scope: string): string {
  const host = new URL(`http://${header(req.headers.host) ?? "127.0.0.1"}`).host;
  const sources = `http://${host}${scope} https://${host}${scope}`;
  // Never allow-same-origin: the page would share Wink's storage and session. Its files ride the grant.
  return `sandbox allow-scripts; default-src ${sources}; script-src ${sources} 'unsafe-inline'; style-src ${sources} 'unsafe-inline'; img-src ${sources} data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://${host} https://${host}`;
}

function assetType(filePath: string): string | null {
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
    svg: "image/svg+xml", ico: "image/x-icon", json: "application/json", wasm: "application/wasm",
    woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  };
  const ext = basename(filePath).split(".").pop()?.toLowerCase() ?? "";
  return Object.hasOwn(types, ext) ? types[ext]! : null;
}
