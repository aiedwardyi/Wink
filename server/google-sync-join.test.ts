import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeDeviceRecord } from "./device-sync.ts";
import { GoogleAccount, type GoogleSession } from "./google-account.ts";
import { decodeDrivePath } from "./drive-mirror.ts";
import { createGoogleSync, readGoogleBinding, type GoogleSync } from "./google-sync.ts";
import { ensureMemorySyncDevice, type MemorySyncLedger } from "./memory-sync.ts";
import { createSyncOperation, loadOrCreateSyncWorkspace, readSyncOperations, writeSyncOperation } from "./profile-sync.ts";
import type { BotRecord, Message, TaskRecord } from "./store.ts";
import { FakeDrive } from "./testing/fake-drive.ts";
import type { Snapshot, TestArgs, TestResult } from "./testing/thread-sync-v2-pc.ts";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const A: GoogleSession = { refreshToken: "refresh-a", sub: "account-a", email: "a@example.com" };
const tokenFetch: typeof fetch = async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }));

interface LocalBot { id: string; syncId: string; name: string; talked: boolean; published: boolean }
interface Fault { match: (method: string, url: URL) => boolean; skip: number; reply: () => Response; hits: number }
interface PC {
  name: string; dataDir: string; deviceId: string; account: GoogleAccount; sync: GoogleSync; ledger: MemorySyncLedger;
  bots: LocalBot[]; folder: string | null; workspaceId: string; sequence: number; activations: Array<string | null>; chatsAtActivation: boolean[]; filing: boolean; fault: Fault | null;
}

type Booting = Omit<PC, "sync"> & { sync?: GoogleSync };

let root: string;
let drive: FakeDrive;
let pcs: PC[];
let engines: Array<() => Promise<void>>;

const bot = (name: string, talked = true): LocalBot => ({ id: `local-${name}`, syncId: randomUUID(), name, talked, published: false });
const botNames = (folder: string) => readSyncOperations(folder).operations.filter((op) => op.entity === "bot").map((op) => String(op.changes?.name)).sort();
const listing = (method: string, url: URL) => method === "GET" && url.pathname === "/drive/v3/files";
const rootLookup = (method: string, url: URL) => listing(method, url) && (url.searchParams.get("q") ?? "").includes("winkRoot");
const download = (method: string, url: URL) => method === "GET" && url.searchParams.get("alt") === "media";
const driveError = (status: number, domain: string, reason: string) => () => new Response(JSON.stringify({ error: { code: status, errors: [{ domain, reason }] } }), { status, headers: { "content-type": "application/json" } });
const fault = (match: Fault["match"], reply: Fault["reply"], skip = 0): Fault => ({ match, skip, reply, hits: 0 });

function publish(pc: Booting): void {
  const folder = pc.folder;
  if (!folder) return;
  for (const item of pc.bots) {
    if ((pc.sync?.held(item.id) && !item.talked) || item.published) continue;
    writeSyncOperation(folder, createSyncOperation({
      operationId: randomUUID(), deviceId: pc.deviceId, sequence: pc.sequence++, recordedAt: 1_800_000_000_000,
      entity: "bot", entityId: item.syncId, changes: { name: item.name },
    }));
    item.published = true;
  }
  writeDeviceRecord(folder, { deviceId: pc.deviceId, name: pc.name, host: `${pc.name}.example.ts.net`, chatSync: 2 }, 1_800_000_000_000);
}

function boot(pc: Booting): GoogleSync {
  return createGoogleSync({
    dataDir: pc.dataDir,
    account: pc.account,
    folder: () => pc.folder,
    prepare: () => void ensureMemorySyncDevice(pc.ledger),
    ownIds: () => ({ profileDeviceId: pc.deviceId, writerId: `writer-${pc.name}`, memoryDeviceId: pc.ledger.device! }),
    unusedBots: () => pc.bots.filter((item) => !item.talked).map((item) => item.id),
    filing: () => pc.filing,
    activate: (mirror) => {
      pc.activations.push(existsSync(join(mirror, "workspace.json")) ? readFileSync(join(mirror, "workspace.json"), "utf8") : null);
      pc.chatsAtActivation.push(existsSync(join(mirror, "threads-v2")) || existsSync(join(mirror, "pictures")));
      pc.folder = mirror;
      pc.workspaceId = loadOrCreateSyncWorkspace(mirror, pc.workspaceId);
      publish(pc);
      return pc.workspaceId;
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const armed = pc.fault;
      if (armed?.match(request.method, url)) {
        if (armed.skip > 0) armed.skip -= 1;
        else {
          armed.hits += 1;
          return armed.reply();
        }
      }
      return drive.fetch(input, init);
    },
    log: () => {},
  });
}

function makePC(name: string, bots: LocalBot[]): PC {
  const dataDir = join(root, name);
  mkdirSync(dataDir, { recursive: true });
  const base: Booting = {
    name, dataDir, deviceId: `device-${name}`, ledger: { bots: {} }, bots, folder: null, workspaceId: randomUUID(), sequence: 1, activations: [], chatsAtActivation: [], filing: false, fault: null,
    account: new GoogleAccount(CLIENT, null, { fetch: tokenFetch, log: () => {} }),
  };
  const pc: PC = Object.assign(base, { sync: boot(base) });
  pcs.push(pc);
  return pc;
}

async function settle(pc: PC): Promise<void> {
  await pc.sync.kick();
  await pc.sync.idle();
}

async function startOn(pc: PC): Promise<void> {
  pc.account.setSession(A);
  await pc.sync.start();
  await pc.sync.idle();
}

/** Home uploads one bot; work signs in to the same account with one unused bot and taps Start while the fault is armed. */
async function joinUnder(armed: Fault) {
  const home = makePC("home", [bot("Counsel")]);
  await startOn(home);
  const work = makePC("work", [bot("Starter", false)]);
  work.account.setSession(A);
  await work.sync.read();
  work.fault = armed;
  await work.sync.start();
  await work.sync.idle();
  return { home, work };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-google-join-"));
  drive = new FakeDrive();
  pcs = [];
  engines = [];
});

afterEach(async () => {
  for (const pc of pcs) pc.sync.stop();
  await Promise.all(engines.map((close) => close()));
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A PC's chat engine on its Drive mirror, in its own worker like the app's message store. */
function engine(folder: string, name: string) {
  const dataDir = join(root, `${name}-engine`);
  const worker = new Worker(new URL("./testing/thread-sync-v2-pc.ts", import.meta.url), {
    workerData: { folder, dataDir, deviceId: `device-${name}`, writer: `writer-${name}`, enabled: true },
    env: { ...process.env, OMB_DATA_DIR: dataDir, OMB_THREAD_SYNC_V2: "1" },
    execArgv: ["--experimental-strip-types"],
  });
  let sequence = 0;
  const call = <T extends TestResult = TestResult>(method: string, args: TestArgs = {}) => new Promise<T>((resolve, reject) => {
    const id = ++sequence;
    const reply = (message: { id: number; value: T; error?: string }) => {
      if (message.id !== id) return;
      worker.off("message", reply);
      if (message.error) reject(new Error(message.error));
      else resolve(message.value);
    };
    worker.on("message", reply);
    worker.postMessage({ id, method, args });
  });
  engines.push(async () => {
    await call("close").catch(() => {});
    await worker.terminate();
  });
  return call;
}

/** Home uploads one bot, one chat and one picture; work, with no bots of its own, taps Start. */
async function joinWithChats() {
  const home = makePC("home", [bot("Counsel")]);
  await startOn(home);
  const chat = join(home.folder!, "threads-v2", "bot-1", "thread-1", "writer-home");
  mkdirSync(chat, { recursive: true });
  writeFileSync(join(chat, "seg-1-1.json.gz"), "segment");
  writeFileSync(join(chat, "head.json"), "{}");
  mkdirSync(join(home.folder!, "pictures"));
  writeFileSync(join(home.folder!, "pictures", "a1.png"), "png");
  await settle(home);
  const work = makePC("work", []);
  work.account.setSession(A);
  await work.sync.read();
  await work.sync.start();
  return work;
}

describe("Google sync first join", { timeout: 60_000 }, () => {
  it("hands the bots to the engines before chat history lands, then fills in the chats", async () => {
    const work = await joinWithChats();
    await work.sync.idle();
    expect(work.chatsAtActivation).toEqual([false]);
    expect(botNames(work.folder!)).toEqual(["Counsel"]);
    expect(existsSync(join(work.folder!, "threads-v2", "bot-1", "thread-1", "writer-home", "head.json"))).toBe(true);
    expect(existsSync(join(work.folder!, "pictures", "a1.png"))).toBe(true);
  });

  it("marks the first sync until this PC has caught up once", async () => {
    const work = await joinWithChats();
    work.filing = true;
    expect(work.sync.status()).toMatchObject({ state: "joining", firstSync: true });
    await work.sync.idle();
    expect(work.sync.status()).toMatchObject({ state: "up-to-date", firstSync: true, finishing: true });
    work.filing = false;
    expect(work.sync.status().firstSync).toBeUndefined();
    work.filing = true;
    await settle(work);
    expect(work.sync.status().firstSync).toBeUndefined();
  });
});

describe("Google sync first join with chat engines", { timeout: 180_000 }, () => {
  it("keeps a send to a bot whose chat has not downloaded yet at the end of that chat on both PCs", async () => {
    const home = makePC("home", [{ ...bot("Counsel"), syncId: "bot" }]);
    await startOn(home);
    const source = engine(home.folder!, "home");
    const { threadId } = await source<TaskRecord>("create");
    await source("batch", { threadId, count: 2001 });
    await source("flush", { threadId });
    const tip = (await source<Snapshot>("snapshot", { threadId })).leaf;
    await settle(home);

    const work = makePC("work", []);
    work.account.setSession(A);
    await work.sync.read();
    let reached = () => {};
    const atChat = new Promise<void>((resolve) => { reached = resolve; });
    let resume = () => {};
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    drive.onDownload = async (file) => {
      if (!decodeDrivePath(file.name)?.startsWith("threads-v2/")) return;
      reached();
      await resumed;
    };
    const joined = work.sync.start();
    await atChat;
    const laptop = engine(work.folder!, "work");
    await laptop("clock");
    const heads = [...drive.records.values()].flatMap(({ file }): Array<[string, typeof file[]]> => {
      const path = decodeDrivePath(file.name);
      return path?.endsWith("/head.json") ? [[path, [file]]] : [];
    });
    const opened = await laptop<BotRecord>("join", { heads });
    await laptop("poll");
    await laptop("send", { threadId: opened.threadId, text: "continue our conversation" });
    resume();
    await joined;
    await work.sync.idle();
    await laptop("pull", { threadId });
    await laptop("flush", { threadId });
    await settle(work);
    await settle(home);
    await source("poll");

    for (const call of [laptop, source]) {
      const shown = await call<BotRecord>("bot");
      const chat = await call<Snapshot>("snapshot", { threadId });
      const send = chat.rows.find((row: Message) => row.text === "continue our conversation");
      expect(shown.threadId).toBe(threadId);
      expect(chat.rows).toHaveLength(2002);
      expect(send?.parentId).toBe(tip);
      expect(chat.leaf).toBe(send?.id);
    }
  });
});

describe("Google sync join under Drive errors", { timeout: 60_000 }, () => {
  it.each([
    ["a bare 429 on the mirror's first listing", () => fault(rootLookup, () => new Response(null, { status: 429 }), 1)],
    ["a 429 on the first download", () => fault(download, () => new Response(null, { status: 429 }))],
    ["a 403 userRateLimitExceeded on a listing", () => fault(rootLookup, driveError(403, "usageLimits", "userRateLimitExceeded"), 1)],
  ])("keeps joining after %s and joins the home workspace on a clean pass", async (_name, make) => {
    const armed = make();
    const { home, work } = await joinUnder(armed);
    expect(armed.hits).toBeGreaterThan(0);
    expect(readGoogleBinding(work.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "joining", workspaceId: null } });
    expect(work.activations).toEqual([]);
    expect(work.sync.status().state).not.toBe("up-to-date");

    work.fault = null;
    await settle(work);
    expect(readGoogleBinding(work.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "ready", workspaceId: home.workspaceId } });
    expect(work.workspaceId).toBe(home.workspaceId);
    expect(work.sync.held("local-Starter")).toBe(true);
    await settle(home);
    expect(botNames(home.folder!)).toEqual(["Counsel"]);
    expect(botNames(work.folder!)).toEqual(["Counsel"]);
  });

  it("reads a permanent Drive error during the join as error, then recovers on a clean pass", async () => {
    const { home, work } = await joinUnder(fault(listing, driveError(403, "global", "insufficientPermissions")));
    expect(readGoogleBinding(work.dataDir)).toMatchObject({ kind: "ok", binding: { phase: "joining" } });
    expect(work.sync.status().state).toBe("error");

    work.fault = null;
    await settle(work);
    expect(work.sync.status().state).toBe("up-to-date");
    expect(work.workspaceId).toBe(home.workspaceId);
    expect(work.sync.held("local-Starter")).toBe(true);
  });
});
