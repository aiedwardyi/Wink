import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { memorySyncDir, memorySyncUnchanged, readMemorySnapshots, saveMemorySyncLedgerIfChanged, syncBotMemory, type MemorySyncLedger } from "./memory-sync.ts";
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
    // the other PC sorts first, so this one does not wait on it to let go of the tidy, which reads every copy until it ends
    const [mine, theirs]: MemorySyncLedger[] = [{ device: "bbbbbbbbbbbb", host: "mine", bots: {} }, { device: "aaaaaaaaaaaa", host: "other", bots: {} }];
    const later = Date.now() + 5_000;
    syncBotMemory(folder, "bot", other, theirs, { host: "other", now: later });
    syncBotMemory(folder, "bot", workspace, mine, { host: "mine", now: later });
    vi.mocked(readFileSync).mockClear();
    syncBotMemory(folder, "bot", workspace, mine, { host: "mine", now: later });
    const copies = vi.mocked(readFileSync).mock.calls.filter(([file]) => String(file).startsWith(memorySyncDir(folder, "bot")));
    expect(copies).toEqual([]);
    writeFileSync(join(other, "MEMORY.md"), "remember this and that");
    syncBotMemory(folder, "bot", other, theirs, { host: "other", now: later });
    expect(syncBotMemory(folder, "bot", workspace, mine, { host: "mine", now: later })["MEMORY.md"]).toBe("pulled");
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
