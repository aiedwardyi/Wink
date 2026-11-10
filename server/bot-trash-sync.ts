// Trash and restore marks between PCs. A mark is the bot field `trashed` in its
// own `.trash` change, timed at the tap, so the latest tap wins however late
// it is sent. Only Empty now writes the permanent delete.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { setAsideFile, writeFileAtomic } from "./atomic.ts";
import type { BotTrash, TrashEntry } from "./bot-trash.ts";
import {
  bindSyncId, createSyncOperation, dropSyncedBot, localIdForSyncId, writeSyncOperation, type ProfileSyncSettings, type ProfileSyncState,
} from "./profile-sync.ts";
import type { BotRecord, Store } from "./store.ts";

export type FolderMark = "trashed" | "restored" | "deleted";
export type HereState = "live" | "trashed" | "emptied" | "absent";
export type TrashSyncAction = "trash" | "restore" | "revive" | "create" | "erase" | "forget" | "none";

const ACTIONS: Record<FolderMark, Record<HereState, TrashSyncAction>> = {
  trashed: { live: "trash", trashed: "none", emptied: "none", absent: "none" },
  restored: { live: "none", trashed: "restore", emptied: "revive", absent: "create" },
  deleted: { live: "erase", trashed: "erase", emptied: "forget", absent: "none" },
};

/** What a PC does with the folder's word on one bot. A tap not sent yet goes out first; only a permanent delete beats it. */
export function trashSyncAction(folder: FolderMark, here: HereState, unsent = false): TrashSyncAction {
  return unsent && folder !== "deleted" ? "none" : ACTIONS[folder][here];
}

export interface TrashSyncHost {
  dataDir: string;
  store: Store;
  trash: BotTrash;
  /** Its bot map and sequence are read and moved here; the caller saves it. */
  settings(): ProfileSyncSettings;
  now(): number;
}

interface Mark {
  botId: string;
  syncId: string;
  trashed: boolean;
  at: number;
}

/** PC-local: taps not sent yet, and the newest mark seen per bot. */
interface TrashSyncFile {
  pending: Mark[];
  seen: Record<string, number>;
}

const fileOf = (host: TrashSyncHost) => join(host.dataDir, "bot-trash-sync.json");

const validMark = (mark: Partial<Mark> | null) =>
  typeof mark?.botId === "string" && typeof mark.syncId === "string" && typeof mark.trashed === "boolean" && Number.isFinite(mark.at);

const sameMark = (file: TrashSyncFile, syncId: string, at: number) =>
  file.pending.some((mark) => mark.syncId === syncId && mark.trashed && mark.at === at);

function load(host: TrashSyncHost): TrashSyncFile {
  let raw: string;
  try {
    raw = readFileSync(fileOf(host), "utf8");
  } catch {
    return { pending: [], seen: {} };
  }
  try {
    // SAFETY: both fields are checked before use, each mark by validMark.
    const disk = JSON.parse(raw) as Partial<TrashSyncFile>;
    if (Array.isArray(disk.pending) && disk.seen && typeof disk.seen === "object") {
      const bad = disk.pending.filter((mark) => !validMark(mark));
      if (bad.length) console.warn(`bot trash sync: skipped bad marks in ${fileOf(host)}: ${JSON.stringify(bad)}`);
      return { pending: disk.pending.filter(validMark), seen: disk.seen };
    }
  } catch {}
  setAsideFile(fileOf(host));
  return { pending: [], seen: {} };
}

function save(host: TrashSyncHost, file: TrashSyncFile): void {
  writeFileAtomic(fileOf(host), JSON.stringify({ version: 1, ...file }, null, 2), { mode: 0o600 });
}

/** The tap time, or 1 ms after the newest mark this PC knows for the bot, whichever is later. */
function markTime(host: TrashSyncHost, file: TrashSyncFile, syncId: string): number {
  const known = [
    file.seen[syncId] ?? 0,
    ...file.pending.filter((mark) => mark.syncId === syncId).map((mark) => mark.at),
    ...host.store.trash.entries.filter((entry) => entry.syncId === syncId).map((entry) => entry.deletedAt),
  ];
  return Math.max(host.now(), ...known.map((at) => at + 1));
}

export function trashBot(host: TrashSyncHost, botId: string): TrashEntry {
  const syncId = host.settings().botMap[botId];
  if (!syncId) return host.trash.trash(botId);
  const file = load(host);
  const entry = host.trash.trash(botId, { syncId, deletedAt: markTime(host, file, syncId) });
  // the 30-day timer may empty the entry before the mark is sent
  file.pending.push({ botId, syncId, trashed: true, at: entry.deletedAt });
  save(host, file);
  return entry;
}

export function restoreBot(host: TrashSyncHost, botId: string): BotRecord {
  const entry = host.store.trash.entry(botId);
  const file = load(host);
  const at = entry?.syncId ? markTime(host, file, entry.syncId) : 0;
  const bot = host.trash.restore(botId);
  if (!entry?.syncId) return bot;
  // a Delete not sent yet still goes out, so other PCs see both taps in order
  if (!entry.told && !sameMark(file, entry.syncId, entry.deletedAt)) file.pending.push({ botId, syncId: entry.syncId, trashed: true, at: entry.deletedAt });
  file.pending.push({ botId, syncId: entry.syncId, trashed: false, at });
  save(host, file);
  return bot;
}

/** Sends every tap not sent yet, oldest first. Returns the number written. */
export function publishTrashMarks(host: TrashSyncHost, folder: string): number {
  const file = load(host);
  const untold = host.store.trash.entries.filter((entry) => !entry.told && entry.step === "trashed");
  const marks = [
    ...file.pending,
    ...untold.flatMap((entry) => entry.syncId && !sameMark(file, entry.syncId, entry.deletedAt) ? [{ botId: entry.record.id, syncId: entry.syncId, trashed: true, at: entry.deletedAt }] : []),
  ].sort((left, right) => left.at - right.at);
  if (!marks.length) return 0;
  const settings = host.settings();
  let written = 0;
  for (const mark of marks) {
    // after a sync Move the bot map no longer names it, so it stays on this PC
    if (settings.botMap[mark.botId] !== mark.syncId) continue;
    writeSyncOperation(folder, createSyncOperation({
      entity: "bot", entityId: mark.syncId, changes: { trashed: mark.trashed },
      operationId: randomUUID(), deviceId: settings.deviceId, sequence: settings.nextSequence++, recordedAt: mark.at,
    }));
    file.seen[mark.syncId] = Math.max(file.seen[mark.syncId] ?? 0, mark.at);
    written++;
  }
  for (const entry of untold) entry.told = true;
  if (untold.length) host.store.trash.save();
  file.pending = [];
  save(host, file);
  return written;
}

/** Applies the folder's marks before the profile import, which takes the two lists. */
export function importTrashMarks(host: TrashSyncHost, state: ProfileSyncState): { trashed: string[]; revive: string[] } {
  const store = host.store;
  const revive: string[] = [];
  if (store.botsFile === "unreadable" || store.trash.unreadable) return { trashed: [], revive };
  const settings = host.settings();
  const file = load(host);
  const tombstoned = Object.keys(state.tombstones).filter((key) => key.startsWith("bot:")).map((key) => key.slice("bot:".length));
  const marked = Object.values(state.bots).filter((bot) => typeof bot.trashed === "boolean").map((bot) => bot.id);
  let seen = false;
  for (const syncId of new Set([...tombstoned, ...marked])) {
    const version = state.fieldVersions[`bot:${syncId}:trashed`];
    if (version && version.recordedAt > (file.seen[syncId] ?? 0)) {
      file.seen[syncId] = version.recordedAt;
      seen = true;
    }
    const localId = localIdForSyncId(settings.botMap, syncId);
    const entry = store.trash.entries.find((candidate) => candidate.syncId === syncId && candidate.step === "trashed");
    const note = store.trash.emptied.find((candidate) => candidate.syncId === syncId);
    const here: HereState = localId && store.bot(localId) ? "live" : entry ? "trashed" : note ? "emptied" : "absent";
    const unsent = entry?.told === false || file.pending.some((mark) => mark.syncId === syncId);
    const mark: FolderMark = tombstoned.includes(syncId) ? "deleted" : state.bots[syncId]!.trashed ? "trashed" : "restored";
    switch (trashSyncAction(mark, here, unsent)) {
      case "trash": {
        const trashed = host.trash.trash(localId!, { syncId, deletedAt: version!.recordedAt });
        trashed.told = true;
        store.trash.save();
        break;
      }
      case "restore":
        host.trash.restore(entry!.record.id);
        break;
      case "revive":
        bindSyncId(settings.botMap, note!.botId, syncId);
        revive.push(syncId);
        break;
      case "erase":
        // a live bot is erased by the import's delete, as today
        if (here !== "trashed") break;
        host.trash.empty([entry!.record.id], { tellOthers: true });
        dropSyncedBot(settings.botMap, settings.syncedHashes, entry!.record.id, syncId);
        break;
      case "forget":
        store.trash.emptied = store.trash.emptied.filter((candidate) => candidate !== note);
        store.trash.save();
        dropSyncedBot(settings.botMap, settings.syncedHashes, note!.botId, syncId);
        break;
    }
  }
  if (seen) save(host, file);
  return { trashed: store.trash.entries.flatMap((entry) => entry.syncId ? [entry.syncId] : []), revive };
}

/** Runs chat sync's rebuild for bots the import brought back, then drops their notes. */
export function finishRevive(host: TrashSyncHost, revive: readonly string[], rebuild: (botId: string) => void): void {
  const list = host.store.trash;
  const notes = list.emptied.filter((note) => note.syncId && revive.includes(note.syncId) && host.store.bot(note.botId));
  if (!notes.length) return;
  for (const note of notes) rebuild(note.botId);
  list.emptied = list.emptied.filter((note) => !notes.includes(note));
  list.save();
}
