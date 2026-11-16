import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { BotTrash, trashedWorkspaceDir } from "./bot-trash.ts";
import { createBotTrashActions, trashDaysLeft } from "./bot-trash-actions.ts";
import type { TrashSyncHost } from "./bot-trash-sync.ts";
import { DATA_DIR } from "./config.ts";
import { scanThreadRows } from "./message-db.ts";
import type { ProfileSyncSettings } from "./profile-sync.ts";
import { RoutineManager } from "./routines.ts";
import { Store, type BotRecord } from "./store.ts";
import { ensureWorkspace, workspaceDir } from "./workspace.ts";

const DAY = 86_400_000;

function open(opts: { syncing?: boolean } = {}) {
  let clock = 1_000 * DAY;
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const routines = new RoutineManager({
    file: join(DATA_DIR, "routines.json"),
    botState: (botId) => (store.bot(botId) ? "ready" : "missing"),
    createTask: () => null,
    startTurn: async () => {},
    startChatTurn: async () => {},
  });
  const now = () => clock;
  const trash = new BotTrash(store, routines, now);
  // SAFETY: the actions read only botMap; the rest of the settings are never touched here.
  const settings = { botMap: {}, pendingBotDeletes: [] } as unknown as ProfileSyncSettings;
  const host: TrashSyncHost = { dataDir: DATA_DIR, store, trash, settings: () => settings, now };
  const queued: string[] = [];
  let awaiting = opts.syncing === true;
  const actions = createBotTrashActions({ host: () => host, queueDeletes: (ids) => queued.push(...ids), awaitingSync: () => awaiting });
  return {
    store, settings, actions, queued,
    tick: (ms: number) => { clock += ms; },
    syncPassed: () => { awaiting = false; },
  };
}

function stocked(store: Store, name = "Atlas"): BotRecord {
  const bot = store.createBot({ name }, { seedMessages: false });
  const second = store.createTask(bot.id, "Second")!;
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hello" });
  store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "hi" });
  store.appendMessage(second.threadId, { role: "user", kind: "text", text: "second" });
  writeFileSync(join(ensureWorkspace(bot.id), "MEMORY.md"), "likes tea\n");
  return store.bot(bot.id)!;
}

const threads = (bot: BotRecord) => [bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)];
const rows = (bot: BotRecord) => threads(bot).reduce((n, id) => n + scanThreadRows(id, 0, 1024).messages.length, 0);

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("bot trash actions", () => {
  it("lists a deleted bot with its days left and restores it with every chat and its memory", () => {
    const { store, actions } = open();
    const bot = stocked(store);
    const before = { rows: rows(bot), record: JSON.parse(JSON.stringify(bot)) };

    actions.trash(bot.id);

    expect(store.bot(bot.id)).toBeFalsy();
    expect(actions.list()).toEqual([{ id: bot.id, name: "Atlas", color: bot.color, mascotStyle: bot.mascotStyle, avatarUrl: undefined, avatarCrop: undefined, daysLeft: 30 }]);
    const restored = actions.restore(bot.id);
    expect(JSON.parse(JSON.stringify(restored))).toEqual(before.record);
    expect(rows(restored)).toBe(before.rows);
    expect(readFileSync(join(workspaceDir(bot.id), "MEMORY.md"), "utf8")).toBe("likes tea\n");
    expect(actions.list()).toEqual([]);
  });

  it("Empty now erases every trashed bot and queues the permanent delete for synced ones", () => {
    const { store, settings, actions, queued } = open();
    const atlas = stocked(store);
    const nova = stocked(store, "Nova");
    settings.botMap[atlas.id] = "sync-atlas";
    actions.trash(atlas.id);
    actions.trash(nova.id);

    expect(actions.emptyNow()).toBe(2);

    expect(actions.list()).toEqual([]);
    expect(store.trash.entries).toEqual([]);
    for (const bot of [atlas, nova]) {
      expect(rows(bot)).toBe(0);
      expect(existsSync(trashedWorkspaceDir(bot.id))).toBe(false);
      expect(existsSync(workspaceDir(bot.id))).toBe(false);
    }
    expect(queued).toEqual(["sync-atlas"]);
    expect(store.trash.emptied).toEqual([]);
  });

  it("empties after 30 days on this PC only, never at 29", () => {
    const { store, actions, queued, tick } = open();
    const bot = stocked(store);
    actions.trash(bot.id);

    tick(29 * DAY);
    expect(actions.emptyExpired()).toBe(0);
    expect(actions.list()).toMatchObject([{ id: bot.id, daysLeft: 1 }]);

    tick(DAY);
    expect(actions.emptyExpired()).toBe(1);
    expect(actions.list()).toEqual([]);
    expect(rows(bot)).toBe(0);
    expect(queued).toEqual([]);
    expect(store.trash.emptied.map((note) => note.botId)).toEqual([bot.id]);
  });

  it("holds the timer until one sync pass ran, so a Restore made elsewhere wins", () => {
    const { store, actions, tick, syncPassed } = open({ syncing: true });
    const bot = stocked(store);
    actions.trash(bot.id);
    tick(31 * DAY);

    expect(actions.emptyExpired()).toBe(0);
    expect(actions.list()).toHaveLength(1);
    syncPassed();
    expect(actions.emptyExpired()).toBe(1);
  });

  it("rounds days left up and never below 1", () => {
    expect(trashDaysLeft(0, 0)).toBe(30);
    expect(trashDaysLeft(0, DAY / 2)).toBe(30);
    expect(trashDaysLeft(0, 29 * DAY + 1)).toBe(1);
    expect(trashDaysLeft(0, 40 * DAY)).toBe(1);
  });
});
