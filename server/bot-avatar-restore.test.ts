import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { loadOrCreateSyncWorkspace, PROFILE_SYNC_CHANGES_DIR, syncValueHash } from "./profile-sync.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { harnessFetch as fetch, spawnHarness as spawn } from "./testing/harness-auth.ts";
import { freePortBlock } from "./testing/ports.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

let child: ChildProcess;
let home: string;
let syncHome: string;
let sync: string;
let port = 0;
let stderr = "";

const png = (text: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);
const assetFor = (bytes: Buffer) => `assets/${createHash("sha256").update(bytes).digest("hex")}.png`;

function botOps(): Array<{ entityId: string; deviceId: string; changes?: Record<string, unknown> }> {
  const dir = join(sync, PROFILE_SYNC_CHANGES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

// A PC whose attachments folder was wiped while bots.json kept the picture names (home, 11-21).
const bot = (id: string, file: string) => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: false, color: "purple", unread: false,
  modelSelection: { instanceId: "ghost", model: "ghost" }, resumeCursors: {}, computer: "off",
  avatarUrl: `/api/attachments/${file}`, avatarCrop: "circle",
});
const jen = { file: `${randomUUID()}.png`, bytes: png("jennovar"), syncId: randomUUID() };
const ori = { file: `${randomUUID()}.png`, bytes: png("origin"), syncId: randomUUID() };

beforeAll(async () => {
  port = await freePortBlock([0, 1]);
  home = createFixtureHome("omb-bot-avatar-restore-");
  syncHome = createFixtureHome("omb-bot-avatar-restore-sync-");
  mkdirSync(join(syncHome, "folder"));
  sync = realpathSync(join(syncHome, "folder"));
  const data = join(home, ".orbit");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }));
  writeFileSync(join(data, "bots.json"), JSON.stringify([bot("jen", jen.file), bot("ori", ori.file)]));
  const workspaceId = loadOrCreateSyncWorkspace(sync, randomUUID());
  // jen's picture is in the sync folder; ori's never arrived
  mkdirSync(join(sync, "assets"));
  writeFileSync(join(sync, assetFor(jen.bytes)), jen.bytes);
  writeFileSync(join(data, "profile-sync.json"), JSON.stringify({
    workspaceId, deviceId: "home", folder: sync, syncChats: true,
    botMap: { jen: jen.syncId, ori: ori.syncId },
    syncedHashes: {
      [`bot:${jen.syncId}:avatarAsset`]: syncValueHash(assetFor(jen.bytes)),
      [`bot:${ori.syncId}:avatarAsset`]: syncValueHash(assetFor(ori.bytes)),
    },
  }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      ORBIT_REMOTE_AUTO: "0",
      ORBIT_RELAY: "0",
      ORBIT_NO_WSL: "1",
    },
    windowsHide: true,
  });
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}, 45_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  removeTestData(home);
  removeTestData(syncHome);
});

describe("bot pictures lost on one PC", () => {
  it("come back from the sync folder and never publish as removed", async () => {
    // a sync pass ran once this PC publishes the fields it never synced
    const deadline = Date.now() + 60_000;
    while (!botOps().some((op) => op.entityId === jen.syncId && op.changes && "name" in op.changes)) {
      if (Date.now() > deadline) throw new Error(`no sync pass: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const avatarOps = botOps().filter((op) => op.changes && "avatarAsset" in op.changes).map((op) => [op.entityId, op.changes!.avatarAsset]);
    expect(avatarOps).toEqual([]);
    const attachments = join(home, ".orbit/attachments");
    expect(readFileSync(join(attachments, jen.file))).toEqual(jen.bytes);
    const served = await fetch(`http://127.0.0.1:${port}/api/attachments/${jen.file}`);
    expect({ status: served.status, same: Buffer.from(await served.arrayBuffer()).equals(jen.bytes) }).toEqual({ status: 200, same: true });
    // ori keeps its picture name for when the file comes back
    const bots = z.array(z.object({ id: z.string(), avatarUrl: z.string().optional() })).parse(JSON.parse(readFileSync(join(home, ".orbit/bots.json"), "utf8")));
    expect(bots.find((entry) => entry.id === "ori")?.avatarUrl).toBe(`/api/attachments/${ori.file}`);
    expect(existsSync(join(attachments, ori.file))).toBe(false);
  }, 120_000);
});
