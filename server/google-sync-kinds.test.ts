import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as atomic from "./atomic.ts";
import { ensureDirs } from "./config.ts";
import { createDriveClient } from "./drive-client.ts";
import { createDriveMirror, decodeDrivePath, DRIVE_READER_REVISION, drivePathHash, drivePathRule, encodeDrivePath } from "./drive-mirror.ts";
import { GoogleAccount } from "./google-account.ts";
import { createGoogleSync, GOOGLE_TABLE_FILE, readGoogleBinding, type GoogleSync } from "./google-sync.ts";
import { applySyncOperations, createSyncOperation, emptyProfileSyncState, loadOrCreateSyncWorkspace, loadProfileSyncSettings, readSyncOperations, remoteFieldsToApply, saveProfileSyncSettings, syncValueHash, writeSyncOperation } from "./profile-sync.ts";
import { syncHold } from "./sync-hold.ts";
import { createStartupTiming } from "./startup-timing.ts";
import { createDriveMirror as oldMirror } from "./testing/drive-mirror-1.0.213.ts";
import { FakeDrive } from "./testing/fake-drive.ts";
import { createSyncEngine } from "./thread-sync-v2-engine.ts";

const OWNER = { issuer: "https://accounts.google.com", sub: "account-a" } as const;
const IDS = { profileDeviceId: "device-reader", writerId: "writer-reader", memoryDeviceId: "aaaaaaaaaaaa" };
const RECEIPT = "google-drive-kinds.json";
let root: string;
let drive: FakeDrive;
let syncs: GoogleSync[];

function write(path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

const table = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, GOOGLE_TABLE_FILE), "utf8"));
const receipt = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, RECEIPT), "utf8"));
const children = () => drive.calls.filter(({ url }) => url.pathname === "/drive/v3/files" && url.searchParams.get("q")?.includes("in parents") && !url.searchParams.get("q")?.includes("name ="));
const starts = () => drive.calls.filter(({ url }) => url.pathname.endsWith("/startPageToken"));
const value = (folder: string) => applySyncOperations(emptyProfileSyncState(), readSyncOperations(folder).operations).bots["bot-1"]?.mascotStyle;
const seed = (path: string, bytes = "data") => drive.add(encodeDrivePath(path), { ph: drivePathHash(path) }, Buffer.from(bytes), [drive.root().id]);
const recover = (dataDir: string, extra: Partial<Parameters<typeof createDriveMirror>[0]> = {}) => mirror(dataDir, { kindsPath: join(dataDir, RECEIPT), allowKindRescan: true, ...extra }).syncOnce();

function window(): void {
  drive.calls.length = 0;
  drive.downloads.length = 0;
  drive.uploads.length = 0;
}

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((done) => { release = done; });
  const started = new Promise<void>((done) => { entered = done; });
  return { release, entered, held, started };
}

function mirror(dataDir: string, extra: Partial<Parameters<typeof createDriveMirror>[0]> = {}) {
  return createDriveMirror({ owner: OWNER, ownIds: IDS, mirrorPath: join(dataDir, "google-drive"), statePath: join(dataDir, GOOGLE_TABLE_FILE),
    client: createDriveClient({ getAccessToken: async () => "fake-access", fetch: drive.fetch }), ...extra });
}

function boot(dataDir: string, ready: () => boolean, extra: Partial<Parameters<typeof createGoogleSync>[0]> = {}) {
  const account = new GoogleAccount({ id: "fake-client", secret: "fake-secret" }, null, {
    fetch: async () => Response.json({ access_token: "fake-access", expires_in: 3600 }), log: () => {},
  });
  account.setSession({ refreshToken: "fake-refresh", sub: OWNER.sub, email: "fake@example.com" });
  const folder = join(dataDir, "google-drive");
  const options = {
    dataDir, account, folder: () => existsSync(join(dataDir, GOOGLE_TABLE_FILE)) ? folder : null, prepare: () => {}, ownIds: () => IDS, unusedBots: () => [],
    activate: (path: string) => loadOrCreateSyncWorkspace(path, "workspace-a"), fetch: drive.fetch, log: () => {},
    kindsReady: ready, ...extra,
  };
  const sync = createGoogleSync(options);
  syncs.push(sync);
  return sync;
}

async function settle(sync: GoogleSync): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await sync.kick();
    if (sync.status().state === "up-to-date" || sync.status().state === "drive-full") return;
  }
  throw new Error(`sync did not settle: ${sync.status().state}`);
}

async function joined() {
  const dataDir = join(root, "reader");
  mkdirSync(dataDir, { recursive: true });
  const sync = boot(dataDir, () => false);
  expect((await sync.start()).status).toBe(200);
  await settle(sync);
  sync.stop();
  return dataDir;
}

async function publish(changes: Record<string, unknown>, sequence = 1) {
  const dataDir = join(root, "writer");
  const folder = join(dataDir, "google-drive");
  mkdirSync(folder, { recursive: true });
  const operation = createSyncOperation({ operationId: randomUUID(), deviceId: "device-writer", sequence, recordedAt: 1_800_000_000_000 + sequence,
    entity: "bot", entityId: "bot-1", changes });
  const file = writeSyncOperation(folder, operation);
  const path = relative(folder, file).split(sep).join("/");
  await mirror(dataDir, { ownIds: { ...IDS, profileDeviceId: "device-writer" } }).syncOnce();
  return { path, operation };
}

async function skipStyle(dataDir: string) {
  const before = table(dataDir).changeToken;
  const { path } = await publish({ mascotStyle: "icon-36" });
  const downloads = drive.downloads.length;
  const summary = await oldMirror({ owner: OWNER, ownIds: IDS, mirrorPath: join(dataDir, "google-drive"), statePath: join(dataDir, GOOGLE_TABLE_FILE),
    client: createDriveClient({ getAccessToken: async () => "fake-access", fetch: drive.fetch }) }).syncOnce();
  expect(table(dataDir).changeToken).not.toBe(before);
  expect(summary.skipped).toContain(path);
  expect(drive.downloads).toHaveLength(downloads);
  expect(existsSync(join(dataDir, "google-drive", path))).toBe(false);
  expect(value(join(dataDir, "google-drive"))).toBeUndefined();
  return path;
}

async function healthyScale() {
  const dataDir = await joined();
  drive.pageSize = 1_000;
  const stored = table(dataDir);
  const paths = [
    ...Array.from({ length: 5_000 }, (_, i) => `threads-v2/bot-1/thread-${i % 100}/peer/seg-${i + 1}-${i + 1}.json.gz`),
    ...Array.from({ length: 100 }, (_, i) => `threads-v2/bot-1/thread-${i}/peer/head.json`),
    ...Array.from({ length: 398 }, (_, i) => `pictures/${i}.png`), `devices/${IDS.profileDeviceId}.json`,
  ];
  for (const path of paths) {
    const file = seed(path, "retained bytes");
    write(join(dataDir, "google-drive", path), "retained bytes");
    stored.files[path] = { driveId: file.id, md5: file.md5Checksum, size: file.size };
  }
  writeFileSync(join(dataDir, GOOGLE_TABLE_FILE), JSON.stringify(stored));
  await mirror(dataDir, { kindsPath: join(dataDir, RECEIPT) }).syncOnce();
  const op = createSyncOperation({ operationId: randomUUID(), deviceId: "device-writer", sequence: 1, recordedAt: 1_800_000_000_001,
    entity: "bot", entityId: "bot-1", changes: { mascotStyle: "icon-36" } });
  const file = writeSyncOperation(join(root, "publisher"), op);
  const path = `changes/${file.split(sep).at(-1)!}`;
  await createDriveClient({ getAccessToken: async () => "fake-access", fetch: drive.fetch }).createFile(drive.root().id, encodeDrivePath(path), { ph: drivePathHash(path) }, readFileSync(file));
  const skipped = await oldMirror({ owner: OWNER, ownIds: IDS, mirrorPath: join(dataDir, "google-drive"), statePath: join(dataDir, GOOGLE_TABLE_FILE),
    client: createDriveClient({ getAccessToken: async () => "fake-access", fetch: drive.fetch }) }).syncOnce();
  expect(skipped.skipped).toContain(path);
  expect(Object.keys(table(dataDir).files)).toHaveLength(5_500);
  expect(drive.records.size).toBe(5_502);
  return dataDir;
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "google-sync-kinds-")));
  drive = new FakeDrive();
  syncs = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  for (const sync of syncs) sync.stop();
  syncHold.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("Google reader kind recovery", () => {
  it("pins the reader revision to classifier, writer, reader and Google enumeration", () => {
    const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const classifier = source("./drive-mirror.ts").split("export function drivePathRule")[1].split("\nfunction priority")[0];
    const profile = source("./profile-sync.ts");
    const own = [...profile.match(/const OWN_OP_EXTENSIONS = (.+);/)![1].matchAll(/: "([a-z]+)"/g)].map((match) => match[1]);
    const reader = profile.match(/const isSyncOperationFile = .+/)![0].match(/json\|[a-z|]+/)![0];
    const google = source("./google-sync.ts").match(/const OPERATION_FILE = .+/)![0].match(/json\|[a-z|]+/)![0];
    expect({ revision: DRIVE_READER_REVISION, classifier: createHash("sha256").update(classifier).digest("hex"), own, reader, google }).toEqual({
      revision: 1, classifier: "2e55776b67e0841ff3f06849ca7956c03b6d6069deb1b0d763e83bc007f443e2", own: ["notes", "paths", "pin", "style"], reader: "json|notes|paths|pin|style", google: "json|notes|paths|pin|style",
    });
    for (const ext of ["json", ...own]) {
      expect(drivePathRule(`changes/1-device-writer-op.${ext}`, IDS)).toBe("once");
      expect(drivePathRule(`changes/1-${IDS.profileDeviceId}-op.${ext}`, IDS)).toBe("own");
    }
  });

  it("recovers a skipped style after an old reader advances a valid cursor", async () => {
    const dataDir = await joined();
    const receiptPath = join(dataDir, RECEIPT);
    if (existsSync(receiptPath)) unlinkSync(receiptPath);
    const path = await skipStyle(dataDir);
    let ready = false;
    const sync = boot(dataDir, () => ready);
    sync.resume();
    await settle(sync);
    expect(value(join(dataDir, "google-drive"))).toBeUndefined();
    drive.calls.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(children()).toHaveLength(0);
    ready = true;
    drive.calls.length = 0;
    const downloads = drive.downloads.length;
    const uploads = drive.uploads.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(children().length, "automatic inventory after quiet tick").toBeGreaterThan(0);
    expect(existsSync(join(dataDir, "google-drive", path))).toBe(true);
    expect(value(join(dataDir, "google-drive"))).toBe("icon-36");
    expect(drive.downloads).toHaveLength(downloads + 1);
    expect(drive.uploads).toHaveLength(uploads);
    drive.calls.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    await sync.idle();
    expect(children()).toHaveLength(0);
    sync.stop();
    drive.calls.length = 0;
    const restarted = boot(dataDir, () => true);
    restarted.resume();
    await settle(restarted);
    expect(children()).toHaveLength(1);
    expect(starts()).toHaveLength(0);
    drive.calls.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    await restarted.idle();
    expect(children()).toHaveLength(0);
    expect(drive.downloads).toHaveLength(downloads + 1);
    expect(drive.uploads).toHaveLength(uploads);
    expect(readSyncOperations(join(dataDir, "google-drive")).operations).toHaveLength(1);
  });

  it("detects a downgrade cursor advance with an existing current receipt", async () => {
    const dataDir = await joined();
    const initial = receipt(dataDir);
    await skipStyle(dataDir);
    seed("pictures/ordinary.png");
    let ready = false;
    const sync = boot(dataDir, () => ready);
    sync.resume();
    await settle(sync);
    expect(receipt(dataDir)).toEqual(initial);
    ready = true;
    window();
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(starts()).toHaveLength(1);
    expect(value(join(dataDir, "google-drive"))).toBe("icon-36");
    expect(receipt(dataDir).changeToken).toBe(table(dataDir).changeToken);
  });

  it.each(["absent", "corrupt", "revision", "owner", "root", "generation", "path", "token"])("repairs a %s receipt once", async (problem) => {
    const dataDir = await joined();
    const path = join(dataDir, RECEIPT);
    const initial = receipt(dataDir);
    if (problem === "absent") unlinkSync(path);
    else if (problem === "corrupt") writeFileSync(path, "{");
    else {
      const changed = structuredClone(initial);
      if (problem === "revision") changed.readerRevision++;
      if (problem === "owner") changed.binding.owner.sub = "other-account";
      if (problem === "root") changed.binding.rootId = "other-root";
      if (problem === "generation") changed.binding.generation++;
      if (problem === "path") changed.binding.mirrorPath = root;
      if (problem === "token") changed.changeToken = "opaque-other-token";
      writeFileSync(path, JSON.stringify(changed));
    }
    window();
    const sync = boot(dataDir, () => true);
    await sync.kick();
    expect(starts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(starts()).toHaveLength(1);
    expect(receipt(dataDir)).toEqual(initial);
    window();
    await vi.advanceTimersByTimeAsync(60_000);
    await sync.idle();
    expect(children()).toHaveLength(0);
    expect(drive.calls).toHaveLength(6);
  });

  it("advances a matching receipt after ordinary passes without inventory", async () => {
    const dataDir = await joined();
    const before = receipt(dataDir);
    seed("pictures/peer.png");
    window();
    const result = await recover(dataDir);
    expect(result.kindRescan).toBeUndefined();
    expect(children()).toHaveLength(0);
    expect(receipt(dataDir).changeToken).not.toBe(before.changeToken);
    expect(receipt(dataDir).changeToken).toBe(table(dataDir).changeToken);
  });

  it("leaves a matching receipt untouched on an idle pass", async () => {
    const dataDir = await joined();
    await skipStyle(dataDir);
    await recover(dataDir);
    const kindsPath = join(dataDir, RECEIPT);
    const age = new Date(1_700_000_000_000);
    utimesSync(kindsPath, age, age);
    const bytes = readFileSync(kindsPath);
    const before = statSync(kindsPath, { bigint: true });
    const token = receipt(dataDir).changeToken;
    const writes = vi.spyOn(atomic, "writeFileAtomic");
    await mirror(dataDir, { kindsPath }).syncOnce();
    const idle = statSync(kindsPath, { bigint: true });
    expect(readFileSync(kindsPath)).toEqual(bytes);
    expect(idle.mtimeNs, "idle pass must leave receipt mtimeNs unchanged").toBe(before.mtimeNs);
    expect([idle.dev, idle.ino]).toEqual([before.dev, before.ino]);
    expect(writes.mock.calls.filter(([path]) => path === kindsPath)).toHaveLength(0);
    seed("pictures/advance.png");
    await mirror(dataDir, { kindsPath }).syncOnce();
    const advanced = statSync(kindsPath, { bigint: true });
    expect(receipt(dataDir).changeToken).not.toBe(token);
    expect(receipt(dataDir).changeToken).toBe(table(dataDir).changeToken);
    expect(readFileSync(kindsPath)).not.toEqual(bytes);
    expect(advanced.mtimeNs).not.toBe(before.mtimeNs);
    expect([advanced.dev, advanced.ino]).not.toEqual([before.dev, before.ino]);
    expect(writes.mock.calls.filter(([path]) => path === kindsPath)).toHaveLength(1);
  });

  it.each([404, 410])("lets cursor expiry %s satisfy a pending receipt without another inventory", async (status) => {
    const dataDir = await joined();
    unlinkSync(join(dataDir, RECEIPT));
    let expired = false;
    const fetch: typeof globalThis.fetch = (input, init) => {
      if (!expired && new URL(String(input)).pathname === "/drive/v3/changes") {
        expired = true;
        return Promise.resolve(new Response(null, { status }));
      }
      return drive.fetch(input, init);
    };
    window();
    const sync = boot(dataDir, () => false, { fetch });
    await sync.kick();
    expect(starts()).toHaveLength(1);
    expect(receipt(dataDir).changeToken).toBe(table(dataDir).changeToken);
    window();
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(children()).toHaveLength(0);
  });

  it("retries safely after the cursor commits but the receipt write fails", async () => {
    const dataDir = await joined();
    const initial = receipt(dataDir);
    await skipStyle(dataDir);
    const writeAtomic = atomic.writeFileAtomic;
    const writes: string[] = [];
    const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, data, options) => {
      writes.push(path);
      if (path === join(dataDir, RECEIPT)) throw new Error("receipt crash");
      writeAtomic(path, data, options);
    });
    await expect(recover(dataDir)).rejects.toThrow("receipt crash");
    expect(writes.at(-2)).toBe(join(dataDir, GOOGLE_TABLE_FILE));
    expect(writes.at(-1)).toBe(join(dataDir, RECEIPT));
    expect(receipt(dataDir)).toEqual(initial);
    expect(value(join(dataDir, "google-drive"))).toBe("icon-36");
    spy.mockRestore();
    window();
    expect((await recover(dataDir)).kindRescan).toBe(true);
    expect(drive.downloads).toHaveLength(0);
    expect(receipt(dataDir).changeToken).toBe(table(dataDir).changeToken);
    expect((await recover(dataDir)).kindRescan).toBeUndefined();
  });

  it.each(["listing-error", "listing-429", "download-error", "download-429", "catchup-429"])("keeps a receipt pending after %s and reuses landed files", async (failure) => {
    const dataDir = await joined();
    const initial = receipt(dataDir);
    await skipStyle(dataDir);
    seed("pictures/retry.png");
    let failed = false;
    const client = createDriveClient({ getAccessToken: async () => "fake-access", fetch: async (input, init) => {
      const url = new URL(String(input));
      const target = failure.startsWith("catchup") ? url.pathname === "/drive/v3/changes" : failure.startsWith("listing") ? url.searchParams.get("q")?.includes("in parents") : url.searchParams.get("alt") === "media" && decodeDrivePath(drive.records.get(url.pathname.split("/").at(-1)!)!.file.name) === "pictures/retry.png";
      if (!failed && target) {
        failed = true;
        return new Response(null, { status: failure.endsWith("429") ? 429 : 503, headers: { "retry-after": "1" } });
      }
      return drive.fetch(input, init);
    } });
    if (failure === "listing-error") await expect(recover(dataDir, { client })).rejects.toThrow();
    else await recover(dataDir, { client });
    expect(failed).toBe(true);
    expect(receipt(dataDir)).toEqual(initial);
    await recover(dataDir);
    const landed = drive.downloads.length;
    await recover(dataDir);
    expect(drive.downloads).toHaveLength(landed);
    expect(drive.downloads.filter((id) => decodeDrivePath(drive.records.get(id)!.file.name)?.endsWith(".style"))).toHaveLength(1);
    expect(value(join(dataDir, "google-drive"))).toBe("icon-36");
    expect(receipt(dataDir).changeToken).toBe(table(dataDir).changeToken);
  });

  it("catches writes during a short-page inventory before acknowledging", async () => {
    const dataDir = await joined();
    await skipStyle(dataDir);
    drive.pageSize = 1;
    for (let i = 0; i < 4; i++) seed(`pictures/${i}.png`);
    let inserted = false;
    const client = createDriveClient({ getAccessToken: async () => "fake-access", fetch: async (input, init) => {
      const response = await drive.fetch(input, init);
      if (!inserted && new URL(String(input)).searchParams.get("q")?.includes("in parents")) {
        inserted = true;
        seed("pictures/during.png");
      }
      return response;
    } });
    window();
    await recover(dataDir, { client });
    expect(inserted).toBe(true);
    expect(children()).toHaveLength(7);
    expect(existsSync(join(dataDir, "google-drive/pictures/during.png"))).toBe(true);
    expect(drive.downloads).toHaveLength(6);
    expect(receipt(dataDir).changeToken).toBe(table(dataDir).changeToken);
    window();
    await recover(dataDir);
    expect(drive.calls).toHaveLength(3);
  });

  it("acknowledges a full Drive once at its unchanged cursor and keeps ordinary cadence", async () => {
    const dataDir = await joined();
    await skipStyle(dataDir);
    const token = table(dataDir).changeToken;
    write(join(dataDir, `google-drive/devices/${IDS.profileDeviceId}.json`), "local presence");
    drive.full = true;
    const sync = boot(dataDir, () => true);
    await sync.kick();
    expect(sync.status().state).toBe("drive-full");
    window();
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(starts()).toHaveLength(1);
    expect(value(join(dataDir, "google-drive"))).toBe("icon-36");
    expect(receipt(dataDir).changeToken).toBe(token);
    expect(table(dataDir).changeToken).toBe(token);
    window();
    await vi.advanceTimersByTimeAsync(90_000);
    await sync.idle();
    expect(children()).toHaveLength(0);
    expect(starts()).toHaveLength(0);
    expect(drive.calls.filter(({ method }) => method === "POST")).toHaveLength(0);
    drive.full = false;
    await vi.advanceTimersByTimeAsync(180_000);
    await settle(sync);
    expect(sync.status().state).toBe("up-to-date");
    expect(receipt(dataDir).changeToken).toBe(table(dataDir).changeToken);
  });

  it.each([
    { ext: "notes", allowed: /\.(?:json)$/, changes: { memoryNotes: false } },
    { ext: "paths", allowed: /\.(?:json|notes)$/, changes: { projectNotes: "C:/notes/project.md" } },
    { ext: "pin", allowed: /\.(?:json|notes|paths)$/, changes: { pinnedMessageId: "message-1" } },
  ])("recovers $ext after a simulated reduced-capability reader advances", async ({ ext, allowed, changes }) => {
    const dataDir = await joined();
    const before = table(dataDir).changeToken;
    const { path, operation } = await publish(changes);
    expect(path).toMatch(new RegExp(`\\.${ext}$`));
    const client = createDriveClient({ getAccessToken: async () => "fake-access", fetch: drive.fetch });
    const reduced = { ...client, listChanges: async (token: string) => {
      const page = await client.listChanges(token);
      return { ...page, changes: page.changes.filter((change) => !change.file || allowed.test(decodeDrivePath(change.file.name) ?? "")) };
    } };
    await oldMirror({ owner: OWNER, ownIds: IDS, mirrorPath: join(dataDir, "google-drive"), statePath: join(dataDir, GOOGLE_TABLE_FILE), client: reduced }).syncOnce();
    expect(table(dataDir).changeToken).not.toBe(before);
    expect(existsSync(join(dataDir, "google-drive", path))).toBe(false);
    const sync = boot(dataDir, () => true);
    sync.resume();
    await settle(sync);
    window();
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(starts()).toHaveLength(1);
    expect(drive.downloads).toHaveLength(1);
    expect(readSyncOperations(join(dataDir, "google-drive")).operations).toEqual([operation]);
  });

  it("keeps a later classic pick, pending edits, tombstones, attachments and operation ids stable", async () => {
    const dataDir = await joined();
    const path = await skipStyle(dataDir);
    const classic = await publish({ mascotStyle: "icon-31" }, 2);
    const folder = join(dataDir, "google-drive");
    seed("pictures/attached.png", "attachment");
    const removed = createSyncOperation({ operationId: randomUUID(), deviceId: "device-writer", sequence: 3, recordedAt: 1_800_000_000_003,
      entity: "bot", entityId: "deleted-bot", deleted: true });
    const later = createSyncOperation({ operationId: randomUUID(), deviceId: "device-writer", sequence: 4, recordedAt: 1_800_000_000_004,
      entity: "bot", entityId: "deleted-bot", changes: { name: "Late edit" } });
    for (const op of [removed, later]) {
      const file = writeSyncOperation(join(root, "ops"), op);
      seed(`changes/${file.split(sep).at(-1)!}`, readFileSync(file, "utf8"));
    }
    const sync = boot(dataDir, () => true);
    sync.resume();
    await settle(sync);
    expect(value(folder)).toBe("icon-31");
    expect(existsSync(join(folder, path))).toBe(false);
    const copies = drive.records.size;
    window();
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(drive.downloads).toHaveLength(1);
    expect(value(folder)).toBe("icon-31");
    const state = applySyncOperations(emptyProfileSyncState(), readSyncOperations(folder).operations);
    expect(state.fieldVersions["bot:bot-1:mascotStyle"].operationId).toBe(classic.operation.operationId);
    expect(state.bots["deleted-bot"]).toBeUndefined();
    expect(state.tombstones["bot:deleted-bot"].operationId).toBe(removed.operationId);
    expect(new Set(state.appliedOperationIds).size).toBe(4);
    expect(remoteFieldsToApply(state, IDS.profileDeviceId, { "bot:bot-1:mascotStyle": syncValueHash("icon-30") }, "bot", "bot-1", state.bots["bot-1"], { mascotStyle: "icon-32" })).toEqual({});
    expect(readFileSync(join(folder, "pictures/attached.png"), "utf8")).toBe("attachment");
    sync.stop();
    const restarted = boot(dataDir, () => true);
    restarted.resume();
    await settle(restarted);
    expect(value(folder)).toBe("icon-31");
    expect(drive.records.size).toBe(copies);
    expect(drive.uploads).toHaveLength(0);
  });

  it("keeps strict binding, table and profile settings compatible with the old reader", async () => {
    const dataDir = await joined();
    const settings = saveProfileSyncSettings(dataDir, loadProfileSyncSettings(dataDir));
    const binding = readFileSync(join(dataDir, "google-binding.json"), "utf8");
    await skipStyle(dataDir);
    await recover(dataDir);
    expect(loadProfileSyncSettings(dataDir)).toEqual(settings);
    expect(readFileSync(join(dataDir, "google-binding.json"), "utf8")).toBe(binding);
    expect(readGoogleBinding(dataDir).kind).toBe("ok");
    expect(Object.keys(table(dataDir)).sort()).toEqual(["binding", "changeToken", "files", "syncedAt", "version"]);
    expect(Object.keys(table(dataDir).binding).sort()).toEqual(["generation", "mirrorPath", "owner", "rootId"]);
    expect(Object.keys(receipt(dataDir)).sort()).toEqual(["binding", "changeToken", "readerRevision", "version"]);
    await expect(oldMirror({ owner: OWNER, ownIds: IDS, mirrorPath: join(dataDir, "google-drive"), statePath: join(dataDir, GOOGLE_TABLE_FILE),
      client: createDriveClient({ getAccessToken: async () => "fake-access", fetch: drive.fetch }) }).syncOnce()).resolves.toMatchObject({ failed: [] });
  });

  it.each(["binding", "table", "missing-table", "missing-mirror"])("preserves the %s corruption gate", async (problem) => {
    const dataDir = await joined();
    if (problem === "binding") writeFileSync(join(dataDir, "google-binding.json"), "{");
    if (problem === "table") writeFileSync(join(dataDir, GOOGLE_TABLE_FILE), "{");
    if (problem === "missing-table") unlinkSync(join(dataDir, GOOGLE_TABLE_FILE));
    if (problem === "missing-mirror") {
      unlinkSync(join(dataDir, "google-drive/workspace.json"));
      rmdirSync(join(dataDir, "google-drive"));
    }
    window();
    const sync = boot(dataDir, () => true);
    sync.resume();
    await sync.kick();
    expect(drive.downloads).toHaveLength(0);
    expect(drive.uploads).toHaveLength(0);
    expect(starts()).toHaveLength(0);
    expect(sync.status().state).toBe("error");
  });

  it.each(["inside", "table", "hard-table", "hard-mirror", "junction"])("refuses a receipt path alias: %s", async (alias) => {
    const dataDir = await joined();
    let kindsPath = join(dataDir, "alias.json");
    if (alias === "inside") kindsPath = join(dataDir, "google-drive/receipt.json");
    if (alias === "table") kindsPath = join(dataDir, GOOGLE_TABLE_FILE);
    if (alias === "hard-table") linkSync(join(dataDir, GOOGLE_TABLE_FILE), kindsPath);
    if (alias === "hard-mirror") linkSync(join(dataDir, "google-drive/workspace.json"), kindsPath);
    if (alias === "junction") {
      symlinkSync(join(dataDir, "google-drive"), join(dataDir, "link"), "junction");
      kindsPath = join(dataDir, "link/receipt.json");
    }
    const saved = readFileSync(join(dataDir, GOOGLE_TABLE_FILE), "utf8");
    await expect(Promise.resolve().then(() => recover(dataDir, { kindsPath }))).rejects.toMatchObject({ problem: alias === "hard-mirror" ? "path-alias" : "unsafe-path" });
    expect(readFileSync(join(dataDir, GOOGLE_TABLE_FILE), "utf8")).toBe(saved);
  });

  it("does not acknowledge a quota error on a download as held own uploads", async () => {
    const dataDir = await joined();
    const initial = receipt(dataDir);
    await skipStyle(dataDir);
    const client = createDriveClient({ getAccessToken: async () => "fake-access", fetch: (input, init) => {
      if (new URL(String(input)).searchParams.get("alt") === "media") return Promise.resolve(Response.json({ error: { errors: [{ reason: "storageQuotaExceeded" }] } }, { status: 403 }));
      return drive.fetch(input, init);
    } });
    const result = await recover(dataDir, { client });
    expect(result.failed).toHaveLength(1);
    expect(receipt(dataDir)).toEqual(initial);
    await recover(dataDir);
    expect(value(join(dataDir, "google-drive"))).toBe("icon-36");
  });

  it("keeps paint and sends free during recovery and holds changed heads until a real v2 pull", async () => {
    const dataDir = await joined();
    const folder = join(dataDir, "google-drive");
    const scope = { botSyncId: "bot-1", threadId: "kinds-thread" };
    const path = `threads-v2/${scope.botSyncId}/${scope.threadId}/peer/head.json`;
    const row = { seq: 1, seen: {}, kind: "row", rowId: "peer-row", baseStamp: null, origin: "peer",
      value: { id: "peer-row", role: "user", kind: "text", text: "peer", at: 1, parentId: null } };
    const head = { v: 2, threadId: scope.threadId, writerId: "peer", generation: 1, sealedThrough: 0, firstSeq: 1, lastSeq: 1, seen: {}, versions: [row] };
    seed(path, "older duplicate");
    const remote = seed(path, JSON.stringify(head));
    await recover(dataDir);
    ensureDirs();
    const engine = createSyncEngine({ dataDir, folder, deviceId: IDS.profileDeviceId });
    expect(engine.pull(scope)).toMatchObject({ rejected: 0, rowsTouched: 1 });
    const variants = engine.variants(scope, "row", "peer-row");
    syncHold.reset();
    unlinkSync(join(dataDir, RECEIPT));
    const listing = gate();
    let ready = false;
    const timing = createStartupTiming({ write: () => {} });
    timing.afterPaint("googleKinds", async () => { ready = true; });
    const pull = vi.fn(() => { const result = engine.pull(scope); syncHold.pulled(folder, scope, result.heads); });
    const sync = boot(dataDir, () => ready, { pull, fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.searchParams.get("q")?.includes("in parents")) { listing.entered(); await listing.held; }
      return drive.fetch(input, init);
    } });
    await sync.kick();
    timing.paint();
    await timing.waitFor("googleKinds");
    expect(ready).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await listing.started;
    try {
      await timing.beforeRequest("POST", "/api/bots/send");
      expect(sync.catchingUp(scope.threadId)).toBe(false);
      expect(syncHold.until(scope.threadId)).toBeUndefined();
    } finally { listing.release(); }
    await sync.idle();
    expect(syncHold.until(scope.threadId)).toBeUndefined();
    expect(pull).not.toHaveBeenCalled();
    expect(engine.pull(scope)).toMatchObject({ applied: 0, rowsTouched: 0, sqlRowsTouched: 0 });
    expect(engine.variants(scope, "row", "peer-row")).toEqual(variants);
    sync.stop();
    unlinkSync(join(dataDir, RECEIPT));
    const downloading = gate();
    let changed = false;
    drive.onDownload = async (file) => { if (file.id === remote.id) { downloading.entered(); await downloading.held; } };
    const control = boot(dataDir, () => true, { pull, fetch: async (input, init) => {
      const response = await drive.fetch(input, init);
      if (!changed && new URL(String(input)).searchParams.get("q")?.includes("in parents")) {
        changed = true;
        drive.edit(remote.id, Buffer.from(JSON.stringify({ ...head, generation: 2, lastSeq: 2, versions: [row,
          { ...row, seq: 2, seen: { peer: 1 }, rowId: "peer-next", value: { ...row.value, id: "peer-next", text: "next" } }] })));
      }
      return response;
    } });
    await control.kick();
    await vi.advanceTimersByTimeAsync(30_000);
    await downloading.started;
    try { expect(syncHold.until(scope.threadId)).toBeGreaterThan(Date.now()); }
    finally { downloading.release(); }
    await control.idle();
    expect(pull).toHaveBeenCalledOnce();
    expect(syncHold.until(scope.threadId)).toBeUndefined();
    expect(engine.variants(scope, "row", "peer-next")).toHaveLength(1);
    timing.close();
  });

  it("defers recovery through republishing, direct kicks and wake catch-up", async () => {
    const dataDir = await joined();
    await skipStyle(dataDir);
    let busy = true;
    const sync = boot(dataDir, () => true, { republishing: () => busy });
    window();
    await sync.kick();
    expect(starts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await sync.kick();
    expect(starts()).toHaveLength(0);
    busy = false;
    await sync.kick();
    expect(starts()).toHaveLength(0);
    vi.setSystemTime(Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(starts()).toHaveLength(0);
    expect(sync.catchingUp("thread")).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(starts()).toHaveLength(1);
  });

  it("arms only permission after the production paint callback or headless fallback", async () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const statement = source.split("\n").find((line) => line.startsWith('startupTiming.afterPaint("googleKinds"'));
    expect(statement).toBeTruthy();
    expect(source).toContain("kindsReady: () => googleKindsReady");
    const startupTiming = createStartupTiming({ write: () => {} });
    const ready = runInNewContext(`let googleKindsReady = false; ${statement}; () => googleKindsReady`, { startupTiming }) as () => boolean;
    startupTiming.serving();
    expect(ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ready()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ready()).toBe(true);
    startupTiming.close();
  });

  it("recovers one style among 5,501 root files in 10 metadata calls and one download", async () => {
    const dataDir = await healthyScale();
    const sync = boot(dataDir, () => true);
    sync.resume();
    await settle(sync);
    window();
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(children()).toHaveLength(6);
    expect(starts()).toHaveLength(1);
    expect(drive.calls.filter(({ url }) => url.searchParams.get("alt") !== "media")).toHaveLength(10);
    expect(drive.calls).toHaveLength(11);
    expect(drive.downloads).toHaveLength(1);
    expect(decodeDrivePath(drive.records.get(drive.downloads[0])!.file.name)).toMatch(/\.style$/);
    expect(drive.uploads).toHaveLength(0);
    expect(value(join(dataDir, "google-drive"))).toBe("icon-36");
    window();
    await vi.advanceTimersByTimeAsync(30_000);
    await sync.idle();
    expect(drive.calls).toHaveLength(3);
    expect(children()).toHaveLength(0);
    expect(drive.downloads).toHaveLength(0);
  }, 60_000);
});
