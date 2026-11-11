import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "./store.ts";

const copyPlan = vi.hoisted(() => ({ fail: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      if (copyPlan.fail) throw Object.assign(new Error(copyPlan.fail), { code: copyPlan.fail });
      return actual.copyFileSync(...args);
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (copyPlan.fail) throw Object.assign(new Error(copyPlan.fail), { code: copyPlan.fail });
      return actual.linkSync(...args);
    },
  };
});

vi.resetModules();
const { BACKUP_MAX_BYTES, DATA_DIR, backupSettings } = await import("./config.ts");
const { appendMessage, closeMessageDb, withMessageTransaction } = await import("./message-db.ts");
const {
  BACKUP_FILE_LIMIT, backupBytes, backupFailure, keptBackups, latestBackup, listBackups,
  readBackupBot, readBackupThread, runBackupWorker, startBackups, writeBackup,
} = await import("./backup.ts");

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const roots: string[] = [];
const msg = (id: string, text: string): Message => ({ id, role: "user", kind: "text", at: 1, text, parentId: null });

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "backup-"));
  roots.push(root);
  return root;
}

function seed(rows = 3, chats = 0) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify([
    { id: "atlas", name: "Atlas", threadId: "t-atlas", tasks: [{ threadId: "t-atlas-2", title: "Two", createdAt: 1 }] },
  ]));
  writeFileSync(join(DATA_DIR, "groups.json"), JSON.stringify([{ id: "team", name: "Team", threadId: "t-room" }]));
  writeFileSync(join(DATA_DIR, "routines.json"), JSON.stringify({ routines: [{ id: "daily" }], runs: [] }));
  writeFileSync(join(DATA_DIR, "config.json"), JSON.stringify({ xai: { key: "xai-secret" }, profile: { name: "Ed" } }));
  const threads = ["t-atlas", "t-atlas-2", "t-room", ...Array.from({ length: chats }, (_, i) => `t-run-${i}`)];
  for (const thread of threads) for (let i = 0; i < rows; i++) appendMessage(thread, msg(`${thread}-${i}`, `${thread} line ${i} ${"words ".repeat(20)}`));
  const desk = join(DATA_DIR, "workspaces", "atlas");
  mkdirSync(join(desk, "memory"), { recursive: true });
  writeFileSync(join(desk, "MEMORY.md"), "# Memory\n- likes green tea\n");
  writeFileSync(join(desk, "memory", "tea.md"), "green");
  writeFileSync(join(desk, "notes.txt"), "draft");
  writeFileSync(join(desk, "movie.mp4"), "");
  truncateSync(join(desk, "movie.mp4"), BACKUP_FILE_LIMIT);
  mkdirSync(join(DATA_DIR, "attachments"), { recursive: true });
  writeFileSync(join(DATA_DIR, "attachments", "cat.png"), "png");
}

const options = (dir: string, now = Date.now()) => ({ dataDir: DATA_DIR, dir, maxBytes: BACKUP_MAX_BYTES, syncFolders: [], now });

function files(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

beforeEach(() => {
  copyPlan.fail = null;
});

afterEach(() => {
  vi.useRealTimers();
  closeMessageDb();
  const link = join(DATA_DIR, "workspaces", "atlas", "project");
  if (existsSync(link)) unlinkSync(link);
  rmSync(DATA_DIR, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("backup place", () => {
  it("defaults to a visible Wink Backups folder in the home folder with a 2 GB cap", () => {
    expect(backupSettings(temp())).toEqual({ dir: join(homedir(), "Wink Backups"), maxBytes: 2 * 1024 ** 3 });
  });

  it("reads the folder and cap from backup.json, a file of their own", () => {
    const dataDir = temp();
    writeFileSync(join(dataDir, "backup.json"), JSON.stringify({ dir: join(dataDir, "..", "elsewhere"), maxBytes: 5 }));
    expect(backupSettings(dataDir)).toEqual({ dir: join(dataDir, "..", "elsewhere"), maxBytes: 5 });
  });

  it("refuses a place inside Wink's data folder or a sync folder", async () => {
    seed();
    await expect(writeBackup(options(join(DATA_DIR, "backups")))).rejects.toThrow("Wink's data folder");
    const sync = temp();
    await expect(writeBackup({ ...options(join(sync, "Wink Backups")), syncFolders: [sync] })).rejects.toThrow("sync folder");
    expect(existsSync(join(DATA_DIR, "backups"))).toBe(false);
    expect(readdirSync(sync)).toEqual([]);
  });
});

describe("writeBackup", () => {
  it("writes every chat, the lists, settings without keys, memory and small files, summary last", async () => {
    seed();
    const dir = join(temp(), "Wink Backups");
    const summary = await writeBackup(options(dir));
    expect(summary).toMatchObject({ chats: 3, rows: 9, bots: 1, rooms: 1, routines: 1, memoryFiles: 2, files: 3, attachments: 1 });
    const [entry] = listBackups(dir);
    expect(entry.summary).toEqual(summary);
    expect(readBackupThread(entry.path, "t-room")?.messages.map((m) => m.id)).toEqual(["t-room-0", "t-room-1", "t-room-2"]);
    const bot = readBackupBot(entry.path, "atlas");
    expect(bot?.bot.name).toBe("Atlas");
    expect(bot?.threads.map((thread) => thread.threadId)).toEqual(["t-atlas", "t-atlas-2"]);
    expect(readFileSync(join(bot!.folder!, "memory", "tea.md"), "utf8")).toBe("green");
    expect(existsSync(join(bot!.folder!, "movie.mp4"))).toBe(false);
    const settings = readFileSync(join(entry.path, "settings.json"), "utf8");
    expect(settings).toContain("Ed");
    expect(settings).not.toContain("xai-secret");
    const summaryAt = statSync(join(entry.path, "summary.json")).mtimeMs;
    for (const file of files(entry.path)) expect(statSync(file).mtimeMs).toBeLessThanOrEqual(summaryAt);
  });

  it("never follows a link inside a bot folder", async () => {
    seed();
    const project = temp();
    writeFileSync(join(project, "secret.txt"), "keep me");
    symlinkSync(project, join(DATA_DIR, "workspaces", "atlas", "project"), "junction");
    const dir = join(temp(), "Wink Backups");
    const summary = await writeBackup(options(dir));
    expect(files(dir).some((file) => file.endsWith("secret.txt"))).toBe(false);
    expect(summary?.files).toBe(3);
    expect(readFileSync(join(project, "secret.txt"), "utf8")).toBe("keep me");
  });

  it("adds under 1 MB when nothing changed", async () => {
    seed();
    appendMessage("t-room", msg("noise", randomBytes(1024 ** 2).toString("base64")));
    const dir = join(temp(), "Wink Backups");
    const now = Date.now();
    await writeBackup(options(dir, now - HOUR));
    const first = backupBytes(listBackups(dir));
    const second = await writeBackup(options(dir, now));
    expect(first).toBeGreaterThan(1024 ** 2);
    expect(second?.addedBytes).toBeLessThan(1024 ** 2);
    expect(backupBytes(listBackups(dir)) - first).toBeLessThan(1024 ** 2);
  });

  it("does not count attachments Wink still holds", async () => {
    seed();
    writeFileSync(join(DATA_DIR, "attachments", "cat.png"), Buffer.alloc(500_000));
    const dir = join(temp(), "Wink Backups");
    await writeBackup(options(dir));
    expect(backupBytes(listBackups(dir))).toBeLessThan(500_000);
  });

  it("keeps earlier backups and lists nothing new when a backup fails", async () => {
    seed();
    const dir = join(temp(), "Wink Backups");
    const now = Date.now();
    await writeBackup(options(dir, now - HOUR));
    copyPlan.fail = "ENOSPC";
    const failure = await writeBackup(options(dir, now)).catch((error: unknown) => error);
    expect(backupFailure(failure)).toBe("the disk is full");
    const entries = listBackups(dir);
    expect(entries).toHaveLength(1);
    expect(readdirSync(dir).filter((name) => name !== "README.txt")).toEqual([entries[0].name]);
    expect(readBackupThread(entries[0].path, "t-atlas")?.messages).toHaveLength(3);
  });

  it("keeps the chat part of a measured-size history under 60 MB", async () => {
    // 35,000 rows shaped like the measured set; the 350,000-row copy is timed outside CI.
    const words = "the bot read the file and wrote a short plan then ran the tests and fixed two lines in the server".split(" ");
    let seedValue = 7;
    const pick = () => words[(seedValue = (seedValue * 48271) % 2147483647) % words.length];
    mkdirSync(DATA_DIR, { recursive: true });
    withMessageTransaction(() => {
      for (let row = 0; row < 35_000; row++) {
        const text = Array.from({ length: 60 + (row % 80) }, pick).join(" ");
        appendMessage(`t-${row % 48}`, { ...msg(`m-${row}`, text), at: 1_700_000_000_000 + row * 1000, role: row % 2 ? "bot" : "user" });
      }
    });
    const dir = join(temp(), "Wink Backups");
    const summary = await writeBackup(options(dir));
    const chatBytes = files(join(listBackups(dir)[0].path, "chats")).reduce((sum, file) => sum + statSync(file).size, 0);
    expect(summary?.rows).toBe(35_000);
    expect(chatBytes * 10).toBeLessThan(60 * 1024 ** 2);
  }, 60_000);
});

describe("backup worker", () => {
  it("never lists a backup cut off half way", async () => {
    seed(2, 30);
    const dir = join(temp(), "Wink Backups");
    const run = runBackupWorker({ ...options(dir), pauseMs: 100 });
    run.done.catch(() => {});
    await vi.waitFor(() => expect(readdirSync(dir).some((name) => existsSync(join(dir, name, "chats")))).toBe(true), { timeout: 15_000 });
    await run.stop();
    expect(listBackups(dir)).toEqual([]);
    expect(readdirSync(dir).filter((name) => name !== "README.txt")).toHaveLength(1);
    await writeBackup(options(dir));
    expect(readdirSync(dir).filter((name) => name !== "README.txt")).toEqual([listBackups(dir)[0].name]);
  });

  it("runs off the main thread: the server answers a bot list while it runs", async () => {
    seed(2, 20);
    const server = createServer((_req, res) => res.end(readFileSync(join(DATA_DIR, "bots.json"))));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const delay = monitorEventLoopDelay({ resolution: 10 });
    try {
      const dir = join(temp(), "Wink Backups");
      let finished = false;
      const run = runBackupWorker({ ...options(dir), pauseMs: 50 });
      void run.done.then(() => { finished = true; });
      delay.enable();
      const started = performance.now();
      const bots = await (await fetch(`http://127.0.0.1:${port}/api/bots`)).json() as Array<{ id: string }>;
      const answered = performance.now() - started;
      expect(bots[0].id).toBe("atlas");
      expect(finished).toBe(false);
      await run.done;
      delay.disable();
      expect(answered).toBeLessThan(500);
      expect(delay.max / 1e6).toBeLessThan(200);
      expect(listBackups(dir)).toHaveLength(1);
      expect(readFileSync(join(dir, "README.txt"), "utf8")).toMatch(/^Wink Backups[\s\S]*Wink 백업/);
    } finally {
      server.close();
    }
  });
});

describe("keeping", () => {
  it("keeps 7 daily and 4 weekly, never the newest two lost", () => {
    const start = new Date(2026, 9, 1, 12).getTime();
    const ats = Array.from({ length: 40 }, (_, day) => start + day * DAY).reverse();
    ats.splice(1, 0, ats[0] - HOUR);
    const kept = [...keptBackups(ats)].sort((a, b) => a - b);
    expect(kept.slice(0, 2)).toEqual([0, 1]);
    expect(kept.filter((index) => ats[index] > ats[0] - 7 * DAY)).toHaveLength(8);
    expect(kept.length).toBeLessThanOrEqual(2 + 7 + 4);
    expect(Math.min(...kept.map((index) => ats[index]))).toBeLessThan(ats[0] - 14 * DAY);
  });

  it("drops the oldest first to stay under the cap, never the newest", async () => {
    seed(400);
    const dir = join(temp(), "Wink Backups");
    const now = Date.now();
    for (const [step, text] of ["one", "two", "three"].entries()) {
      appendMessage("t-atlas", msg(`change-${text}`, text.repeat(5000)));
      await writeBackup({ ...options(dir, now - (2 - step) * DAY), maxBytes: 1 });
    }
    expect(listBackups(dir).map((entry) => entry.summary.at)).toEqual([now]);
  });
});

describe("startBackups", () => {
  it("waits a few minutes after start and for no turn running, then backs up daily and before an update", async () => {
    seed();
    const dataDir = DATA_DIR;
    const dir = join(temp(), "Wink Backups");
    writeFileSync(join(dataDir, "backup.json"), JSON.stringify({ dir }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let busy = true;
    const log = vi.fn();
    const backups = startBackups({ dataDir, syncFolders: () => [], idle: () => !busy, log });
    try {
      vi.advanceTimersByTime(4 * 60_000);
      expect(existsSync(dir)).toBe(false);
      vi.advanceTimersByTime(2 * 60_000);
      expect(existsSync(dir)).toBe(false);
      busy = false;
      vi.advanceTimersByTime(60_000);
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("backup: saved 3 chats and 1 bots")), { timeout: 15_000 });
      vi.useRealTimers();
      await backups.beforeUpdate();
      expect(listBackups(dir)).toHaveLength(2);
      expect(latestBackup(dir)?.summary.bots).toBe(1);
    } finally {
      backups.stop();
    }
  });

  it("logs a failed backup in plain words", async () => {
    seed();
    const sync = temp();
    writeFileSync(join(DATA_DIR, "backup.json"), JSON.stringify({ dir: join(sync, "Wink Backups") }));
    const log = vi.fn();
    const backups = startBackups({ dataDir: DATA_DIR, syncFolders: () => [sync], idle: () => true, log });
    try {
      await backups.beforeUpdate();
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^backup: failed, .*sync folder.*Earlier backups are kept\.$/));
    } finally {
      backups.stop();
    }
  });
});
