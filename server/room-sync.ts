// Room records between one user's PCs. A room travels as `room` ops under its
// own group id, in `.room` files older builds never read. Only route edits
// publish; imports, and values a PC derived (members it lacks, a normalized
// responder), never do. Team rooms stay on their host; a pointer op names the
// room, each other PC asks with its seat key, and the host seals the room's code
// to that key, so the folder alone opens nothing. Each PC takes its seat once.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { setAsideFile, writeFileAtomic } from "./atomic.ts";
import { EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import {
  applySyncOperations, createSyncOperation, emptyProfileSyncState, localIdForSyncId, readSyncOperations, writeSyncOperation,
  type ProfileSyncSettings, type ProfileSyncState, type SyncedRoom,
} from "./profile-sync.ts";
import { removeRotatingLog } from "./rotating-log.ts";
import { isOwnerRoomCode, isSeatKey, openSeat, sealSeat, seatKey } from "./rooms/seat-key.ts";
import { UNTITLED_TASK, type GroupDefaultResponder, type GroupRecord, type Store } from "./store.ts";

export const ROOM_SYNC_FILE = "room-sync.json";

export interface RoomSyncHost {
  dataDir: string;
  store: Store;
  /** Its bot map and sequence are read and moved here; the caller saves it. */
  settings(): ProfileSyncSettings;
  now(): number;
  working(group: GroupRecord): boolean;
  /** Chat sync holds this thread and has not taken its delete. */
  syncing?(threadId: string): boolean;
  /** The code of a team room this PC hosts, or null while it cannot be reached. */
  invite?(roomId: string, deviceId: string): string | null;
  /** Joins a team room as a guest seat, unless this PC has one there by then. */
  join?(code: string, roomId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  /** Whether this PC has a guest seat in the room, left or removed too, or the user left it here by hand. */
  joined?(roomId: string): boolean;
  /** Whether the user left the room here by hand. */
  left?(roomId: string): boolean;
}

const MEMBER = "member.";
/** A pointer's `seat.<device>` is that PC's seat key; `seal.<device>` the room code sealed to it. */
const SEAT = "seat.";
const SEAL = "seal.";
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const FIELDS = ["name", "bulletin", "section", "pinned", "pinnedMessageId", "setupCompletedAt", "setupSkippedAt", "defaultResponder"] as const;
const CLEARED_BY_NULL = new Set(["section", "pinnedMessageId"]);

const pendingSchema = z.object({
  groupId: z.string(),
  at: z.number(),
  changes: z.record(z.string(), z.unknown()),
  deleted: z.literal(true).optional(),
});
type Pending = z.infer<typeof pendingSchema>;

/** PC-local. `applied` maps `groupId:field` to the op this PC last took or sent for it; `pending` holds route edits by local bot id. */
const fileSchema = z.object({
  scope: z.string().catch(""),
  marked: z.array(z.string()).catch([]),
  applied: z.record(z.string(), z.string()).catch({}),
  pending: z.array(pendingSchema).catch([]),
  unresolved: z.record(z.string(), z.object({ members: z.array(z.string()), responder: z.string().optional() })).catch({}),
  /** Team rooms hosted here: the room each pointer names, the seat keys other PCs asked with, and a digest of what each was sealed. */
  pointers: z.record(z.string(), z.string()).catch({}),
  seats: z.record(z.string(), z.record(z.string(), z.string())).catch({}),
  sealed: z.record(z.string(), z.record(z.string(), z.string())).catch({}),
  /** Team rooms hosted on another PC: once `joined` or `left` never again, a `refused` code is not tried twice.
   * `asked` is the seat key sent for it. Kept across folders, but a join still `waiting` stays with its folder. */
  joins: z.record(z.string(), z.object({
    code: z.string().optional(), room: z.string().optional(), state: z.enum(["waiting", "joined", "refused", "left"]), asked: z.string().optional(),
  })).catch({}),
});
type RoomSyncFile = z.infer<typeof fileSchema>;

const fileOf = (host: RoomSyncHost) => join(host.dataDir, ROOM_SYNC_FILE);
const empty = (scope = ""): RoomSyncFile => ({ scope, marked: [], applied: {}, pending: [], unresolved: {}, pointers: {}, seats: {}, sealed: {}, joins: {} });

function load(host: RoomSyncHost): RoomSyncFile {
  let raw: string;
  try {
    raw = readFileSync(fileOf(host), "utf8");
  } catch {
    return empty();
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {}
  setAsideFile(fileOf(host));
  return empty();
}

/** Another workspace or folder starts over, keeping only edits not sent yet. */
function scoped(host: RoomSyncHost, folder: string): RoomSyncFile {
  const file = load(host);
  const scope = `${host.settings().workspaceId}:${folder}`;
  if (file.scope === scope) return file;
  const joins = Object.fromEntries(Object.entries(file.joins).filter(([, entry]) => entry.state !== "waiting"));
  return { ...empty(scope), pending: file.pending, joins };
}

function save(host: RoomSyncHost, file: RoomSyncFile): void {
  writeFileAtomic(fileOf(host), JSON.stringify({ version: 1, ...file }, null, 2), { mode: 0o600 });
}

function forget(file: RoomSyncFile, marked: Set<string>, groupId: string): void {
  marked.delete(groupId);
  delete file.unresolved[groupId];
  for (const key of Object.keys(file.applied)) if (key.startsWith(`${groupId}:`)) delete file.applied[key];
}

function record(host: RoomSyncHost, entry: Pending): void {
  const file = load(host);
  // a later edit of a field replaces the one not sent yet
  for (const older of file.pending) {
    if (older.groupId !== entry.groupId) continue;
    for (const field of Object.keys(entry.changes)) delete older.changes[field];
  }
  file.pending = file.pending.filter((older) => entry.deleted ? older.groupId !== entry.groupId : older.deleted || Object.keys(older.changes).length);
  file.pending.push(entry);
  // a responder picked here outranks one still waiting for its bot
  if ("defaultResponder" in entry.changes) delete file.unresolved[entry.groupId]?.responder;
  save(host, file);
}

/** Call before the patch lands: members go out one field each, as the diff from `before`. */
export function roomEdited(host: RoomSyncHost, before: GroupRecord, patch: Partial<GroupRecord>): void {
  if (before.hosted) return;
  const changes: Record<string, unknown> = {};
  for (const field of FIELDS) if (field in patch) changes[field] = patch[field] ?? null;
  if (patch.memberIds) {
    for (const id of patch.memberIds) if (!before.memberIds.includes(id)) changes[`${MEMBER}${id}`] = true;
    for (const id of before.memberIds) if (!patch.memberIds.includes(id)) changes[`${MEMBER}${id}`] = false;
  }
  if (Object.keys(changes).length) record(host, { groupId: before.id, at: host.now(), changes });
}

export function roomRemoved(host: RoomSyncHost, group: GroupRecord): void {
  if (!group.hosted) record(host, { groupId: group.id, at: host.now(), changes: {}, deleted: true });
}

const responderBot = (field: string, value: unknown) =>
  field === "defaultResponder" && (value as GroupDefaultResponder | null)?.kind === "member" ? (value as { botId: string }).botId : null;

/** Local ids to sync ids; a bot with no sync id yet (held on a joining PC) stays behind in `held`. */
function toSync(store: Store, botMap: Record<string, string>, changes: Record<string, unknown>) {
  const sync: Record<string, unknown> = {};
  const held: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(changes)) {
    const botId = field.startsWith(MEMBER) ? field.slice(MEMBER.length) : responderBot(field, value);
    if (botId === null) {
      sync[field] = value;
      continue;
    }
    const syncId = botMap[botId];
    if (!syncId) {
      if (store.bot(botId)) held[field] = value;
    } else if (field.startsWith(MEMBER)) sync[`${MEMBER}${syncId}`] = value;
    else sync[field] = { kind: "member", botId: syncId };
  }
  return { sync, held };
}

function createChanges(group: GroupRecord): Record<string, unknown> {
  return {
    name: group.name,
    createdAt: group.createdAt,
    // tasks are newest first; the room's first thread keeps its id everywhere
    threadId: group.dm ? group.threadId : group.tasks?.at(-1)?.threadId ?? group.threadId,
    dm: Boolean(group.dm),
    bulletin: group.bulletin,
    section: group.section ?? null,
    pinned: Boolean(group.pinned),
    pinnedMessageId: group.pinnedMessageId ?? null,
    ...("setupCompletedAt" in group ? { setupCompletedAt: group.setupCompletedAt ?? null } : {}),
    ...("setupSkippedAt" in group ? { setupSkippedAt: group.setupSkippedAt ?? null } : {}),
    defaultResponder: group.defaultResponder,
    ...Object.fromEntries(group.memberIds.map((id) => [`${MEMBER}${id}`, true])),
  };
}

/** Sends rooms the folder lacks, stamped at their birth, then every route edit not sent yet. Returns the number written. */
export function publishRooms(host: RoomSyncHost, folder: string): number {
  const { store } = host;
  if (store.groupsFile === "unreadable") return 0;
  const settings = host.settings();
  const file = scoped(host, folder);
  const before = JSON.stringify(file);
  const marked = new Set(file.marked);
  let written = 0;
  const write = (groupId: string, changes: Record<string, unknown>, at: number, deleted = false): boolean => {
    try {
      const operation = createSyncOperation({
        entity: "room", entityId: groupId, ...(deleted ? { deleted: true } : { changes }),
        operationId: randomUUID(), deviceId: settings.deviceId, sequence: settings.nextSequence++, recordedAt: at,
      });
      writeSyncOperation(folder, operation);
      for (const field of Object.keys(changes)) file.applied[`${groupId}:${field}`] = operation.operationId;
      written++;
      return true;
    } catch (error) {
      console.warn(`room sync: skipped room ${groupId}`, error);
      return false;
    }
  };
  const fresh = store.groups.filter((group) => !group.hosted && !marked.has(group.id));
  if (fresh.length) {
    const known = applySyncOperations(emptyProfileSyncState(), readSyncOperations(folder).operations);
    for (const group of fresh) {
      if (known.rooms[group.id] || known.tombstones[`room:${group.id}`]) {
        marked.add(group.id);
        continue;
      }
      // an old stamp fills in PCs that lack the room and never beats a real edit made later anywhere
      const { sync, held } = toSync(store, settings.botMap, createChanges(group));
      if (!write(group.id, sync, group.createdAt)) continue;
      marked.add(group.id);
      file.pending = file.pending.filter((entry) => entry.groupId !== group.id || entry.deleted);
      if (Object.keys(held).length) file.pending.push({ groupId: group.id, at: group.createdAt, changes: held });
    }
  }
  for (const group of store.groups) {
    if (!group.hosted) continue;
    const roomId = group.hosted.roomId;
    const available = host.invite?.(roomId, settings.deviceId);
    const sealed = { ...file.sealed[group.id] };
    const changes: Record<string, unknown> = {};
    for (const [deviceId, key] of available ? Object.entries(file.seats[group.id] ?? {}) : []) {
      const code = host.invite?.(roomId, deviceId);
      if (!code) continue;
      const mark = createHash("sha256").update(`${roomId}\n${code}\n${key}`).digest("base64url");
      if (sealed[deviceId] === mark) continue;
      changes[`${SEAL}${deviceId}`] = sealSeat(key, code, `${group.id}:${roomId}`);
      sealed[deviceId] = mark;
    }
    // a room turned team room leaves the other PCs; its threads stop syncing, so no delete would follow.
    // A pointer from an earlier build carried the code in the clear; the first one from here clears it.
    const pointed = file.pointers[group.id] === roomId && !marked.has(group.id);
    if ((pointed || (!available && !marked.has(group.id))) && !Object.keys(changes).length) continue;
    if (!write(group.id, { hosted: true, room: roomId, ...(pointed ? {} : { invite: null }), ...changes }, host.now())) continue;
    forget(file, marked, group.id);
    file.pointers[group.id] = roomId;
    file.sealed[group.id] = sealed;
  }
  // this PC's seat key, once, for each team room it waits to join
  const asking = Object.entries(file.joins).filter(([, entry]) => entry.state === "waiting" && !entry.code);
  const key = asking.length ? seatKey(host.dataDir) : "";
  for (const [groupId, entry] of asking) {
    if (entry.asked === key || !write(groupId, { [`${SEAT}${settings.deviceId}`]: key }, host.now())) continue;
    entry.asked = key;
  }
  const left: Pending[] = [];
  for (const entry of [...file.pending].sort((a, b) => a.at - b.at)) {
    if (entry.deleted) {
      if (write(entry.groupId, {}, entry.at, true)) forget(file, marked, entry.groupId);
      else left.push(entry);
      continue;
    }
    const group = store.group(entry.groupId);
    if (!group || group.hosted) continue;
    const { sync, held } = toSync(store, settings.botMap, entry.changes);
    if (Object.keys(sync).length && !write(entry.groupId, sync, entry.at)) left.push(entry);
    else if (Object.keys(held).length) left.push({ ...entry, changes: held });
  }
  file.pending = left;
  file.marked = [...marked];
  if (JSON.stringify(file) !== before) save(host, file);
  return written;
}

const roomThreads = (group: GroupRecord) => new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]);

function removeRoom(store: Store, group: GroupRecord): void {
  const threadIds = roomThreads(group);
  // the deleting PC already told chat sync; a second delete from here would cover rows written here after it
  store.applySyncImport(() => store.deleteGroup(group.id));
  for (const threadId of threadIds) {
    for (const dir of [EVENTS_DIR, NATIVE_DIR]) removeRotatingLog(join(dir, `${threadId}.ndjson`));
  }
}

function syncedRecord(remote: SyncedRoom): GroupRecord {
  const threadId = String(remote.threadId);
  const createdAt = Number(remote.createdAt);
  const dm = remote.dm === true;
  return {
    id: remote.id, threadId, name: String(remote.name), memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "",
    unread: false, createdAt, busyBotId: null,
    ...(dm ? { dm: true } : { tasks: [{ threadId, title: UNTITLED_TASK, createdAt }] }),
  };
}

/** Applies the folder's rooms: a new room under its own ids, then each field's newest value not applied here yet. `deferred` asks for another pass. */
export function importRooms(host: RoomSyncHost, state: ProfileSyncState, folder: string): { deferred: boolean } {
  const { store } = host;
  if (store.groupsFile === "unreadable") return { deferred: false };
  const botMap = host.settings().botMap;
  const file = scoped(host, folder);
  const before = JSON.stringify(file);
  const marked = new Set(file.marked);
  let deferred = false;
  for (const key of Object.keys(state.tombstones)) {
    if (!key.startsWith("room:")) continue;
    const group = store.group(key.slice("room:".length));
    if (group && !group.hosted) {
      if (host.working(group)) {
        deferred = true;
        continue;
      }
      // chat sync drops each synced thread on its own delete; one with rows from after the delete keeps the room
      if ([...roomThreads(group)].some((threadId) => host.syncing?.(threadId))) continue;
      removeRoom(store, group);
    }
    forget(file, marked, key.slice("room:".length));
  }
  for (const remote of Object.values(state.rooms)) {
    const id = remote.id;
    const mine = file.pending.filter((entry) => entry.groupId === id);
    // deleted here; its tombstone goes out next
    if (mine.some((entry) => entry.deleted)) continue;
    let group = store.group(id);
    if (group?.hosted) {
      const seats = Object.entries(remote).flatMap(([field, value]) => {
        const deviceId = field.slice(SEAT.length);
        return field.startsWith(SEAT) && DEVICE.test(deviceId) && deviceId !== host.settings().deviceId && isSeatKey(value) ? [[deviceId, value] as const] : [];
      });
      if (seats.length) file.seats[id] = Object.fromEntries(seats);
      else delete file.seats[id];
      continue;
    }
    if (remote.hosted === true) {
      if (group && host.working(group)) {
        deferred = true;
        continue;
      }
      if (group) removeRoom(store, group);
      forget(file, marked, id);
      // a pointer naming no room came from an earlier build; a seat taken or left here could not be told from it
      const room = typeof remote.room === "string" && remote.room ? remote.room : null;
      if (room) point(host, file, id, room, openSeat(host.dataDir, remote[`${SEAL}${host.settings().deviceId}`], `${id}:${room}`));
      continue;
    }
    if (!group) {
      if (typeof remote.name !== "string" || typeof remote.createdAt !== "number" || typeof remote.threadId !== "string") continue;
      if (store.groupByThread(remote.threadId)) continue;
      forget(file, marked, id);
      group = store.addSyncedGroup(syncedRecord(remote));
    }
    marked.add(id);
    // a roster change waits for the turn, as the roster route does
    const busy = host.working(group);
    // a field edited here and not sent yet keeps its local value
    const waiting = new Set(mine.flatMap((entry) => Object.keys(toSync(store, botMap, entry.changes).sync)));
    const patch: Partial<GroupRecord> = {};
    let members = [...group.memberIds];
    const unresolved = file.unresolved[id] ?? { members: [] };
    for (const [field, value] of Object.entries(remote)) {
      const version = state.fieldVersions[`room:${id}:${field}`];
      const key = `${id}:${field}`;
      if (field === "id" || !version || file.applied[key] === version.operationId || waiting.has(field)) continue;
      if (busy && field.startsWith(MEMBER)) {
        deferred = true;
        continue;
      }
      file.applied[key] = version.operationId;
      if (field.startsWith(MEMBER)) {
        const syncId = field.slice(MEMBER.length);
        const localId = localIdForSyncId(botMap, syncId);
        unresolved.members = unresolved.members.filter((other) => other !== syncId);
        if (value !== true) members = members.filter((member) => member !== localId);
        else if (!localId) unresolved.members.push(syncId);
        else if (!members.includes(localId)) members.push(localId);
      } else if (field === "defaultResponder") {
        const responder = value as GroupDefaultResponder;
        delete unresolved.responder;
        // a sync id is no member here, so the store falls back as it does for a missing bot
        patch.defaultResponder = responder;
        if (responder.kind === "member") unresolved.responder = responder.botId;
      } else if ((FIELDS as readonly string[]).includes(field)) {
        Object.assign(patch, { [field]: value === null && CLEARED_BY_NULL.has(field) ? undefined : value });
      }
    }
    // members another PC named before this one had their bots
    if (!busy) {
      for (const syncId of unresolved.members) {
        const localId = localIdForSyncId(botMap, syncId);
        if (localId && !members.includes(localId)) members.push(localId);
      }
      unresolved.members = unresolved.members.filter((syncId) => !localIdForSyncId(botMap, syncId));
    }
    // the store would swap a responder who is not a member yet for another member
    const responderId = unresolved.responder && localIdForSyncId(botMap, unresolved.responder);
    if (responderId && members.includes(responderId)) {
      patch.defaultResponder = { kind: "member", botId: responderId };
      delete unresolved.responder;
    }
    if (members.join() !== group.memberIds.join()) patch.memberIds = members;
    if (Object.keys(patch).length) store.patchGroup(id, patch);
    if (unresolved.members.length || unresolved.responder) file.unresolved[id] = unresolved;
    else delete file.unresolved[id];
  }
  file.marked = [...marked];
  if (JSON.stringify(file) !== before) save(host, file);
  return { deferred };
}

/** A pointer for `groupId` names `room`, with the code sealed to this PC once the host has sealed it. */
function point(host: RoomSyncHost, file: RoomSyncFile, groupId: string, room: string, code: string | null): void {
  const was = file.joins[groupId];
  // an entry from before pointers named rooms is for the room the group has
  if (was && (!was.room || was.room === room)) {
    was.room = room;
    const upgrade = isOwnerRoomCode(code) && !isOwnerRoomCode(was.code);
    if ((was.state === "joined" && !upgrade) || was.state === "left" || !code || code === was.code) return;
    file.joins[groupId] = { ...was, code, state: "waiting" };
    return;
  }
  // the host replaced the group's room: a PC the user left the old one on stays out, any other takes the new seat
  if (was && (was.state === "left" || (was.room && host.left?.(was.room)))) {
    file.joins[groupId] = { room, state: "left" };
    return;
  }
  file.joins[groupId] = { room, state: "waiting", ...(code ? { code } : {}), ...(was?.asked ? { asked: was.asked } : {}) };
}

const joining = new Set<string>();

/** Takes the guest seat of each team room waiting here, one try per pass; a host that is off, or a full room, is tried again on the next. */
export function joinTeamRooms(host: RoomSyncHost, folder: string): void {
  const { join } = host;
  if (!join) return;
  const file = scoped(host, folder);
  const before = JSON.stringify(file);
  const scope = file.scope;
  for (const [groupId, entry] of Object.entries(file.joins)) {
    const { code, room, state } = entry;
    const key = `${host.dataDir}\n${groupId}`;
    if (state !== "waiting" || !code || !room || joining.has(key)) continue;
    // a seat taken or left by hand stays as the user left it; a join would reset it
    if (host.left?.(room) || (!isOwnerRoomCode(code) && host.joined?.(room))) {
      entry.state = host.left?.(room) ? "left" : "joined";
      continue;
    }
    joining.add(key);
    void join(code, room).then((result) => {
      // 400 is bad-code: this PC's relay is not set up yet, so it cannot read the host's code
      const later = !result.ok && (result.status >= 500 || result.status === 429 || result.status === 400 || result.error === "room is busy" || result.error === "room-full");
      const latest = load(host);
      const current = latest.joins[groupId];
      if (later || latest.scope !== scope || current?.code !== code || current.room !== room || current.state !== "waiting") return;
      current.state = result.ok || result.error === "seated" ? (host.left?.(room) ? "left" : "joined") : "refused";
      save(host, latest);
    }).catch((error) => console.warn(`room sync: join of room ${groupId} failed`, error)).finally(() => joining.delete(key));
  }
  if (JSON.stringify(file) !== before) save(host, file);
}
