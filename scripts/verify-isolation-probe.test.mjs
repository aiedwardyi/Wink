import { createHash } from "node:crypto";
import fs from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

import { siteRevision, startSiteServer } from "../electron/verify-site-server.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const source = fs.readFileSync(new URL("./verify-isolation-probe.mjs", import.meta.url), "utf8");
const hash = value => createHash("sha256").update(value).digest("hex");

it("stages every child module and browser resource in the isolated app", () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wink-isolation-test-")));
  try {
    const context = { fs, path, repo, hash, Buffer, flag: () => null };
    runInNewContext(source.slice(source.indexOf("function copyProbeApp("), source.indexOf("function dnsSummary(")), context);
    const { appPath } = context.copyProbeApp(root, "fixture", 1234, 1235);
    const pending = [path.join(appPath, "electron", "entry.mjs")], seen = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const code = fs.readFileSync(file, "utf8");
      for (const match of code.matchAll(/(?:from\s*|import\()\s*["'](\.[^"']+)["']/g)) pending.push(path.resolve(path.dirname(file), match[1]));
      for (const match of code.matchAll(/new URL\(["'](\.[^"']+)["'], import\.meta\.url\)/g)) expect(fs.existsSync(path.resolve(path.dirname(file), match[1])), match[1]).toBe(true);
    }
    expect(seen.has(path.join(appPath, "electron", "verify-run.mjs"))).toBe(true);
    expect(seen.has(path.join(appPath, "electron", "verify-hidden.mjs"))).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("grades S12 against the static server's actual refusal codes", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wink-isolation-test-")));
  let server;
  try {
    fs.writeFileSync(path.join(root, "hostile.html"), "<h1>Fixture</h1>");
    const input = { root, entry: "hostile.html" };
    server = await startSiteServer({ ...input, revision: await siteRevision(input) });
    const status = (pathname, method = "GET", host) => new Promise((resolve, reject) => {
      const url = new URL(server.url);
      const req = request({ hostname: url.hostname, port: url.port, path: pathname, method, headers: host ? { Host: host } : {} }, res => { res.resume(); res.once("end", () => resolve(res.statusCode)); });
      req.on("error", reject); req.end();
    });
    const staticChecks = await Promise.all([status("/hostile.html"), status("/hostile.html", "HEAD"), status("/hostile.html", "POST"), status("/hostile.html", "GET", "foreign.invalid"), ...["/../secret", "/%2e%2e/secret", "/%252e%252e/secret", "/hostile.html:secret", "/.env"].map(value => status(value))]);
    const row = vi.fn();
    const grade = source.split("\n").find(line => line.includes('row("S12",'));
    runInNewContext(grade, { staticChecks, row });
    expect(row).toHaveBeenLastCalledWith("S12", 9, true, staticChecks);
    staticChecks[3] = 200;
    runInNewContext(grade, { staticChecks, row });
    expect(row).toHaveBeenLastCalledWith("S12", 9, false, staticChecks);
  } finally { await server?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
