import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { memorySyncDir, syncBotMemory, type MemorySyncLedger } from "./memory-sync.ts";
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
