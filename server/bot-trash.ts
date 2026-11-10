// Recently deleted bots on this PC. The record moves to bot-trash.json,
// the folder moves by one rename, the chats stay in messages.db. One atomic
// write of bot-trash.json is the point of no return for each action, so a
// crash leaves the bot or the trashed bot, never neither.
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { setAsideFile, writeFileAtomic } from "./atomic.ts";
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import type { RoutineManager } from "./routines.ts";
import { removeRotatingLog } from "./rotating-log.ts";
import { sectionKey, type BotRecord, type Store } from "./store.ts";
import { removeWorkspaceDir, workspaceDir } from "./workspace.ts";

export const TRASH_FILE = join(DATA_DIR, "bot-trash.json");
export const WORKSPACES_TRASH_DIR = join(DATA_DIR, "workspaces-trash");

export function trashedWorkspaceDir(botId: string): string {
  return join(WORKSPACES_TRASH_DIR, botId);
}

export interface TrashEntry {
  record: BotRecord;
  syncId?: string;
  /** The tap, on whichever PC made it. */
  deletedAt: number;
  /** When it reached this PC's trash; each PC counts its own 30 days from here. */
  arrivedAt: number;
  /** Rooms the trash took it out of. */
  rooms: string[];
  /** Routines the trash switched off. */
  routines: string[];
  step: "trashed" | "restoring" | "emptying";
  /** Emptying only: whether the other PCs get the chat deletes. */
  tellOthers?: boolean;
  told: boolean;
}

/** A bot the timer emptied here, kept so a later restore from another PC can be recognized. */
export interface EmptiedNote {
  botId: string;
  syncId?: string;
  threadIds: string[];
  emptiedAt: number;
}

const STEPS = new Set<TrashEntry["step"]>(["trashed", "restoring", "emptying"]);

const validEntry = (entry: Partial<TrashEntry> | null) =>
  typeof entry?.record?.id === "string" &&
  STEPS.has(entry.step!) &&
  Number.isFinite(entry.arrivedAt) &&
  Array.isArray(entry.rooms) &&
  Array.isArray(entry.routines);

const threadsOf = (bot: BotRecord) => [...new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)])];

const busyCode = (error: unknown) =>
  error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EBUSY");

export class TrashList {
  entries: TrashEntry[] = [];
  emptied: EmptiedNote[] = [];
  /** An unreadable list is never emptied from; the first save sets the file aside. */
  unreadable = false;
  private unloaded = false;
  private readonly file: string;

  constructor(file = TRASH_FILE) {
    this.file = file;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) this.unreadable = this.unloaded = true;
      return;
    }
    try {
      // SAFETY: both fields are checked before use.
      const disk = JSON.parse(raw) as { bots?: unknown; emptied?: unknown };
      if (!Array.isArray(disk.bots) || !disk.bots.every(validEntry)) throw new Error("bad trash list");
      // SAFETY: every entry passed validEntry; the notes are only written by this class.
      this.entries = disk.bots as TrashEntry[];
      // SAFETY: as above.
      this.emptied = Array.isArray(disk.emptied) ? (disk.emptied as EmptiedNote[]) : [];
    } catch {
      this.unreadable = this.unloaded = true;
    }
  }

  entry(botId: string): TrashEntry | undefined {
    return this.entries.find((entry) => entry.record.id === botId);
  }

  threadIds(): string[] {
    return this.entries.flatMap((entry) => threadsOf(entry.record));
  }

  save(): void {
    if (this.unloaded) {
      setAsideFile(this.file);
      this.unloaded = false;
    }
    writeFileAtomic(this.file, JSON.stringify({ version: 1, bots: this.entries, emptied: this.emptied }, null, 2), { mode: 0o600 });
  }
}

type TrashRoutines = Pick<RoutineManager, "listRoutines" | "disableForBot" | "update">;

export class BotTrash {
  private readonly store: Store;
  private readonly routines: TrashRoutines;
  private readonly now: () => number;

  constructor(store: Store, routines: TrashRoutines, now: () => number = Date.now) {
    this.store = store;
    this.routines = routines;
    this.now = now;
  }

  private get list(): TrashList {
    return this.store.trash;
  }

  private refuseUnloadedBots(): void {
    if (this.store.botsFile === "unreadable") throw new Error("bots.json did not load");
  }

  /** Finishes whatever a crash interrupted. Runs once, before anything reads the bot list. */
  start(): void {
    const list = this.list;
    if (list.unreadable) {
      console.warn("bot trash: bot-trash.json did not load; nothing in workspaces-trash is touched");
      return;
    }
    const now = this.now();
    let changed = false;
    for (const entry of list.entries) {
      if (entry.arrivedAt > now) {
        entry.arrivedAt = now;
        changed = true;
      }
    }
    if (changed) list.save();
    // a finish that drops an entry replaces list.entries, so this walks the list as it was
    for (const entry of list.entries) {
      if (entry.step === "restoring") this.finishRestore(entry, false);
      else if (entry.step === "emptying") this.finishEmpty(entry);
      else this.finishTrash(entry);
    }
    let folders: string[] = [];
    try {
      folders = readdirSync(WORKSPACES_TRASH_DIR);
    } catch {}
    for (const name of folders) {
      if (!list.entry(name)) console.warn(`bot trash: ${join(WORKSPACES_TRASH_DIR, name)} has no trash entry; left alone`);
    }
  }

  trash(botId: string, opts: { syncId?: string; deletedAt?: number } = {}): TrashEntry {
    this.refuseUnloadedBots();
    const bot = this.store.bot(botId);
    if (!bot) throw new Error("no such bot");
    if (this.list.entry(botId)) throw new Error("that bot is already in the trash");
    const now = this.now();
    const entry: TrashEntry = {
      record: structuredClone(bot),
      deletedAt: opts.deletedAt ?? now,
      arrivedAt: now,
      rooms: this.store.groups
        .filter((group) => !group.dm && group.memberIds.length > 1 && group.memberIds.includes(botId))
        .map((group) => group.id),
      routines: this.routines.listRoutines().filter((routine) => routine.botId === botId && routine.enabled).map((routine) => routine.id),
      step: "trashed",
      told: false,
    };
    if (opts.syncId) entry.syncId = opts.syncId;
    this.list.entries.push(entry);
    try {
      this.list.save();
    } catch (error) {
      this.list.entries = this.list.entries.filter((candidate) => candidate !== entry);
      throw error;
    }
    this.finishTrash(entry);
    return entry;
  }

  restore(botId: string): BotRecord {
    this.refuseUnloadedBots();
    const entry = this.list.entry(botId);
    if (!entry || entry.step !== "trashed") throw new Error("no such bot in the trash");
    entry.step = "restoring";
    this.list.save();
    return this.finishRestore(entry, true)!;
  }

  /** `tellOthers` false is the timer: nothing is written for other PCs and a note of the ids stays. */
  empty(botIds: string[], { tellOthers }: { tellOthers: boolean }): void {
    if (this.list.unreadable) return;
    const targets = botIds.flatMap((id) => {
      const entry = this.list.entry(id);
      return entry?.step === "trashed" ? [entry] : [];
    });
    if (!targets.length) return;
    for (const entry of targets) Object.assign(entry, { step: "emptying", tellOthers });
    this.list.save();
    for (const entry of targets) this.finishEmpty(entry);
  }

  private finishTrash(entry: TrashEntry): void {
    const id = entry.record.id;
    if (this.store.bot(id)) {
      this.store.bots = this.store.bots.filter((bot) => bot.id !== id);
      this.store.saveBots();
      this.store.emit({ type: "bot.deleted", botId: id });
    }
    this.store.leaveRooms(id);
    this.routines.disableForBot(id);
    const from = workspaceDir(id);
    if (!lstatSync(from, { throwIfNoEntry: false })) return;
    try {
      mkdirSync(WORKSPACES_TRASH_DIR, { recursive: true, mode: 0o700 });
      renameSync(from, trashedWorkspaceDir(id));
    } catch (error) {
      // a file open inside holds the folder; the next start moves it
      console.warn(`bot trash: folder of ${id} stays in workspaces for now`, error);
    }
  }

  private finishRestore(entry: TrashEntry, asked: boolean): BotRecord | null {
    const record = entry.record;
    const from = trashedWorkspaceDir(record.id);
    if (lstatSync(from, { throwIfNoEntry: false })) {
      try {
        if (lstatSync(workspaceDir(record.id), { throwIfNoEntry: false })) throw new Error(`a folder for ${record.name} already exists`);
        renameSync(from, workspaceDir(record.id));
      } catch (error) {
        entry.step = "trashed";
        this.list.save();
        const message = busyCode(error)
          ? `Could not restore ${record.name}. A file in its folder is open in another app. Close it and try again.`
          : `Could not restore ${record.name}: ${error instanceof Error ? error.message : String(error)}`;
        if (asked) throw new Error(message, { cause: error });
        console.warn(`bot trash: ${message}`);
        return null;
      }
    }
    let bot = this.store.bot(record.id);
    if (!bot) {
      bot = record;
      if (bot.busy) bot.busy = false;
      if (bot.activity !== undefined && bot.activity !== "idle") bot.activity = "idle";
      delete bot.activeThreadId;
      const section = sectionKey(bot.section);
      if (bot.chiefOfStaff && this.store.bots.some((other) => other.chiefOfStaff && sectionKey(other.section) === section)) {
        bot.chiefOfStaff = false;
      }
      this.store.bots.unshift(bot);
      this.store.saveBots();
    }
    for (const groupId of entry.rooms) {
      const group = this.store.group(groupId);
      if (group && !group.memberIds.includes(bot.id)) this.store.patchGroup(groupId, { memberIds: [...group.memberIds, bot.id] });
    }
    for (const routine of this.routines.listRoutines()) {
      if (entry.routines.includes(routine.id) && routine.botId === bot.id && !routine.enabled) {
        this.routines.update(routine.id, { enabled: true });
      }
    }
    this.list.entries = this.list.entries.filter((candidate) => candidate !== entry);
    this.list.save();
    this.store.emit({ type: "bot", botId: bot.id });
    return bot;
  }

  private finishEmpty(entry: TrashEntry): void {
    const record = entry.record;
    const threadIds = threadsOf(record);
    for (const threadId of threadIds) {
      this.store.deleteThreadRecord(threadId, entry.tellOthers !== false);
      for (const dir of [EVENTS_DIR, NATIVE_DIR]) removeRotatingLog(join(dir, `${threadId}.ndjson`));
    }
    try {
      removeWorkspaceDir(trashedWorkspaceDir(record.id));
      removeWorkspaceDir(workspaceDir(record.id));
    } catch (error) {
      // the entry stays "emptying" and the next start finishes it
      console.warn(`bot trash: folder of ${record.id} could not be removed yet`, error);
      return;
    }
    if (entry.tellOthers === false) {
      const note: EmptiedNote = { botId: record.id, threadIds, emptiedAt: this.now() };
      if (entry.syncId) note.syncId = entry.syncId;
      this.list.emptied.push(note);
    }
    this.list.entries = this.list.entries.filter((candidate) => candidate !== entry);
    this.list.save();
  }
}
