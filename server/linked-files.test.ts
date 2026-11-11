import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { linkedFileGrant, serveLinkedFile, serveLinkedFolder, type LinkedMessage, type ServeLinkedFileOptions } from "./linked-files.ts";
import { requestCredentials } from "./phone-auth.ts";
import {
  loadThreadSyncLedger,
  markThreadDirty,
  messageWriter,
  pullThread,
  saveThreadSyncLedger,
  uploadThread,
  type LocalThread,
  type ThreadSyncHost,
} from "./thread-sync.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string, parent = tmpdir()): string {
  const root = mkdtempSync(join(parent, prefix));
  roots.push(root);
  return root;
}

function isTcpAddress(address: string | AddressInfo | null): address is AddressInfo {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node's server address is a string for named pipes.
  return address !== null && typeof address !== "string";
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!isTcpAddress(address)) return reject(new Error("no port"));
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

/** Serves a folder whose HTML files a bot linked, to a signed-in client. */
async function linkedSite(files: Record<string, string>) {
  const root = temp("linked-site-");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  const links = Object.keys(files).filter((name) => name.endsWith(".html")).map((name) => `[page](${join(root, name)})`);
  const server = await listen((req, res) => serveLinkedFile(req, res, {
    bearerOk: true, remoteKey: undefined, threadId: "t1", deviceId: "home",
    messages: [{ id: "m1", text: links.join(" ") }],
    writerDeviceId: () => null, rootsFor: () => [root],
  }));
  const open = (name: string) => fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(join(root, name))}`);
  return { root, server, open };
}

/** One PC's thread-sync state in its own scratch data folder. */
function syncedPc(folder: string, deviceId: string) {
  const dataDir = temp(`linked-pc-${deviceId}-`);
  const threads = new Map<string, LocalThread>();
  const host: ThreadSyncHost = {
    folder,
    dataDir,
    deviceId,
    ledger: loadThreadSyncLedger(dataDir),
    saveLedger: () => saveThreadSyncLedger(dataDir, host.ledger),
    local: (threadId) => threads.get(threadId) ?? null,
    running: () => false,
    adopt: (_botId, file) => {
      threads.set(file.task.threadId, {
        title: file.task.title,
        createdAt: file.task.createdAt,
        messages: structuredClone(file.messages),
        activeLeafId: file.activeLeafId,
      });
    },
    remove: (_botId, threadId) => void threads.delete(threadId),
    conflicted: () => {},
    now: () => 1_700_000_000_500,
  };
  return { host, dataDir, threads };
}

describe("linked files", () => {
  it("rejects canonical hidden assets while serving normal and pnpm targets", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const site = await linkedSite({ "index.html": "page", ".secrets.json": "private", "normal.json": "public", ".hidden/data.json": "private", "node_modules/.pnpm/pkg/index.js": "package" });
    try {
      const page = await site.open("index.html");
      expect(page.status).toBe(200);
      const canonical = realpathSync(site.root);
      for (const [target, status, body] of [[".secrets.json", 404, null], [".hidden/data.json", 404, null], ["normal.json", 200, "public"], ["node_modules/.pnpm/pkg/index.js", 200, "package"]] as const) {
        const alias = target.endsWith(".js") ? "public.js" : "public.json";
        vi.mocked(realpathSync).mockImplementation(((path, ...args) => path === join(canonical, alias) ? join(canonical, target) : Reflect.apply(actual.realpathSync, actual, [path, ...args])) as typeof realpathSync);
        const response = await fetch(new URL(alias, page.url));
        expect(response.status, target).toBe(status);
        if (body) expect(await response.text()).toBe(body);
      }
    } finally {
      vi.mocked(realpathSync).mockRestore();
      await site.server.close();
    }
  });
  it("judges a media-named file symlink by its resolved type without Windows link privileges", async () => {
    const root = temp("linked-real-type-", process.cwd());
    const folder = join(root, "bot");
    mkdirSync(folder);
    const alias = join(root, "alias.mp4");
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true, remoteKey: undefined, threadId: "t1", deviceId: "home",
      messages: [{ id: "m1", role: "bot", text: `[video](<${alias}>)` }],
      writerDeviceId: () => null, rootsFor: () => [folder],
    }));
    try {
      for (const ext of ["txt", "exe", "png"]) {
        const target = join(root, `target.${ext}`);
        writeFileSync(target, "private");
        vi.mocked(realpathSync).mockReturnValueOnce(target);
        const response = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(alias)}`, { headers: { Range: "bytes=0-0" } });
        expect(response.status).toBe(ext === "png" ? 206 : 404);
        if (ext === "png") {
          expect(response.headers.get("content-type")).toBe("image/png");
          expect(await response.text()).toBe("p");
        } else expect(await response.json()).toEqual({ error: "not found", reason: "outside" });
      }
    } finally {
      await server.close();
    }
  });

  it.each(["other-PC", "phone"])("streams bot-linked Desktop media outside roots to %s", async (client) => {
    const user = join(temp("linked-anywhere-", process.cwd()), "Users", "mredw");
    const desktop = join(user, "Desktop");
    const folder = join(user, "Projects", "car-advisor");
    mkdirSync(desktop, { recursive: true });
    mkdirSync(folder, { recursive: true });
    const types = [["mp4", "video/mp4"], ["png", "image/png"], ["mp3", "audio/mpeg"], ["pdf", "application/pdf"]];
    const messages = types.map(([ext]) => ({ id: ext!, role: "bot", text: `[demo](<${join(desktop, `demo.${ext}`)}>)` }));
    for (const [ext] of types) writeFileSync(join(desktop, `demo.${ext}`), "0123456789");
    const options = {
      bearerOk: false, remoteKey: client === "other-PC" ? "k" : undefined,
      phoneSession: client === "phone", threadId: "t1", deviceId: "home",
      messages, writerDeviceId: () => null, rootsFor: () => [folder],
    };
    const server = await listen((req, res) => serveLinkedFile(req, res, options));
    try {
      for (const [ext, mime] of types) {
        const response = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(join(desktop, `demo.${ext}`))}`, {
          headers: { cookie: "orbit_remote=k", Range: "bytes=0-0" },
        });
        expect(response.status).toBe(206);
        expect(response.headers.get("content-type")).toBe(mime);
        expect(response.headers.get("content-range")).toBe("bytes 0-0/10");
        expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(await response.text()).toBe("0");
      }
      const unauthenticated = await listen((req, res) => serveLinkedFile(req, res, { ...options, remoteKey: undefined, phoneSession: false }));
      try {
        const denied = await fetch(`${unauthenticated.url}/api/threads/t1/linked-file?path=${encodeURIComponent(join(desktop, "demo.mp4"))}`);
        expect(denied.status).toBe(401);
      } finally {
        await unauthenticated.close();
      }
    } finally {
      await server.close();
    }
  });

  it("keeps unlinked, non-media, hidden, AppData, system, and disguised files outside roots refused", async () => {
    const root = temp("linked-media-policy-", process.cwd());
    const folder = join(root, "bot");
    const desktop = join(root, "Users", "mredw", "Desktop");
    mkdirSync(folder);
    mkdirSync(desktop, { recursive: true });
    const refused = [
      ...["txt", "json", "html", "exe"].map((ext) => join(desktop, `linked.${ext}`)),
      join(desktop, ".hidden", "linked.png"),
      join(desktop, ".linked.png"),
      join(root, "Users", "someone-else", "aPpDaTa", "Local", "linked.mp4"),
      ...["WINDIR", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"].map((name) => join(root, name, "linked.mp4")),
    ];
    for (const name of ["WINDIR", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"]) vi.stubEnv(name, join(root, name));
    const unlinked = join(desktop, "unlinked.mp4");
    for (const path of [...refused, unlinked]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "private");
    }
    const alias = join(desktop, "junction.mp4");
    symlinkSync(dirname(refused[0]!), alias, "junction");
    const disguised = join(alias, "linked.txt");
    const mediaAlias = join(desktop, "appdata.mp4");
    symlinkSync(dirname(refused[6]!), mediaAlias, "junction");
    const secretMedia = join(mediaAlias, "linked.mp4");
    const hiddenAlias = join(desktop, "visible");
    symlinkSync(dirname(refused[4]!), hiddenAlias, "junction");
    const hiddenMedia = join(hiddenAlias, "linked.png");
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true, remoteKey: undefined, threadId: "t1", deviceId: "home",
      messages: [...refused, disguised, secretMedia, hiddenMedia].map((path) => ({ id: path, role: "bot", text: `[file](<${path}>)` })),
      writerDeviceId: () => null, rootsFor: () => [folder],
    }));
    try {
      for (const path of [...refused, disguised, secretMedia, hiddenMedia, unlinked]) {
        const response = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(path)}`, { headers: { Range: "bytes=0-0" } });
        expect(response.status, path).toBe(404);
        expect(await response.json(), path).toEqual(path === unlinked ? { error: "not found" } : { error: "not found", reason: "outside" });
      }
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  });

  it.each(["other-PC", "phone"])("explains a bot-linked Desktop video outside roots to %s without exposing unlinked paths", async (client) => {
    const user = join(temp("linked-desktop-"), "Users", "mredw");
    const desktop = join(user, "Desktop");
    const folder = join(user, "Projects", "car-advisor");
    mkdirSync(desktop, { recursive: true });
    mkdirSync(folder, { recursive: true });
    const file = join(desktop, "donecheck-demo.mp4");
    writeFileSync(file, "video");
    writeFileSync(join(desktop, "unlinked.mp4"), "private");
    mkdirSync(join(desktop, "directory.mp4"));
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: false, remoteKey: client === "other-PC" ? "k" : undefined,
      phoneSession: client === "phone", threadId: "t1", deviceId: "home",
      messages: [file, join(desktop, "missing.mp4"), join(desktop, "directory.mp4")].map((path) => ({ id: path, role: "bot", text: `[video](<${path}>)` })),
      writerDeviceId: () => null, rootsFor: () => [folder],
    }));
    try {
      const get = (path: string) => fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(path)}`, {
        headers: { cookie: "orbit_remote=k", Range: "bytes=0-0" },
      });
      const outside = await get(file);
      expect(outside.status).toBe(404);
      expect(await outside.json()).toEqual({ error: "not found", reason: "outside" });
      for (const name of ["unlinked.mp4", "unknown.mp4", "missing.mp4", "directory.mp4"]) {
        const response = await get(join(desktop, name));
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not found" });
      }
    } finally {
      await server.close();
    }
  });

  it("downloads linked non-media files, including empty files, with the existing auth", async () => {
    const root = temp("linked-download-");
    const names = ["file.zip", "notes.md", "notes.txt", "report.docx", "LICENSE", "empty.zip"];
    for (const name of names) writeFileSync(join(root, name), name === "empty.zip" ? "" : name);
    const options = {
      bearerOk: false, remoteKey: "k", threadId: "t1", deviceId: "home",
      messages: names.map((name) => ({ id: name, text: `[file](${join(root, name)})` })),
      writerDeviceId: () => null, rootsFor: () => [root],
    };
    const server = await listen((req, res) => serveLinkedFile(req, res, options));
    try {
      for (const name of names) {
        const url = `${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(join(root, name))}`;
        const res = await fetch(url, { headers: { cookie: "orbit_remote=k" } });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
        expect(await res.text()).toBe(name === "empty.zip" ? "" : name);
        expect((await fetch(url)).status).toBe(401);
      }
    } finally {
      await server.close();
    }
  });

  it("does not grant file access from a user's link", async () => {
    const root = temp("linked-user-");
    const file = join(root, "notes.png");
    writeFileSync(file, "private");
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true, remoteKey: undefined, threadId: "t1", deviceId: "home",
      messages: [{ id: "m1", role: "user", text: `[notes](${file})` }],
      writerDeviceId: () => null, rootsFor: () => [root],
    }));
    try {
      expect((await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(file)}`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("serves linked HTML and its folder assets without exposing siblings or symlink escapes", async () => {
    const root = temp("linked-html-");
    const site = join(root, "site");
    const outside = join(root, "outside");
    mkdirSync(join(site, "assets"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(site, "index.html"), '<link rel="stylesheet" href="style.css"><script src="assets/app.js"></script><img src="logo.png">');
    writeFileSync(join(site, "style.css"), "@font-face { font-family: body; src: url(assets/body.woff2); } body { color: red; }");
    writeFileSync(join(site, "assets", "app.js"), "document.title = 'ready';");
    writeFileSync(join(site, "assets", "body.woff2"), "font-bytes");
    writeFileSync(join(site, "logo.png"), "png-bytes");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(site, "escape"), "junction");
    const options = {
      bearerOk: false, remoteKey: "k", threadId: "t1", deviceId: "home",
      messages: [{ id: "m1", text: `[site](${join(site, "index.html")})` }],
      writerDeviceId: () => null, rootsFor: () => [root],
    };
    const server = await listen((req, res) => serveLinkedFile(req, res, options));
    const headers = { cookie: "orbit_remote=k" };
    try {
      const page = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(join(site, "index.html"))}`, { headers });
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
      expect(await page.text()).toContain("style.css");
      // The sandboxed page sends no cookie, and its fonts and module scripts send Origin: null.
      const css = await fetch(new URL("style.css", page.url));
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");
      expect(await css.text()).toContain("color: red");
      const js = await fetch(new URL("assets/app.js", page.url));
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("javascript");
      const png = await fetch(new URL("logo.png", page.url));
      expect([png.status, png.headers.get("content-type"), await png.text()]).toEqual([200, "image/png", "png-bytes"]);
      const font = await fetch(new URL("assets/body.woff2", page.url), { headers: { origin: "null" } });
      expect([font.status, font.headers.get("access-control-allow-origin"), await font.text()]).toEqual([200, "*", "font-bytes"]);
      for (const asset of ["%2e%2e%2foutside%2fsecret.txt", "%2e%2e%5coutside%5csecret.txt", "%2foutside%2fsecret.txt", "C%3a%5coutside%5csecret.txt", "escape/secret.txt", "assets/../../outside/secret.txt"]) {
        const denied = await fetch(`${page.url}${asset}`, { headers });
        expect(denied.status, asset).toBe(404);
        expect(await denied.text()).not.toContain("secret");
      }
      const forged = `${server.url}/api/threads/t1/linked-file/${encodeURIComponent(join(outside, "unlinked.html"))}/secret.txt`;
      expect((await fetch(forged, { headers })).status).toBe(404);
      const other = `${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(join(site, "style.css"))}`;
      expect((await fetch(other, { headers })).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("gives a linked page an opaque origin, away from Wink's storage and session", async () => {
    const { server, open } = await linkedSite({ "index.html": "<script>localStorage.getItem('omb-drafts')</script>" });
    try {
      const policy = (await open("index.html")).headers.get("content-security-policy") ?? "";
      expect(policy).toMatch(/^sandbox allow-scripts;/);
      expect(policy).not.toContain("allow-same-origin");
    } finally {
      await server.close();
    }
  });

  it("sandboxes every file beside a linked page, so an svg opened on its own cannot script", async () => {
    const { server, open } = await linkedSite({
      "index.html": '<a href="payload.svg">open</a>',
      "payload.svg": '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/bots")</script></svg>',
      "style.css": "body {}",
    });
    try {
      const page = await open("index.html");
      for (const name of ["payload.svg", "style.css"]) {
        const res = await fetch(new URL(name, page.url));
        expect(res.status, name).toBe(200);
        expect(res.headers.get("content-security-policy"), name).toBe("sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:");
      }
    } finally {
      await server.close();
    }
  });

  it("refuses dotfiles, dot folders and types a page cannot load beside a linked page", async () => {
    const { server, open } = await linkedSite({
      "index.html": "<p>page</p>",
      ".env": "TOKEN=secret",
      ".git/config": "secret",
      ".private/keys.json": "secret",
      "notes.txt": "secret",
    });
    try {
      const page = await open("index.html");
      for (const name of [".env", ".git/config", ".private/keys.json", "notes.txt"]) {
        const res = await fetch(new URL(name, page.url));
        expect(res.status, name).toBe(404);
        expect(await res.text(), name).not.toContain("secret");
      }
    } finally {
      await server.close();
    }
  });

  it("opens a page's folder only with that page's unexpired grant", async () => {
    const { root, server, open } = await linkedSite({ "index.html": "<p>page</p>", "style.css": "body {}", "other/index.html": "<p>other</p>" });
    const scope = `${server.url}/api/threads/t1/linked-file/${encodeURIComponent(join(root, "index.html"))}/`;
    try {
      const grant = (await open("index.html")).url.slice(scope.length, -1);
      const foreign = (await open("other/index.html")).url.split("/").at(-2)!;
      const later = `${(Number.parseInt(grant, 36) + 1).toString(36)}${grant.slice(grant.indexOf("."))}`;
      // The signed-in session alone no longer opens the folder.
      for (const url of [`${scope}style.css`, `${scope}x/style.css`, `${scope}${foreign}/style.css`, `${scope}${later}/style.css`]) {
        expect((await fetch(url)).status, url).toBe(404);
      }
      expect((await fetch(`${scope}${grant}/style.css`)).status).toBe(200);
      const asset = new URL(`${scope}${grant}/style.css`).pathname;
      expect([linkedFileGrant("GET", asset), linkedFileGrant("POST", asset), linkedFileGrant("GET", asset.replace(grant, foreign))]).toEqual([true, false, false]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
      expect((await fetch(`${scope}${grant}/style.css`)).status).toBe(404);
      expect(linkedFileGrant("GET", asset)).toBe(false);
    } finally {
      vi.useRealTimers();
      await server.close();
    }
  });

  it("admits a page's grant at the server's Origin and sign-in gates", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source.includes('!originAllowedByRemote(origin, REMOTE_HOST) && !(origin === "null" && linkedFileGrant(method, path))'), "Origin gate").toBe(true);
    expect(source.includes("!apiRequestAuthorized(credentials.bearerOk, req.headers.cookie, credentials.remoteKey, path) && !linkedFileGrant(method, path)"), "sign-in gate").toBe(true);
  });

  it("refuses an unlinked path, escapes, a file outside the roots, and an unauthenticated request", async () => {
    const root = temp("linked-root-");
    const outside = temp("linked-out-");
    const secret = Buffer.from("secret-bytes");
    const clip = Buffer.from("0123456789abcdef");
    writeFileSync(join(root, "clip.mp4"), clip);
    writeFileSync(join(root, "other.mp4"), Buffer.from("not-linked"));
    writeFileSync(join(root, "notes.md"), Buffer.from("notes"));
    writeFileSync(join(outside, "secret.mp4"), secret);
    symlinkSync(outside, join(root, "escape"), "junction");
    const dotdot = `${root}${sep}..${sep}${basename(outside)}${sep}secret.mp4`;
    const messages: LinkedMessage[] = [
      { id: "m1", text: `[clip](${join(root, "clip.mp4")})` },
      { id: "m2", text: `[notes](${join(root, "notes.md")})` },
      { id: "m3", text: `[out](${join(outside, "secret.mp4")})` },
      { id: "m4", text: `[up](${dotdot})` },
      { id: "m5", text: `[link](${join(root, "escape", "secret.mp4")})` },
    ];
    const options = {
      bearerOk: true,
      remoteKey: "k",
      threadId: "t1",
      messages,
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    };
    const server = await listen((req, res) => serveLinkedFile(req, res, options));
    try {
      const get = (filePath: string) =>
        fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`);
      const unlinked = await get(join(root, "other.mp4"));
      expect(unlinked.status).toBe(404);
      const up = await get(dotdot);
      expect(up.status).toBe(404);
      expect(Buffer.from(await up.arrayBuffer()).includes(secret)).toBe(false);
      const escaped = await get(join(root, "escape", "secret.mp4"));
      expect(escaped.status).toBe(404);
      expect(Buffer.from(await escaped.arrayBuffer()).includes(secret)).toBe(false);
      const outsideRes = await get(join(outside, "secret.mp4"));
      expect(outsideRes.status).toBe(404);
      expect(Buffer.from(await outsideRes.arrayBuffer()).includes(secret)).toBe(false);
      const ext = await get(join(root, "notes.md"));
      expect(ext.status).toBe(200);
      expect(ext.headers.get("content-disposition")).toMatch(/^attachment;/);
      const denied = await listen((req, res) => serveLinkedFile(req, res, { ...options, bearerOk: false }));
      try {
        const unauth = await fetch(`${denied.url}/api/threads/t1/linked-file?path=${encodeURIComponent(join(root, "clip.mp4"))}`);
        expect(unauth.status).toBe(401);
        expect(Buffer.from(await unauth.arrayBuffer()).includes(clip)).toBe(false);
      } finally {
        await denied.close();
      }
    } finally {
      await server.close();
    }
  });

  it.each(["mp4", "zip", "html"])("serves a relay phone's %s only on its phone session", async (ext) => {
    const root = temp("linked-relay-");
    const clip = Buffer.from("relay-clip");
    writeFileSync(join(root, `clip.${ext}`), clip);
    const base = {
      threadId: "t1",
      messages: [{ id: "m1", text: `[clip](${join(root, `clip.${ext}`)})` }],
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    };
    const cases: Array<[ReturnType<typeof requestCredentials>, number]> = [
      [requestCredentials(true, true, false, "k"), 200],
      // a relay request with the tailnet cookie or the boot token is still unauthenticated
      [requestCredentials(true, false, true, "k"), 401],
      // a phone session counts for nothing off the relay
      [requestCredentials(false, true, false, undefined), 401],
    ];
    for (const [credentials, status] of cases) {
      const server = await listen((req, res) => serveLinkedFile(req, res, { ...base, ...credentials }));
      try {
        const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(join(root, `clip.${ext}`))}`, {
          headers: { cookie: "orbit_remote=k; __Host-wink_phone=wkd_x" },
        });
        expect(res.status).toBe(status);
        expect(Buffer.from(await res.arrayBuffer()).equals(clip)).toBe(status === 200);
      } finally {
        await server.close();
      }
    }
  });

  it("returns 206 with the requested bytes", async () => {
    const root = temp("linked-range-");
    const clip = Buffer.from("0123456789abcdef");
    const filePath = join(root, "clip.mp4");
    writeFileSync(filePath, clip);
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: [{ id: "m1", text: `[clip](${filePath})` }],
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    }));
    try {
      const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`, {
        headers: { Range: "bytes=2-5" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 2-5/16");
      expect([res.headers.get("content-disposition")?.split(";")[0], res.headers.get("content-security-policy")]).toEqual(["inline", null]);
      expect(Buffer.from(await res.arrayBuffer()).equals(clip.subarray(2, 6))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("names the other PC when the linked file is not on this one", async () => {
    const root = temp("linked-remote-");
    const filePath = join(root, "clip.mp4");
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: [{ id: "m1", text: `[clip](${filePath})` }],
      deviceId: "this-pc",
      writerDeviceId: (id) => (id === "m1" ? "other-pc" : null),
      rootsFor: () => [root],
    }));
    try {
      const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ deviceId: "other-pc" });
    } finally {
      await server.close();
    }
  });

  it("serves a Korean file name with an ASCII fallback and the file bytes", async () => {
    const root = temp("linked-ko-");
    const name = "한글 영상.mp4";
    const filePath = join(root, name);
    const clip = Buffer.from("korean-video-bytes");
    writeFileSync(filePath, clip);
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: [{ id: "m1", text: `[clip](<${filePath}>)` }],
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    }));
    try {
      const url = `${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`;
      const full = await fetch(url);
      expect(full.status).toBe(200);
      const disposition = full.headers.get("content-disposition") ?? "";
      expect([...disposition].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
      expect(disposition).toContain("filename*=UTF-8''");
      expect(Buffer.from(await full.arrayBuffer()).equals(clip)).toBe(true);
      const ranged = await fetch(url, { headers: { Range: "bytes=0-5" } });
      expect(ranged.status).toBe(206);
      expect(Buffer.from(await ranged.arrayBuffer()).equals(clip.subarray(0, 6))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("ends the response when the file disappears before the stream opens", async () => {
    const root = temp("linked-vanish-");
    const filePath = join(root, "clip.mp4");
    writeFileSync(filePath, Buffer.from("0123456789abcdef"));
    const crashes: unknown[] = [];
    const onCrash = (error: Error) => crashes.push(error);
    process.on("uncaughtException", onCrash);
    const server = await listen((req, res) => {
      serveLinkedFile(req, res, {
        bearerOk: true,
        remoteKey: undefined,
        threadId: "t1",
        messages: [{ id: "m1", text: `[clip](${filePath})` }],
        deviceId: "this-pc",
        writerDeviceId: () => null,
        rootsFor: () => [root],
      });
      unlinkSync(filePath);
    });
    try {
      const pending = fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`, {
        signal: AbortSignal.timeout(2000),
      });
      try {
        const res = await pending;
        await res.arrayBuffer();
      } catch {
        // a destroyed response still counts as ended
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(crashes).toEqual([]);
    } finally {
      process.off("uncaughtException", onCrash);
      await server.close();
    }
  });

  it("serves parenthesized names, titles, reference links, and angle-bracket paths", async () => {
    const root = temp("linked-md-");
    const nested = join(root, "My Files");
    mkdirSync(nested);
    const paren = Buffer.from("paren-bytes");
    const titled = Buffer.from("title-bytes");
    const referred = Buffer.from("ref-bytes");
    const spaced = Buffer.from("spaced-bytes");
    const hidden = Buffer.from("hidden-bytes");
    const encoded = Buffer.from("encoded-bytes");
    const parenPath = join(root, "clip(1).mp4");
    const titlePath = join(root, "title.mp4");
    const refPath = join(root, "ref.mp4");
    const spacedPath = join(nested, "clip (1).mp4");
    const hiddenPath = join(root, "secret.mp4");
    const encodedPath = join(nested, "영상 1.mp4");
    writeFileSync(parenPath, paren);
    writeFileSync(titlePath, titled);
    writeFileSync(refPath, referred);
    writeFileSync(spacedPath, spaced);
    writeFileSync(hiddenPath, hidden);
    writeFileSync(encodedPath, encoded);
    const messages: LinkedMessage[] = [
      { id: "m1", text: `[clip](${parenPath})` },
      { id: "m2", text: `[x](${titlePath} "Preview")` },
      { id: "m3", text: `[x][v]\n\n[v]: ${refPath}` },
      { id: "m4", text: `[clip](<${spacedPath}>)` },
      { id: "m5", text: `see \`[clip](${hiddenPath})\` later` },
      { id: "m6", text: `[clip](${pathToFileURL(encodedPath).href})` },
    ];
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages,
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    }));
    try {
      const get = async (filePath: string) => {
        const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`);
        return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
      };
      const parenRes = await get(parenPath);
      expect(parenRes.status).toBe(200);
      expect(parenRes.bytes.equals(paren)).toBe(true);
      const titleRes = await get(titlePath);
      expect(titleRes.status).toBe(200);
      expect(titleRes.bytes.equals(titled)).toBe(true);
      const refRes = await get(refPath);
      expect(refRes.status).toBe(200);
      expect(refRes.bytes.equals(referred)).toBe(true);
      const spacedRes = await get(spacedPath);
      expect(spacedRes.status).toBe(200);
      expect(spacedRes.bytes.equals(spaced)).toBe(true);
      const hiddenRes = await get(hiddenPath);
      expect(hiddenRes.status).toBe(404);
      expect(hiddenRes.bytes.includes(hidden)).toBe(false);
      const encodedRes = await get(encodedPath);
      expect(encodedRes.status).toBe(200);
      expect(encodedRes.bytes.equals(encoded)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("serves a path under a dot folder exactly as linked", async () => {
    const root = join(temp("linked-dot-"), ".orbit");
    mkdirSync(root);
    const clip = Buffer.from("dot-folder-bytes");
    const plainPath = join(root, "clip.mp4");
    const anglePath = join(root, "look.mp4");
    writeFileSync(plainPath, clip);
    writeFileSync(anglePath, clip);
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: [{ id: "m1", text: `[clip](${plainPath}) [look](<${anglePath}>)` }],
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    }));
    try {
      for (const filePath of [plainPath, anglePath]) {
        const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`);
        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer()).equals(clip)).toBe(true);
      }
    } finally {
      await server.close();
    }
  });

  it("still refuses a path the message names but does not link", async () => {
    const root = join(temp("linked-named-"), ".orbit");
    mkdirSync(root);
    const other = Buffer.from("named-not-linked");
    const clipPath = join(root, "clip.mp4");
    const otherPath = join(root, "other.mp4");
    writeFileSync(clipPath, Buffer.from("linked"));
    writeFileSync(otherPath, other);
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: [{ id: "m1", text: `[clip](${clipPath}), and ${otherPath} is next` }],
      deviceId: "this-pc",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    }));
    try {
      const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(otherPath)}`);
      expect(res.status).toBe(404);
      expect(Buffer.from(await res.arrayBuffer()).includes(other)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("still names the PC that holds the file after the other PC reacts", async () => {
    const folder = temp("linked-react-");
    const filePath = join(folder, "clip.mp4");
    const bot = "sync-bot-1";
    const work = syncedPc(folder, "work");
    const home = syncedPc(folder, "home");
    work.threads.set("t1", {
      title: "Clip",
      createdAt: 1_700_000_000_000,
      activeLeafId: "m1",
      messages: [{
        id: "m1",
        role: "bot",
        kind: "text",
        text: `[clip](${filePath})`,
        at: 1_700_000_000_000,
        parentId: null,
      }],
    });
    expect(uploadThread(work.host, bot, "t1")).toBe("written");
    expect(pullThread(home.host, "bot", bot, "t1")).toBe("imported");
    const local = home.threads.get("t1")!;
    local.messages = local.messages.map((message) => (
      message.id === "m1" ? { ...message, reactions: [{ emoji: "👍", by: "user" }] } : message
    ));
    markThreadDirty(home.host.ledger, "t1");
    home.host.saveLedger();
    expect(uploadThread(home.host, bot, "t1")).toBe("written");
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: home.threads.get("t1")!.messages.map((message) => ({ id: message.id, text: message.text })),
      deviceId: "home",
      writerDeviceId: (messageId) => messageWriter(home.dataDir, "t1", messageId),
      rootsFor: () => [folder],
    }));
    try {
      const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found", deviceId: "work" });
    } finally {
      await server.close();
    }
  });

  it("finds a Korean-named document on the PC whose bot linked it", async () => {
    const folder = temp("linked-peer-");
    const bot = join(temp("linked-peer-home-"), "봇 폴더");
    const docs = join(dirname(bot), "내 문서");
    const names = ["주간 보고서.docx", "회의 노트.md", "문서 1.hwp", "표 1.xlsx", "요약 1.pdf"];
    const paths = [bot, docs].flatMap((dir) => names.map((name) => join(dir, name)));
    const home = syncedPc(folder, "home");
    const work = syncedPc(folder, "work");
    home.threads.set("t1", {
      title: "Report",
      createdAt: 1_700_000_000_000,
      activeLeafId: "m1",
      messages: [{
        id: "m1",
        role: "bot",
        kind: "text",
        text: paths.map((path) => `[열기](${path.replaceAll("\\", "/").replaceAll(" ", "%20")})`).join("\n"),
        at: 1_700_000_000_000,
        parentId: null,
      }],
    });
    expect(uploadThread(home.host, "sync-bot-1", "t1")).toBe("written");
    expect(pullThread(work.host, "bot", "sync-bot-1", "t1")).toBe("imported");
    const serve = (pc: ReturnType<typeof syncedPc>) => listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: pc.threads.get("t1")!.messages.map((message) => ({ id: message.id, role: message.role, text: message.text })),
      deviceId: pc.host.deviceId,
      writerDeviceId: (messageId) => messageWriter(pc.dataDir, "t1", messageId),
      rootsFor: () => [bot],
    }));
    const ask = async (url: string, path: string) => {
      const res = await fetch(`${url}/api/threads/t1/linked-file?path=${encodeURIComponent(path)}`);
      return [res.status, res.ok ? await res.text() : await res.json()];
    };
    const workPc = await serve(work);
    try {
      for (const path of paths) expect(await ask(workPc.url, path), path).toEqual([404, { error: "not found", deviceId: "home" }]);
    } finally {
      await workPc.close();
    }
    for (const path of paths) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, basename(path));
    }
    const homePc = await serve(home);
    try {
      for (const name of names) {
        expect(await ask(homePc.url, join(bot, name)), name).toEqual([200, name]);
        if (!name.endsWith(".pdf")) expect(await ask(homePc.url, join(docs, name)), name).toEqual([404, { error: "not found", reason: "outside" }]);
      }
    } finally {
      await homePc.close();
    }
  });

  it("serves a linked file whose link carries a line fragment", async () => {
    const root = temp("linked-fragment-");
    const filePath = join(root, "notes.md");
    writeFileSync(filePath, "notes");
    const server = await listen((req, res) => serveLinkedFile(req, res, {
      bearerOk: true,
      remoteKey: undefined,
      threadId: "t1",
      messages: [{ id: "m1", text: `[notes](${filePath.replaceAll("\\", "/")}#L10)` }],
      deviceId: "home",
      writerDeviceId: () => null,
      rootsFor: () => [root],
    }));
    try {
      const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`);
      expect([res.status, await res.text()]).toEqual([200, "notes"]);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["darwin", "C:/Users/홍길동/문서/주간 보고서.docx"],
    ["linux", "C:/Users/홍길동/문서/주간 보고서.docx"],
    ["win32", "/Users/gildong/문서/주간 보고서.docx"],
  ] as const)("names the PC that wrote a path a %s PC cannot hold", async (platform, filePath) => {
    const own = process.platform;
    const server = await listen((req, res) => {
      Object.defineProperty(process, "platform", { value: platform });
      try {
        serveLinkedFile(req, res, {
          bearerOk: true,
          remoteKey: undefined,
          threadId: "t1",
          messages: [{ id: "m1", text: `[주간 보고서](${filePath.replaceAll(" ", "%20")})` }],
          deviceId: "this-pc",
          writerDeviceId: () => "other-pc",
          rootsFor: () => [],
        });
      } finally {
        Object.defineProperty(process, "platform", { value: own });
      }
    });
    try {
      const res = await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(filePath)}`, { headers: { Range: "bytes=0-0" } });
      expect([res.status, await res.json()]).toEqual([404, { error: "not found", deviceId: "other-pc" }]);
    } finally {
      await server.close();
    }
  });
});

describe("linked folders", () => {
  async function linkedFolder(link: (root: string) => string, overrides: Partial<ServeLinkedFileOptions> = {}) {
    const root = temp("linked-folder-");
    const folder = join(root, "showcase-1111");
    mkdirSync(join(folder, "sub"), { recursive: true });
    const files = { "older.png": "png", "page.html": "<p>page</p>", "notes.txt": "notes text", ".env": "secret", "desktop.ini": "x", "sub/deep.txt": "deep" };
    let at = 1_700_000_000;
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(folder, name), text);
      utimesSync(join(folder, name), at, at);
      at += 60;
    }
    const options: ServeLinkedFileOptions = {
      bearerOk: true, remoteKey: undefined, threadId: "t1", deviceId: "home",
      messages: [{ id: "m1", text: `[showcase-1111](${link(folder)})` }],
      writerDeviceId: () => null, rootsFor: () => [root], ...overrides,
    };
    const server = await listen((req, res) => (req.url?.includes("/linked-folder") ? serveLinkedFolder : serveLinkedFile)(req, res, options));
    const list = (path: string) => fetch(`${server.url}/api/threads/t1/linked-folder?path=${encodeURIComponent(path)}`);
    const open = (path: string) => fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(path)}`);
    return { root, folder, server, list, open };
  }

  it("a remote folder link lists its files", async () => {
    const site = await linkedFolder((folder) => folder);
    try {
      const res = await site.list(site.folder);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.json()).toMatchObject({
        files: [{ name: "notes.txt", size: 10, path: join(site.folder, "notes.txt") }, { name: "page.html", size: 11 }, { name: "older.png", size: 3 }],
        more: 0,
      });
      expect((await site.list(`${site.folder}${sep}`)).status).toBe(200);
      for (let i = 0; i < 202; i++) writeFileSync(join(site.folder, `bulk-${i}.txt`), "");
      const capped = await (await site.list(site.folder)).json();
      expect(capped).toHaveProperty("files.length", 200);
      expect(capped).toHaveProperty("more", 5);
    } finally {
      await site.server.close();
    }
  });

  it("a file inside a linked folder opens remotely", async () => {
    const site = await linkedFolder((folder) => pathToFileURL(folder).href);
    try {
      const notes = await site.open(join(site.folder, "notes.txt"));
      expect([notes.status, await notes.text()]).toEqual([200, "notes text"]);
      expect(notes.headers.get("content-disposition")).toContain("attachment");
      const page = await site.open(join(site.folder, "page.html"));
      expect([page.status, await page.text()]).toEqual([200, "<p>page</p>"]);
      for (const name of [".env", "desktop.ini", join("sub", "deep.txt"), join("sub", "..", ".env"), "missing.txt"]) {
        expect((await site.open(join(site.folder, name))).status, name).toBe(404);
      }
    } finally {
      await site.server.close();
    }
    const denied = await linkedFolder((folder) => folder, { bearerOk: false });
    try {
      expect((await denied.list(denied.folder)).status).toBe(401);
    } finally {
      await denied.server.close();
    }
  });

  it("a folder outside the roots is refused", async () => {
    const outside = temp("linked-folder-outside-");
    writeFileSync(join(outside, "secret.txt"), "secret");
    const site = await linkedFolder((folder) => folder, { rootsFor: () => [join(outside, "..", "nowhere")] });
    try {
      expect((await site.list(site.folder)).status).toBe(404);
      expect((await site.open(join(site.folder, "notes.txt"))).status).toBe(404);
    } finally {
      await site.server.close();
    }
    const root = temp("linked-folder-alias-");
    const alias = join(root, "alias");
    symlinkSync(outside, alias, "junction");
    mkdirSync(join(root, "unlinked"));
    mkdirSync(join(root, ".private"));
    writeFileSync(join(root, "unlinked", "a.txt"), "a");
    writeFileSync(join(root, ".private", "a.txt"), "a");
    const options: ServeLinkedFileOptions = {
      bearerOk: true, remoteKey: undefined, threadId: "t1", deviceId: "home",
      messages: [{ id: "m1", text: `[alias](${alias}) [private](${join(root, ".private")}) [root](${root})` }, { id: "m2", role: "user", text: `[mine](${join(root, "unlinked")})` }],
      writerDeviceId: () => null, rootsFor: () => [root],
    };
    const server = await listen((req, res) => (req.url?.includes("/linked-folder") ? serveLinkedFolder : serveLinkedFile)(req, res, options));
    try {
      for (const folder of [alias, join(root, "unlinked"), join(root, ".private"), root, join(alias, "..", "unlinked")]) {
        expect((await fetch(`${server.url}/api/threads/t1/linked-folder?path=${encodeURIComponent(folder)}`)).status, folder).toBe(404);
      }
      for (const file of [join(alias, "secret.txt"), join(root, "unlinked", "a.txt"), join(root, ".private", "a.txt")]) {
        expect((await fetch(`${server.url}/api/threads/t1/linked-file?path=${encodeURIComponent(file)}`)).status, file).toBe(404);
      }
    } finally {
      await server.close();
    }
  });
});
