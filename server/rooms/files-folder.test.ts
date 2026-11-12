import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import { holdRoomFiles, moveRoomFiles, roomFilesFolder, roomFilesRoot } from "./files-folder.ts";

const disk = vi.hoisted(() => ({ corrupt: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
    await fs.copyFile(...args);
    if (disk.corrupt) await fs.writeFile(args[1], "modified");
  } };
});

const old = join(DATA_DIR, "room-files");
const pick = join(DATA_DIR, "new-files");
const next = join(pick, "Wink room files");
const setting = join(DATA_DIR, "room-files-folder.json");
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(join(old, "room1"), { recursive: true });
  writeFileSync(join(old, "room1", "file1"), "original");
  disk.corrupt = false;
});

afterEach(() => { disk.corrupt = false; });

describe("room files folder", () => {
  it("keeps hashes and changes only its own PC-local setting", async () => {
    const before = hash(join(old, "room1", "file1"));
    await moveRoomFiles(pick);
    expect(hash(join(next, "room1", "file1"))).toBe(before);
    expect(existsSync(join(old, "room1", "file1"))).toBe(false);
    expect(JSON.parse(readFileSync(setting, "utf8"))).toEqual({ path: next });
    expect(roomFilesRoot()).toBe(next);
  });

  it("keeps the old folder if a copied hash differs", async () => {
    disk.corrupt = true;
    await expect(moveRoomFiles(next)).rejects.toMatchObject({ status: 503 });
    expect(readFileSync(join(old, "room1", "file1"), "utf8")).toBe("original");
    expect(existsSync(setting)).toBe(false);
    expect(existsSync(join(next, "room1", "file1"))).toBe(false);
    expect(roomFilesRoot()).toBe(old);
  });

  it("never overwrites a file in the destination or moves an active upload", async () => {
    mkdirSync(join(next, "room1"), { recursive: true });
    writeFileSync(join(next, "room1", "file1"), "other");
    await expect(moveRoomFiles(next)).rejects.toMatchObject({ status: 503 });
    expect(readFileSync(join(next, "room1", "file1"), "utf8")).toBe("other");
    const release = holdRoomFiles();
    try { await expect(moveRoomFiles(join(DATA_DIR, "elsewhere"))).rejects.toMatchObject({ status: 503 }); }
    finally { release(); }
    expect(roomFilesRoot()).toBe(old);
  });

  it("starts read-only when the configured drive is unavailable and never falls back", () => {
    const missing = join(DATA_DIR, "unmounted-drive");
    writeFileSync(setting, JSON.stringify({ path: missing }));
    expect(roomFilesFolder()).toEqual({ path: missing, error: "unavailable" });
    expect(() => roomFilesRoot()).toThrow("room files folder is unavailable");
    expect(() => holdRoomFiles()).toThrow("room files folder is unavailable");
    expect(existsSync(missing)).toBe(false);
    expect(readFileSync(join(old, "room1", "file1"), "utf8")).toBe("original");
  });
});
