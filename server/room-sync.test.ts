import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
import { importRooms, joinTeamRooms, publishRooms, roomEdited, roomRemoved, type RoomSyncHost } from "./room-sync.ts";
import { closeJoinedDb, endJoined, joinedRoom, leftByHand, removeJoined, saveJoined, seatTaken } from "./rooms/joined.ts";
import { openSeat } from "./rooms/seat-key.ts";
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

  it("keeps a create, an edit and a delete that failed to write", () => {
    const atlas = bot("Atlas", "sync-atlas");
    const group = store.createGroup("Plans", [atlas.id]);
    const changes = join(folder, "changes");
    const blocked = () => {
      renameSync(changes, `${changes}-off`);
      writeFileSync(changes, "");
      expect(publishRooms(host(), folder)).toBe(0);
      rmSync(changes);
      renameSync(`${changes}-off`, changes);
      return publishRooms(host(), folder);
    };
    mkdirSync(changes);
    expect(blocked()).toBe(1);
    roomEdited(host(), group, { name: "Plans 2" });
    expect(blocked()).toBe(1);
    expect(state().rooms[group.id]!.name).toBe("Plans 2");
    roomRemoved(host(), group);
    expect(blocked()).toBe(1);
    expect(state().tombstones[`room:${group.id}`]).toBeTruthy();
  });

  it("holds a responder until its bot joins the room", () => {
    const atlas = bot("Atlas", "sync-atlas");
    const nova = bot("Nova", "sync-nova");
    remote("room-1", created("room-1", { "member.sync-atlas": true }), T0);
    sync();
    remote("room-1", { defaultResponder: { kind: "member", botId: "sync-nova" } }, T0 + 1_000);
    sync();
    remote("room-1", { "member.sync-nova": true }, T0 + 2_000);
    sync();
    expect(store.group("room-1")).toMatchObject({ memberIds: [atlas.id, nova.id], defaultResponder: { kind: "member", botId: nova.id } });
  });

  it("waits for a running turn before changing the roster", () => {
    const atlas = bot("Atlas", "sync-atlas");
    const nova = bot("Nova", "sync-nova");
    remote("room-1", created("room-1", { "member.sync-atlas": true, "member.sync-nova": true }), T0);
    sync();
    remote("room-1", { name: "Plans 2", "member.sync-nova": false }, T0 + 1_000);
    expect(importRooms(host(true), state(), folder)).toEqual({ deferred: true });
    expect(store.group("room-1")).toMatchObject({ name: "Plans 2", memberIds: [atlas.id, nova.id] });
    importRooms(host(), state(), folder);
    expect(store.group("room-1")!.memberIds).toEqual([atlas.id]);
  });

  it("keeps team rooms on their host", () => {
    const atlas = bot("Atlas", "sync-atlas");
    const hosted = store.createGroup("Team", [atlas.id], false, undefined, undefined, { roomId: "hosted-1" });
    roomEdited(host(), hosted, { name: "Team 2" });
    roomRemoved(host(), hosted);
    expect(publishRooms(host(), folder)).toBe(0);
  });

  it("drops the other PCs' copy of a room that turns into a team room", () => {
    const atlas = bot("Atlas", "sync-atlas");
    const group = store.createGroup("Plans", [atlas.id]);
    publishRooms(host(), folder);
    store.patchGroup(group.id, { hosted: { roomId: "hosted-1" } });
    expect(publishRooms(host(), folder)).toBe(1);
    expect(state().rooms[group.id]!.hosted).toBe(true);
    expect(sync()).toBe(0);
    expect(store.group(group.id)!.hosted).toEqual({ roomId: "hosted-1" });
    remote("room-1", created("room-1"), T0);
    sync();
    remote("room-1", { hosted: true }, T0 + 1_000);
    expect(importRooms(host(true), state(), folder)).toEqual({ deferred: true });
    expect(store.group("room-1")).toBeTruthy();
    sync();
    expect(store.group("room-1")).toBeFalsy();
    sync();
    expect(store.groups.map((other) => other.id)).toEqual([group.id]);
  });

  it("drops a team room's copy even while chat sync still holds its thread", () => {
    remote("room-1", created("room-1"), T0);
    sync();
    const holding = { ...host(), syncing: () => true };
    remote("room-1", null, T0 + 1_000);
    importRooms(holding, state(), folder);
    expect(store.group("room-1")).toBeTruthy();
    rmSync(join(folder, "changes"), { recursive: true });
    remote("room-1", created("room-1"), T0);
    remote("room-1", { hosted: true }, T0 + 1_000);
    importRooms(holding, state(), folder);
    expect(store.group("room-1")).toBeFalsy();
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
      store, startGroupTurn, groupIsWorking: () => false, resolveReplyTarget: () => undefined, sendSequencer: { run: (_key: unknown, _print: unknown, work: () => unknown) => work() },
    } as unknown as Parameters<typeof createGroupRoutes>[0]);
    const req = Readable.from([JSON.stringify({ text: "hi", threadId: "thread-room-1" })]) as unknown as IncomingMessage;
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await routes.postMessage(req, res as unknown as ServerResponse, ["", "room-1"] as RegExpMatchArray);
    expect(res.writeHead.mock.calls[0][0]).toBe(202);
    expect(startGroupTurn).toHaveBeenCalledWith("room-1", "hi", undefined, undefined, undefined, undefined, [], undefined);
  });
});


describe("team rooms on the user's other PCs", () => {
  const secret = (n: number) => `wki_${String(n).repeat(43)}`;
  const code = (n: number) => `wkr1:abc.wink.test:code-${n}.${secret(n)}`;
  const invites = new Map<string, string>();
  const codeRooms = new Map<string, string>();
  const serve = (roomId: string, n: number) => {
    invites.set(roomId, code(n));
    codeRooms.set(code(n), roomId);
  };
  let joinSeat: ReturnType<typeof vi.fn<NonNullable<RoomSyncHost["join"]>>>;
  let homeDir: string;
  let workDir: string;
  let homeStore: Store;
  let workStore: Store;
  let homeSettings: ProfileSyncSettings;
  let workSettings: ProfileSyncSettings;

  const homePc = (): RoomSyncHost => ({
    dataDir: homeDir, store: homeStore, settings: () => homeSettings, now: () => clock, working: () => false,
    invite: vi.fn((roomId: string) => invites.get(roomId) ?? null),
  });
  const workPc = (): RoomSyncHost => ({
    dataDir: workDir, store: workStore, settings: () => workSettings, now: () => clock, working: () => false,
    join: joinSeat, joined: seatTaken, left: leftByHand,
  });
  const pass = (pc: RoomSyncHost, at = folder) => {
    importRooms(pc, applySyncOperations(emptyProfileSyncState(), readSyncOperations(at).operations), at);
    joinTeamRooms(pc, at);
    return publishRooms(pc, at);
  };
  /** Work, then Home, a few times: Work asks, Home seals, Work joins. */
  const rounds = async (n = 3) => {
    for (let i = 0; i < n; i++) {
      pass(workPc());
      pass(homePc());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    pass(workPc());
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const joinsOf = (dir: string) => JSON.parse(readFileSync(join(dir, "room-sync.json"), "utf8")).joins;
  const folderText = () => files().map((name) => readFileSync(join(folder, "changes", name), "utf8")).join("\n");
  const hostTk = (roomId = "room-1") => homeStore.createGroup("TK", [], false, undefined, undefined, { roomId });

  beforeEach(() => {
    invites.clear();
    codeRooms.clear();
    homeDir = mkdtempSync(join(tmpdir(), "room-home-"));
    workDir = mkdtempSync(join(tmpdir(), "room-work-"));
    homeStore = store;
    workStore = new Store(() => ({ instanceId: "fake-work", model: "m" }));
    homeSettings = { ...settings, deviceId: "pc-home" };
    workSettings = { ...settings, deviceId: "pc-work" };
    // the host's door, as guestClient.seat takes it: the seat is saved here
    joinSeat = vi.fn<NonNullable<RoomSyncHost["join"]>>(async (joinCode, roomId) => {
      saveJoined(roomId ?? codeRooms.get(joinCode)!, "abc.wink.test", { id: "me", name: "Edward 2" }, `wkg_${"b".repeat(43)}`, joinCode);
      return { ok: true };
    });
  });

  afterEach(() => {
    closeJoinedDb();
    rmSync(join(DATA_DIR, "joined.db"), { force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it("seats the other PC once with the code sealed to it, and never the host", async () => {
    const tk = hostTk();
    serve("room-1", 1);
    await rounds();
    expect(joinSeat).toHaveBeenCalledTimes(1);
    expect(joinSeat).toHaveBeenCalledWith(code(1), "room-1");
    expect(joinsOf(workDir)[tk.id]).toMatchObject({ room: "room-1", state: "joined" });
    expect(homeStore.groups.map((group) => group.hosted)).toEqual([{ roomId: "room-1" }]);
    expect(workStore.groups).toEqual([]);
    expect(existsSync(join(homeDir, "room-sync.json")) && JSON.parse(readFileSync(join(homeDir, "room-sync.json"), "utf8")).joins).toEqual({});
    // a restart and later passes take no second seat
    workStore = new Store(() => ({ instanceId: "fake-work", model: "m" }));
    await rounds();
    expect(joinSeat).toHaveBeenCalledTimes(1);
  });

  it("upgrades only the live sync seat once when the host publishes its owner code", async () => {
    const tk = hostTk();
    serve("room-1", 1);
    await rounds();
    const ownerCode = `wkr1:abc.wink.test:seat_room-1.${secret(2)}`;
    invites.set("room-1", ownerCode);
    await rounds();
    expect(joinSeat.mock.calls).toEqual([[code(1), "room-1"], [ownerCode, "room-1"]]);
    expect(joinsOf(workDir)[tk.id]).toMatchObject({ state: "joined" });
    expect(folderText()).not.toContain(secret(2));
    expect(endJoined("room-1", "left")).toBe(true);
    await rounds();
    expect(joinSeat).toHaveBeenCalledTimes(2);
  });

  it("puts no code in the folder that joins by itself", async () => {
    const tk = hostTk();
    serve("room-1", 1);
    await rounds();
    expect(joinSeat).toHaveBeenCalledTimes(1);
    expect(folderText()).not.toContain(secret(1));
    expect(folderText()).not.toContain("code-1");
    const seal = state().rooms[tk.id]!["seal.pc-work"];
    const stranger = mkdtempSync(join(tmpdir(), "room-stranger-"));
    try {
      expect(openSeat(workDir, seal, `${tk.id}:room-1`)).toBe(code(1));
      expect(openSeat(homeDir, seal, `${tk.id}:room-1`)).toBeNull();
      expect(openSeat(stranger, seal, `${tk.id}:room-1`)).toBeNull();
      // a seal moved to another room's pointer opens nothing
      expect(openSeat(workDir, seal, `${tk.id}:room-2`)).toBeNull();
    } finally {
      rmSync(stranger, { recursive: true, force: true });
    }
  });

  it("never seats a PC again in a room the user left there by hand, even after Remove", async () => {
    saveJoined("room-1", "abc.wink.test", { id: "me", name: "Edward 2" }, `wkg_${"b".repeat(43)}`, code(1));
    expect(endJoined("room-1", "left")).toBe(true);
    expect(removeJoined("room-1")).toBe(true);
    const tk = hostTk();
    serve("room-1", 1);
    await rounds();
    serve("room-1", 2);
    await rounds();
    expect(joinSeat).not.toHaveBeenCalled();
    expect(joinsOf(workDir)[tk.id]).toMatchObject({ state: "left" });
    expect(joinedRoom("room-1")).toBeNull();
  });

  it("keeps a join still waiting with the workspace it came from", async () => {
    joinSeat.mockResolvedValue({ ok: false, status: 503, error: "unavailable" });
    hostTk();
    serve("room-1", 1);
    await rounds();
    const tries = joinSeat.mock.calls.length;
    expect(tries).toBeGreaterThan(0);
    const other = mkdtempSync(join(tmpdir(), "room-other-"));
    try {
      workSettings = { ...workSettings, workspaceId: "other-workspace" };
      for (let i = 0; i < 3; i++) pass(workPc(), other);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(joinSeat).toHaveBeenCalledTimes(tries);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("tries a full room again on later passes", async () => {
    const full = { ok: false as const, status: 409, error: "room-full" };
    joinSeat.mockResolvedValueOnce(full).mockResolvedValueOnce(full);
    const tk = hostTk();
    serve("room-1", 1);
    await rounds(5);
    expect(joinSeat).toHaveBeenCalledTimes(3);
    expect(joinsOf(workDir)[tk.id]).toMatchObject({ state: "joined" });
  });

  it("tries again while the host is off and never a refused code twice", async () => {
    joinSeat.mockResolvedValueOnce({ ok: false, status: 503, error: "unavailable" }).mockResolvedValueOnce({ ok: false, status: 404, error: "no-invite" });
    const tk = hostTk();
    serve("room-1", 1);
    await rounds(5);
    expect(joinSeat).toHaveBeenCalledTimes(2);
    expect(joinsOf(workDir)[tk.id]).toMatchObject({ state: "refused" });
    serve("room-1", 2);
    await rounds();
    expect(joinSeat).toHaveBeenCalledTimes(3);
    expect(joinSeat).toHaveBeenLastCalledWith(code(2), "room-1");
    expect(joinsOf(workDir)[tk.id]).toMatchObject({ state: "joined" });
  });

  it("takes a seat in a room that replaced the group's old one, unless the user left the old one here", async () => {
    const tk = hostTk();
    serve("room-1", 1);
    await rounds();
    expect(joinSeat).toHaveBeenCalledTimes(1);
    homeStore.patchGroup(tk.id, { hosted: { roomId: "room-2" } });
    serve("room-2", 2);
    await rounds();
    expect(joinSeat).toHaveBeenCalledTimes(2);
    expect(joinSeat).toHaveBeenLastCalledWith(code(2), "room-2");
    expect(joinsOf(workDir)[tk.id]).toMatchObject({ room: "room-2", state: "joined" });
    endJoined("room-2", "left");
    homeStore.patchGroup(tk.id, { hosted: { roomId: "room-3" } });
    serve("room-3", 3);
    await rounds();
    expect(joinSeat).toHaveBeenCalledTimes(2);
    expect(joinsOf(workDir)[tk.id]).toMatchObject({ room: "room-3", state: "left" });
  });

  it("never seats from a pointer that names no room, and the host's next pointer clears the code it carried", async () => {
    saveJoined("room-1", "abc.wink.test", { id: "me", name: "Edward 2" }, `wkg_${"b".repeat(43)}`, code(1));
    endJoined("room-1", "left");
    const tk = hostTk();
    // the first checkpoint's pointer: the code in the clear and no room
    remote(tk.id, { hosted: true, invite: code(1) }, T0, "pc-home");
    pass(workPc());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(joinSeat).not.toHaveBeenCalled();
    serve("room-1", 1);
    pass(homePc());
    expect(state().rooms[tk.id]).toMatchObject({ hosted: true, room: "room-1", invite: null });
    await rounds();
    expect(joinSeat).not.toHaveBeenCalled();
    expect(joinedRoom("room-1")!.status).toBe("left");
  });

  it("never writes rooms.db, a room or a hosted mark on the other PC, nor a room op after its seat", async () => {
    const tk = hostTk();
    serve("room-1", 1);
    await rounds();
    const ops = readSyncOperations(folder).operations.length;
    for (let i = 0; i < 3; i++) expect(pass(workPc())).toBe(0);
    expect(workStore.groups).toEqual([]);
    expect(existsSync(join(DATA_DIR, "rooms.db"))).toBe(false);
    expect(readSyncOperations(folder).operations).toHaveLength(ops);
    expect(new Set(readSyncOperations(folder).operations.map((operation) => operation.entityId))).toEqual(new Set([tk.id]));
  });
});
