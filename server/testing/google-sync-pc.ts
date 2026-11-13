import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

import { BotTrash, trashedWorkspaceDir } from "../bot-trash.ts";
import { createBotTrashActions, trashDaysLeft } from "../bot-trash-actions.ts";
import { finishRevive, importTrashMarks, publishTrashMarks, type TrashSyncHost } from "../bot-trash-sync.ts";
import { closeMessageDb } from "../message-db.ts";
import { writeDeviceRecord } from "../device-sync.ts";
import {
  applySyncOperations, bindSyncId, botDeletesToPublish, createSyncOperation, dropSyncedBot, emptyProfileSyncState, loadOrCreateSyncWorkspace,
  loadProfileSyncSettings, markImported, markSynced, planProfileImport, readSyncOperations, saveProfileSyncSettings, unsyncedChanges,
  writeSyncOperation, type ProfileSyncState,
} from "../profile-sync.ts";
import { ensureMemorySyncDevice, loadMemorySyncLedger, saveMemorySyncLedger, syncBotMemory } from "../memory-sync.ts";
import { pullSyncedPicture, pruneSyncedPictures } from "../picture-sync.ts";
import { importRooms, publishRooms, roomEdited, roomRemoved, type RoomSyncHost } from "../room-sync.ts";
import { createRoomThreads } from "../room-thread-sync.ts";
import { RoutineManager } from "../routines.ts";
import { Store, type BotRecord } from "../store.ts";
import { ensureSyncV2Identity } from "../thread-sync-v2-engine.ts";
import { createThreadSyncV2Store } from "../thread-sync-v2-store.ts";
import { workspaceDir } from "../workspace.ts";

export interface ChatSpec { title: string; rows: number; pictureAges?: number[] }
export interface BotSpec { name: string; memory?: string; chats?: ChatSpec[] }
export interface ReportBot { name: string; syncId: string | null; chats: string[]; rows: string[]; memory: string | null; pictures: string }
export interface PlaceBot { id: string; syncId: string | null; name: string; chats: string[]; memory: string | null; files: number; daysLeft?: number }
export interface Places { bots: PlaceBot[]; trash: PlaceBot[] }
export interface PlaceRoom { id: string; threadId: string; name: string; members: string[]; dm: boolean; setup: boolean }
export interface RoomRow { id: string; role: string; text?: string; from?: string; parentId?: string | null }
export interface RoomChat { active: string; busy: boolean; threads: Array<{ id: string; title: string; rows: RoomRow[] }>; written: string[] }
export interface TestArgs { bots?: BotSpec[]; bot?: string; to?: string; text?: string; chat?: ChatSpec; folder?: string | null; thread?: string; busy?: boolean; skew?: number; old?: boolean; room?: string; members?: string[]; dm?: boolean; title?: string }
export type TestResult = ReportBot[] | Places | PlaceRoom[] | RoomChat | Record<string, string> | number | boolean | undefined;

const { dataDir } = z.object({ dataDir: z.string() }).parse(workerData);
const DAY = 86_400_000;
const store = new Store(() => ({ instanceId: "test", model: "test" }));
let skew = 0;
const now = () => Date.now() + skew;
const routines = new RoutineManager({
  file: join(dataDir, "routines.json"), botState: (botId) => (store.bot(botId) ? "ready" : "missing"),
  createTask: () => null, startTurn: async () => {}, startChatTurn: async () => {},
});
const trash = new BotTrash(store, routines, now);
trash.start();
const attachments = join(dataDir, "attachments");
const ledger = loadMemorySyncLedger(dataDir);
let settings = loadProfileSyncSettings(dataDir);
ensureSyncV2Identity(settings.deviceId);
ensureMemorySyncDevice(ledger);
save();
let v2: ReturnType<typeof createThreadSyncV2Store> = null;
let busy = false;
// a build before the trash: never reads a mark
let old = false;
const host: TrashSyncHost = { dataDir, store, trash, settings: () => settings, now };
const roomHost: RoomSyncHost = { dataDir, store, settings: () => settings, now, working: () => false, syncing: (threadId) => v2?.holds(threadId) ?? false };
const roomThreads = createRoomThreads({
  store, botMap: () => settings.botMap,
  syncId: (botId) => {
    if (!settings.botMap[botId]) {
      settings.botMap[botId] = randomUUID();
      save();
    }
    return settings.botMap[botId]!;
  },
});
// room message ids this PC wrote itself rather than imported
const written = new Set<string>();
// threads of rooms deleted here still owe chat sync their delete; index.ts flushes them on a timer
const deleted = new Set<string>();
store.onChange((change) => {
  if (change.type === "message" && !change.imported && store.groupByThread(change.threadId)) written.add(change.message.id);
});
const trashActions = createBotTrashActions({
  host: () => host,
  queueDeletes: (syncIds) => {
    settings.pendingBotDeletes.push(...syncIds);
    save();
  },
  awaitingSync: () => false,
});

function save(): void {
  settings = saveProfileSyncSettings(dataDir, settings);
  saveMemorySyncLedger(dataDir, ledger);
}

const portable = (bot: { name: string }) => ({ name: bot.name });
const big = (i: number) => `row ${i} ${"lorem ipsum dolor sit amet ".repeat(800)}`;

function writeChat(botId: string, chat: ChatSpec, at: number): void {
  const task = store.createTask(botId, chat.title, false)!;
  for (let i = 0; i < chat.rows; i++) store.appendMessage(task.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: big(i), at: at + i });
  for (const days of chat.pictureAges ?? []) {
    const name = `${randomUUID()}.png`;
    mkdirSync(attachments, { recursive: true });
    writeFileSync(join(attachments, name), `png-${name}`);
    store.appendMessage(task.threadId, { role: "user", kind: "screen", image: name, shown: true, png: "pixels", mime: "image/png", at: Date.now() - days * DAY });
  }
}

/** index.ts importProfileChanges, names only. */
function importProfile(state: ProfileSyncState, marks: { trashed: string[]; revive: string[] }): void {
  const plan = planProfileImport({
    state, deviceId: settings.deviceId, workspaceId: settings.workspaceId, synced: settings.syncedHashes, botMap: settings.botMap,
    local: store.bots.map((bot) => ({ id: bot.id, name: bot.name, section: bot.section, hidden: bot.hidden, changes: portable(bot) })),
    localOrder: { sectionOrder: [], itemOrder: {} }, pendingBotDeletes: settings.pendingBotDeletes, ...marks,
  });
  for (const item of plan.bots) {
    const remote = state.bots[item.globalId]!;
    let bot = item.localId ? store.bot(item.localId) : undefined;
    const created = !bot;
    if (!bot) bot = store.createBot({ name: String(remote.name ?? "Imported bot") }, { seedMessages: false, id: item.localId ?? undefined });
    else if ("name" in item.apply) store.patchBot(bot.id, { name: String(remote.name) });
    bindSyncId(settings.botMap, bot.id, item.globalId);
    const local = portable(store.bot(bot.id)!);
    markImported(settings.syncedHashes, "bot", item.globalId, remote, item.apply, local);
    if (created) markSynced(settings.syncedHashes, { entity: "bot", entityId: item.globalId, changes: Object.fromEntries(Object.entries(local).filter(([field]) => !(field in remote))) });
  }
  for (const item of plan.remove) {
    store.deleteBot(item.localId);
    dropSyncedBot(settings.botMap, settings.syncedHashes, item.localId, item.globalId);
  }
}

/** index.ts publishProfileChanges, names only. */
function publishProfile(folder: string): void {
  const changed = unsyncedChanges(settings.syncedHashes, store.bots.map((bot) => {
    settings.botMap[bot.id] ??= randomUUID();
    return { entity: "bot" as const, entityId: settings.botMap[bot.id]!, changes: portable(bot) };
  }));
  for (const item of changed) {
    writeSyncOperation(folder, createSyncOperation({ ...item, operationId: randomUUID(), deviceId: settings.deviceId, sequence: settings.nextSequence++, recordedAt: Date.now() }));
    markSynced(settings.syncedHashes, item);
  }
  const deletes = botDeletesToPublish(settings.botMap, new Set(store.bots.map((bot) => bot.id)), settings.pendingBotDeletes);
  for (const [localId, globalId] of deletes.publish) {
    writeSyncOperation(folder, createSyncOperation({ entity: "bot", entityId: globalId, deleted: true, operationId: randomUUID(), deviceId: settings.deviceId, sequence: settings.nextSequence++, recordedAt: Date.now() }));
    dropSyncedBot(settings.botMap, settings.syncedHashes, localId, globalId);
  }
  settings.pendingBotDeletes = deletes.pendingBotDeletes;
}

function syncProfile(folder: string): void {
  if (!old) publishTrashMarks(host, folder);
  const operations = readSyncOperations(folder).operations.filter((op) => !old || !("trashed" in (op.changes ?? {})));
  const state = applySyncOperations(emptyProfileSyncState(), operations);
  const marks = old ? { trashed: [], revive: [] } : importTrashMarks(host, state);
  importProfile(state, marks);
  if (!old) importRooms(roomHost, state, folder);
  publishProfile(folder);
  if (!old) publishRooms(roomHost, folder);
  finishRevive(host, marks.revive, (botId) => v2?.rebuild(botId));
  for (const bot of store.bots) if (settings.botMap[bot.id]) syncBotMemory(folder, settings.botMap[bot.id]!, workspaceDir(bot.id), ledger);
  writeDeviceRecord(folder, { deviceId: settings.deviceId, name: "Test PC", host: "test.example.ts.net", chatSync: 2 }, Date.now());
  save();
}

function chats() {
  const folder = settings.folder;
  if (!folder || !settings.syncChats) return null;
  v2 ??= createThreadSyncV2Store({
    store, dataDir, deviceId: settings.deviceId,
    folder: () => settings.folder, enabled: () => settings.syncChats,
    target: (threadId) => {
      if (store.groupByThread(threadId)) return old ? null : roomThreads.target(threadId);
      const bot = store.botByThread(threadId);
      const botSyncId = bot ? settings.botMap[bot.id] : undefined;
      return bot && botSyncId && store.taskByThread(bot.id, threadId) ? { botId: bot.id, botSyncId } : null;
    },
    bots: () => store.bots.flatMap((bot) => settings.botMap[bot.id] ? [{ botId: bot.id, botSyncId: settings.botMap[bot.id]! }] : []),
    running: () => busy,
    project: (message) => message,
    imported: (botId) => { store.followNewestTask(botId); },
    maintenance: () => {
      syncProfile(settings.folder!);
      pruneSyncedPictures(settings.folder!, dataDir);
    },
    // an old build has no room owners
    get rooms() { return old ? undefined : roomThreads; },
  });
  return v2;
}

function report(): ReportBot[] {
  return store.bots.map((bot) => {
    const tasks = store.tasks(bot.id).filter((task) => store.messagesFor(task.threadId).length);
    const images = tasks.flatMap((task) => store.messagesFor(task.threadId).flatMap((message) => message.image ?? []));
    const present = images.filter((name) => existsSync(join(attachments, name)) || (!!settings.folder && pullSyncedPicture(settings.folder, attachments, name)));
    const memory = join(workspaceDir(bot.id), "MEMORY.md");
    return {
      name: bot.name,
      syncId: settings.botMap[bot.id] ?? null,
      chats: tasks.map((task) => `${task.title}:${store.messagesFor(task.threadId).length}`).sort(),
      rows: tasks.map((task) => `${task.title}:${createHash("sha256").update(JSON.stringify(store.messagesFor(task.threadId).map(({ role, kind, text, image }) => ({ role, kind, text, image })))).digest("hex")}`).sort(),
      memory: existsSync(memory) ? readFileSync(memory, "utf8") : null,
      pictures: `${present.length}/${images.length}`,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function fileCount(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).reduce((n, entry) => n + (entry.isDirectory() ? fileCount(join(dir, entry.name)) : 1), 0);
}

function place(bot: BotRecord, dir: string): PlaceBot {
  const tasks = (bot.tasks ?? []).filter((task) => store.messagesFor(task.threadId).length);
  const memory = join(dir, "MEMORY.md");
  return {
    id: bot.id, syncId: settings.botMap[bot.id] ?? null, name: bot.name,
    chats: tasks.map((task) => `${task.title}:${store.messagesFor(task.threadId).length}`).sort(),
    memory: existsSync(memory) ? readFileSync(memory, "utf8") : null, files: fileCount(dir),
  };
}

function places(): Places {
  const byName = (a: PlaceBot, b: PlaceBot) => a.name.localeCompare(b.name);
  return {
    bots: store.bots.map((bot) => place(bot, workspaceDir(bot.id))).sort(byName),
    trash: store.trash.entries.map((entry) => {
      const dir = existsSync(trashedWorkspaceDir(entry.record.id)) ? trashedWorkspaceDir(entry.record.id) : workspaceDir(entry.record.id);
      return { ...place(entry.record, dir), syncId: entry.syncId ?? null, daysLeft: trashDaysLeft(entry.arrivedAt, now()) };
    }).sort(byName),
  };
}

function rooms(): PlaceRoom[] {
  const name = (id: string) => store.bot(id)?.name ?? id;
  return store.groups.map((group) => ({
    id: group.id, threadId: group.threadId, name: group.name, members: group.memberIds.map(name).sort(), dm: Boolean(group.dm),
    setup: group.setupCompletedAt != null || group.setupSkippedAt != null,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function roomChat(name: string): RoomChat {
  const group = room(name);
  const threads = group.dm ? [{ threadId: group.threadId, title: "" }] : group.tasks!;
  return {
    active: threads.find((task) => task.threadId === group.threadId)!.title,
    busy: Boolean(group.busyBotId),
    threads: threads.map((task) => ({
      id: task.threadId, title: task.title,
      rows: store.messagesFor(task.threadId).map(({ id, role, text, from, parentId }) => ({ id, role, text, from: from?.botId, parentId })),
    })),
    written: [...written].filter((id) => threads.some((task) => store.messagesFor(task.threadId).some((message) => message.id === id))),
  };
}

const roomThreadIds = (group: { threadId: string; tasks?: Array<{ threadId: string }> }) => new Set([group.threadId, ...(group.tasks ?? []).map((task) => task.threadId)]);
const live = (name: string) => store.bots.find((bot) => bot.name === name)!;
const room = (name: string) => store.groups.find((group) => group.name === name)!;
const trashed = (name: string) => store.trash.entries.find((entry) => entry.record.name === name)!;

async function run(method: string, args: TestArgs): Promise<TestResult> {
  // The test's Google activate edits profile-sync.json between calls, as index.ts does in-process.
  settings = loadProfileSyncSettings(dataDir);
  switch (method) {
    case "seed":
      for (const spec of args.bots ?? []) {
        const bot = store.createBot({ name: spec.name }, { seedMessages: false });
        for (const chat of spec.chats ?? []) writeChat(bot.id, chat, Date.now() - 40 * DAY);
        if (spec.memory) {
          mkdirSync(workspaceDir(bot.id), { recursive: true });
          writeFileSync(join(workspaceDir(bot.id), "MEMORY.md"), spec.memory);
        }
      }
      return;
    case "chat":
      writeChat(store.bots.find((bot) => bot.name === args.bot)!.id, args.chat!, Date.now());
      return;
    case "rename":
      store.patchBot(store.bots.find((bot) => bot.name === args.bot)!.id, { name: args.to! });
      return;
    case "memory": {
      const bot = store.bots.find((bot) => bot.name === args.bot)!;
      mkdirSync(workspaceDir(bot.id), { recursive: true });
      writeFileSync(join(workspaceDir(bot.id), "MEMORY.md"), args.text!);
      return;
    }
    case "append": {
      const bot = store.bots.find((bot) => bot.name === args.bot)!;
      const task = store.tasks(bot.id).find((task) => task.title === args.chat!.title)!;
      for (let i = 0; i < args.chat!.rows; i++) store.appendMessage(task.threadId, { role: "user", kind: "text", text: `during upload ${i}`, at: Date.now() + i });
      return;
    }
    case "folder":
      // First folder sync, or DELETE (Disconnect). Does not clear a bot map.
      if (args.folder) {
        mkdirSync(args.folder, { recursive: true });
        settings.workspaceId = loadOrCreateSyncWorkspace(args.folder, settings.workspaceId);
        settings.folder = args.folder;
        settings.syncChats = true;
      } else settings.folder = null;
      save();
      return;
    case "putFolder": {
      // index.ts PUT /api/profile-sync. A workspace change clears the bot map, then start() runs before maintenance mints ids.
      mkdirSync(args.folder!, { recursive: true });
      const workspaceId = loadOrCreateSyncWorkspace(args.folder!, settings.workspaceId);
      if (workspaceId !== settings.workspaceId) {
        settings = { ...settings, workspaceId, botMap: {}, sectionMap: {}, reviewedResolutions: {}, seenCheckpoint: "", syncedHashes: {} };
      } else if (settings.folder !== args.folder) {
        settings = { ...settings, reviewedResolutions: {}, seenCheckpoint: "" };
      }
      settings.folder = args.folder!;
      save();
      const sync = settings.syncChats ? chats() : null;
      sync?.start();
      if (sync) {
        await sync.poll();
        while (sync.republishing()) await new Promise((done) => setTimeout(done, 5));
      }
      return;
    }
    case "republish":
      // index.ts activate mints bot sync ids, then republishes chats under them.
      if (settings.folder && settings.syncChats) syncProfile(settings.folder);
      chats()?.republish();
      return chats()?.republishing() ?? false;
    case "start":
      chats()?.start();
      return chats()?.republishing() ?? false;
    case "pass": {
      // One app pass: the v2 poll runs the profile and memory maintenance, then every thread flushes.
      const sync = chats();
      if (!sync) return;
      await sync.poll();
      for (const bot of store.bots) for (const task of store.tasks(bot.id)) await sync.flush(task.threadId);
      for (const threadId of [...store.groups.flatMap((group) => [...roomThreadIds(group)]), ...deleted]) await sync.flush(threadId);
      while (sync.republishing()) await new Promise((done) => setTimeout(done, 5));
      await sync.poll();
      return;
    }
    case "pull":
      await chats()?.pull(args.thread!);
      return;
    case "busy":
      busy = args.busy!;
      return;
    case "report":
      return report();
    case "places":
      return places();
    case "trash":
      trashActions.trash(live(args.bot!).id);
      return;
    case "restore":
      trashActions.restore(trashed(args.bot!).record.id);
      return;
    case "empty":
      trashActions.emptyNow([trashed(args.bot!).record.id]);
      return;
    case "timer":
      trashActions.emptyExpired();
      return;
    case "oldDelete": {
      // Delete on a build before the trash
      const bot = live(args.bot!);
      const syncId = settings.botMap[bot.id];
      store.deleteBot(bot.id);
      if (syncId) settings.pendingBotDeletes.push(syncId);
      save();
      return;
    }
    case "clock":
      skew = args.skew!;
      return;
    case "room":
      // index.ts group routes: a create publishes on the next pass, an edit or delete is heard before it lands
      store.createGroup(args.room!, (args.members ?? []).map((name) => live(name).id), args.dm === true);
      return;
    case "roomEdit": {
      const patch = { ...(args.to ? { name: args.to } : {}), ...(args.members ? { memberIds: args.members.map((name) => live(name).id) } : {}) };
      roomEdited(roomHost, room(args.room!), patch);
      store.patchGroup(room(args.room!).id, patch);
      return;
    }
    case "roomDelete":
      for (const threadId of roomThreadIds(room(args.room!))) deleted.add(threadId);
      roomRemoved(roomHost, room(args.room!));
      store.deleteGroup(room(args.room!).id);
      return;
    case "rooms":
      return rooms();
    case "roomSay": {
      // `bot` is a member's name, or any other id to send as a bot this PC lacks
      const group = room(args.room!);
      const threadId = args.title ? group.tasks!.find((task) => task.title === args.title)!.threadId : group.threadId;
      const bot = args.bot ? store.bots.find((candidate) => candidate.name === args.bot) : undefined;
      const from = args.bot ? { botId: bot?.id ?? args.bot, name: args.bot, color: "#3366ff" } : undefined;
      if (from) store.appendMessage(threadId, { role: "bot", kind: "text", text: args.text!, from });
      else store.appendMessage(threadId, { role: "user", kind: "text", text: args.text! });
      return;
    }
    case "roomTask":
      store.createGroupTask(room(args.room!).id, args.title);
      return;
    case "roomChat":
      return roomChat(args.room!);
    case "threadRows":
      return store.messagesFor(args.thread!).length;
    case "botIds":
      return Object.fromEntries(store.bots.map((bot) => [bot.name, bot.id]));
    case "rebuild":
      v2?.rebuild(live(args.bot!).id);
      return;
    case "old":
      old = args.old!;
      return;
    case "close":
      await v2?.close();
      closeMessageDb();
      return;
    default:
      throw new Error(`unknown method ${method}`);
  }
}

let queue = Promise.resolve();
parentPort!.on("message", ({ id, method, args = {} }: { id: number; method: string; args: TestArgs }) => {
  queue = queue.then(async () => {
    try {
      parentPort!.postMessage({ id, value: await run(method, args) });
    } catch (error) {
      parentPort!.postMessage({ id, error: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
  });
});
