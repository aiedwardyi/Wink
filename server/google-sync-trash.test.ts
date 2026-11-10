import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodeDrivePath } from "./drive-mirror.ts";
import { GoogleAccount, type GoogleSession } from "./google-account.ts";
import { GOOGLE_BINDING_FILE, createGoogleSync, type GoogleSync } from "./google-sync.ts";
import { loadOrCreateSyncWorkspace, loadProfileSyncSettings, readSyncOperations, saveProfileSyncSettings, syncedInFolder } from "./profile-sync.ts";
import { FakeDrive } from "./testing/fake-drive.ts";
import type { BotSpec, Places, TestArgs, TestResult } from "./testing/google-sync-pc.ts";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const A: GoogleSession = { refreshToken: "refresh-a", sub: "account-a", email: "a@example.com" };
const tokenFetch: typeof fetch = async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BOTS: BotSpec[] = [
  { name: "Atlas", memory: "Atlas: likes tea.\n", chats: [{ title: "Plans", rows: 4 }, { title: "Notes", rows: 2 }] },
  { name: "Nova", memory: "Nova memory.\n", chats: [{ title: "Ideas", rows: 3 }] },
];

interface PC {
  dataDir: string; account: GoogleAccount; sync: GoogleSync;
  call(method: string, args?: TestArgs): Promise<TestResult>;
  places(): Promise<Places>;
  close(): Promise<void>;
}
type Booting = Omit<PC, "sync"> & { sync?: GoogleSync };

let root: string;
let drive: FakeDrive;
let pcs: PC[];

const drivePaths = () => [...drive.records.values()].filter(({ file }) => !file.trashed && file.appProperties?.ph).map(({ file }) => decodeDrivePath(file.name)!).sort();
const names = (bots: Places["bots"]) => bots.map((bot) => bot.name);
const marks = (pc: PC) => readSyncOperations(join(pc.dataDir, "google-drive")).operations
  .filter((op) => op.changes && "trashed" in op.changes).sort((a, b) => a.recordedAt - b.recordedAt);
const atlas = (places: Places) => places.bots.find((bot) => bot.name === "Atlas")!;

function boot(pc: Booting): GoogleSync {
  return createGoogleSync({
    dataDir: pc.dataDir,
    account: pc.account,
    folder: () => loadProfileSyncSettings(pc.dataDir).folder,
    prepare: () => {},
    unusedBots: () => [],
    activate: (mirror) => {
      let settings = loadProfileSyncSettings(pc.dataDir);
      if (settings.folder !== mirror) settings = { ...settings, reviewedResolutions: {}, seenCheckpoint: "" };
      const workspaceId = loadOrCreateSyncWorkspace(mirror, settings.workspaceId);
      if (workspaceId !== settings.workspaceId) settings = { ...settings, workspaceId, botMap: {}, sectionMap: {}, reviewedResolutions: {}, seenCheckpoint: "", syncedHashes: {} };
      saveProfileSyncSettings(pc.dataDir, { ...settings, folder: mirror, syncChats: true, syncedHashes: syncedInFolder(settings.syncedHashes, mirror) });
      void pc.call("republish");
      return workspaceId;
    },
    pull: (threadId) => { void pc.call("pull", { thread: threadId }); },
    fetch: (input, init) => drive.fetch(input, init),
    log: () => {},
  });
}

function makePC(name: string): PC {
  const dataDir = join(root, name);
  const worker = new Worker(new URL("./testing/google-sync-pc.ts", import.meta.url), {
    workerData: { dataDir }, env: { ...process.env, OMB_DATA_DIR: dataDir, OMB_THREAD_SYNC_V2: "1" }, execArgv: ["--experimental-strip-types"],
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: TestResult): void; reject(error: Error): void }>();
  worker.on("message", ({ id, value, error }: { id: number; value: TestResult; error?: string }) => {
    const request = pending.get(id);
    pending.delete(id);
    if (error) request?.reject(new Error(error));
    else request?.resolve(value);
  });
  const exited = new Promise<void>((resolve) => worker.on("exit", () => resolve()));
  const base: Booting = {
    dataDir,
    account: new GoogleAccount(CLIENT, null, { fetch: tokenFetch, log: () => {} }),
    call: (method, args = {}) => new Promise<TestResult>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    }),
    // SAFETY: the fixture's places method answers Places.
    places: async () => await base.call("places") as Places,
    async close() {
      base.sync?.stop();
      await base.call("close");
      await worker.terminate();
      await exited;
    },
  };
  const pc: PC = Object.assign(base, { sync: boot(base) });
  pcs.push(pc);
  return pc;
}

async function pass(pc: PC): Promise<void> {
  await pc.call("pass");
  await pc.sync.kick();
  await pc.sync.idle();
}

async function rounds(n: number, among = pcs): Promise<void> {
  for (let i = 0; i < n; i++) for (const pc of among) await pass(pc);
}

async function start(pc: PC): Promise<void> {
  pc.account.setSession(A);
  await pc.sync.read();
  await pc.sync.start();
  await pc.sync.idle();
}

/** A seeds two bots by folder sync, then both PCs start Google and settle. */
async function pair(): Promise<{ a: PC; b: PC; before: { a: Places; b: Places } }> {
  const a = makePC("a");
  await a.call("seed", { bots: BOTS });
  await a.call("folder", { folder: join(root, "old-folder") });
  await a.call("pass");
  await a.call("folder", { folder: null });
  await start(a);
  await rounds(2);
  const b = makePC("b");
  await start(b);
  await rounds(3);
  const before = { a: await a.places(), b: await b.places() };
  expect(names(before.a.bots)).toEqual(["Atlas", "Nova"]);
  expect(before.b.bots.map(({ id: _id, ...bot }) => bot)).toEqual(before.a.bots.map(({ id: _id, ...bot }) => bot));
  return { a, b, before };
}

const both = async (a: PC, b: PC) => ({ a: await a.places(), b: await b.places() });
const inTrash = (before: Places, days = 30) => ({ bots: before.bots.filter((bot) => bot.name !== "Atlas"), trash: [{ ...atlas(before), daysLeft: days }] });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-google-trash-"));
  drive = new FakeDrive();
  drive.pageSize = 1000;
  pcs = [];
});

afterEach(async () => {
  for (const pc of pcs) await pc.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Bot trash between two Google PCs", { timeout: 180_000 }, () => {
  it("(a) Delete and Restore on A before B syncs leave B untouched", async () => {
    const { a, b, before } = await pair();
    await a.call("trash", { bot: "Atlas" });
    expect(await a.places()).toEqual(inTrash(before.a));
    await a.call("restore", { bot: "Atlas" });
    await rounds(2);
    expect(await both(a, b)).toEqual(before);
    expect(marks(b).map((op) => op.changes!.trashed)).toEqual([true, false]);
  });

  it("(b) Delete on A, Restore on B brings the same bot back on both, nothing downloads", async () => {
    const { a, b, before } = await pair();
    const keys = { profile: Object.keys(JSON.parse(readFileSync(join(b.dataDir, "profile-sync.json"), "utf8"))).sort(), binding: Object.keys(JSON.parse(readFileSync(join(b.dataDir, GOOGLE_BINDING_FILE), "utf8"))).sort() };
    await a.call("trash", { bot: "Atlas" });
    await rounds(2);
    expect(await both(a, b)).toEqual({ a: inTrash(before.a), b: inTrash(before.b) });
    const downloads = drive.downloads.length;
    await b.call("restore", { bot: "Atlas" });
    await rounds(3);
    expect(await both(a, b)).toEqual(before);
    const chatFiles = drive.downloads.slice(downloads).map((id) => decodeDrivePath(drive.records.get(id)!.file.name)!).filter((path) => path.startsWith("threads-v2"));
    expect(chatFiles).toEqual([]);
    expect(keys).toEqual({
      profile: ["botMap", "deviceId", "folder", "nextSequence", "pendingBotDeletes", "reviewedResolutions", "sectionMap", "seenCheckpoint", "syncChats", "syncedHashes", "workspaceId"],
      binding: ["emailHint", "heldBots", "mirrorPath", "owner", "phase", "rootId", "spaceId", "transport", "transportStatePath", "version", "workspaceId"],
    });
    for (const pc of [a, b]) {
      expect(Object.keys(JSON.parse(readFileSync(join(pc.dataDir, "profile-sync.json"), "utf8"))).sort()).toEqual(keys.profile);
      expect(Object.keys(JSON.parse(readFileSync(join(pc.dataDir, GOOGLE_BINDING_FILE), "utf8"))).sort()).toEqual(keys.binding);
    }
  });

  it("(c) Empty now on A erases the bot from B's trash", async () => {
    const { a, b, before } = await pair();
    await a.call("trash", { bot: "Atlas" });
    await rounds(2);
    const trashedOnB = join(b.dataDir, "workspaces-trash", atlas(before.b).id);
    expect(existsSync(trashedOnB)).toBe(true);
    await a.call("empty", { bot: "Atlas" });
    await rounds(2);
    const gone = { bots: before.a.bots.filter((bot) => bot.name !== "Atlas"), trash: [] };
    expect((await a.places())).toEqual(gone);
    expect((await b.places())).toEqual({ bots: before.b.bots.filter((bot) => bot.name !== "Atlas"), trash: [] });
    expect(existsSync(trashedOnB)).toBe(false);
    expect(readSyncOperations(join(b.dataDir, "google-drive")).operations.some((op) => op.deleted && op.entityId === atlas(before.a).syncId)).toBe(true);
  });

  it("(d) A's timer erases only A's copy; B, off for 40 days, trashes and restores it on both", async () => {
    const { a, b, before } = await pair();
    await a.call("trash", { bot: "Atlas" });
    await rounds(1, [a]);
    await a.call("clock", { skew: 30 * DAY });
    const files = drivePaths();
    await a.call("timer");
    await rounds(2, [a]);
    expect(await a.places()).toEqual({ bots: before.a.bots.filter((bot) => bot.name !== "Atlas"), trash: [] });
    expect(drivePaths()).toEqual(files);
    await b.call("clock", { skew: 40 * DAY });
    await rounds(2, [b]);
    expect(await b.places()).toEqual(inTrash(before.b, 30));
    await b.call("clock", { skew: 45 * DAY });
    await b.call("restore", { bot: "Atlas" });
    await rounds(3);
    const after = await both(a, b);
    expect(after.b).toEqual(before.b);
    expect(atlas(after.a)).toEqual({ ...atlas(before.a), files: atlas(after.a).files });
    expect(after.a.trash).toEqual([]);
  });

  it("(e1) A new, B old: Delete on A keeps the bot on B until it updates, Empty now erases it there", async () => {
    const { a, b, before } = await pair();
    await b.call("old", { old: true });
    await a.call("trash", { bot: "Atlas" });
    await a.call("trash", { bot: "Nova" });
    await rounds(2);
    expect(names((await b.places()).bots)).toEqual(["Atlas", "Nova"]);
    await b.call("chat", { bot: "Atlas", chat: { title: "On B", rows: 2 } });
    await a.call("empty", { bot: "Nova" });
    await rounds(2);
    expect(await b.places()).toEqual({ bots: [{ ...atlas(before.b), chats: [...atlas(before.b).chats, "On B:2"].sort() }], trash: [] });
    await b.call("old", { old: false });
    await rounds(2);
    expect(names((await b.places()).trash)).toEqual(["Atlas"]);
    expect(names((await a.places()).trash)).toEqual(["Atlas"]);
    await a.call("restore", { bot: "Atlas" });
    await rounds(3);
    const after = await both(a, b);
    expect(after.a).toEqual({ bots: [{ ...atlas(before.a), chats: [...atlas(before.a).chats, "On B:2"].sort() }], trash: [] });
    expect(after.b).toEqual({ bots: [{ ...atlas(before.b), chats: [...atlas(before.b).chats, "On B:2"].sort() }], trash: [] });
  });

  it("(e2) A new, B old: Delete on B erases everywhere, as today", async () => {
    const { a, b, before } = await pair();
    await b.call("old", { old: true });
    await b.call("oldDelete", { bot: "Atlas" });
    await rounds(3);
    expect(await both(a, b)).toEqual({
      a: { bots: before.a.bots.filter((bot) => bot.name !== "Atlas"), trash: [] },
      b: { bots: before.b.bots.filter((bot) => bot.name !== "Atlas"), trash: [] },
    });
  });

  it("(f) B's edit and chat after A's Delete go to B's trash and come back on both at Restore", async () => {
    const { a, b, before } = await pair();
    await a.call("trash", { bot: "Atlas" });
    await rounds(1, [a]);
    await b.call("rename", { bot: "Atlas", to: "Atlas B" });
    await b.call("chat", { bot: "Atlas B", chat: { title: "Late", rows: 2 } });
    await b.sync.kick();
    await b.sync.idle();
    await rounds(1, [b]);
    const edited = (place: Places) => ({ ...atlas(place), name: "Atlas B", chats: [...atlas(place).chats, "Late:2"].sort() });
    expect((await b.places()).trash).toEqual([{ ...edited(before.b), daysLeft: 30 }]);
    await rounds(2);
    expect(names((await a.places()).trash)).toEqual(["Atlas"]);
    expect(names((await b.places()).trash)).toEqual(["Atlas B"]);
    await a.call("restore", { bot: "Atlas" });
    await rounds(4);
    const after = await both(a, b);
    expect(after.a.bots.find((bot) => bot.id === atlas(before.a).id)).toEqual(edited(before.a));
    expect(after.b.bots.find((bot) => bot.id === atlas(before.b).id)).toEqual(edited(before.b));
    expect([after.a.trash, after.b.trash]).toEqual([[], []]);
  });

  it("keeps a Restore made on a PC whose clock is an hour behind", async () => {
    const { a, b, before } = await pair();
    await b.call("clock", { skew: -HOUR });
    await a.call("trash", { bot: "Atlas" });
    await rounds(2);
    await b.call("restore", { bot: "Atlas" });
    await rounds(3);
    expect(await both(a, b)).toEqual(before);
    const [trashed, restored] = marks(a);
    expect(restored.recordedAt).toBeGreaterThan(trashed.recordedAt);
  });

  it("does not let a Delete made offline on Monday and sent on Friday undo Wednesday's Restore", async () => {
    const { a, b, before } = await pair();
    await a.call("clock", { skew: DAY });
    await a.call("trash", { bot: "Atlas" });
    await b.call("clock", { skew: 2 * DAY });
    await b.call("trash", { bot: "Atlas" });
    await rounds(1, [b]);
    await b.call("clock", { skew: 3 * DAY });
    await b.call("restore", { bot: "Atlas" });
    await rounds(1, [b]);
    await a.call("clock", { skew: 5 * DAY });
    await rounds(3);
    expect(await both(a, b)).toEqual(before);
    expect(marks(a).map((op) => op.changes!.trashed)).toEqual([true, true, false]);
  });
});
