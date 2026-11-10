import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotTrash, TRASH_FILE, trashedWorkspaceDir, WORKSPACES_TRASH_DIR } from "./bot-trash.ts";
import { DATA_DIR, EVENTS_DIR, NATIVE_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { scanThreadRows } from "./message-db.ts";
import { RoutineManager } from "./routines.ts";
import { Store, type BotRecord } from "./store.ts";
import type { TaskResumePacket } from "./task-state.ts";
import { ensureWorkspace, workspaceDir } from "./workspace.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const BOTS_FILE = join(DATA_DIR, "bots.json");
const DAY = 24 * 60 * 60_000;

let project: string;

function open(now: () => number = Date.now) {
  const store = new Store(selection);
  const routines = new RoutineManager({
    file: join(DATA_DIR, "routines.json"),
    botState: (botId) => (store.bot(botId) ? "ready" : "missing"),
    createTask: () => null,
    startTurn: async () => {},
    startChatTurn: async () => {},
  });
  return { store, routines, trash: new BotTrash(store, routines, now) };
}

function stockedBot(store: Store, name = "Atlas"): BotRecord {
  const bot = store.createBot({ name }, { seedMessages: false });
  const second = store.createTask(bot.id, "Second")!;
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hello atlas" });
  store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "hello back" });
  store.appendMessage(second.threadId, { role: "user", kind: "text", text: "second task" });
  store.setResumeCursor(bot.id, "claude", "session-1", bot.threadId);
  const dir = ensureWorkspace(bot.id);
  writeFileSync(join(dir, "MEMORY.md"), "# Memory\nlikes tea\n");
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(8 * 1024 * 1024, 7));
  mkdirSync(join(dir, "apps", "web"), { recursive: true });
  symlinkSync(project, join(dir, "project"), "junction");
  symlinkSync(project, join(dir, "apps", "web", "node_modules"), "junction");
  return store.bot(bot.id)!;
}

const threadsOf = (bot: BotRecord) => [...new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)])];
const chatRows = (bot: BotRecord) => threadsOf(bot).reduce((n, id) => n + scanThreadRows(id, 0, 1024).messages.length, 0);
const entries = (dir: string): number =>
  readdirSync(dir).reduce((n, name) => {
    const stat = lstatSync(join(dir, name));
    return n + 1 + (stat.isDirectory() && !stat.isSymbolicLink() ? entries(join(dir, name)) : 0);
  }, 0);
const onDisk = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const projectUntouched = () => expect(readFileSync(join(project, "src", "main.ts"), "utf8")).toBe("export const answer = 42;");

/** Live bots plus trash entries naming `id`, in memory and on disk. */
function places(store: Store, id: string) {
  const live = store.bots.filter((bot) => bot.id === id).length;
  const trashed = store.trash.entries.filter((entry) => entry.record.id === id).length;
  const disk =
    (onDisk(BOTS_FILE) as BotRecord[]).filter((bot) => bot.id === id).length +
    (existsSync(TRASH_FILE) ? (onDisk(TRASH_FILE).bots as Array<{ record: BotRecord }>).filter((entry) => entry.record.id === id).length : 0);
  return { live, trashed, total: live + trashed, disk };
}

function packet(botId: string, threadId: string): TaskResumePacket {
  return {
    v: 1,
    threadId,
    botId,
    goal: "Prepare the weekly report",
    plan: [{ step: "Write the draft", status: "active" }],
    completed: [],
    evidence: [],
    artifacts: [],
    blockers: [],
    nextAction: "Write the draft",
    updatedAt: 100,
    updatedBy: "harness",
    flushReason: "progress",
    turnsAtWrite: 0,
  };
}

function editTrashFile(edit: (file: { bots: Array<Record<string, unknown>> }) => void) {
  const file = onDisk(TRASH_FILE);
  edit(file);
  writeFileSync(TRASH_FILE, JSON.stringify(file));
}

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  project = mkdtempSync(join(tmpdir(), "omb-trash-project-"));
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "src", "main.ts"), "export const answer = 42;");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(project, { recursive: true, force: true });
});

describe("bot trash", () => {
  it("moves the record and the folder and leaves the chats", () => {
    const { store, trash } = open();
    const bot = stockedBot(store);
    const record = plain(bot);
    const rows = chatRows(bot);
    const files = entries(workspaceDir(bot.id));
    const big = statSync(join(workspaceDir(bot.id), "big.bin"), { bigint: true }).ino;

    trash.trash(bot.id);

    expect((onDisk(BOTS_FILE) as BotRecord[]).map((saved) => saved.id)).not.toContain(bot.id);
    expect(onDisk(TRASH_FILE).bots).toMatchObject([{ record, step: "trashed" }]);
    expect(chatRows(record)).toBe(rows);
    expect(existsSync(workspaceDir(bot.id))).toBe(false);
    const moved = trashedWorkspaceDir(bot.id);
    expect(moved).toBe(join(WORKSPACES_TRASH_DIR, bot.id));
    expect(entries(moved)).toBe(files);
    expect(lstatSync(join(moved, "project")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(moved, "apps", "web", "node_modules")).isSymbolicLink()).toBe(true);
    expect(statSync(join(moved, "big.bin"), { bigint: true }).ino).toBe(big);
    projectUntouched();
  });

  it("restores the same bot to its rooms and routines", () => {
    const { store, routines, trash } = open();
    const bot = stockedBot(store);
    const other = store.createBot({ name: "Nova" }, { seedMessages: false });
    const kept = store.createGroup("Kept", [bot.id, other.id]);
    const gone = store.createGroup("Gone", [bot.id, other.id]);
    const at = Date.now() + DAY;
    const on = routines.create({ name: "On", prompt: "p", botId: bot.id, schedule: { type: "once", at } });
    const off = routines.create({ name: "Off", prompt: "p", botId: bot.id, enabled: false, schedule: { type: "once", at } });
    const others = routines.create({ name: "Others", prompt: "p", botId: other.id, schedule: { type: "once", at } });
    store.writeTaskPacket(packet(bot.id, bot.threadId));
    const record = plain(store.bot(bot.id)!);
    const rows = chatRows(bot);

    trash.trash(bot.id);
    expect(store.group(kept.id)!.memberIds).toEqual([other.id]);
    expect(routines.listRoutines().find((routine) => routine.id === on.id)!.enabled).toBe(false);
    expect(store.taskPacket(bot.threadId)).toBeNull();
    store.deleteGroup(gone.id);
    const othersBefore = plain(routines.listRoutines().find((routine) => routine.id === others.id));

    const restored = trash.restore(bot.id);

    expect(plain(restored)).toEqual(record);
    expect(plain(store.bot(bot.id))).toEqual(record);
    expect(store.trash.entries).toEqual([]);
    expect(onDisk(TRASH_FILE).bots).toEqual([]);
    expect(chatRows(restored)).toBe(rows);
    expect(store.group(kept.id)!.memberIds).toEqual([other.id, bot.id]);
    expect(store.group(gone.id)).toBeUndefined();
    const after = routines.listRoutines();
    expect(after.find((routine) => routine.id === on.id)!.enabled).toBe(true);
    expect(after.find((routine) => routine.id === off.id)!.enabled).toBe(false);
    expect(plain(after.find((routine) => routine.id === others.id))).toEqual(othersBefore);
    expect(store.taskPacket(bot.threadId)).toMatchObject({ goal: "Prepare the weekly report" });
    expect(readFileSync(join(workspaceDir(bot.id), "MEMORY.md"), "utf8")).toContain("likes tea");
    expect(existsSync(trashedWorkspaceDir(bot.id))).toBe(false);
    projectUntouched();
  });

  it("demotes a restored Chief of Staff when the section has another", () => {
    const { store, trash } = open();
    const first = store.createBot({ name: "First", section: "Ops" }, { seedMessages: false });
    store.setChiefOfStaff(first.id);
    trash.trash(first.id);
    const second = store.createBot({ name: "Second", section: "Ops" }, { seedMessages: false });
    store.setChiefOfStaff(second.id);

    expect(trash.restore(first.id).chiefOfStaff).toBe(false);
    expect(store.bot(second.id)!.chiefOfStaff).toBe(true);
  });

  it("keeps a trashed bot's session files when the bot list saves", () => {
    const { store, trash } = open();
    const bot = stockedBot(store);
    store.recordSessionSystem("claude", "session-1", "system text");
    trash.trash(bot.id);

    store.createBot({ name: "Later" }, { seedMessages: false });
    expect(open().store.sessionSystem("claude", "session-1")).toBe("system text");
    expect(store.sessionSystem("claude", "session-1")).toBe("system text");
  });

  describe("start after a crash", () => {
    it("takes a trashed bot still in bots.json out of it", () => {
      const first = open();
      const bot = stockedBot(first.store);
      const before = readFileSync(BOTS_FILE, "utf8");
      first.trash.trash(bot.id);
      writeFileSync(BOTS_FILE, before);

      const { store, trash } = open();
      trash.start();

      expect(places(store, bot.id)).toEqual({ live: 0, trashed: 1, total: 1, disk: 1 });
      expect(existsSync(trashedWorkspaceDir(bot.id))).toBe(true);
    });

    it("moves a trashed bot's folder left in workspaces", () => {
      const first = open();
      const bot = stockedBot(first.store);
      first.trash.trash(bot.id);
      renameSync(trashedWorkspaceDir(bot.id), workspaceDir(bot.id));

      const { store, trash } = open();
      trash.start();

      expect(places(store, bot.id)).toEqual({ live: 0, trashed: 1, total: 1, disk: 1 });
      expect(existsSync(workspaceDir(bot.id))).toBe(false);
      expect(lstatSync(join(trashedWorkspaceDir(bot.id), "project")).isSymbolicLink()).toBe(true);
    });

    it("finishes a restore", () => {
      const first = open();
      const bot = stockedBot(first.store);
      const record = plain(bot);
      first.trash.trash(bot.id);
      editTrashFile((file) => (file.bots[0]!.step = "restoring"));

      const { store, trash } = open();
      trash.start();

      expect(places(store, bot.id)).toEqual({ live: 1, trashed: 0, total: 1, disk: 1 });
      expect(plain(store.bot(bot.id))).toEqual(record);
      expect(existsSync(join(workspaceDir(bot.id), "MEMORY.md"))).toBe(true);
    });

    it("finishes a restore that already saved bots.json", () => {
      const first = open();
      const bot = stockedBot(first.store);
      const before = readFileSync(BOTS_FILE, "utf8");
      first.trash.trash(bot.id);
      editTrashFile((file) => (file.bots[0]!.step = "restoring"));
      writeFileSync(BOTS_FILE, before);

      const { store, trash } = open();
      trash.start();

      expect(places(store, bot.id)).toEqual({ live: 1, trashed: 0, total: 1, disk: 1 });
    });

    it("finishes an empty", () => {
      const first = open();
      const bot = stockedBot(first.store);
      first.trash.trash(bot.id);
      editTrashFile((file) => Object.assign(file.bots[0]!, { step: "emptying", tellOthers: false }));

      const { store, trash } = open();
      trash.start();

      expect(places(store, bot.id)).toEqual({ live: 0, trashed: 0, total: 0, disk: 0 });
      expect(chatRows(bot)).toBe(0);
      expect(existsSync(trashedWorkspaceDir(bot.id))).toBe(false);
      projectUntouched();
    });

    it("leaves a trash folder no entry names", () => {
      const orphan = join(WORKSPACES_TRASH_DIR, "unknown-bot");
      mkdirSync(orphan, { recursive: true });
      writeFileSync(join(orphan, "notes.md"), "keep me");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      open().trash.start();

      expect(readFileSync(join(orphan, "notes.md"), "utf8")).toBe("keep me");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown-bot"));
    });
  });

  it.skipIf(process.platform !== "win32")("trashes with a file open and refuses a restore that cannot move the folder", () => {
    const first = open();
    const bot = stockedBot(first.store);
    let held = openSync(join(workspaceDir(bot.id), "MEMORY.md"), "r");
    try {
      first.trash.trash(bot.id);
      expect(first.store.bot(bot.id)).toBeNull();
      expect(first.store.trash.entries.map((entry) => entry.record.id)).toEqual([bot.id]);
      expect(existsSync(workspaceDir(bot.id))).toBe(true);
    } finally {
      closeSync(held);
    }

    const { store, trash } = open();
    trash.start();
    expect(existsSync(workspaceDir(bot.id))).toBe(false);
    expect(existsSync(trashedWorkspaceDir(bot.id))).toBe(true);

    held = openSync(join(trashedWorkspaceDir(bot.id), "MEMORY.md"), "r");
    try {
      expect(() => trash.restore(bot.id)).toThrow("Could not restore Atlas. A file in its folder is open in another app. Close it and try again.");
      expect(places(store, bot.id)).toEqual({ live: 0, trashed: 1, total: 1, disk: 1 });
      expect(store.trash.entries[0]!.step).toBe("trashed");
    } finally {
      closeSync(held);
    }
    expect(trash.restore(bot.id).id).toBe(bot.id);
  });

  it("empties and tells the other PCs", () => {
    const { store, trash } = open();
    const bot = stockedBot(store);
    for (const threadId of threadsOf(bot)) {
      mkdirSync(EVENTS_DIR, { recursive: true });
      mkdirSync(NATIVE_DIR, { recursive: true });
      writeFileSync(join(EVENTS_DIR, `${threadId}.ndjson`), "{}\n");
      writeFileSync(join(NATIVE_DIR, `${threadId}.ndjson`), "{}\n");
    }
    trash.trash(bot.id, { syncId: "global-1" });
    const deletes: string[] = [];
    store.setSyncWriter((threadId, mutations, write) => {
      if (mutations.some((mutation) => mutation.kind === "delete")) deletes.push(threadId);
      write();
    });

    trash.empty([bot.id], { tellOthers: true });

    expect(chatRows(bot)).toBe(0);
    expect(deletes.sort()).toEqual(threadsOf(bot).sort());
    expect(existsSync(trashedWorkspaceDir(bot.id))).toBe(false);
    expect(existsSync(workspaceDir(bot.id))).toBe(false);
    for (const threadId of threadsOf(bot)) {
      expect(existsSync(join(EVENTS_DIR, `${threadId}.ndjson`))).toBe(false);
      expect(existsSync(join(NATIVE_DIR, `${threadId}.ndjson`))).toBe(false);
    }
    expect(store.trash.entries).toEqual([]);
    expect(onDisk(TRASH_FILE)).toMatchObject({ bots: [], emptied: [] });
    projectUntouched();
  });

  it("empties on this PC only and keeps a note of the ids", () => {
    const now = 1_800_000_000_000;
    const { store, trash } = open(() => now);
    const bot = stockedBot(store);
    trash.trash(bot.id, { syncId: "global-1" });
    const deletes: string[] = [];
    store.setSyncWriter((threadId, mutations, write) => {
      if (mutations.some((mutation) => mutation.kind === "delete")) deletes.push(threadId);
      write();
    });

    trash.empty([bot.id], { tellOthers: false });

    expect(chatRows(bot)).toBe(0);
    expect(deletes).toEqual([]);
    expect(existsSync(trashedWorkspaceDir(bot.id))).toBe(false);
    expect(store.trash.entries).toEqual([]);
    const note = { botId: bot.id, syncId: "global-1", threadIds: threadsOf(bot), emptiedAt: now };
    expect(store.trash.emptied).toEqual([note]);
    expect(onDisk(TRASH_FILE).emptied).toEqual([note]);
    projectUntouched();
  });

  it("sets aside a trash list that will not load and never empties from it", () => {
    mkdirSync(WORKSPACES_TRASH_DIR, { recursive: true });
    const folder = join(WORKSPACES_TRASH_DIR, "lost-bot");
    mkdirSync(folder);
    writeFileSync(join(folder, "MEMORY.md"), "lost notes");
    writeFileSync(TRASH_FILE, '{"version": 1, "bots": [{"record"');
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { store, trash } = open();
    trash.start();
    trash.empty(["lost-bot"], { tellOthers: false });

    expect(store.trash.entries).toEqual([]);
    expect(readFileSync(join(folder, "MEMORY.md"), "utf8")).toBe("lost notes");
    const bot = store.createBot({ name: "Next" }, { seedMessages: false });
    trash.trash(bot.id);
    const kept = readdirSync(DATA_DIR).filter((name) => /^bot-trash\.bad-\d+\.json$/.test(name));
    expect(kept.map((name) => readFileSync(join(DATA_DIR, name), "utf8"))).toEqual(['{"version": 1, "bots": [{"record"']);
    expect(onDisk(TRASH_FILE).bots).toHaveLength(1);
    expect(readFileSync(join(folder, "MEMORY.md"), "utf8")).toBe("lost notes");
  });

  it("refuses to trash or restore while bots.json is unreadable", () => {
    const first = open();
    const kept = first.store.createBot({ name: "Kept" }, { seedMessages: false });
    const live = first.store.createBot({ name: "Live" }, { seedMessages: false });
    first.trash.trash(kept.id);
    writeFileSync(BOTS_FILE, '[{"id": "bot-1"');

    const { store, trash } = open();
    trash.start();

    expect(() => trash.trash(live.id)).toThrow("bots.json did not load");
    expect(() => trash.restore(kept.id)).toThrow("bots.json did not load");
    expect(store.trash.entries.map((entry) => entry.record.id)).toEqual([kept.id]);
    expect(readFileSync(BOTS_FILE, "utf8")).toBe('[{"id": "bot-1"');
  });

  it("resets an arrival time in the future to now", () => {
    const now = 1_800_000_000_000;
    const first = open(() => now);
    const bot = first.store.createBot({ name: "Atlas" }, { seedMessages: false });
    first.trash.trash(bot.id);
    editTrashFile((file) => (file.bots[0]!.arrivedAt = now + 10 * DAY));

    const { store, trash } = open(() => now);
    trash.start();

    expect(store.trash.entries[0]!.arrivedAt).toBe(now);
    expect(onDisk(TRASH_FILE).bots[0].arrivedAt).toBe(now);
  });
});
