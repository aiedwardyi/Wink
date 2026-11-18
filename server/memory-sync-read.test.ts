import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import { markTalked, memorySyncDir, memorySyncUnchanged, peerMemoryLanded, readMemorySnapshots, saveMemorySyncLedgerIfChanged, syncBotMemory, type MemorySyncLedger } from "./memory-sync.ts";
import { MEMORY_SEED } from "./workspace.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), readFileSync: vi.fn(actual.readFileSync) };
});

const roots: string[] = [];

afterEach(() => {
  vi.mocked(existsSync).mockRestore();
  vi.mocked(readFileSync).mockRestore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("memory reads", () => {
  it("keeps both edits when a turn starts during the peer snapshot read", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory-turn-"));
    roots.push(root);
    const home = { folder: join(root, "home-drive"), workspace: join(root, "home"), ledger: { bots: {}, device: "aaaaaaaaaaaa" } };
    const work = { folder: join(root, "work-drive"), workspace: join(root, "work"), ledger: { bots: {}, device: "bbbbbbbbbbbb" } };
    const sync = (pc: typeof home) => syncBotMemory(pc.folder, "bot", pc.workspace, pc.ledger);
    const deliver = (from: typeof home, to: typeof work) => {
      const dir = memorySyncDir(to.folder, "bot");
      const name = `${from.ledger.device}.json`;
      mkdirSync(dir, { recursive: true });
      copyFileSync(join(memorySyncDir(from.folder, "bot"), name), join(dir, name));
    };
    for (const pc of [home, work]) mkdirSync(pc.workspace);
    const base = "- Shared note\n";
    const peerNote = "- Home learned the verdict\n";
    const turnEdit = "- Shared note\n- Work learned the date\n";
    writeFileSync(join(home.workspace, "MEMORY.md"), base);
    sync(home);
    deliver(home, work);
    sync(work);
    markTalked(home.ledger, "bot", Date.now() - 1000);
    writeFileSync(join(home.workspace, "MEMORY.md"), peerNote);
    sync(home);
    deliver(home, work);

    let busy = false;
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const reading = new Promise<void>((done) => { started = done; });
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const queue = source.slice(source.indexOf("const memorySyncs ="), source.indexOf("function noteTalked("));
    // SAFETY: The evaluated expression returns the two queue functions used by this test.
    const { syncMemory, pending } = runInNewContext(stripTypeScriptTypes(`${queue}\n({ syncMemory, pending: () => memorySyncs.get("work-bot") });`), {
      DATA_DIR: root, store: { bot: () => ({}) }, profileSyncSettings: { folder: work.folder }, chatSyncBotId: () => "bot", existsSync,
      workspaceDir: () => work.workspace, memorySyncLedger: work.ledger, legacyMemoryLedger: {}, memoryHealthCheck: { refresh: () => {} },
      botHasActiveTurn: () => busy, memorySyncUnchanged, syncBotMemory, saveMemorySyncLedgerIfChanged, savedMemoryLedger: "",
      readMemorySnapshots: async () => { started(); await held; return readMemorySnapshots(work.folder, "bot"); },
    }) as { syncMemory(botId: string): void; pending(): Promise<void> | undefined };
    peerMemoryLanded("bot", { "work-bot": "bot" }, () => busy, syncMemory);
    const inFlight = pending();
    expect(inFlight).toBeDefined();
    await reading;
    busy = true;
    const turnBase = readFileSync(join(work.workspace, "MEMORY.md"), "utf8");
    expect(turnBase).toBe(base);
    markTalked(work.ledger, "bot");
    release();
    await inFlight;
    const midTurn = readFileSync(join(work.workspace, "MEMORY.md"), "utf8");
    writeFileSync(join(work.workspace, "MEMORY.md"), turnEdit);
    busy = false;
    syncMemory("work-bot");
    await pending();
    deliver(work, home);
    sync(home);

    expect.soft(midTurn).toBe(base);
    for (const pc of [home, work]) {
      expect(readFileSync(join(pc.workspace, "MEMORY.md"), "utf8")).toBe(turnEdit);
      const dir = join(pc.workspace, "memory");
      const copies = existsSync(dir) ? readdirSync(dir).filter((file) => file.includes(".conflict-")) : [];
      expect.soft(copies.map((file) => readFileSync(join(dir, file), "utf8").split("\n").slice(1).join("\n"))).toContain(peerNote);
    }
  });

  it.each(["EACCES", "EPERM", "EIO", "ENOENT", "ENOTDIR"])("handles %s without losing the last readable snapshot", async (code) => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = mkdtempSync(join(tmpdir(), "memory-read-"));
    roots.push(root);
    const folder = join(root, "drive");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const path = join(workspace, "MEMORY.md");
    writeFileSync(path, "remember this");
    const ledger: MemorySyncLedger = { bots: {} };
    const sync = () => syncBotMemory(folder, "bot", workspace, ledger);
    sync();
    vi.mocked(existsSync).mockImplementation((file) => file === path ? false : actual.existsSync(file));
    vi.mocked(readFileSync).mockImplementation(((file, ...args) => {
      if (file === path) throw Object.assign(new Error(code), { code });
      return Reflect.apply(actual.readFileSync, actual, [file, ...args]);
    }) as typeof readFileSync);
    const absent = code === "ENOENT" || code === "ENOTDIR";
    expect(sync()["MEMORY.md"]).toBe(absent ? "pushed" : "skipped");
    const snapshot = JSON.parse(actual.readFileSync(join(memorySyncDir(folder, "bot"), `${ledger.device}.json`), "utf8"));
    expect(snapshot.files["MEMORY.md"].text).toBe(absent ? null : "remember this");
  });

  it("reads no PC's copy again while nothing changed, and pulls once one does", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-unchanged-"));
    roots.push(root);
    const folder = join(root, "drive");
    const [workspace, other] = [join(root, "workspace"), join(root, "other")];
    for (const dir of [workspace, other]) {
      mkdirSync(dir);
      writeFileSync(join(dir, "MEMORY.md"), "remember this");
    }
    const [mine, theirs]: MemorySyncLedger[] = [{ bots: {} }, { bots: {} }];
    const later = Date.now() + 5_000;
    syncBotMemory(folder, "bot", other, theirs, { host: "other", now: later });
    syncBotMemory(folder, "bot", workspace, mine, { now: later });
    vi.mocked(readFileSync).mockClear();
    syncBotMemory(folder, "bot", workspace, mine, { now: later });
    const copies = vi.mocked(readFileSync).mock.calls.filter(([file]) => String(file).startsWith(memorySyncDir(folder, "bot")));
    expect(copies).toEqual([]);
    writeFileSync(join(other, "MEMORY.md"), "remember this and that");
    syncBotMemory(folder, "bot", other, theirs, { host: "other", now: later });
    expect(syncBotMemory(folder, "bot", workspace, mine, { now: later })["MEMORY.md"]).toBe("pulled");
  });

  it("rechecks a file edited within its timestamp's resolution", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-racy-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "MEMORY.md"), "remember this");
    const ledger: MemorySyncLedger = { bots: {} };
    syncBotMemory(join(root, "drive"), "bot", workspace, ledger);
    writeFileSync(join(workspace, "MEMORY.md"), "remember that");
    expect(syncBotMemory(join(root, "drive"), "bot", workspace, ledger)["MEMORY.md"]).toBe("pushed");
  });

  it("knows a pass would change nothing without reading any snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-skip-"));
    roots.push(root);
    const folder = join(root, "drive");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "MEMORY.md"), "remember this");
    const ledger: MemorySyncLedger = { bots: {} };
    const later = Date.now() + 5_000;
    expect(memorySyncUnchanged(folder, "bot", workspace, ledger, { now: later })).toBe(false);
    syncBotMemory(folder, "bot", workspace, ledger, { now: later });
    syncBotMemory(folder, "bot", workspace, ledger, { now: later });
    vi.mocked(readFileSync).mockClear();
    expect(memorySyncUnchanged(folder, "bot", workspace, ledger, { now: later })).toBe(true);
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
    writeFileSync(join(workspace, "MEMORY.md"), "remember this, and that");
    expect(memorySyncUnchanged(folder, "bot", workspace, ledger, { now: later })).toBe(false);
  });

  it("does not record a peer's edit as seen when it landed after the snapshots were read", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory-landed-"));
    roots.push(root);
    const folder = join(root, "drive");
    const [workspace, other] = [join(root, "workspace"), join(root, "other")];
    for (const dir of [workspace, other]) {
      mkdirSync(dir);
      writeFileSync(join(dir, "MEMORY.md"), "remember this");
    }
    const later = Date.now() + 10_000;
    const [mine, theirs]: MemorySyncLedger[] = [{ bots: {} }, { bots: {} }];
    syncBotMemory(folder, "bot", other, theirs, { host: "other", now: later });
    syncBotMemory(folder, "bot", workspace, mine, { now: later });
    const groups = await readMemorySnapshots(folder, "bot");
    writeFileSync(join(other, "MEMORY.md"), "remember this and that");
    syncBotMemory(folder, "bot", other, theirs, { host: "other", now: later });
    syncBotMemory(folder, "bot", workspace, mine, { now: later, snapshots: groups });
    expect(mine.bots.bot.seen).toBeUndefined();
    expect(syncBotMemory(folder, "bot", workspace, mine, { now: later })["MEMORY.md"]).toBe("pulled");
  });

  it("saves a ledger that failed to save as soon as the disk takes it", () => {
    const root = mkdtempSync(join(tmpdir(), "memory-ledger-"));
    roots.push(root);
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "a file where the data folder should be");
    const ledger: MemorySyncLedger = { bots: { bot: { files: {} } } };
    const saved = JSON.stringify({ bots: {} });
    expect(() => saveMemorySyncLedgerIfChanged(join(blocked, "data"), ledger, saved)).toThrow();
    const data = join(root, "data");
    expect(saveMemorySyncLedgerIfChanged(data, ledger, saved)).toBe(JSON.stringify(ledger));
    expect(JSON.parse(readFileSync(join(data, "memory-sync-v2.json"), "utf8"))).toEqual(ledger);
    expect(saveMemorySyncLedgerIfChanged(join(blocked, "data"), ledger, JSON.stringify(ledger))).toBe(JSON.stringify(ledger));
  });

  it("retries a file it could not read, even though nothing about it changed", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const root = mkdtempSync(join(tmpdir(), "memory-retry-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const path = join(workspace, "MEMORY.md");
    writeFileSync(path, "remember this");
    const later = Date.now() + 5_000;
    const ledger: MemorySyncLedger = { bots: {} };
    vi.mocked(readFileSync).mockImplementation(((file, ...args) => {
      if (file === path) throw Object.assign(new Error("EIO"), { code: "EIO" });
      return Reflect.apply(actual.readFileSync, actual, [file, ...args]);
    }) as typeof readFileSync);
    expect(syncBotMemory(join(root, "drive"), "bot", workspace, ledger, { now: later })["MEMORY.md"]).toBe("skipped");
    expect(ledger.bots.bot.seen).toBeUndefined();
    vi.mocked(readFileSync).mockRestore();
    expect(syncBotMemory(join(root, "drive"), "bot", workspace, ledger, { now: later })["MEMORY.md"]).toBe("pushed");
    expect(ledger.bots.bot.seen).toBeDefined();
  });

  it("retries a snapshot that did not parse, sync or off the event loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory-partial-"));
    roots.push(root);
    const folder = join(root, "drive");
    const [workspace, other] = [join(root, "workspace"), join(root, "other")];
    for (const dir of [workspace, other]) mkdirSync(dir);
    writeFileSync(join(other, "MEMORY.md"), "from the other PC");
    const later = Date.now() + 5_000;
    const [mine, theirs]: MemorySyncLedger[] = [{ bots: {} }, { bots: {} }];
    syncBotMemory(folder, "bot", other, theirs, { host: "other", now: later });
    const snapshot = join(memorySyncDir(folder, "bot"), `${theirs.device}.json`);
    const whole = readFileSync(snapshot, "utf8");
    writeFileSync(snapshot, whole.slice(0, 20));
    syncBotMemory(folder, "bot", workspace, mine, { now: later });
    expect(mine.bots.bot.seen).toBeUndefined();
    const groups = await readMemorySnapshots(folder, "bot");
    expect(groups.some((group) => group?.partial)).toBe(true);
    syncBotMemory(folder, "bot", workspace, mine, { now: later, snapshots: groups });
    expect(mine.bots.bot.seen).toBeUndefined();
    writeFileSync(snapshot, whole);
    expect(syncBotMemory(folder, "bot", workspace, mine, { now: later })["MEMORY.md"]).toBe("pulled");
  });

  it.each(["", "   \n", MEMORY_SEED])("keeps empty or seed memory absent: %j", (text) => {
    const root = mkdtempSync(join(tmpdir(), "memory-empty-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "MEMORY.md"), text);
    const ledger: MemorySyncLedger = { bots: {} };
    expect(syncBotMemory(join(root, "drive"), "bot", workspace, ledger)["MEMORY.md"]).toBe("current");
    expect(ledger.bots.bot.files["MEMORY.md"]).toBeUndefined();
  });
});
