import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

import { closeMessageDb } from "../message-db.ts";
import { writeDeviceRecord } from "../device-sync.ts";
import {
  applySyncOperations, bindSyncId, createSyncOperation, emptyProfileSyncState, loadOrCreateSyncWorkspace, loadProfileSyncSettings,
  markImported, markSynced, planProfileImport, readSyncOperations, saveProfileSyncSettings, unsyncedChanges, writeSyncOperation,
} from "../profile-sync.ts";
import { createMemoryClean, mergeParkedCopy, recordTypedLines, typedHashes, type TextCall } from "../memory-clean.ts";
import { ensureMemorySyncDevice, loadMemorySyncLedger, markTalked, saveMemorySyncLedger, syncBotMemory } from "../memory-sync.ts";
import { pullSyncedPicture, pruneSyncedPictures } from "../picture-sync.ts";
import { Store } from "../store.ts";
import { ensureSyncV2Identity } from "../thread-sync-v2-engine.ts";
import { createThreadSyncV2Store } from "../thread-sync-v2-store.ts";
import { workspaceDir } from "../workspace.ts";

export interface ChatSpec { title: string; rows: number; pictureAges?: number[] }
export interface BotSpec { name: string; memory?: string; chats?: ChatSpec[] }
export interface ReportBot { name: string; syncId: string | null; chats: string[]; rows: string[]; memory: string | null; pictures: string }
export interface TestArgs {
  bots?: BotSpec[]; bot?: string; to?: string; text?: string; chat?: ChatSpec; folder?: string | null; thread?: string; busy?: boolean;
  typed?: boolean; retire?: string[]; days?: number; hold?: boolean;
}
export type TestResult = ReportBot[] | boolean | string | null | undefined;

// An old build runs the same memory sync without the cleanup options and never runs a cleanup.
const { dataDir, oldBuild } = z.object({ dataDir: z.string(), oldBuild: z.boolean().optional() }).parse(workerData);
const DAY = 86_400_000;
const store = new Store(() => ({ instanceId: "test", model: "test" }));
const attachments = join(dataDir, "attachments");
const ledger = loadMemorySyncLedger(dataDir);
let settings = loadProfileSyncSettings(dataDir);
ensureSyncV2Identity(settings.deviceId);
ensureMemorySyncDevice(ledger);
save();
let v2: ReturnType<typeof createThreadSyncV2Store> = null;
let busy = false;
let skew = 0;
let retire: string[] = [];
let hold: Promise<void> | null = null;
let release = () => {};
const QUIET_MS = 11 * 60_000;
const questions = Array.from({ length: 18 }, (_, i) => ({ kind: i < 12 ? "changed" : i < 16 ? "protected" : "absent", question: `Fact ${i}?`, answer: i < 16 ? `value ${i}` : null }));
/** Retires every numbered line that equals one of the test's retire lines, and passes the recall check. */
const propose: TextCall = async (prompt) => {
  if (prompt.startsWith("[memory-clean:questions]")) return JSON.stringify(questions);
  if (prompt.startsWith("[memory-clean:grade]")) return JSON.stringify(Array(18).fill(true));
  await hold;
  const ids = [...prompt.matchAll(/^(\d+)\| (.*)$/gm)].filter(([, , line]) => retire.includes(line!)).map(([, id]) => Number(id));
  return JSON.stringify({ version: 1, file: /"file":"([^"]+)"/.exec(prompt)?.[1], changes: ids.map((id) => ({ op: "retire", id, reason: "Done" })) });
};
const recall: TextCall = async () => JSON.stringify(questions.map((q) => q.answer));
const clean = oldBuild ? null : createMemoryClean({
  store, dataDir,
  engine: async () => ({ propose, recall, key: "fake" }),
  busy: () => busy, pending: () => false, dropped: () => false,
  home: (botId) => ({ folder: settings.folder ?? undefined, botSyncId: settings.botMap[botId], device: ledger.device ?? "", talkedAt: ledger.talked?.[settings.botMap[botId] ?? ""] }),
  now: () => Date.now() + skew,
});
clean?.start();

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
function importProfile(folder: string): void {
  const state = applySyncOperations(emptyProfileSyncState(), readSyncOperations(folder).operations);
  const plan = planProfileImport({
    state, deviceId: settings.deviceId, workspaceId: settings.workspaceId, synced: settings.syncedHashes, botMap: settings.botMap,
    local: store.bots.map((bot) => ({ id: bot.id, name: bot.name, section: bot.section, hidden: bot.hidden, changes: portable(bot) })),
    localOrder: { sectionOrder: [], itemOrder: {} }, pendingBotDeletes: settings.pendingBotDeletes,
  });
  for (const item of plan.bots) {
    const remote = state.bots[item.globalId]!;
    let bot = item.localId ? store.bot(item.localId) : undefined;
    const created = !bot;
    if (!bot) bot = store.createBot({ name: String(remote.name ?? "Imported bot") }, { seedMessages: false });
    else if ("name" in item.apply) store.patchBot(bot.id, { name: String(remote.name) });
    bindSyncId(settings.botMap, bot.id, item.globalId);
    const local = portable(store.bot(bot.id)!);
    markImported(settings.syncedHashes, "bot", item.globalId, remote, item.apply, local);
    if (created) markSynced(settings.syncedHashes, { entity: "bot", entityId: item.globalId, changes: Object.fromEntries(Object.entries(local).filter(([field]) => !(field in remote))) });
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
}

function syncProfile(folder: string): void {
  importProfile(folder);
  publishProfile(folder);
  for (const bot of store.bots) if (settings.botMap[bot.id]) syncBotMemory(folder, settings.botMap[bot.id]!, workspaceDir(bot.id), ledger, oldBuild ? {} : { typed: typedHashes(bot.id), mergeParked: mergeParkedCopy });
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
      const path = join(workspaceDir(bot.id), "MEMORY.md");
      mkdirSync(workspaceDir(bot.id), { recursive: true });
      if (args.typed && !oldBuild) recordTypedLines(bot.id, existsSync(path) ? readFileSync(path, "utf8") : "", args.text!);
      writeFileSync(path, args.text!);
      return;
    }
    case "talk":
      markTalked(ledger, settings.botMap[store.bots.find((bot) => bot.name === args.bot)!.id]!);
      save();
      return;
    case "clean": {
      // A cleanup on this PC once it is quiet, the way the idle timer starts one. `hold` parks it at propose until "release".
      const bot = store.bots.find((bot) => bot.name === args.bot)!;
      if (!clean) throw new Error("old builds never run a cleanup");
      skew += (args.days ?? 0) * DAY + QUIET_MS;
      retire = args.retire ?? [];
      if (args.hold) hold = new Promise((done) => { release = done; });
      clean.check(bot.id);
      clean.tick();
      if (!args.hold) await clean.idle();
      return clean.summary(bot.id).run?.runId ?? null;
    }
    case "release": {
      release();
      hold = null;
      await clean!.idle();
      return clean!.summary(store.bots.find((bot) => bot.name === args.bot)!.id).run?.runId ?? null;
    }
    case "undo": {
      const bot = store.bots.find((bot) => bot.name === args.bot)!;
      const runId = clean!.summary(bot.id).run?.runId;
      return runId ? (await clean!.undo(bot.id, runId)).ok : false;
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
    case "close":
      clean?.dispose();
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
