import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDriveClient } from "./drive-client.ts";
import { readDriveOwnIds } from "./drive-own-ids.ts";
import { GoogleAccount, type GoogleSession } from "./google-account.ts";
import { GOOGLE_TABLE_FILE, createGoogleSync, type GoogleSync } from "./google-sync.ts";
import { loadOrCreateSyncWorkspace, loadProfileSyncSettings, saveProfileSyncSettings, syncedInFolder } from "./profile-sync.ts";
import { createDriveMirror as oldMirror } from "./testing/drive-mirror-1.0.213.ts";
import { FakeDrive } from "./testing/fake-drive.ts";
import type { BotSpec, PlaceRoom, ReportBot, RoomChat, TestArgs, TestResult } from "./testing/google-sync-pc.ts";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const A: GoogleSession = { refreshToken: "refresh-a", sub: "account-a", email: "a@example.com" };
const OWNER = { issuer: "https://accounts.google.com", sub: A.sub } as const;
const tokenFetch: typeof fetch = async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }));
const BOTS: BotSpec[] = [{ name: "Atlas", chats: [{ title: "Plans", rows: 2 }] }, { name: "Nova" }];

interface PC {
  dataDir: string; account: GoogleAccount; sync: GoogleSync;
  call(method: string, args?: TestArgs): Promise<TestResult>;
  rooms(): Promise<PlaceRoom[]>;
  chat(room: string): Promise<RoomChat>;
  close(): Promise<void>;
}
type Booting = Omit<PC, "sync"> & { sync?: GoogleSync };

let root: string;
let drive: FakeDrive;
let pcs: PC[];
const old = new Set<PC>();

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
    // SAFETY: the fixture's rooms method answers PlaceRoom[].
    rooms: async () => await base.call("rooms") as PlaceRoom[],
    // SAFETY: the fixture's roomChat method answers RoomChat.
    chat: async (room) => await base.call("roomChat", { room }) as RoomChat,
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

/** An old PC runs the 1.0.213 Drive mirror and a v2 store with no room owners. */
async function pass(pc: PC): Promise<void> {
  await pc.call("pass");
  if (old.has(pc)) {
    await oldMirror({ owner: OWNER, ownIds: readDriveOwnIds(pc.dataDir), mirrorPath: join(pc.dataDir, "google-drive"), statePath: join(pc.dataDir, GOOGLE_TABLE_FILE),
      client: createDriveClient({ getAccessToken: async () => "access", fetch: drive.fetch }) }).syncOnce();
    return;
  }
  await pc.sync.kick();
  await pc.sync.idle();
}

async function rounds(n: number): Promise<void> {
  for (let i = 0; i < n; i++) for (const pc of pcs) await pass(pc);
}

async function start(pc: PC): Promise<void> {
  pc.account.setSession(A);
  await pc.sync.read();
  await pc.sync.start();
  await pc.sync.idle();
}

const HOME = ["Atlas", "Nova", "Orion", "Lyra", "Vega", "Rigel", "Sol"];
const PAIRS = HOME.flatMap((x, i) => HOME.slice(i + 1).map((y) => [x, y] as const)).slice(0, 17);
const CHANNELS = PAIRS.map(([x, y]) => `${x} ⇄ ${y}`).sort();
const TEAM_ROOMS = ["Friends", "Launch crew"];

/** Home on 11-13: bot-to-bot channels and team rooms, all made before chat sync took rooms. */
async function home(pc: PC): Promise<void> {
  await pc.call("seed", { bots: HOME.map((name) => ({ name })) });
  for (const [i, [x, y]] of PAIRS.entries()) {
    const room = `${x} ⇄ ${y}`;
    await pc.call("room", { room, members: [x, y], dm: true });
    for (let n = 0; n < 2 + (i % 3); n++) {
      const [from, to] = n % 2 ? [y, x] : [x, y];
      await pc.call("roomSay", { room, text: `${from} to ${to} ${n}`, bot: from, to });
    }
  }
  await pc.call("room", { room: "Launch crew", members: ["Atlas"], hosted: true });
  await pc.call("roomSay", { room: "Launch crew", text: "team only: launch plan", bot: "Atlas" });
  await pc.call("room", { room: "Friends", hosted: true });
  await pc.call("roomSay", { room: "Friends", text: "team only: hello friends" });
}

const portable = (chat: RoomChat) => chat.threads.map(({ id, title, rows }) => ({ id, title, rows: rows.map(({ id, role, text, parentId }) => ({ id, role, text, parentId })) }));
const texts = (chat: RoomChat) => chat.threads.flatMap((thread) => thread.rows.map((row) => row.text));
const names = (rooms: PlaceRoom[]) => rooms.map((room) => room.name);
// SAFETY: the fixture's report method answers ReportBot[].
const bots = (pc: PC) => pc.call("report") as Promise<ReportBot[]>;
// SAFETY: the fixture's botIds method answers names to local ids.
const ids = (pc: PC) => pc.call("botIds") as Promise<Record<string, string>>;
const uploaded = () => drive.uploads.map((upload) => (upload.name.endsWith(".gz") ? gunzipSync(upload.bytes) : upload.bytes).toString("utf8"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-google-room-backfill-"));
  drive = new FakeDrive();
  drive.pageSize = 1000;
  pcs = [];
  old.clear();
});

afterEach(async () => {
  for (const pc of pcs) await pc.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Room backfill between Google PCs", { timeout: 300_000 }, () => {
  it("adds no rows when a room's history is seeded twice", async () => {
    const a = makePC("a");
    await a.call("seed", { bots: BOTS });
    await a.call("room", { room: "Plans", members: ["Atlas", "Nova"] });
    await a.call("room", { room: "Atlas ⇄ Nova", members: ["Atlas", "Nova"], dm: true });
    for (const text of ["one", "two", "three"]) await a.call("roomSay", { room: "Plans", text });
    await a.call("roomSay", { room: "Atlas ⇄ Nova", text: "ping", bot: "Atlas", to: "Nova" });
    await a.call("roomSay", { room: "Atlas ⇄ Nova", text: "pong", bot: "Nova", to: "Atlas" });
    await start(a);
    await rounds(2);
    const b = makePC("b");
    await start(b);
    await rounds(3);
    const seeded = await Promise.all(["Plans", "Atlas ⇄ Nova"].map(async (room) => portable(await a.chat(room))));
    expect(seeded.map((chat) => chat[0].rows.length)).toEqual([3, 2]);
    expect(await Promise.all(["Plans", "Atlas ⇄ Nova"].map(async (room) => portable(await b.chat(room))))).toEqual(seeded);
    const packets = await a.call("packets");

    expect(await a.call("reseed")).toBe(2);
    await rounds(3);
    expect(await a.call("packets")).toBe(packets);
    for (const pc of [a, b]) {
      expect(await Promise.all(["Plans", "Atlas ⇄ Nova"].map(async (room) => portable(await pc.chat(room))))).toEqual(seeded);
    }
  });

  it("smoke: Home's 17 channels reach B with equal rows, team rooms stay home, and C on the old build is unchanged", async () => {
    const a = makePC("a");
    await home(a);
    await start(a);
    await rounds(2);
    const c = makePC("c");
    await c.call("old", { old: true });
    await start(c);
    c.sync.stop();
    old.add(c);
    await rounds(2);
    const device = loadProfileSyncSettings(c.dataDir).deviceId;
    const b = makePC("b");
    await start(b);
    await rounds(4);

    expect(names(await a.rooms())).toEqual([...CHANNELS, ...TEAM_ROOMS].sort());
    expect(names(await b.rooms())).toEqual(CHANNELS);
    expect((await b.rooms()).every((room) => room.dm && room.members.length === 2)).toBe(true);
    for (const room of CHANNELS) {
      const [ours, theirs] = [await a.chat(room), await b.chat(room)];
      expect(ours.threads[0].rows.length).toBeGreaterThan(1);
      expect(portable(theirs)).toEqual(portable(ours));
    }
    const [idsA, idsB] = [await ids(a), await ids(b)];
    const [x, y] = PAIRS[0];
    expect((await b.chat(`${x} ⇄ ${y}`)).threads[0].rows.map((row) => row.from)).toEqual([idsB[x], idsB[y]]);
    for (const id of [...Object.values(idsA), ...Object.values(idsB)]) expect(uploaded().some((text) => text.includes(id))).toBe(false);
    for (const room of TEAM_ROOMS) {
      const thread = (await a.chat(room)).threads[0].id;
      expect(await b.call("threadRows", { thread })).toBe(0);
    }
    expect(uploaded().some((text) => text.includes("team only"))).toBe(false);

    await c.call("chat", { bot: "Atlas", chat: { title: "From C", rows: 2 } });
    await a.call("chat", { bot: "Nova", chat: { title: "From A", rows: 2 } });
    await rounds(4);
    expect(await c.rooms()).toEqual([]);
    expect(await c.call("threadRows", { thread: (await a.chat(CHANNELS[0])).threads[0].id })).toBe(0);
    expect(loadProfileSyncSettings(c.dataDir).deviceId).toBe(device);
    const everyone = await bots(a);
    expect(everyone.find((bot) => bot.name === "Atlas")?.chats).toEqual(["From C:2"]);
    expect(everyone.find((bot) => bot.name === "Nova")?.chats).toEqual(["From A:2"]);
    expect(await bots(b)).toEqual(everyone);
    expect(await bots(c)).toEqual(everyone);
  });

  it("keeps both channels a pair made on two PCs and sends new exchanges to the oldest on both", async () => {
    const a = makePC("a");
    await a.call("seed", { bots: BOTS });
    await start(a);
    await rounds(2);
    const b = makePC("b");
    await start(b);
    await rounds(3);
    await a.call("room", { room: "On A", members: ["Atlas", "Nova"], dm: true });
    await new Promise((done) => setTimeout(done, 20));
    await b.call("room", { room: "On B", members: ["Atlas", "Nova"], dm: true });
    await rounds(3);
    for (const pc of [a, b]) expect(names(await pc.rooms())).toEqual(["On A", "On B"]);

    expect(await a.call("exchange", { bot: "Atlas", to: "Nova", text: "asked on A" })).toBe("On A");
    await rounds(3);
    expect(await b.call("exchange", { bot: "Nova", to: "Atlas", text: "asked on B" })).toBe("On A");
    await rounds(3);
    for (const pc of [a, b]) {
      expect(texts(await pc.chat("On A"))).toEqual(["asked on A", "asked on B"]);
      expect(texts(await pc.chat("On B"))).toEqual([]);
    }
  });
});
