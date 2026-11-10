import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BotTrash } from "./bot-trash.ts";
import { importTrashMarks, publishTrashMarks, restoreBot, trashBot, trashSyncAction, type TrashSyncHost } from "./bot-trash-sync.ts";
import { DATA_DIR } from "./config.ts";
import {
  applySyncOperations, createSyncOperation, emptyProfileSyncState, loadProfileSyncSettings, ownOpSyncChanges, parseSyncOperationText,
  planProfileImport, readSyncOperations, syncOperationFileName, writeSyncOperation, type ProfileSyncOperation,
} from "./profile-sync.ts";
import { RoutineManager } from "./routines.ts";
import { Store } from "./store.ts";

const OLD_ENDINGS = /\.(?:json|notes|paths|pin|style)$/;
let folder: string;
let clock: number;
let sequence: number;

function open() {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const routines = new RoutineManager({
    file: join(DATA_DIR, "routines.json"), botState: (botId) => (store.bot(botId) ? "ready" : "missing"),
    createTask: () => null, startTurn: async () => {}, startChatTurn: async () => {},
  });
  const settings = { ...loadProfileSyncSettings(DATA_DIR), deviceId: "device-here" };
  const host: TrashSyncHost = { dataDir: DATA_DIR, store, trash: new BotTrash(store, routines, () => clock), settings: () => settings, now: () => clock };
  const bot = store.createBot({ name: "Atlas" }, { seedMessages: false });
  settings.botMap[bot.id] = "sync-atlas";
  return { store, settings, host, bot };
}

function op(input: Partial<ProfileSyncOperation> & Pick<ProfileSyncOperation, "recordedAt">): ProfileSyncOperation {
  return createSyncOperation({ operationId: randomUUID(), deviceId: "device-other", sequence: ++sequence, entity: "bot", entityId: "sync-atlas", ...input });
}

const state = (...ops: ProfileSyncOperation[]) => applySyncOperations(emptyProfileSyncState(), ops);

function oldReader() {
  const dir = join(folder, "changes");
  return state(...readdirSync(dir).filter((name) => OLD_ENDINGS.test(name)).map((name) => parseSyncOperationText(readFileSync(join(dir, name), "utf8"))));
}

function plan(input: Partial<Parameters<typeof planProfileImport>[0]> & Pick<Parameters<typeof planProfileImport>[0], "state">) {
  return planProfileImport({ deviceId: "device-here", workspaceId: "workspace", synced: {}, botMap: {}, local: [], localOrder: {}, ...input });
}

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  folder = mkdtempSync(join(tmpdir(), "omb-trash-sync-"));
  clock = 1_800_000_000_000;
  sequence = 0;
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("trash sync table", () => {
  it.each([
    ["trashed", "live", "trash"],
    ["trashed", "trashed", "none"],
    ["trashed", "emptied", "none"],
    ["trashed", "absent", "none"],
    ["restored", "live", "none"],
    ["restored", "trashed", "restore"],
    ["restored", "emptied", "revive"],
    ["restored", "absent", "create"],
    ["deleted", "live", "erase"],
    ["deleted", "trashed", "erase"],
    ["deleted", "emptied", "forget"],
    ["deleted", "absent", "none"],
  ] as const)("folder %s, bot %s here: %s", (mark, here, action) => {
    expect(trashSyncAction(mark, here)).toBe(action);
  });

  it("never lets older folder news overrule a tap not sent yet", () => {
    expect(trashSyncAction("restored", "trashed", true)).toBe("none");
    expect(trashSyncAction("trashed", "live", true)).toBe("none");
    expect(trashSyncAction("deleted", "trashed", true)).toBe("erase");
  });
});

describe("trash marks", () => {
  it("times a mark at the tap, after the newest mark this PC has seen", () => {
    const { store, host, bot } = open();
    const trashed = op({ recordedAt: clock + 5_000, changes: { trashed: true } });
    importTrashMarks(host, state(trashed));
    expect(store.trash.entry(bot.id)).toMatchObject({ deletedAt: clock + 5_000, told: true });
    restoreBot(host, bot.id);
    expect(publishTrashMarks(host, folder)).toBe(1);
    const sent = readSyncOperations(folder).operations;
    expect(sent).toMatchObject([{ changes: { trashed: false }, recordedAt: clock + 5_001, deviceId: "device-here" }]);
    expect(state(trashed, ...sent).bots["sync-atlas"].trashed).toBe(false);
  });

  it("keeps the tap time however late the mark is sent", () => {
    const { host, bot } = open();
    trashBot(host, bot.id);
    const tapped = clock;
    clock += 4 * 24 * 3_600_000;
    publishTrashMarks(host, folder);
    expect(readSyncOperations(folder).operations).toMatchObject([{ changes: { trashed: true }, recordedAt: tapped }]);
    expect(publishTrashMarks(host, folder)).toBe(0);
  });

  it("writes a mark only in its own .trash change, which a reader on the old endings never opens", () => {
    const { host, bot } = open();
    writeSyncOperation(folder, op({ recordedAt: clock - 1, deviceId: "device-here", changes: { name: "Atlas" } }));
    trashBot(host, bot.id);
    publishTrashMarks(host, folder);
    const files = readdirSync(join(folder, "changes"));
    expect(files.filter((name) => name.endsWith(".trash"))).toHaveLength(1);
    for (const name of files.filter((file) => file.endsWith(".json"))) expect(readFileSync(join(folder, "changes", name), "utf8")).not.toContain("trashed");
    const split = ownOpSyncChanges({ entity: "bot", entityId: "sync-atlas", changes: { name: "Atlas", trashed: true } });
    expect(split.map((item) => syncOperationFileName(op({ recordedAt: clock, changes: item.changes })).split(".").at(-1))).toEqual(["json", "trash"]);
    expect(oldReader().bots["sync-atlas"]).toEqual({ id: "sync-atlas", name: "Atlas" });
    writeSyncOperation(folder, op({ recordedAt: clock + 10, deviceId: "device-here", deleted: true }));
    expect(oldReader().bots["sync-atlas"]).toBeUndefined();
  });

  it("sends nothing for trashed bots after a sync Move", () => {
    const { settings, host, bot } = open();
    trashBot(host, bot.id);
    settings.botMap = {};
    expect(publishTrashMarks(host, folder)).toBe(0);
    restoreBot(host, bot.id);
    expect(publishTrashMarks(host, folder)).toBe(0);
    expect(readSyncOperations(folder).operations).toEqual([]);
  });
});

describe("coming back by itself", () => {
  const remote = (trashed: boolean) => state(op({ recordedAt: 1, changes: { name: "Atlas" } }), op({ recordedAt: 2, changes: { trashed } }));

  it("does not re-create a trashed bot when bots.json is missing", () => {
    const botMap = { "local-atlas": "sync-atlas" };
    expect(plan({ state: remote(true), botMap, restore: true }).bots).toEqual([]);
    expect(plan({ state: remote(false), botMap, restore: true, trashed: ["sync-atlas"] }).bots).toEqual([]);
    expect(plan({ state: remote(false), botMap, restore: true }).bots).toMatchObject([{ globalId: "sync-atlas", localId: "local-atlas" }]);
  });

  it("keeps a delete when a PC that never touched the mark edits the bot", () => {
    const after = state(op({ recordedAt: 1, changes: { name: "Atlas" } }), op({ recordedAt: 2, changes: { trashed: true } }),
      op({ recordedAt: 3, deviceId: "device-third", changes: { name: "Atlas 2" } }));
    expect(after.bots["sync-atlas"]).toEqual({ id: "sync-atlas", name: "Atlas 2", trashed: true });
    expect(plan({ state: after, botMap: { "local-atlas": "sync-atlas" } }).bots).toEqual([]);
  });

  it("does not create a bot marked in the trash on a PC joining", () => {
    expect(plan({ state: remote(true) }).bots).toEqual([]);
    expect(plan({ state: remote(false) }).bots).toMatchObject([{ globalId: "sync-atlas", localId: null }]);
  });
});
