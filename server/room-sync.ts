// Room records between one user's PCs. A room travels as `room` ops under its
// own group id, in `.room` files older builds never read. Only route edits
// publish; imports, and values a PC derived (members it lacks, a normalized
// responder), never do. Team rooms stay on their host.
import { randomUUID } from "node:crypto";
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
}

const MEMBER = "member.";
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
});
type RoomSyncFile = z.infer<typeof fileSchema>;

const fileOf = (host: RoomSyncHost) => join(host.dataDir, ROOM_SYNC_FILE);
const empty = (scope = ""): RoomSyncFile => ({ scope, marked: [], applied: {}, pending: [], unresolved: {} });

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
  return file.scope === scope ? file : { ...empty(scope), pending: file.pending };
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
    if (group?.hosted) continue;
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
