// Pictures and files in team rooms: room-owned blobs under opaque ids. Bytes
// stream to disk, are fsynced, and only then get a row; a room reaches a blob
// only through its row, so a crash leaves nothing the room can open.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream";
import { DatabaseSync } from "node:sqlite";

import { sniffImageMime } from "../attachments.ts";
import { DATA_DIR } from "../config.ts";
import { RateLimiter } from "../phone-auth.ts";
import { roomById, RoomError, type RoomFile } from "./db.ts";
import { holdRoomFiles, roomFilesBusy, roomFilesFolder, roomFilesRoot } from "./files-folder.ts";

export const IMAGE_MAX_BYTES = 100 * 1024 ** 2;
export const DOCUMENT_MAX_BYTES = 1024 ** 3;
export const ROOM_DISK_BYTES = 100 * 1024 ** 3;
export const MAX_MESSAGE_FILES = 50;
const UPLOADS = MAX_MESSAGE_FILES * 4;
const UPLOAD_WINDOW_MS = 10 * 60_000;
const UNSENT_MS = 24 * 60 * 60_000;
const HEAD_BYTES = 16;
const FILE_ID = /^[A-Za-z0-9_-]{24}$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{16,80}$/;

const ROOT = roomFilesRoot;
const roomDir = (roomId: string) => join(ROOT(), roomId);
const DB_FILE = () => join(DATA_DIR, "rooms.db");

const uploads = new RateLimiter(UPLOADS, UPLOAD_WINDOW_MS, () => Date.now());
/** Bytes still streaming per room, so two uploads can't both take the last free space. */
const inflight = new Map<string, number>();

const statusError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** A write may land short; loop until the whole chunk is on disk. */
export async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  for (let at = 0; at < chunk.length;) {
    const { bytesWritten } = await handle.write(chunk, at, chunk.length - at);
    if (!bytesWritten) throw new Error("no progress");
    at += bytesWritten;
  }
}

// Opened per call, like people-only: a held handle would outlive closeRoomsDb.
function withDb<T>(run: (db: DatabaseSync) => T): T {
  // db.ts owns the file, its mode, WAL and the log's files column.
  roomById("");
  const db = new DatabaseSync(DB_FILE());
  try {
    db.exec("PRAGMA synchronous = FULL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS room_files (
        room_id TEXT NOT NULL,
        id TEXT NOT NULL,
        owner TEXT NOT NULL,
        upload_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (room_id, id),
        UNIQUE (room_id, owner, upload_id)
      )
    `);
    return run(db);
  } finally {
    db.close();
  }
}

type FileRow = RoomFile & { owner: string };
const FILE_COLUMNS = "id, owner, name, type, bytes, sha256";
const publicFile = ({ id, name, type, bytes, sha256 }: FileRow): RoomFile => ({ id, name, type, bytes, sha256 });

/** One room's file by id; another room's id reads as absent. */
export function roomFile(roomId: string, id: string): RoomFile | null {
  if (!FILE_ID.test(id)) return null;
  const row = withDb((db) => db.prepare(`SELECT ${FILE_COLUMNS} FROM room_files WHERE room_id = ? AND id = ?`).get(roomId, id)) as FileRow | undefined;
  return row ? publicFile(row) : null;
}

/** The files a sender attaches: theirs, in this room, at most MAX_MESSAGE_FILES. */
export function ownRoomFiles(roomId: string, owner: string, ids: readonly string[]): RoomFile[] {
  if (ids.length > MAX_MESSAGE_FILES) throw new RoomError(400, `at most ${MAX_MESSAGE_FILES} files per message`);
  return ids.map((id) => {
    const row = FILE_ID.test(id)
      ? withDb((db) => db.prepare(`SELECT ${FILE_COLUMNS} FROM room_files WHERE room_id = ? AND id = ? AND owner = ?`).get(roomId, id, owner)) as FileRow | undefined
      : undefined;
    if (!row) throw new RoomError(404, "no such file in this room");
    return publicFile(row);
  });
}

export const ROOM_FILE_TYPES = [
  "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "application/zip", "application/x-ole-storage",
  "video/mp4", "video/quicktime", "video/x-m4v", "video/webm", "audio/mp4", "audio/mpeg", "audio/wav", "text/plain",
] as const;

/** Still pictures share the ftyp box with video; they stay refused. */
const STILL_BRAND = /^(hei[cxms]|hev[cms]|mif1|msf1|avi[fs])$/;
const FTYP = { "qt  ": "video/quicktime", "M4V ": "video/x-m4v", "M4VH": "video/x-m4v", "M4A ": "audio/mp4" } as const;

function sniffMedia(head: Buffer): string | null {
  const latin = head.toString("latin1");
  if (latin.startsWith("ftyp", 4)) return STILL_BRAND.test(latin.slice(8, 12)) ? null : FTYP[latin.slice(8, 12) as keyof typeof FTYP] ?? "video/mp4";
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  if (latin.startsWith("ID3") || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0 && ((head[1] ?? 0) & 0x06) !== 0)) return "audio/mpeg";
  if (latin.startsWith("RIFF") && latin.startsWith("WAVE", 8)) return "audio/wav";
  return null;
}

/** Text files are UTF-8 with no control characters beyond tab, line ends and form feed. */
function sniff(head: Buffer): { type: string; max: number } {
  const image = sniffImageMime(head);
  if (image) return { type: image, max: IMAGE_MAX_BYTES };
  const latin = head.toString("latin1");
  if (latin.startsWith("%PDF-")) return { type: "application/pdf", max: DOCUMENT_MAX_BYTES };
  if (latin.startsWith("PK\x03\x04")) return { type: "application/zip", max: DOCUMENT_MAX_BYTES };
  if (head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return { type: "application/x-ole-storage", max: DOCUMENT_MAX_BYTES };
  const media = sniffMedia(head);
  if (media) return { type: media, max: DOCUMENT_MAX_BYTES };
  return { type: "text/plain", max: DOCUMENT_MAX_BYTES };
}

const BINARY_TEXT = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;

/** Display name only: no folders, no control or reserved characters. */
function cleanName(raw: string | null): string {
  // eslint-disable-next-line no-control-regex -- names are display metadata only.
  const name = (raw ?? "").split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "").trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/, "");
  return name || "file";
}

const used = (roomId: string) =>
  (withDb((db) => db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM room_files WHERE room_id = ?").get(roomId)) as { bytes: number }).bytes;

export function listRoomFiles(roomId: string, host: string) {
  const files = withDb((db) => db.prepare(`
    SELECT f.id, f.name, f.type, f.bytes, f.at, f.owner,
      CASE WHEN f.owner = 'host' THEN ? ELSE COALESCE(p.name,
        (SELECT author_name FROM log, json_each(log.files) sent WHERE log.room_id = f.room_id AND json_extract(sent.value, '$.id') = f.id LIMIT 1), f.owner) END AS sender
    FROM room_files f LEFT JOIN people p ON p.room_id = f.room_id AND p.id = f.owner
    WHERE f.room_id = ? ORDER BY f.at DESC, f.rowid DESC
  `).all(host, roomId));
  return { files, used: used(roomId), capacity: ROOM_DISK_BYTES, error: roomFilesFolder().error };
}

export function roomFilesState(roomId: string) {
  const deleted = withDb((db) => db.prepare("SELECT id FROM room_file_deletions WHERE room_id = ?").all(roomId)) as Array<{ id: string }>;
  return { deleted: deleted.map((file) => file.id), error: roomFilesFolder().error };
}

/** Newest first, past the `seen` count a teammate holds (a higher one gets all), capped so the frame stays under a teammate's frame limit. */
export function deletedRoomFiles(roomId: string, seen = 0): { ids: string[]; count: number } {
  return withDb((db) => {
    // One snapshot, so a delete between the two reads can't push an unseen id out of the limit.
    db.exec("BEGIN");
    try {
      const { count } = db.prepare("SELECT COUNT(*) AS count FROM room_file_deletions WHERE room_id = ?").get(roomId) as { count: number };
      const fresh = Math.min(5000, seen > count ? count : count - seen);
      const ids = fresh ? db.prepare("SELECT id FROM room_file_deletions WHERE room_id = ? ORDER BY rowid DESC LIMIT ?").all(roomId, fresh) as Array<{ id: string }> : [];
      return { ids: ids.map((file) => file.id), count };
    } finally {
      db.exec("COMMIT");
    }
  });
}

export async function deleteRoomFile(roomId: string, id: string): Promise<void> {
  const release = holdRoomFiles();
  try {
    if (!FILE_ID.test(id)) throw statusError(404, "not found");
    await rm(join(roomDir(roomId), id), { force: true });
    withDb((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR IGNORE INTO room_file_deletions (room_id, id) VALUES (?, ?)").run(roomId, id);
        db.prepare("DELETE FROM room_files WHERE room_id = ? AND id = ?").run(roomId, id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  } finally {
    release();
  }
}

export interface Upload {
  /** "host" or a person id. */
  owner: string;
  name: string | null;
  /** Required: a resent upload after a lost reply must find the first one. */
  uploadId: string | null;
  /** Rechecked once the bytes are on disk, before the row: the uploader may have been removed meanwhile. */
  still?: () => boolean;
}

type Received = { ok: true; bytes: number; sha256: string; type: string } | { ok: false; status: number; error: string };

/** Streams the body into `file`, cut at the first byte past a limit. Never buffered whole. */
function receive(req: IncomingMessage, file: string, roomId: string, base: number, counted: { bytes: number }): Promise<Received> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const text = new TextDecoder("utf-8", { fatal: true });
    let head: Buffer[] | null = [];
    let kind: { type: string; max: number } | null = null;
    let size = 0;
    let done = false;
    const opened = open(file, "wx", 0o600);
    let writes: Promise<unknown> = opened;
    writes.catch(() => {});
    const finish = (result: Received) => {
      if (done) return;
      done = true;
      req.resume();
      void (async () => {
        const handle = await opened.catch(() => null);
        try {
          await writes;
          if (result.ok) await handle!.sync();
        } finally {
          await handle?.close();
        }
      })().then(() => resolve(result), () => resolve({ ok: false, status: 500, error: "couldn't save the file" }));
    };
    const fail = (status: number, error: string) => finish({ ok: false, status, error });
    const write = (chunk: Buffer) => {
      if (done) return;
      hash.update(chunk);
      if (kind!.type === "text/plain") {
        try {
          if (BINARY_TEXT.test(text.decode(chunk, { stream: true }))) return fail(415, "this kind of file can't be shared");
        } catch {
          return fail(415, "this kind of file can't be shared");
        }
      }
      req.pause();
      writes = writes.then(async () => {
        await writeAll(await opened, chunk);
      });
      writes.then(() => req.resume(), () => fail(500, "couldn't save the file"));
    };
    const decide = () => {
      kind = sniff(Buffer.concat(head!));
      const chunks = head!;
      head = null;
      for (const chunk of chunks) write(chunk);
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      counted.bytes += chunk.length;
      inflight.set(roomId, (inflight.get(roomId) ?? 0) + chunk.length);
      if (base + inflight.get(roomId)! > ROOM_DISK_BYTES) return fail(507, "this room is out of space for files");
      if (size > DOCUMENT_MAX_BYTES || (kind && size > kind.max)) return fail(413, tooLarge(kind?.max ?? DOCUMENT_MAX_BYTES));
      if (head) {
        head.push(chunk);
        if (size < HEAD_BYTES) return;
        decide();
        if (size > kind!.max) return fail(413, tooLarge(kind!.max));
        return;
      }
      write(chunk);
    });
    req.on("end", () => {
      if (done) return;
      if (!size) return fail(400, "file is empty");
      if (head) decide();
      if (done) return;
      if (kind!.type === "text/plain") {
        try {
          if (BINARY_TEXT.test(text.decode())) return fail(415, "this kind of file can't be shared");
        } catch {
          return fail(415, "this kind of file can't be shared");
        }
      }
      void writes.then(() => finish({ ok: true, bytes: size, sha256: hash.digest("hex"), type: kind!.type }), () => fail(500, "couldn't save the file"));
    });
    req.on("error", () => fail(400, "upload aborted"));
    req.on("close", () => {
      if (!req.readableEnded) fail(400, "upload aborted");
    });
  });
}

const tooLarge = (max: number) => (max === IMAGE_MAX_BYTES ? "pictures can be up to 100 MB" : "files can be up to 1 GB");

/** Durable before the reply: bytes fsynced and renamed into place, then the row committed. */
export async function saveRoomFile(req: IncomingMessage, roomId: string, upload: Upload): Promise<RoomFile> {
  const release = holdRoomFiles();
  try {
    return await saveFile(req, roomId, upload);
  } finally {
    release();
  }
}

async function saveFile(req: IncomingMessage, roomId: string, upload: Upload): Promise<RoomFile> {
  if (upload.uploadId === null || !UPLOAD_ID.test(upload.uploadId)) throw statusError(400, "bad uploadId");
  if (!uploads.take(`${roomId}\n${upload.owner}`)) throw statusError(429, "too many files at once, try again in a few minutes");
  const length = Number(req.headers["content-length"] ?? 0);
  if (length > DOCUMENT_MAX_BYTES) throw statusError(413, tooLarge(DOCUMENT_MAX_BYTES));
  const base = used(roomId);
  const free = ROOM_DISK_BYTES - base - (inflight.get(roomId) ?? 0);
  if (free <= 0 || length > free) throw statusError(507, "this room is out of space for files");
  const id = randomBytes(18).toString("base64url");
  const dir = roomDir(roomId);
  const temp = join(dir, `.${id}.tmp`);
  const counted = { bytes: 0 };
  let received: Received;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    received = await receive(req, temp, roomId, base, counted);
  } catch {
    received = { ok: false, status: 500, error: "couldn't save the file" };
  } finally {
    const left = (inflight.get(roomId) ?? 0) - counted.bytes;
    if (left > 0) inflight.set(roomId, left);
    else inflight.delete(roomId);
  }
  if (!received.ok) {
    await rm(temp, { force: true }).catch(() => {});
    throw statusError(received.status, received.error);
  }
  const blob = join(dir, id);
  try {
    if (upload.still && !upload.still()) throw statusError(401, "unauthorized");
    await rename(temp, blob);
    await syncDir(dir);
    const file: FileRow = { id, owner: upload.owner, name: cleanName(upload.name), type: received.type, bytes: received.bytes, sha256: received.sha256 };
    const kept = withDb((db) => {
      const room = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM room_files WHERE room_id = ?").get(roomId) as { bytes: number };
      if (room.bytes + file.bytes > ROOM_DISK_BYTES && !db.prepare("SELECT 1 FROM room_files WHERE room_id = ? AND owner = ? AND upload_id = ?").get(roomId, file.owner, upload.uploadId)) {
        return null;
      }
      const inserted = db.prepare(`
        INSERT INTO room_files (room_id, id, owner, upload_id, name, type, bytes, sha256, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (room_id, owner, upload_id) DO NOTHING
      `).run(roomId, id, file.owner, upload.uploadId, file.name, file.type, file.bytes, file.sha256, Date.now()).changes;
      return inserted ? file : db.prepare(`SELECT ${FILE_COLUMNS} FROM room_files WHERE room_id = ? AND owner = ? AND upload_id = ?`).get(roomId, upload.owner, upload.uploadId) as unknown as FileRow;
    });
    if (!kept) {
      await rm(blob, { force: true });
      throw statusError(507, "this room is out of space for files");
    }
    if (kept.id === id) return publicFile(kept);
    await rm(blob, { force: true });
    if (kept.sha256 !== file.sha256) throw statusError(409, "uploadId was used for another file");
    return publicFile(kept);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    if ((error as { status?: number }).status) throw error;
    await rm(blob, { force: true }).catch(() => {});
    throw statusError(500, "couldn't save the file");
  }
}

/** Windows can't fsync a folder (EPERM); there the rename is as durable as it gets. */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!["EPERM", "EISDIR", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** Pictures preview inline under their own fixed type; everything else only downloads. */
export function fileHeaders(file: RoomFile, preview: boolean): Record<string, string> {
  const image = file.type.startsWith("image/");
  const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return {
    "content-type": image ? file.type : "application/octet-stream",
    "content-length": String(file.bytes),
    "content-disposition": `${preview ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "x-content-type-options": "nosniff",
    "x-content-sha256": file.sha256,
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "no-store",
  };
}

/** Streams a blob at `path`; false (nothing written) when it can't be opened. */
export async function sendBlob(res: ServerResponse, path: string, file: RoomFile, preview: boolean): Promise<boolean> {
  if (preview && !file.type.startsWith("image/")) return false;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    if ((await handle.stat()).size !== file.bytes) throw new Error("size");
  } catch {
    await handle?.close();
    return false;
  }
  res.writeHead(200, fileHeaders(file, preview));
  pipeline(handle.createReadStream(), res, () => {});
  return true;
}

/** The ACL is the caller's; this only resolves an id inside one room. */
export function serveRoomFile(res: ServerResponse, roomId: string, id: string, preview: boolean): Promise<boolean> {
  const release = holdRoomFiles();
  res.once("close", release);
  const file = roomFile(roomId, id);
  return file ? sendBlob(res, join(roomDir(roomId), file.id), file, preview) : Promise.resolve(false);
}

/** On start: half-written uploads, blobs without a row, and day-old uploads no message took. */
export function sweepRoomFiles(groups: readonly { hosted?: { roomId: string }; picture?: string }[] = []): void {
  try {
    if (roomFilesBusy() || !existsSync(ROOT())) return;
    const cutoff = Date.now() - UNSENT_MS;
    withDb((db) => {
      const stale = db.prepare(`
        SELECT room_id, id FROM room_files f WHERE at < ? AND NOT EXISTS (
          SELECT 1 FROM log, json_each(log.files) AS sent
          WHERE log.room_id = f.room_id AND log.files IS NOT NULL AND json_extract(sent.value, '$.id') = f.id
        )
      `).all(cutoff) as Array<{ room_id: string; id: string }>;
      const drop = db.prepare("DELETE FROM room_files WHERE room_id = ? AND id = ?");
      for (const row of stale) {
        if (!groups.some((group) => group.hosted?.roomId === row.room_id && group.picture === row.id)) drop.run(row.room_id, row.id);
      }
      const known = db.prepare("SELECT 1 FROM room_files WHERE room_id = ? AND id = ?");
      const rooms = new Set((db.prepare("SELECT id FROM rooms").all() as Array<{ id: string }>).map((room) => room.id));
      for (const roomId of readdirSync(ROOT())) {
        if (!rooms.has(roomId)) continue;
        try {
          for (const name of readdirSync(roomDir(roomId))) {
            if (!FILE_ID.test(name) || !known.get(roomId, name)) rmSync(join(roomDir(roomId), name), { force: true, recursive: true });
          }
        } catch {}
      }
    });
  } catch {}
}
