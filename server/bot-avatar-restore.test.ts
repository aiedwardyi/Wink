import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { loadOrCreateSyncWorkspace, PROFILE_SYNC_CHANGES_DIR, syncValueHash } from "./profile-sync.ts";
import { waitForExit } from "./testing/cleanup.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
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

async function start(home: string, port: number): Promise<string> {
  stderr = "";
  child = spawn(process.execPath, [join(root, "server/index.ts")], {
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
  return new Promise<string>((resolve, reject) => {
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
}

const get = (port: number, path: string, token: string) =>
  new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path, headers: { authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });

const png = (text: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);
const assetFor = (bytes: Buffer) => `assets/${createHash("sha256").update(bytes).digest("hex")}.png`;

function botOps(sync: string): Array<{ entityId: string; deviceId: string; changes?: Record<string, unknown> }> {
  const dir = join(sync, PROFILE_SYNC_CHANGES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

// A PC whose attachments folder was wiped while bots.json kept the picture names (home, 11-21).
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "bot-avatar-restore-"));
  mkdirSync(join(home, "data"));
  mkdirSync(join(home, "ui"));
  writeFileSync(join(home, "ui/index.html"), "<h1>shell</h1>");
  writeFileSync(join(home, "data/config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }));
  const bot = (id: string, file: string) => ({
    id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: false, color: "purple", unread: false,
    modelSelection: { instanceId: "ghost", model: "ghost" }, resumeCursors: {}, computer: "off",
    avatarUrl: `/api/attachments/${file}`, avatarCrop: "circle",
  });
  const jen = { file: `${randomUUID()}.png`, bytes: png("jennovar"), syncId: randomUUID() };
  const ori = { file: `${randomUUID()}.png`, bytes: png("origin"), syncId: randomUUID() };
  writeFileSync(join(home, "data/bots.json"), JSON.stringify([bot("jen", jen.file), bot("ori", ori.file)]));
  const sync = realpathSync(mkdtempSync(join(tmpdir(), "bot-avatar-restore-sync-")));
  const workspaceId = loadOrCreateSyncWorkspace(sync, randomUUID());
  // jen's picture is in the sync folder; ori's never arrived
  mkdirSync(join(sync, "assets"));
  writeFileSync(join(sync, assetFor(jen.bytes)), jen.bytes);
  writeFileSync(join(home, "data/profile-sync.json"), JSON.stringify({
    workspaceId, deviceId: "home", folder: sync, syncChats: true,
    botMap: { jen: jen.syncId, ori: ori.syncId },
    syncedHashes: {
      [`bot:${jen.syncId}:avatarAsset`]: syncValueHash(assetFor(jen.bytes)),
      [`bot:${ori.syncId}:avatarAsset`]: syncValueHash(assetFor(ori.bytes)),
    },
  }));
  return { home, sync, jen, ori };
}

describe("bot pictures lost on one PC", () => {
  it("come back from the sync folder and never publish as removed", async () => {
    const { home, sync, jen, ori } = makeHome();
    const port = await freePort();
    const token = await start(home, port);
    // a sync pass ran once this PC publishes the fields it never synced
    const deadline = Date.now() + 60_000;
    while (!botOps(sync).some((op) => op.entityId === jen.syncId && op.changes && "name" in op.changes)) {
      if (Date.now() > deadline) throw new Error(`no sync pass: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const avatarOps = botOps(sync).filter((op) => op.changes && "avatarAsset" in op.changes).map((op) => [op.entityId, op.changes!.avatarAsset]);
    expect(avatarOps).toEqual([]);
    expect(readFileSync(join(home, "data/attachments", jen.file))).toEqual(jen.bytes);
    const served = await get(port, `/api/attachments/${jen.file}`, token);
    expect({ status: served.status, same: served.body.equals(jen.bytes) }).toEqual({ status: 200, same: true });
    // ori keeps its picture name for when the file comes back
    const bots = z.array(z.object({ id: z.string(), avatarUrl: z.string().optional() })).parse(JSON.parse(readFileSync(join(home, "data/bots.json"), "utf8")));
    expect(bots.find((bot) => bot.id === "ori")?.avatarUrl).toBe(`/api/attachments/${ori.file}`);
    expect(existsSync(join(home, "data/attachments", ori.file))).toBe(false);
  }, 120_000);
});
