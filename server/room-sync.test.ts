import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { drivePathRule } from "./drive-mirror.ts";
import { createGroupRoutes, roomSetupPending } from "./group-routes.ts";
import {
  applySyncOperations, createSyncOperation, emptyProfileSyncState, loadProfileSyncSettings, readSyncOperations, syncOperationFileName,
  writeSyncOperation, type ProfileSyncSettings,
} from "./profile-sync.ts";
import { importRooms, publishRooms, roomEdited, roomRemoved, type RoomSyncHost } from "./room-sync.ts";
import { Store, type GroupRecord } from "./store.ts";
import { drivePathRule as oldDrivePathRule } from "./testing/drive-mirror-1.0.213.ts";

const IDS = { profileDeviceId: "device-reader", writerId: "writer-reader", memoryDeviceId: "aaaaaaaaaaaa" };
const T0 = 1_800_000_000_000;
let folder: string;
let store: Store;
let settings: ProfileSyncSettings;
let sequence: number;
let clock: number;

const host = (working = false): RoomSyncHost => ({ dataDir: DATA_DIR, store, settings: () => settings, now: () => clock, working: () => working });
const state = () => applySyncOperations(emptyProfileSyncState(), readSyncOperations(folder).operations);
const sync = () => {
  importRooms(host(), state(), folder);
  return publishRooms(host(), folder);
};
const files = () => readdirSync(join(folder, "changes"));

/** Another PC's room op, written straight into the folder. */
function remote(entityId: string, changes: Record<string, unknown> | null, recordedAt: number, deviceId = "pc-a") {
  return writeSyncOperation(folder, createSyncOperation({
    entity: "room", entityId, ...(changes ? { changes } : { deleted: true }),
    operationId: randomUUID(), deviceId, sequence: ++sequence, recordedAt,
  }));
}

function created(id: string, extra: Record<string, unknown> = {}) {
  return { name: "Plans", createdAt: T0, threadId: `thread-${id}`, dm: false, bulletin: "", section: null, pinned: false, pinnedMessageId: null,
    setupCompletedAt: null, setupSkippedAt: T0, defaultResponder: { kind: "everyone" }, ...extra };
}

function bot(name: string, syncId?: string) {
  const record = store.createBot({ name }, { seedMessages: false });
  if (syncId) settings.botMap[record.id] = syncId;
  return record;
}

beforeEach(() => {
  rmSync(join(DATA_DIR, "groups.json"), { force: true });
  rmSync(join(DATA_DIR, "bots.json"), { force: true });
  rmSync(join(DATA_DIR, "room-sync.json"), { force: true });
  folder = mkdtempSync(join(tmpdir(), "room-sync-"));
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  settings = { ...loadProfileSyncSettings(join(folder, "none")), folder, syncChats: true };
  sequence = 0;
  clock = T0 + 60_000;
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("room records over profile sync", () => {
  it("writes every room op as .room, which the old reader never takes", () => {
    const atlas = bot("Atlas", "sync-atlas");
    const group = store.createGroup("Plans", [atlas.id]);
    publishRooms(host(), folder);
    roomEdited(host(), group, { name: "Plans 2" });
    publishRooms(host(), folder);
    roomRemoved(host(), group);
    publishRooms(host(), folder);
    expect(files()).toHaveLength(3);
    for (const name of files()) {
      expect(name).toMatch(/\.room$/);
      expect(oldDrivePathRule(`changes/${name}`, IDS)).toBe("unknown");
      expect(drivePathRule(`changes/${name}`, IDS)).toBe("once");
    }
    const op = readSyncOperations(folder).operations[0];
    expect(syncOperationFileName(op)).toMatch(/\.room$/);
    expect(syncOperationFileName({ ...op, changes: undefined, deleted: true })).toMatch(/\.room$/);
  });

  it("imports the same create twice as one room under its ids", () => {
    remote("room-1", created("room-1"), T0);
    remote("room-1", created("room-1"), T0, "pc-c");
    sync();
    sync();
    expect(store.groups.map(({ id, threadId, name }) => ({ id, threadId, name }))).toEqual([{ id: "room-1", threadId: "thread-room-1", name: "Plans" }]);
    expect(files().length).toBe(2);
  });

  it("maps members through the bot map, keeps the unresolved and resolves them once bound", () => {
    const atlas = bot("Atlas", "sync-atlas");
    remote("room-1", created("room-1", { "member.sync-atlas": true, "member.sync-nova": true, defaultResponder: { kind: "member", botId: "sync-nova" } }), T0);
    sync();
    expect(store.group("room-1")).toMatchObject({ memberIds: [atlas.id], defaultResponder: { kind: "member", botId: atlas.id } });
    expect(files()).toHaveLength(1);
    const nova = bot("Nova", "sync-nova");
    importRooms(host(), state(), folder);
    expect(store.group("room-1")).toMatchObject({ memberIds: [atlas.id, nova.id], defaultResponder: { kind: "member", botId: nova.id } });
  });

  it("keeps both of two member adds made at once on two PCs", () => {
    const atlas = bot("Atlas", "sync-atlas");
    const nova = bot("Nova", "sync-nova");
    const kit = bot("Kit", "sync-kit");
    remote("room-1", created("room-1", { "member.sync-atlas": true }), T0);
    sync();
    remote("room-1", { "member.sync-nova": true }, T0 + 2_000);
    roomEdited(host(), store.group("room-1")!, { memberIds: [atlas.id, kit.id] });
    store.patchGroup("room-1", { memberIds: [atlas.id, kit.id] });
    sync();
    sync();
    expect(store.group("room-1")!.memberIds).toEqual([atlas.id, kit.id, nova.id]);
    expect(state().rooms["room-1"]).toMatchObject({ "member.sync-atlas": true, "member.sync-nova": true, "member.sync-kit": true });
  });

  it("publishes nothing while groups.json is unreadable", () => {
    const atlas = bot("Atlas", "sync-atlas");
    const group = store.createGroup("Plans", [atlas.id]);
    roomRemoved(host(), group);
    writeFileSync(join(DATA_DIR, "groups.json"), "{ not json");
    store = new Store(() => ({ instanceId: "fake", model: "m" }));
    remote("room-1", created("room-1"), T0);
    expect(store.groupsFile).toBe("unreadable");
    expect(sync()).toBe(0);
    expect(files()).toHaveLength(1);
    expect(store.groups).toEqual([]);
  });

  it("never lets a backfilled create beat a newer edit", () => {
    const atlas = bot("Atlas", "sync-atlas");
    const group = store.createGroup("Old", [atlas.id]);
    group.createdAt = T0;
    sync();
    remote(group.id, { name: "New" }, T0 + 5_000);
    sync();
    expect(readSyncOperations(folder).operations.find((op) => op.deviceId === settings.deviceId)?.recordedAt).toBe(T0);
    expect(store.group(group.id)!.name).toBe("New");
    expect(state().rooms[group.id]!.name).toBe("New");
  });

  it("deletes only on a tombstone, never from a room missing in the folder", () => {
    const atlas = bot("Atlas", "sync-atlas");
    const mine = store.createGroup("Mine", [atlas.id]);
    remote("room-1", created("room-1"), T0);
    sync();
    rmSync(join(folder, "changes"), { recursive: true });
    importRooms(host(), state(), folder);
    expect(store.groups.map((group) => group.name).sort()).toEqual(["Mine", "Plans"]);
    remote("room-1", null, T0 + 1_000);
    expect(importRooms(host(true), state(), folder)).toEqual({ deferred: true });
    expect(store.group("room-1")).toBeTruthy();
    importRooms(host(), state(), folder);
    expect(store.groups.map((group) => group.id)).toEqual([mine.id]);
  });

  it("keeps team rooms on their host", () => {
    const atlas = bot("Atlas", "sync-atlas");
    const hosted = store.createGroup("Team", [atlas.id], false, undefined, undefined, { roomId: "hosted-1" });
    roomEdited(host(), hosted, { name: "Team 2" });
    roomRemoved(host(), hosted);
    expect(publishRooms(host(), folder)).toBe(0);
  });

  it("publishes a route edit as only the fields it changed", async () => {
    const atlas = bot("Atlas", "sync-atlas");
    const nova = bot("Nova", "sync-nova");
    const group = store.createGroup("Plans", [atlas.id, nova.id]);
    publishRooms(host(), folder);
    const routes = createGroupRoutes({
      store, groupIsWorking: () => false, publicGroupState: (value: GroupRecord) => value, checkedMemberIds: (memberIds: string[]) => ({ ok: true, memberIds }),
      rooms: { created: () => {}, edited: (before: GroupRecord, patch: Partial<GroupRecord>) => roomEdited(host(), before, patch), removed: () => {} },
    } as unknown as Parameters<typeof createGroupRoutes>[0]);
    const req = Readable.from([JSON.stringify({ name: "Plans 2", memberIds: [nova.id], unread: true })]) as unknown as IncomingMessage;
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await routes.patch(req, res as unknown as ServerResponse, ["", group.id] as RegExpMatchArray);
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    publishRooms(host(), folder);
    expect(readSyncOperations(folder).operations.at(-1)!.changes).toEqual({ name: "Plans 2", "member.sync-atlas": false });
  });

  it("lets an imported room take a send", async () => {
    remote("room-1", created("room-1"), T0);
    sync();
    const group = store.group("room-1")!;
    expect(roomSetupPending(group, 0)).toBe(false);
    const startGroupTurn = vi.fn(() => ({ id: "message-1" }));
    const routes = createGroupRoutes({
      store, startGroupTurn, resolveReplyTarget: () => undefined, sendSequencer: { run: (_key: unknown, _print: unknown, work: () => unknown) => work() },
    } as unknown as Parameters<typeof createGroupRoutes>[0]);
    const req = Readable.from([JSON.stringify({ text: "hi", threadId: "thread-room-1" })]) as unknown as IncomingMessage;
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await routes.postMessage(req, res as unknown as ServerResponse, ["", "room-1"] as RegExpMatchArray);
    expect(res.writeHead.mock.calls[0][0]).toBe(202);
    expect(startGroupTurn).toHaveBeenCalledWith("room-1", "hi", undefined, undefined);
  });
});
