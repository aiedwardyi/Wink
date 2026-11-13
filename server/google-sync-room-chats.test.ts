import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

/** A with two bots and a room, B joined and holding the room. */
async function pair(rooms = ["Plans"]): Promise<[PC, PC]> {
  const a = makePC("a");
  await a.call("seed", { bots: BOTS });
  await start(a);
  for (const room of rooms) await a.call("room", { room, members: ["Atlas", "Nova"] });
  await rounds(2);
  const b = makePC("b");
  await start(b);
  await rounds(3);
  expect((await b.rooms()).map((room) => room.name)).toEqual([...rooms].sort());
  return [a, b];
}

const portable = (chat: RoomChat) => chat.threads.map(({ id, title, rows }) => ({ id, title, rows: rows.map(({ id, role, text, parentId }) => ({ id, role, text, parentId })) }));
const texts = (chat: RoomChat) => chat.threads.flatMap((thread) => thread.rows.map((row) => row.text));
// SAFETY: the fixture's report method answers ReportBot[].
const bots = (pc: PC) => pc.call("report") as Promise<ReportBot[]>;
// SAFETY: the fixture's botIds method answers names to local ids.
const ids = (pc: PC) => pc.call("botIds") as Promise<Record<string, string>>;
const uploaded = () => drive.uploads.map((upload) => (upload.name.endsWith(".gz") ? gunzipSync(upload.bytes) : upload.bytes).toString("utf8"));

function roomHeads(pc: PC): string[] {
  const dir = join(pc.dataDir, "google-drive", "threads-v2");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((path) => path.startsWith("room-") && path.endsWith("head.json"));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-google-room-chats-"));
  drive = new FakeDrive();
  drive.pageSize = 1000;
  pcs = [];
  old.clear();
});

afterEach(async () => {
  for (const pc of pcs) await pc.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Room messages between Google PCs", { timeout: 240_000 }, () => {
  it("brings A's rows to B with the same ids and order and starts no turn there", async () => {
    const [a, b] = await pair();
    await a.call("roomSay", { room: "Plans", text: "hello" });
    await a.call("roomSay", { room: "Plans", text: "hi there", bot: "Atlas" });
    await a.call("roomTask", { room: "Plans", title: "Launch" });
    await a.call("roomSay", { room: "Plans", text: "next task", title: "Launch" });
    await rounds(3);
    const [ours, theirs] = [await a.chat("Plans"), await b.chat("Plans")];
    expect(texts(ours)).toEqual(["next task", "hello", "hi there"]);
    expect(portable(theirs)).toEqual(portable(ours));
    expect(theirs.written).toEqual([]);
    expect(theirs.busy).toBe(false);
    expect(theirs.active).toBe("New task");
  });

  it("maps a row's bot to B's own bot and keeps a bot B lacks", async () => {
    const [a, b] = await pair();
    await a.call("roomSay", { room: "Plans", text: "from Atlas", bot: "Atlas" });
    await a.call("roomSay", { room: "Plans", text: "from a stranger", bot: "stranger-bot" });
    await rounds(3);
    const [idsA, idsB] = [await ids(a), await ids(b)];
    expect(idsB.Atlas).not.toBe(idsA.Atlas);
    const rows = (await b.chat("Plans")).threads[0].rows;
    expect(rows.find((row) => row.text === "from Atlas")?.from).toBe(idsB.Atlas);
    expect(rows.find((row) => row.text === "from a stranger")?.from).toBe("stranger-bot");
    expect((await a.chat("Plans")).threads[0].rows.find((row) => row.text === "from Atlas")?.from).toBe(idsA.Atlas);
    const sent = uploaded().filter((text) => text.includes("from Atlas"));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((text) => text.includes(loadProfileSyncSettings(a.dataDir).botMap[idsA.Atlas]!))).toBe(true);
    for (const id of [...Object.values(idsA), ...Object.values(idsB)]) expect(uploaded().some((text) => text.includes(id))).toBe(false);
  });

  it("keeps room scopes through republish, bot rebuilds and maintenance passes", async () => {
    const [a, b] = await pair();
    await a.call("roomSay", { room: "Plans", text: "from A" });
    await rounds(2);
    await b.call("roomSay", { room: "Plans", text: "from B", bot: "Nova" });
    await rounds(3);
    const before = portable(await a.chat("Plans"));
    expect(before[0].rows.map((row) => row.text)).toEqual(["from A", "from B"]);
    for (const pc of [a, b]) {
      await pc.call("republish");
      await pc.call("rebuild", { bot: "Atlas" });
      await pc.call("rebuild", { bot: "Nova" });
    }
    await rounds(3);
    expect(portable(await a.chat("Plans"))).toEqual(before);
    expect(portable(await b.chat("Plans"))).toEqual(before);
    expect(roomHeads(a).length).toBe(2);
    expect(await bots(b)).toEqual(await bots(a));
  });

  it("drops B's copy of a deleted room and keeps one B wrote to after the delete", async () => {
    const [a, b] = await pair(["Ideas", "Plans"]);
    for (const room of ["Ideas", "Plans"]) await a.call("roomSay", { room, text: `before ${room}` });
    await rounds(3);
    const ideas = await b.chat("Ideas");
    expect(texts(ideas)).toEqual(["before Ideas"]);
    for (const room of ["Ideas", "Plans"]) await a.call("roomDelete", { room });
    await b.call("roomSay", { room: "Plans", text: "late on B" });
    await rounds(4);
    expect(await a.rooms()).toEqual([]);
    expect((await b.rooms()).map((room) => room.name)).toEqual(["Plans"]);
    expect(await b.call("threadRows", { thread: ideas.threads[0].id })).toBe(0);
    expect(texts(await b.chat("Plans"))).toEqual(expect.arrayContaining(["before Plans", "late on B"]));
  });

  it("smoke: A and B chat both ways; C on the old build downloads room heads and no-ops while its bot chats sync", async () => {
    const a = makePC("a");
    await a.call("seed", { bots: BOTS });
    await start(a);
    await rounds(2);
    const c = makePC("c");
    await start(c);
    await rounds(3);
    c.sync.stop();
    old.add(c);
    await c.call("old", { old: true });
    await a.call("room", { room: "Plans", members: ["Atlas", "Nova"] });
    await rounds(2);
    const b = makePC("b");
    await start(b);
    await rounds(3);

    await a.call("roomSay", { room: "Plans", text: "A asks" });
    await a.call("roomSay", { room: "Plans", text: "Atlas answers on A", bot: "Atlas" });
    await rounds(3);
    await b.call("roomSay", { room: "Plans", text: "B asks" });
    await b.call("roomSay", { room: "Plans", text: "Nova answers on B", bot: "Nova" });
    await c.call("chat", { bot: "Atlas", chat: { title: "From C", rows: 2 } });
    await a.call("chat", { bot: "Nova", chat: { title: "From A", rows: 2 } });
    await rounds(4);

    const chat = await a.chat("Plans");
    expect(texts(chat)).toEqual(["A asks", "Atlas answers on A", "B asks", "Nova answers on B"]);
    expect(portable(await b.chat("Plans"))).toEqual(portable(chat));
    const [idsA, idsB] = [await ids(a), await ids(b)];
    expect(chat.threads[0].rows.map((row) => row.from)).toEqual([undefined, idsA.Atlas, undefined, idsA.Nova]);
    expect((await b.chat("Plans")).threads[0].rows.map((row) => row.from)).toEqual([undefined, idsB.Atlas, undefined, idsB.Nova]);

    expect(await c.rooms()).toEqual([]);
    expect(roomHeads(c).length).toBe(2);
    expect(await c.call("threadRows", { thread: chat.threads[0].id })).toBe(0);
    const everyone = await bots(a);
    expect(everyone.find((bot) => bot.name === "Atlas")?.chats).toEqual(expect.arrayContaining(["From C:2", "Plans:2"]));
    expect(everyone.find((bot) => bot.name === "Nova")?.chats).toEqual(["From A:2"]);
    expect(await bots(b)).toEqual(everyone);
    expect(await bots(c)).toEqual(everyone);
  });
});
