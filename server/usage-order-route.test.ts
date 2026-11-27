import type { ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import { waitForExit } from "./testing/cleanup.ts";
import { spawnTestNode } from "./testing/harness-auth.ts";
import { createFixtureHome } from "./testing/test-home.ts";
import type { UsageOrderConfig } from "./usage-order.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
let child: ChildProcess | undefined;
let stderr = "";
type Save = { key: string; order: string[] } | { seed: Record<string, string[]>; from: "desktop" | "browser" };

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

async function start(config: { usageOrder: UsageOrderConfig }) {
  const home = createFixtureHome("usage-order-route-");
  mkdirSync(join(home, "data"));
  mkdirSync(join(home, "ui"));
  writeFileSync(join(home, "ui/index.html"), "<h1>shell</h1>");
  writeFileSync(join(home, "data/config.json"), JSON.stringify(config));
  const port = await freePort();
  stderr = "";
  child = spawnTestNode(process.execPath, [join(root, "server/index.ts")], {
    cwd: root,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: join(home, "data"),
      OMB_STATIC_DIR: join(home, "ui"), OMB_PORT: String(port), OMB_WEBHOOK_PORT: "0",
      ORBIT_REMOTE_AUTO: "0", ORBIT_RELAY: "0", ORBIT_NO_WSL: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  child.stdout!.resume();
  child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`token timed out: ${stderr}`)), 30_000);
    // The first message is the test-home handshake (spawnTestNode); the token follows.
    child!.on("message", (value) => {
      const message = z.object({ type: z.literal("orbit:api-token"), token: z.string() }).safeParse(value);
      if (!message.success) return;
      clearTimeout(timer);
      resolve(message.data.token);
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
  const auth = { authorization: `Bearer ${token}` };
  const send = (method: string, path: string, body?: Save) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    let finish = () => {};
    const reply = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { ...auth, "content-type": "application/json", "content-length": Buffer.byteLength(text) } }, (res) => {
        let out = "";
        res.on("data", (chunk) => { out += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
      });
      req.on("error", reject);
      req.flushHeaders();
      finish = () => req.end(text);
    });
    return { reply, finish: () => finish() };
  };
  return {
    /** A save whose body is still on its way; the route has its headers. */
    async held(body: Save) {
      const save = send("PUT", "/api/usage-order", body);
      await this.saved();
      return save;
    },
    async put(body: Save) {
      const save = send("PUT", "/api/usage-order", body);
      save.finish();
      return save.reply;
    },
    async saved() {
      const config = send("GET", "/api/config");
      config.finish();
      return JSON.parse((await config.reply).body).usageOrder?.orders;
    },
    disk: () => JSON.parse(readFileSync(join(home, "data/config.json"), "utf8")).usageOrder?.orders,
  };
}

const accounts = ["claude", "acct-2", "acct-3"];
const sections = ["claude", "codex", "grok", "muse"];

it("keeps an account drag that returned while a section save was still arriving", async () => {
  const wink = await start({ usageOrder: { orders: { claude: accounts } } });
  const section = await wink.held({ key: "engines", order: [...sections].reverse() });
  const dragged = ["acct-2", "acct-3", "claude"];
  expect((await wink.put({ key: "claude", order: dragged })).status).toBe(200);
  expect((await wink.saved()).claude).toEqual(dragged);
  section.finish();
  expect((await section.reply).status).toBe(200);
  expect(wink.disk()).toEqual({ claude: dragged, engines: [...sections].reverse() });
  expect(await wink.saved()).toEqual({ claude: dragged, engines: [...sections].reverse() });
}, 120_000);

it("keeps a drag that returned while the desktop app's old order was still arriving", async () => {
  const wink = await start({ usageOrder: { orders: { engines: sections }, seed: "browser" } });
  const migration = await wink.held({ seed: { engines: ["muse", "grok", "claude", "codex"] }, from: "desktop" });
  const dragged = ["codex", "grok", "muse", "claude"];
  expect((await wink.put({ key: "engines", order: dragged })).status).toBe(200);
  migration.finish();
  expect((await migration.reply).status).toBe(200);
  expect(wink.disk()).toEqual({ engines: dragged });
}, 120_000);
