import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { writeDeviceRecord } from "./device-sync.ts";
import { waitForExit } from "./testing/cleanup.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const HOUR = 60 * 60_000;
let child: ChildProcess | undefined;
let stderr = "";

afterEach(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  child = undefined;
});

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = z.object({ port: z.number() }).parse(listener.address()).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "device-remove-route-"));
  mkdirSync(join(home, "data"));
  mkdirSync(join(home, "ui"));
  writeFileSync(join(home, "ui/index.html"), "<h1>shell</h1>");
  writeFileSync(join(home, "data/config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }));
  writeFileSync(join(home, "data/bots.json"), JSON.stringify([{
    id: "fixture", threadId: "fixture-thread", name: "Fixture", title: "", description: "",
    notifications: false, color: "purple", unread: false,
    modelSelection: { instanceId: "ghost", model: "ghost" }, resumeCursors: {}, computer: "off",
  }]));
  const sync = realpathSync(mkdtempSync(join(tmpdir(), "device-remove-sync-")));
  writeFileSync(join(home, "data/profile-sync.json"), JSON.stringify({ workspaceId: "ws-test", deviceId: "home", folder: sync }));
  mkdirSync(join(sync, "devices"));
  const device = (id: string, lastSeen: number) => writeFileSync(join(sync, "devices", `${id}.json`), JSON.stringify({ deviceId: id, name: id, host: `${id}.tail1234.ts.net`, lastSeen }));
  device("work", Date.now());
  device("old", Date.now() - 2 * HOUR);
  const data = { "threads-v2/bot/thread/w1/head.json": "{}", "changes/1-old-x.json": "{}", "memory-v2/bot/abcdefabcdef.json": "{}", "board/old/deleted.json": "{}" };
  for (const [path, text] of Object.entries(data)) {
    mkdirSync(join(sync, path, ".."), { recursive: true });
    writeFileSync(join(sync, path), text);
  }
  return { home, sync, device };
}

async function start(home: string, port: number, extra: Record<string, string>) {
  stderr = "";
  child = spawn(process.execPath, [join(root, "server/index.ts")], {
    cwd: root,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: join(home, "data"),
      OMB_STATIC_DIR: join(home, "ui"), OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0",
      ORBIT_REMOTE_AUTO: "0", ORBIT_RELAY: "0", ORBIT_NO_WSL: "1", ...extra,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  child.stdout!.resume();
  child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`token timed out: ${stderr}`)), 30_000);
    child!.once("message", (value) => {
      clearTimeout(timer);
      resolve(z.object({ type: z.literal("orbit:api-token"), token: z.string() }).parse(value).token);
    });
    child!.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`harness exited: ${stderr}`));
    });
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`harness did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return token;
}

const call = (port: number, method: string, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end();
  });

const snapshot = (folder: string) => Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
  const path = join(entry.parentPath, entry.name);
  return [path.slice(folder.length + 1).replaceAll("\\", "/"), readFileSync(path, "utf8")];
}));

const listed = z.object({ devices: z.array(z.object({ deviceId: z.string(), checking: z.boolean().optional() })) });
async function devices(port: number, token: string): Promise<string[]> {
  for (let tries = 0; ; tries += 1) {
    const list = listed.parse(JSON.parse((await call(port, "GET", "/api/devices", { authorization: `Bearer ${token}` })).body)).devices;
    if (tries >= 40 || !list.some((item) => item.checking)) return list.map((item) => item.deviceId).sort();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe("DELETE /api/devices/:id", () => {
  it("removes an offline PC, even one that just went offline, and rewrites only this PC's record", async () => {
    const { home, sync } = makeHome();
    const port = await freePort();
    const token = await start(home, port, { ORBIT_REMOTE_HOST: "home.tail1234.ts.net" });
    const auth = { authorization: `Bearer ${token}` };
    expect(await devices(port, token)).toEqual(["home", "old", "work"]);
    expect((await call(port, "DELETE", "/api/devices/old")).status).toBe(401);
    expect((await call(port, "DELETE", "/api/devices/old", { ...auth, host: "home.tail1234.ts.net" })).status).toBe(403);
    expect((await call(port, "DELETE", "/api/devices/home", auth)).status).toBe(409);
    const missing = await call(port, "DELETE", "/api/devices/nobody", auth);
    expect({ status: missing.status, code: JSON.parse(missing.body).code }).toEqual({ status: 409, code: "pc-gone" });
    const before = snapshot(sync);
    expect((await call(port, "DELETE", "/api/devices/old", auth)).status).toBe(200);
    const after = snapshot(sync);
    expect(Object.keys({ ...before, ...after }).filter((path) => before[path] !== after[path])).toEqual(["devices/home.json"]);
    expect(await devices(port, token)).toEqual(["home", "work"]);
    expect((await call(port, "DELETE", "/api/devices/work", auth)).status).toBe(200);
    expect(await devices(port, token)).toEqual(["home"]);
  }, 120_000);

  it("refuses with a reason when this PC has no host to hold the removal", async () => {
    const { home } = makeHome();
    const port = await freePort();
    const token = await start(home, port, {});
    const reply = await call(port, "DELETE", "/api/devices/old", { authorization: `Bearer ${token}` });
    expect({ status: reply.status, code: JSON.parse(reply.body).code }).toEqual({ status: 409, code: "no-own-record" });
    expect(await devices(port, token)).toEqual(["old", "work"]);
  }, 120_000);
});

describe("GET /api/devices", () => {
  it("lists a reinstalled PC once with a renamed tailnet host or an older record", async () => {
    const { home, sync } = makeHome();
    const port = await freePort();
    const host = "home.tail1234.ts.net";
    const token = await start(home, port, { ORBIT_REMOTE_HOST: host });
    const own = JSON.parse(readFileSync(join(sync, "devices", "home.json"), "utf8"));
    const machine = z.string().regex(/^[0-9a-f]{32}$/).parse(own.machine);
    for (const prior of [
      { host: "home-before.tail1234.ts.net", machine },
      { host, machine: machine.slice(0, 16) },
      { host },
    ]) {
      writeDeviceRecord(sync, { deviceId: "home-before", name: "Home", ...prior }, Date.now() - 60_000);
      expect(await devices(port, token)).toEqual(["home", "old", "work"]);
    }
  }, 120_000);
});
