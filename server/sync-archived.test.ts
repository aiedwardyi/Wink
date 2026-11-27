import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { GOOGLE_BINDING_FILE } from "./google-sync.ts";
import { readSyncOperations } from "./profile-sync.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { harnessFetch, spawnHarness } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const ROOT = join(import.meta.dirname, "..");

interface Body { folder?: string; enabled?: boolean; name?: string; hidden?: boolean }
interface PC {
  home: string; dataDir: string; base: string; child: ChildProcess;
  api(method: string, path: string, body?: Body): Promise<any>;
}

let root: string;
let folder: string;
let pcs: PC[];
const homes = new Map<string, string>();
// the server also listens beside its own port
const firstPort = 30_000 + Math.floor(Math.random() * 200) * 100;
let boots = 0;

async function boot(name: string): Promise<PC> {
  let home = homes.get(name);
  if (!home) {
    home = createFixtureHome(`orbit-sync-${name}-`);
    homes.set(name, home);
  }
  const dataDir = join(home, ".orbit");
  mkdirSync(dataDir, { recursive: true });
  // one unknown driver: no CLI probes, no network
  if (!existsSync(join(dataDir, "config.json"))) writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }));
  const port = firstPort + 20 * boots++;
  const base = `http://127.0.0.1:${port}`;
  const child = spawnHarness(process.execPath, [join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env: {
      ...Object.fromEntries(["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_USER_DATA: join(home, "user-data"),
      APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
      ORBIT_REMOTE_AUTO: "0", ORBIT_RELAY: "0", ORBIT_NO_WSL: "1",
    },
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  child.stdout!.on("data", (chunk) => { stderr += chunk; });
  const api = async (method: string, path: string, body?: Body) => {
    const res = await harnessFetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };
  const pc = { home, dataDir, base, child, api };
  pcs.push(pc);
  for (const end = Date.now() + 90_000; ;) {
    if ((await harnessFetch(`${base}/api/bots?messages=0`).catch(() => null))?.status === 200) break;
    if (child.exitCode !== null || Date.now() > end) throw new Error(`${name} start: ${stderr.slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pc;
}

async function close(pc: PC): Promise<void> {
  pcs = pcs.filter((other) => other !== pc);
  if (pc.child.exitCode !== null) return;
  const ended = new Promise<void>((resolve) => pc.child.once("exit", () => resolve()));
  pc.child.kill();
  await ended;
}

// PUT /api/profile-sync rescans the folder at once: import, then publish
async function sync(pc: PC): Promise<void> {
  await pc.api("PUT", "/api/profile-sync", { folder });
  await pc.api("PUT", "/api/profile-sync/chats", { enabled: true });
}

async function create(pc: PC, name: string, hidden = false): Promise<string> {
  const { bot } = await pc.api("POST", "/api/bots", { name });
  if (hidden) await pc.api("PATCH", `/api/bots/${bot.id}`, { hidden: true });
  return bot.id;
}

const listed = z.object({ bots: z.array(z.object({ id: z.string(), name: z.string(), hidden: z.boolean().optional() })) });
const list = async (pc: PC) => listed.parse(await pc.api("GET", "/api/bots?messages=0")).bots;
const bots = async (pc: PC) => (await list(pc)).map((bot) => ({ name: bot.name, archived: bot.hidden === true })).sort((a, b) => a.name.localeCompare(b.name));
const idOf = async (pc: PC, name: string) => (await list(pc)).find((bot) => bot.name === name)!.id;
const published = () => readSyncOperations(folder).operations.flatMap((op) => op.entity === "bot" && op.changes?.name ? [String(op.changes.name)] : []).sort();

/** Both PCs rescan until `check` holds. */
async function settle<T>(check: () => Promise<T>, want: T): Promise<void> {
  await expect.poll(async () => {
    for (const pc of pcs) await sync(pc);
    return check();
  }, { timeout: 60_000, interval: 1_000 }).toEqual(want);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-sync-archived-"));
  folder = join(root, "sync");
  mkdirSync(folder);
  pcs = [];
});

afterEach(async () => {
  while (pcs.length) await close(pcs[0]!);
  for (const home of homes.values()) removeTestData(home);
  homes.clear();
  await removeTempDir(root);
});

describe("archived bots between two PCs", { timeout: 240_000 }, () => {
  it("arrive archived on a joining PC, and archive or unarchive on either PC reaches the other", async () => {
    const a = await boot("a");
    await create(a, "Kept");
    await create(a, "Shelved", true);
    await sync(a);
    const b = await boot("b");
    const want = [{ name: "Kept", archived: false }, { name: "Shelved", archived: true }];
    await settle(async () => [await bots(a), await bots(b)], [want, want]);

    await b.api("PATCH", `/api/bots/${await idOf(b, "Shelved")}`, { hidden: false });
    const restored = [{ name: "Kept", archived: false }, { name: "Shelved", archived: false }];
    await settle(async () => [await bots(a), await bots(b)], [restored, restored]);

    await a.api("PATCH", `/api/bots/${await idOf(a, "Kept")}`, { hidden: true });
    const swapped = [{ name: "Kept", archived: true }, { name: "Shelved", archived: false }];
    await settle(async () => [await bots(a), await bots(b)], [swapped, swapped]);
    expect(published()).toEqual(["Kept", "Shelved"]);
  });

  it("arrive archived on a PC that already shares the bot from before archive synced", async () => {
    const a = await boot("a");
    await create(a, "Kept");
    await create(a, "Shelved");
    await sync(a);
    let b = await boot("b");
    const active = [{ name: "Kept", archived: false }, { name: "Shelved", archived: false }];
    await settle(async () => [await bots(a), await bots(b)], [active, active]);
    await close(b);
    // what a PC that synced on a build without archive sync has: no base for hidden
    const state = join(b.dataDir, "profile-sync.json");
    const settings = JSON.parse(readFileSync(state, "utf8"));
    settings.syncedHashes = Object.fromEntries(Object.entries(settings.syncedHashes).filter(([key]) => !key.endsWith(":hidden")));
    writeFileSync(state, JSON.stringify(settings));
    await a.api("PATCH", `/api/bots/${await idOf(a, "Shelved")}`, { hidden: true });
    await sync(a);
    b = await boot("b");
    const want = [{ name: "Kept", archived: false }, { name: "Shelved", archived: true }];
    await settle(async () => [await bots(a), await bots(b)], [want, want]);
  });

  it("publishes an archived bot a joined PC held back, and keeps its unused bot held", async () => {
    const a = await boot("a");
    await create(a, "Kept");
    await sync(a);
    let b = await boot("b");
    const held = [await create(b, "Spare", true), await create(b, "Fresh")];
    await expect.poll(() => JSON.parse(readFileSync(join(b.dataDir, "bots.json"), "utf8")).map((bot: { id: string }) => bot.id), { timeout: 10_000 }).toEqual(expect.arrayContaining(held));
    await close(b);
    // what finishJoin writes when a PC with unused bots joins an account that has bots
    writeFileSync(join(b.dataDir, GOOGLE_BINDING_FILE), JSON.stringify({
      version: 1, spaceId: "space-b", owner: { issuer: "https://accounts.google.com", sub: "account-a" }, emailHint: "a@example.com", transport: "google-drive",
      rootId: null, mirrorPath: join(b.dataDir, "google-drive"), transportStatePath: join(b.dataDir, "google-drive-state.json"), workspaceId: null, heldBots: held, phase: "ready",
    }));
    b = await boot("b");
    await settle(async () => [await bots(a), published()], [
      [{ name: "Kept", archived: false }, { name: "Spare", archived: true }],
      ["Kept", "Spare"],
    ]);
  });
});
