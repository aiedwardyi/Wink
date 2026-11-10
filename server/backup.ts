// Daily dated backups on the person's own disk, outside Wink's data folder
// and every sync folder. A dated folder counts only once summary.json, written
// last, is in it. Unchanged chats and files are hard links to the previous
// backup, attachments hard links to Wink's own copy, so a quiet day costs nothing.
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync,
  type Stats,
} from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { gunzipSync, gzipSync } from "node:zlib";

import { writeFileAtomic } from "./atomic.ts";
import { backupSettings } from "./config.ts";
import { openThreadExport } from "./message-db.ts";
import type { BotRecord, Message } from "./store.ts";

export const BACKUP_FILE_LIMIT = 10 * 1024 * 1024;
const FIRST_DELAY_MS = 5 * 60_000;
const BUSY_RETRY_MS = 60_000;
const CHECK_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const UPDATE_WAIT_MS = 2 * 60_000;
const NAME = /^\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/;
const SUMMARY = "summary.json";
const CHAT_INDEX = "index.json";
const SETTINGS_KEPT = ["profile", "rooms", "localVm", "features", "vps"];

export interface BackupOptions {
  dataDir: string;
  dir: string;
  maxBytes: number;
  syncFolders: readonly string[];
  /** README text for the backup place, written once. */
  note?: string;
  /** Skip when the newest backup is younger than this. */
  minAgeMs?: number;
  pauseMs?: number;
  now?: number;
}

export interface BackupSummary {
  at: number;
  chats: number;
  rows: number;
  bots: number;
  rooms: number;
  routines: number;
  memoryFiles: number;
  files: number;
  attachments: number;
  /** Links and files of 10 MB or more, left out. */
  skipped: number;
  bytes: number;
  addedBytes: number;
}

export interface BackupEntry {
  name: string;
  path: string;
  summary: BackupSummary;
}

export interface BackupThread {
  threadId: string;
  activeLeafId: string | null;
  messages: Message[];
}

type ChatIndex = Record<string, { file: string; sha: string; rows: number }>;

const within = (child: string, parent: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function backupPlaceError(dir: string, dataDir: string, syncFolders: readonly string[]): string | null {
  if (within(dir, dataDir)) return "backups cannot go inside Wink's data folder";
  if (syncFolders.some((folder) => within(dir, folder))) return "backups cannot go inside a sync folder, or they would reach your other PCs";
  return null;
}

export function backupFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOSPC") return "the disk is full";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "Wink may not write to the backup folder";
  if (code === "ENOENT") return "the backup folder is not there";
  return error instanceof Error ? error.message : String(error);
}

/** Complete backups, newest first. */
export function listBackups(dir: string): BackupEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => NAME.test(name)).flatMap((name) => {
    const path = join(dir, name);
    try {
      const summary = JSON.parse(readFileSync(join(path, SUMMARY), "utf8")) as BackupSummary;
      return Number.isFinite(summary.at) ? [{ name, path, summary }] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => b.summary.at - a.summary.at);
}

export function latestBackup(dir: string): BackupEntry | null {
  return listBackups(dir)[0] ?? null;
}

export function readBackupThread(path: string, threadId: string): BackupThread | null {
  const file = readChatIndex(path)[threadId]?.file;
  if (!file) return null;
  const [head, ...rows] = gunzipSync(readFileSync(join(path, "chats", file))).toString("utf8").split("\n").filter(Boolean);
  return { threadId, activeLeafId: (JSON.parse(head) as { activeLeafId: string | null }).activeLeafId, messages: rows.map((row) => JSON.parse(row) as Message) };
}

/** One bot as that backup saw it: its record, every task's chat and its folder copy. */
export function readBackupBot(path: string, botId: string): { bot: BotRecord; threads: BackupThread[]; folder: string | null } | null {
  const bot = (JSON.parse(readFileSync(join(path, "bots.json"), "utf8")) as BotRecord[]).find((candidate) => candidate.id === botId);
  if (!bot) return null;
  const threadIds = [...new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)])];
  const folder = join(path, "bots", botId);
  return { bot, threads: threadIds.flatMap((threadId) => readBackupThread(path, threadId) ?? []), folder: existsSync(folder) ? folder : null };
}

/** Disk the backups hold: each file once, and nothing for a file Wink still keeps itself. */
export function backupBytes(entries: readonly BackupEntry[]): number {
  const files = new Map<bigint, { size: bigint; links: bigint; seen: bigint }>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const stat = statSync(path, { bigint: true });
        const file = files.get(stat.ino) ?? { size: stat.size, links: stat.nlink, seen: 0n };
        file.seen++;
        files.set(stat.ino, file);
      }
    }
  };
  for (const entry of entries) walk(entry.path);
  let total = 0n;
  for (const file of files.values()) if (file.seen >= file.links) total += file.size;
  return Number(total);
}

const localDay = (at: number) => {
  const day = new Date(at);
  return `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
};
const localWeek = (at: number) => {
  const day = new Date(at);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return localDay(day.getTime());
};

/** Indexes (newest first) the ladder keeps: the newest two, then the newest of each of 7 days and 4 weeks. */
export function keptBackups(ats: readonly number[]): Set<number> {
  const kept = new Set([0, 1].filter((index) => index < ats.length));
  const days = new Set<string>();
  const weeks = new Set<string>();
  ats.forEach((at, index) => {
    const day = localDay(at);
    if (!days.has(day) && days.size < 7) kept.add(index);
    days.add(day);
    const week = localWeek(at);
    if (!weeks.has(week) && weeks.size < 4) kept.add(index);
    weeks.add(week);
  });
  return kept;
}

function folderName(dir: string, at: number): string {
  const time = new Date(at);
  const two = (value: number) => String(value).padStart(2, "0");
  const base = `${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())}-${two(time.getHours())}${two(time.getMinutes())}${two(time.getSeconds())}`;
  let name = base;
  for (let copy = 2; existsSync(join(dir, name)); copy++) name = `${base}-${copy}`;
  return name;
}

function readChatIndex(path: string): ChatIndex {
  try {
    return JSON.parse(readFileSync(join(path, "chats", CHAT_INDEX), "utf8")) as ChatIndex;
  } catch {
    return {};
  }
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

// fs.rmSync empties a junction's target under Electron; the promise rm does not.
const remove = (path: string) => rm(path, { recursive: true, force: true });

export async function writeBackup(options: BackupOptions): Promise<BackupSummary | null> {
  const { dataDir, dir, now = Date.now(), pauseMs = 5 } = options;
  const refused = backupPlaceError(dir, dataDir, options.syncFolders);
  if (refused) throw new Error(refused);
  mkdirSync(dir, { recursive: true });
  const readme = join(dir, "README.txt");
  if (options.note && !existsSync(readme)) writeFileSync(readme, options.note);
  const previous = latestBackup(dir);
  if (previous && now - previous.summary.at < (options.minAgeMs ?? 0)) return null;
  for (const name of readdirSync(dir)) {
    if (NAME.test(name) && !existsSync(join(dir, name, SUMMARY))) await remove(join(dir, name));
  }
  const target = join(dir, folderName(dir, now));
  mkdirSync(target);
  let summary: BackupSummary;
  try {
    summary = await fill(target, previous?.path ?? null, { dataDir, now, pauseMs });
    writeFileAtomic(join(target, SUMMARY), JSON.stringify(summary, null, 2));
  } catch (error) {
    await remove(target);
    throw error;
  }
  await prune(dir, options.maxBytes);
  return summary;
}

async function fill(target: string, previous: string | null, { dataDir, now, pauseMs }: { dataDir: string; now: number; pauseMs: number }): Promise<BackupSummary> {
  const summary: BackupSummary = {
    at: now, chats: 0, rows: 0, bots: 0, rooms: 0, routines: 0, memoryFiles: 0, files: 0, attachments: 0, skipped: 0, bytes: 0, addedBytes: 0,
  };
  // Wink's own copy first (attachments only, never rewritten in place), then last backup's copy when size and time match.
  const put = (from: string, stat: Stats, to: string, before: string | null, shared: boolean) => {
    summary.bytes += stat.size;
    for (const source of [shared ? from : null, before]) {
      if (!source) continue;
      try {
        if (source === before) {
          const old = statSync(source);
          if (old.size !== stat.size || Math.abs(old.mtimeMs - stat.mtimeMs) >= 1) continue;
        }
        linkSync(source, to);
        return;
      } catch {
        /* copy below */
      }
    }
    copyFileSync(from, to);
    utimesSync(to, stat.atime, stat.mtime);
    summary.addedBytes += stat.size;
  };
  const copyTree = (from: string, to: string, before: string | null, shared: boolean, onFile: (rel: string) => void, rel = "") => {
    let names: string[];
    try {
      names = readdirSync(from);
    } catch {
      return;
    }
    for (const name of names) {
      const source = join(from, name);
      let stat: Stats;
      try {
        // lstat: a junction or symlink is never followed.
        stat = lstatSync(source);
      } catch {
        continue; // removed since the listing
      }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.size >= BACKUP_FILE_LIMIT)) summary.skipped++;
      else if (stat.isDirectory()) copyTree(source, join(to, name), before && join(before, name), shared, onFile, join(rel, name));
      else if (stat.isFile()) {
        mkdirSync(to, { recursive: true });
        put(source, stat, join(to, name), before && join(before, name), shared);
        onFile(join(rel, name));
      }
    }
  };

  for (const name of ["bots.json", "groups.json", "routines.json"]) {
    const from = join(dataDir, name);
    if (existsSync(from)) put(from, statSync(from), join(target, name), previous && join(previous, name), false);
  }
  const length = (value: unknown) => (Array.isArray(value) ? value.length : 0);
  summary.bots = length(readJson(join(dataDir, "bots.json")));
  summary.rooms = length(readJson(join(dataDir, "groups.json")));
  summary.routines = length((readJson(join(dataDir, "routines.json")) as { routines?: unknown } | undefined)?.routines);
  const config = readJson(join(dataDir, "config.json"));
  if (config && typeof config === "object") {
    const kept = Object.fromEntries(Object.entries(config).filter(([key]) => SETTINGS_KEPT.includes(key)));
    writeFileSync(join(target, "settings.json"), JSON.stringify(kept, null, 2));
  }

  const database = join(dataDir, "messages.db");
  if (existsSync(database)) {
    const chats = join(target, "chats");
    mkdirSync(chats);
    const before = previous ? readChatIndex(previous) : {};
    const index: ChatIndex = {};
    const source = openThreadExport(database);
    try {
      for (const threadId of source.threadIds()) {
        const lines = [JSON.stringify({ threadId, activeLeafId: source.activeLeafId(threadId) })];
        for (const row of source.rows(threadId)) lines.push(row.json);
        const text = `${lines.join("\n")}\n`;
        const sha = createHash("sha256").update(text).digest("hex");
        const file = `${createHash("sha256").update(threadId).digest("hex").slice(0, 24)}.jsonl.gz`;
        let linked = false;
        if (previous && before[threadId]?.sha === sha) {
          try {
            linkSync(join(previous, "chats", before[threadId].file), join(chats, file));
            linked = true;
          } catch {
            /* write it again */
          }
        }
        if (!linked) {
          const packed = gzipSync(text);
          writeFileSync(join(chats, file), packed);
          summary.addedBytes += packed.length;
        }
        index[threadId] = { file, sha, rows: lines.length - 1 };
        summary.chats++;
        summary.rows += lines.length - 1;
        await sleep(pauseMs);
      }
    } finally {
      source.close();
    }
    writeFileSync(join(chats, CHAT_INDEX), JSON.stringify(index));
  }

  copyTree(join(dataDir, "workspaces"), join(target, "bots"), previous && join(previous, "bots"), false, (rel) => {
    summary.files++;
    const [, ...inside] = rel.split(/[\\/]/);
    if (inside.join("/") === "MEMORY.md" || inside[0] === "memory") summary.memoryFiles++;
  });
  copyTree(join(dataDir, "attachments"), join(target, "attachments"), previous && join(previous, "attachments"), true, () => summary.attachments++);
  return summary;
}

async function prune(dir: string, maxBytes: number): Promise<void> {
  const entries = listBackups(dir);
  const kept = keptBackups(entries.map((entry) => entry.summary.at));
  for (const [index, entry] of entries.entries()) if (!kept.has(index)) await remove(entry.path);
  const left = entries.filter((_, index) => kept.has(index));
  while (left.length > 1 && backupBytes(left) > maxBytes) await remove(left.pop()!.path);
}

export function runBackupWorker(options: BackupOptions): { done: Promise<BackupSummary | null>; stop: () => Promise<number> } {
  const source = new URL("./backup-worker.ts", import.meta.url);
  const entry = existsSync(source) ? source : new URL("./backup-worker.js", import.meta.url);
  const worker = new Worker(entry, { workerData: options, execArgv: entry.pathname.endsWith(".ts") ? ["--experimental-strip-types"] : [] });
  const done = new Promise<BackupSummary | null>((resolve, reject) => {
    worker.once("message", (reply: { summary?: BackupSummary | null; error?: string }) => {
      if (reply.error === undefined) resolve(reply.summary ?? null);
      else reject(new Error(reply.error));
    });
    worker.once("error", (error) => reject(new Error(backupFailure(error))));
    worker.once("exit", () => reject(new Error("the backup stopped before it finished")));
  });
  return { done, stop: () => worker.terminate() };
}

/** Soon after start, then daily, only while no turn runs, always in a worker. */
export function startBackups(options: { dataDir: string; syncFolders: () => string[]; idle: () => boolean; log: (line: string) => void }) {
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (ms: number) => {
    timer = setTimeout(tick, ms);
    timer.unref();
  };
  const backup = async (minAgeMs: number) => {
    const { dir, maxBytes } = backupSettings(options.dataDir);
    try {
      const summary = await runBackupWorker({ dataDir: options.dataDir, dir, maxBytes, syncFolders: options.syncFolders(), minAgeMs }).done;
      if (summary) options.log(`backup: saved ${summary.chats} chats and ${summary.bots} bots in ${dir} (+${(summary.addedBytes / 1024 ** 2).toFixed(1)} MB)`);
    } catch (error) {
      options.log(`backup: failed, ${backupFailure(error)}. Earlier backups are kept.`);
    }
  };
  const run = (minAgeMs: number) => (running ??= backup(minAgeMs).finally(() => {
    running = null;
  }));
  function tick() {
    if (!options.idle()) return later(BUSY_RETRY_MS);
    void run(DAY_MS).then(() => later(CHECK_MS));
  }
  later(FIRST_DELAY_MS);
  return {
    beforeUpdate: () => Promise.race([run(0), sleep(UPDATE_WAIT_MS, undefined, { ref: false })]),
    stop: () => clearTimeout(timer),
  };
}
