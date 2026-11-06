import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { siteRevision, startSiteServer } from "./verify-site-server.mjs";

const scratch = join(await realpath(tmpdir()), "wink-lv0-engine");
let root, server;
const get = (path, options = {}) => new Promise((resolve, reject) => {
  const url = new URL(server.origin);
  const req = request({ hostname: url.hostname, port: url.port, path, ...options }, res => {
    const chunks = [];
    res.on("data", c => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on("error", reject);
  req.end();
});
beforeEach(async () => {
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(join(scratch, "site-test-"));
  await writeFile(join(root, "index.html"), "<h1>Trusted fixture</h1>");
});
afterEach(async () => {
  await server?.close();
  server = null;
  await remove(root);
});
async function remove(path) {
  if (!path.startsWith(scratch + sep)) throw new Error("Outside scratch");
  await rm(path, { recursive: true, force: true });
}
const start = async () => server = await startSiteServer({ root, entry: "index.html", revision: await siteRevision({ root, entry: "index.html" }) });

it("proxies only pinned loopback GET/HEAD without credentials, foreign redirects or writes", async () => {
  const requests = [];
  let content = "<h1>Local app</h1>";
  const upstream = createServer((req, res) => {
    requests.push({ method: req.method, headers: req.headers, url: req.url });
    if (req.url === "/foreign") return res.writeHead(302, { location: "http://192.168.1.2:3000/" }).end();
    if (req.url === "/redirect") return res.writeHead(302, { location: "/dashboard" }).end();
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "private=value" }).end(content);
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const root = `http://127.0.0.1:${upstream.address().port}/dashboard?q=1`, entry = "index.html";
    server = await startSiteServer({ root, entry, revision: await siteRevision({ root, entry }) });
    const path = new URL(server.url).pathname + new URL(server.url).search;
    const reply = await get(path, { headers: { Cookie: "secret=1", Authorization: "Bearer secret" } });
    expect(reply.body).toBe(content);
    expect(reply.headers["set-cookie"]).toBeUndefined();
    expect(reply.headers["x-orbit-verify-loopback"]).toBe("1");
    expect(requests[0]).toMatchObject({ method: "GET", url: "/dashboard?q=1" });
    expect(requests[0].headers.cookie).toBeUndefined();
    expect(requests[0].headers.authorization).toBeUndefined();
    expect((await get(path, { method: "POST" })).status).toBe(405);
    expect((await get("//192.168.1.2/")).status).toBe(404);
    expect((await get("/foreign")).status).toBe(403);
    expect((await get("/redirect")).headers.location).toBe(server.origin + "/dashboard");
    expect((await get(path, { method: "HEAD" })).body).toBe("");
    expect(await server.revisionUnchanged()).toBe(true);
    content = "changed";
    expect((await get(path)).body).toBe("<h1>Local app</h1>");
    expect(await server.revisionUnchanged()).toBe(true);
    expect(requests.every(row => row.method === "GET")).toBe(true);
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

it("bounds stalled loopback responses and closes active sockets", async () => {
  const upstream = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: pending\n\n"); });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const root = `http://127.0.0.1:${upstream.address().port}/`, entry = "index.html";
    server = await startSiteServer({ root, entry, revision: await siteRevision({ root, entry }) });
    const started = Date.now();
    const reply = await get("/");
    expect(reply.status).toBe(403);
    expect(reply.headers["x-orbit-verify-blocked"]).toBe("1");
    expect(Date.now() - started).toBeLessThan(6500);
    expect(await server.revisionUnchanged()).toBe(true);
    await server.close();
    expect(server.counts().sockets).toBe(0);
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

it("waits for dev chunks and sends uncached HEAD probes without reading route bodies", async () => {
  const methods = [];
  const upstream = createServer((req, res) => {
    methods.push(req.method);
    if (req.url === "/slow.js") setTimeout(() => res.end("ready"), 1800);
    else res.writeHead(200).end(req.method === "HEAD" ? undefined : "route");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const root = `http://127.0.0.1:${upstream.address().port}/`, entry = "index.html";
    server = await startSiteServer({ root, entry, revision: await siteRevision({ root, entry }) });
    expect((await get("/slow.js")).body).toBe("ready");
    expect((await get("/other", { method: "HEAD" })).status).toBe(200);
    expect(methods).toEqual(["GET", "HEAD"]);
    expect(await server.revisionUnchanged()).toBe(true);
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

it("admits loopback dev chunks above the static-file limit", async () => {
  const bytes = Buffer.alloc(9 * 1024 * 1024, 97);
  const upstream = createServer((req, res) => res.end(req.url === "/over.js" ? Buffer.alloc(17 * 1024 * 1024) : bytes));
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const root = `http://127.0.0.1:${upstream.address().port}/`, entry = "index.html";
    server = await startSiteServer({ root, entry, revision: await siteRevision({ root, entry }) });
    expect((await get("/chunk.js")).body.length).toBe(bytes.length);
    expect(await server.revisionUnchanged()).toBe(true);
    expect((await get("/over.js")).headers["x-orbit-verify-blocked"]).toBe("1");
    await expect(server.revisionUnchanged()).rejects.toMatchObject({ code: "resource-limit" });
  } finally { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

describe("verify static server", () => {
  it("accepts system temp aliases and refuses linked root components", async () => {
    const alias = join(process.platform === "win32" ? tmpdir() : await realpath(tmpdir()), "wink-lv0-engine", basename(root));
    expect(await siteRevision({ root: alias, entry: "index.html" })).toBe(await siteRevision({ root, entry: "index.html" }));
    const linked = join(root, "linked");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "index.html"), "<h1>Nested</h1>");
    await symlink(root, linked, "junction");
    try {
      await expect(siteRevision({ root: linked, entry: "index.html" })).rejects.toThrow("outside-folders");
      await expect(siteRevision({ root: join(linked, "nested"), entry: "index.html" })).rejects.toThrow("outside-folders");
    } finally { await rm(linked); }
  });

  it("serves only admitted GET/HEAD bytes, secure headers and closes", async () => {
    await start();
    expect((await get("/index.html")).body).toContain("Trusted fixture");
    const head = await get("/index.html", { method: "HEAD" });
    expect(head.body).toBe("");
    expect(head.headers["x-content-type-options"]).toBe("nosniff");
    expect(head.headers["x-dns-prefetch-control"]).toBe("off");
    expect(head.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(await server.revisionUnchanged()).toBe(true);
    await server.close();
    await expect(get("/index.html")).rejects.toThrow();
  });

  it("rejects traversal, hidden paths, ADS, foreign Host, writes and listing", async () => {
    await mkdir(join(root, "empty"));
    await start();
    for (const path of ["/../index.html", "/%2e%2e/index.html", "/%252e%252e/index.html", "/.env", "/.git/config", "/index.html:secret", "/empty/", "/a%5c..%5cindex.html"]) {
      expect((await get(path)).status, path).toBe(404);
    }
    expect((await get("/index.html", { headers: { Host: "foreign.invalid" } })).status).toBe(404);
    expect((await get("/index.html", { method: "POST" })).status).toBe(405);
  });

  it("serves directory URLs only through their admitted index files", async () => {
    await mkdir(join(root, "about"));
    await mkdir(join(root, "nodir"));
    await writeFile(join(root, "about/index.html"), "<h1>About</h1>");
    await start();
    const index = await get("/about/index.html");
    const directory = await get("/about/");
    expect(directory.status).toBe(200);
    expect(directory.body).toBe(index.body);
    expect(directory.headers["content-type"]).toBe(index.headers["content-type"]);
    const head = await get("/about/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(index.headers["content-length"]);
    for (const path of ["/nodir/", "/about//", "/about/../about/", "/about/%2e%2e/about/", "/about%3asecret/", "/about%5c/"]) expect((await get(path)).status, path).toBe(404);
    expect((await get("/about/", { headers: { Host: "foreign.invalid" } })).status).toBe(404);
    expect(await server.revisionUnchanged()).toBe(true);
    await writeFile(join(root, "about/index.html"), "<h1>Changed</h1>");
    expect((await get("/about/")).status).toBe(404);
    expect(await server.revisionUnchanged()).toBe(false);
  });

  it.each(["edit", "addition", "replacement"])("detects an unrequested %s at finalize", async change => {
    await writeFile(join(root, "asset.css"), "body{color:red}");
    await start();
    if (change === "edit") await writeFile(join(root, "asset.css"), "body{color:tan}");
    if (change === "addition") await writeFile(join(root, "added.css"), "p{}");
    if (change === "replacement") {
      await rename(join(root, "asset.css"), join(root, "old.css"));
      await writeFile(join(root, "asset.css"), "body{color:red}");
      await rm(join(root, "old.css"));
    }
    expect(await server.revisionUnchanged()).toBe(false);
    if (change !== "addition") expect((await get("/asset.css")).status).toBe(404);
  });

  it("rejects UNC, device paths, private files and oversized files at admission", async () => {
    for (const path of ["\\\\server\\share", "\\\\?\\C:\\site", "C:relative"]) {
      await expect(startSiteServer({ root: path, entry: "index.html", revision: "0".repeat(64) })).rejects.toThrow();
    }
    for (const file of [".env", "package.json", "secret.pem", "payload.exe"]) {
      await writeFile(join(root, file), "private");
      await expect(start()).rejects.toThrow();
      await rm(join(root, file));
    }
    await writeFile(join(root, "big.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(start()).rejects.toThrow();
  });

  it("rejects junction escapes and link swaps", async () => {
    const outside = await mkdtemp(join(scratch, "outside-"));
    try {
      await writeFile(join(outside, "asset.css"), "outside");
      await symlink(outside, join(root, "escape"), "junction");
      await expect(start()).rejects.toThrow();
      await rm(join(root, "escape"));
      await mkdir(join(root, "assets"));
      await writeFile(join(root, "assets/asset.css"), "p{}");
      await start();
      await rename(join(root, "assets"), join(root, "saved"));
      await symlink(outside, join(root, "assets"), "junction");
      expect((await get("/assets/asset.css")).status).toBe(404);
      expect(await server.revisionUnchanged()).toBe(false);
    } finally {
      await remove(outside);
    }
  });
});
