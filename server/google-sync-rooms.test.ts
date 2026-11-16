import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDriveClient } from "./drive-client.ts";
import { readDriveOwnIds } from "./drive-own-ids.ts";
import { GoogleAccount, type GoogleSession } from "./google-account.ts";
import { GOOGLE_BINDING_FILE, GOOGLE_TABLE_FILE, createGoogleSync, readGoogleBinding, type GoogleSync } from "./google-sync.ts";
import { loadOrCreateSyncWorkspace, loadProfileSyncSettings, saveProfileSyncSettings, syncedInFolder } from "./profile-sync.ts";
import { createDriveMirror as oldMirror } from "./testing/drive-mirror-1.0.213.ts";
import { FakeDrive } from "./testing/fake-drive.ts";
import type { BotSpec, PlaceRoom, TestArgs, TestResult } from "./testing/google-sync-pc.ts";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const A: GoogleSession = { refreshToken: "refresh-a", sub: "account-a", email: "a@example.com" };
const OWNER = { issuer: "https://accounts.google.com", sub: A.sub } as const;
const tokenFetch: typeof fetch = async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }));
const BOTS: BotSpec[] = [{ name: "Atlas", chats: [{ title: "Plans", rows: 2 }] }, { name: "Nova" }];

interface PC {
  dataDir: string; account: GoogleAccount; sync: GoogleSync;
  call(method: string, args?: TestArgs): Promise<TestResult>;
  rooms(): Promise<PlaceRoom[]>;
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

/** An old PC runs the 1.0.213 Drive mirror, which never downloads a `.room` file. */
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

const strict = (pc: PC) => ({
  deviceId: loadProfileSyncSettings(pc.dataDir).deviceId,
  profile: Object.keys(JSON.parse(readFileSync(join(pc.dataDir, "profile-sync.json"), "utf8"))).sort(),
  binding: readFileSync(join(pc.dataDir, GOOGLE_BINDING_FILE), "utf8"),
  bindingOk: readGoogleBinding(pc.dataDir).kind,
});
const roomFiles = (pc: PC) => readdirSync(join(pc.dataDir, "google-drive", "changes")).filter((name) => name.endsWith(".room"));
const portable = (rooms: PlaceRoom[]) => rooms.filter((room) => room.name !== "C only");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-google-rooms-"));
  drive = new FakeDrive();
  drive.pageSize = 1000;
  pcs = [];
  old.clear();
});

afterEach(async () => {
  for (const pc of pcs) await pc.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Room records between Google PCs", { timeout: 180_000 }, () => {
  it("A creates, renames and edits members; B follows; C on the 1.0.213 mirror stays as it was", async () => {
    const a = makePC("a");
    await a.call("seed", { bots: BOTS });
    await start(a);
    await rounds(2);
    const c = makePC("c");
    await start(c);
    await rounds(3);
    await c.call("room", { room: "C only", members: ["Atlas"] });
    c.sync.stop();
    old.add(c);
    await c.call("old", { old: true });
    await rounds(1);
    const before = { rooms: await c.rooms(), strict: strict(c) };
    expect(before.rooms.map((room) => room.name)).toEqual(["C only"]);
    expect(before.strict.bindingOk).toBe("ok");

    await a.call("room", { room: "Plans", members: ["Atlas"] });
    await a.call("room", { room: "Atlas & Nova", members: ["Atlas", "Nova"], dm: true });
    await rounds(2);
    const b = makePC("b");
    await start(b);
    await rounds(3);
    expect(await b.rooms()).toEqual(await a.rooms());
    expect((await b.rooms()).map(({ name, members, dm, setup }) => ({ name, members, dm, setup }))).toEqual([
      { name: "Atlas & Nova", members: ["Atlas", "Nova"], dm: true, setup: false },
      { name: "Plans", members: ["Atlas"], dm: false, setup: true },
    ]);

    await a.call("roomEdit", { room: "Plans", to: "Plans 2", members: ["Atlas", "Nova"] });
    await rounds(3);
    expect(await b.rooms()).toEqual(await a.rooms());
    expect((await b.rooms()).find((room) => room.name === "Plans 2")?.members).toEqual(["Atlas", "Nova"]);

    expect(await c.rooms()).toEqual(before.rooms);
    expect(portable(await a.rooms()).map((room) => room.name)).toEqual(["Atlas & Nova", "Plans 2"]);
    expect(roomFiles(c)).toEqual([]);
    expect(roomFiles(b).length).toBeGreaterThan(0);
    expect(strict(c)).toEqual(before.strict);
    for (const pc of [a, b]) {
      expect(strict(pc).profile).toEqual(before.strict.profile);
      expect(strict(pc).bindingOk).toBe("ok");
    }
  });

  it("deletes a room on every new PC and never from a PC that lacks it", async () => {
    const a = makePC("a");
    await a.call("seed", { bots: BOTS });
    await start(a);
    await a.call("room", { room: "Plans", members: ["Atlas"] });
    await rounds(2);
    const b = makePC("b");
    await start(b);
    await rounds(3);
    await b.call("room", { room: "Only B", members: ["Nova"] });
    await rounds(3);
    expect((await a.rooms()).map((room) => room.name)).toEqual(["Only B", "Plans"]);
    await b.call("roomDelete", { room: "Plans" });
    await rounds(3);
    expect((await a.rooms()).map((room) => room.name)).toEqual(["Only B"]);
    expect(await b.rooms()).toEqual(await a.rooms());
  });
});
