import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, ReadStream, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { attachmentExists, ATTACHMENTS_DIR, readAttachment } from "../attachments.ts";
import { DATA_DIR } from "../config.ts";
import { appendRoomEntry, closeRoomsDb, createRoom, recentRoomEntries } from "./db.ts";
import { FILE_PATH, fileRoute } from "./file-routes.ts";
import { MAX_MESSAGE_FILES, ROOM_DISK_BYTES, sweepRoomFiles } from "./files.ts";
import { moveRoomFiles, roomFilesRoot } from "./files-folder.ts";

const disk = vi.hoisted(() => ({ shortWrites: false, failSync: null as { path: string; code: string } | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (...args: Parameters<typeof fs.open>) => {
    const fail = disk.failSync;
    if (fail && String(args[0]) === fail.path) {
      return { sync: () => Promise.reject(Object.assign(new Error("sync failed"), { code: fail.code })), close: () => Promise.resolve() };
    }
    return new Proxy(await fs.open(...args), {
      get(target, key) {
        if (key === "write" && disk.shortWrites) return (buffer: Buffer, offset = 0, length = buffer.length - offset) => target.write(buffer, offset, Math.min(length, 7));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return { ...fs, open };
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json: any;
}

let server: Server;
let port = 0;
const replies: Reply[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = FILE_PATH.exec(url.pathname);
    if (!match) return void res.writeHead(404).end();
    void fileRoute(match, req, res, url, match[1]!, String(req.headers["x-owner"] ?? "host"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  closeRoomsDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  replies.length = 0;
});

afterEach(() => closeRoomsDb());

function call(method: string, path: string, init: { body?: Buffer | Buffer[]; owner?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  const chunks = init.body === undefined ? [] : Array.isArray(init.body) ? init.body : [init.body];
  const headers: Record<string, string> = { "x-owner": init.owner ?? "host", ...init.headers };
  if (!Array.isArray(init.body) && init.body) headers["content-length"] ??= String(init.body.length);
  return new Promise((resolve, reject) => {
    let done: (() => void) | null = null;
    const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const parts: Buffer[] = [];
      done = () => {
        done = () => {};
        const body = Buffer.concat(parts);
        let json: unknown = null;
        try {
          json = JSON.parse(body.toString("utf8"));
        } catch {}
        const reply = { status: res.statusCode ?? 0, headers: res.headers, body, json };
        replies.push(reply);
        resolve(reply);
      };
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => done!());
      res.on("error", () => done!());
    });
    // A refused body is cut by the server while it is still going out.
    req.on("error", (error) => (done ? done() : reject(error)));
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

const upload = (roomId: string, body: Buffer | Buffer[], query: Record<string, string> = {}, owner?: string) =>
  call("POST", `/rooms/${roomId}/files?${new URLSearchParams({ uploadId: newUploadId(), ...query })}`, { body, owner });
const newUploadId = () => randomBytes(12).toString("base64url");

const png = (size: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size - 8)]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const roomDir = (roomId: string) => join(DATA_DIR, "room-files", roomId);
const rows = (roomId: string) => {
  const db = new DatabaseSync(join(DATA_DIR, "rooms.db"));
  try {
    return db.prepare("SELECT id, owner, upload_id FROM room_files WHERE room_id = ?").all(roomId);
  } finally {
    db.close();
  }
};
const exec = (sql: string, ...values: Array<string | number>) => {
  const db = new DatabaseSync(join(DATA_DIR, "rooms.db"));
  try {
    db.prepare(sql).run(...values);
  } finally {
    db.close();
  }
};

describe("room file types", () => {
  it("are sniffed from the bytes, never the name or the declared type", async () => {
    const room = createRoom("Team").id;
    const cases: Array<[Buffer, string]> = [
      [png(64), "image/png"],
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(60)]), "image/jpeg"],
      [Buffer.from("%PDF-1.7\n...", "latin1"), "application/pdf"],
      [Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), randomBytes(40)]), "application/zip"],
      [Buffer.from("name,amount\n김민아,3\n", "utf8"), "text/plain"],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), "text/plain"],
    ];
    for (const [bytes, type] of cases) {
      const res = await call("POST", `/rooms/${room}/files?uploadId=${newUploadId()}&name=${encodeURIComponent("photo.png")}`, { body: bytes, headers: { "content-type": "image/png" } });
      expect(res.status).toBe(200);
      expect(res.json.file).toEqual({ id: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/), name: "photo.png", type, bytes: bytes.length, sha256: sha(bytes) });
    }
    for (const bytes of [Buffer.concat([Buffer.from("MZ"), randomBytes(200)]), Buffer.from([0x68, 0x69, 0x00, 0x21, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a])]) {
      expect(await upload(room, bytes)).toMatchObject({ status: 415, json: { error: "this kind of file can't be shared" } });
    }
    expect(await upload(room, Buffer.alloc(0))).toMatchObject({ status: 400, json: { error: "file is empty" } });
    expect(rows(room)).toHaveLength(cases.length);
  });

  it("serve pictures under their fixed type, inline only as a preview, and everything else as a download", async () => {
    const room = createRoom("Team").id;
    const picture = png(500);
    const image = (await upload(room, picture, { name: "cat.png" })).json.file;
    const svg = (await upload(room, Buffer.from("<svg><script>alert(1)</script></svg>"), { name: "x.svg" })).json.file;
    const safe = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "no-store" };
    const download = await call("GET", `/rooms/${room}/files/${image.id}`);
    expect(download.body.equals(picture)).toBe(true);
    expect(download.headers).toMatchObject({ ...safe, "content-type": "image/png", "content-disposition": expect.stringMatching(/^attachment;/) });
    const preview = await call("GET", `/rooms/${room}/files/${image.id}/preview`);
    expect(preview.headers).toMatchObject({ ...safe, "content-type": "image/png", "content-disposition": expect.stringMatching(/^inline;/) });
    const text = await call("GET", `/rooms/${room}/files/${svg.id}`);
    expect(text.headers).toMatchObject({ ...safe, "content-type": "application/octet-stream", "content-disposition": expect.stringMatching(/^attachment;/) });
    expect((await call("GET", `/rooms/${room}/files/${svg.id}/preview`)).status).toBe(404);
  });
});

describe("room file limits", () => {
  it("cut pictures past 100 MB and files past 1 GB while streaming, keeping nothing", async () => {
    const room = createRoom("Team").id;
    const big = png(1024 * 1024);
    const picture = await upload(room, [big, ...Array.from({ length: 100 }, () => big)]);
    expect(picture).toMatchObject({ status: 413, json: { error: "pictures can be up to 100 MB" } });
    const line = Buffer.alloc(1024 * 1024, "a");
    expect(await call("POST", `/rooms/${room}/files?uploadId=${newUploadId()}`, { body: line, headers: { "content-length": String(1024 ** 3 + 1) } }).catch(() => null)).toMatchObject({ status: 413, json: { error: "files can be up to 1 GB" } });
    expect(rows(room)).toEqual([]);
    expect(readdirSync(roomDir(room))).toEqual([]);
  });

  it("refuse a room past its disk cap with a plain error", async () => {
    const room = createRoom("Team").id;
    expect((await upload(room, Buffer.from("first"))).status).toBe(200);
    exec("INSERT INTO room_files (room_id, id, owner, name, type, bytes, sha256, at) VALUES (?, ?, 'host', 'big', 'text/plain', ?, '', ?)", room, "B".repeat(24), ROOM_DISK_BYTES - 100, Date.now());
    expect(await upload(room, [Buffer.alloc(80, "a"), Buffer.alloc(80, "a")])).toMatchObject({ status: 507, json: { error: "this room is out of space for files" } });
    expect(await upload(room, Buffer.alloc(200, "a"))).toMatchObject({ status: 507 });
    expect(await upload(createRoom("Other").id, Buffer.alloc(200, "a"))).toMatchObject({ status: 200 });
  });

  it("allow several full messages of uploads per person per 10 minutes", async () => {
    const room = createRoom("Team").id;
    for (let i = 0; i < MAX_MESSAGE_FILES * 4; i++) expect((await upload(room, Buffer.from(`note ${i}`), {}, "p1")).status).toBe(200);
    expect(await upload(room, Buffer.from("one more"), {}, "p1")).toMatchObject({ status: 429, json: { error: "too many files at once, try again in a few minutes" } });
    expect((await upload(room, Buffer.from("someone else"), {}, "p2")).status).toBe(200);
  });
});

describe("room file durability", () => {
  it("is on disk with its row before the upload answers, and a retried uploadId adds nothing", async () => {
    const room = createRoom("Team").id;
    const bytes = png(4096);
    const first = await upload(room, bytes, { uploadId: "upload-0000000001" });
    expect(readFileSync(join(roomDir(room), first.json.file.id)).equals(bytes)).toBe(true);
    expect(rows(room)).toEqual([{ id: first.json.file.id, owner: "host", upload_id: "upload-0000000001" }]);
    const again = await upload(room, bytes, { uploadId: "upload-0000000001" });
    expect(again.json.file).toEqual(first.json.file);
    expect(await upload(room, png(4096), { uploadId: "upload-0000000001" })).toMatchObject({ status: 409, json: { error: "uploadId was used for another file" } });
    expect(await upload(room, bytes, { uploadId: "short" })).toMatchObject({ status: 400, json: { error: "bad uploadId" } });
    expect(readdirSync(roomDir(room))).toEqual([first.json.file.id]);
  });

  it("streams to disk as it arrives, and an upload cut halfway leaves no row and no file", async () => {
    const room = createRoom("Team").id;
    const req = request({ host: "127.0.0.1", port, method: "POST", path: `/rooms/${room}/files?uploadId=${newUploadId()}`, headers: { "content-length": String(8 * 1024 * 1024) }, agent: false });
    req.on("error", () => {});
    req.write(png(1024 * 1024));
    const deadline = Date.now() + 4_000;
    const temp = () => (existsSync(roomDir(room)) ? readdirSync(roomDir(room)).filter((name) => name.endsWith(".tmp")) : []);
    while (!(temp().length && statSync(join(roomDir(room), temp()[0]!)).size > 0)) {
      if (Date.now() > deadline) throw new Error("nothing on disk");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    req.destroy();
    while (temp().length) {
      if (Date.now() > deadline) throw new Error("temp file kept");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(rows(room)).toEqual([]);
    expect(readdirSync(roomDir(room))).toEqual([]);
  });

  it("sweeps half-written files, blobs without a row and day-old unsent uploads on start", async () => {
    const room = createRoom("Team").id;
    const sent = (await upload(room, Buffer.from("sent"))).json.file;
    const oldSent = (await upload(room, Buffer.from("old but sent"))).json.file;
    const fresh = (await upload(room, Buffer.from("not sent yet"))).json.file;
    const stale = (await upload(room, Buffer.from("never sent"))).json.file;
    appendRoomEntry(room, { author: { kind: "host", id: "host", name: "Edward" }, text: "", files: [sent, oldSent] });
    const old = Date.now() - 2 * 24 * 60 * 60_000;
    exec("UPDATE room_files SET at = ? WHERE id IN (?, ?)", old, stale.id, oldSent.id);
    writeFileSync(join(roomDir(room), `.${"x".repeat(24)}.tmp`), "half");
    writeFileSync(join(roomDir(room), "Z".repeat(24)), "no row");
    sweepRoomFiles();
    expect(readdirSync(roomDir(room)).sort()).toEqual([sent.id, oldSent.id, fresh.id].sort());
    expect(rows(room).map((row) => (row as { id: string }).id).sort()).toEqual([sent.id, oldSent.id, fresh.id].sort());
    expect(recentRoomEntries(room, 1)[0]!.files).toEqual([sent, oldSent]);
  });
});

describe("room file isolation", () => {
  it("never opens another room's id, a bad id, or anything through the attachment routes", async () => {
    const a = createRoom("A").id;
    const b = createRoom("B").id;
    const file = (await upload(a, png(100))).json.file;
    expect((await call("GET", `/rooms/${b}/files/${file.id}`)).status).toBe(404);
    expect((await call("GET", `/rooms/${a}/files/${"A".repeat(24)}`)).status).toBe(404);
    expect((await call("GET", `/rooms/${a}/files/..%2F..%2Frooms.db`)).status).toBe(404);
    expect(readAttachment(file.id)).toBeNull();
    expect(attachmentExists(file.id)).toBe(false);
    expect(join(DATA_DIR, "room-files").startsWith(ATTACHMENTS_DIR)).toBe(false);
  });

  it("puts no host path in any reply", async () => {
    const room = createRoom("Team").id;
    await upload(room, png(100), { name: `${DATA_DIR}\\secret\\cat.png` });
    await upload(room, Buffer.concat([Buffer.from("MZ"), randomBytes(100)]));
    await upload(room, Buffer.alloc(0));
    await call("GET", `/rooms/${room}/files/${"A".repeat(24)}`);
    rmSync(roomDir(room), { recursive: true, force: true });
    writeFileSync(roomDir(room), "a file where the folder goes");
    await upload(room, png(100));
    expect(replies.map((reply) => reply.status)).toEqual([200, 415, 400, 404, 500]);
    expect(replies[0]!.json.file.name).toBe("cat.png");
    const all = JSON.stringify(replies.map((reply) => [reply.headers, reply.body.toString("utf8")]));
    for (const path of [DATA_DIR, homedir(), DATA_DIR.replaceAll("\\", "\\\\"), "room-files", ".tmp"]) expect(all).not.toContain(path);
  });
});

describe("room file edges", () => {
  it("keeps a picked folder's own files through a boot sweep", async () => {
    const room = createRoom("Team").id;
    const file = (await upload(room, Buffer.from("kept"))).json.file;
    const pick = join(DATA_DIR, "Documents");
    mkdirSync(join(pick, "Photos"), { recursive: true });
    writeFileSync(join(pick, "notes.txt"), "mine");
    writeFileSync(join(pick, "Photos", "trip.jpg"), "mine");
    await moveRoomFiles(pick);
    mkdirSync(join(roomFilesRoot(), "Scans"));
    writeFileSync(join(roomFilesRoot(), "Scans", "receipt.pdf"), "mine");
    sweepRoomFiles();
    expect(readFileSync(join(pick, "notes.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(pick, "Photos", "trip.jpg"), "utf8")).toBe("mine");
    expect(readFileSync(join(roomFilesRoot(), "Scans", "receipt.pdf"), "utf8")).toBe("mine");
    expect((await call("GET", `/rooms/${room}/files/${file.id}`)).status).toBe(200);
  });

  it("keeps the current picture and sweeps a replaced day-old picture", async () => {
    const room = createRoom("Team").id;
    const old = (await upload(room, png(64))).json.file;
    const current = (await upload(room, png(64))).json.file;
    exec("UPDATE room_files SET at = ?", Date.now() - 25 * 60 * 60_000);
    (sweepRoomFiles as (...args: unknown[]) => void)([{ hosted: { roomId: room }, picture: current.id }]);
    expect((await call("GET", `/rooms/${room}/files/${current.id}/preview`)).status).toBe(200);
    expect((await call("GET", `/rooms/${room}/files/${old.id}/preview`)).status).toBe(404);
  });

  it("hold a room's cap when uploads race for the last space", async () => {
    const room = createRoom("Team").id;
    expect((await upload(room, Buffer.from("first"))).status).toBe(200);
    exec("INSERT INTO room_files (room_id, id, owner, name, type, bytes, sha256, at) VALUES (?, ?, 'host', 'big', 'text/plain', ?, '', ?)", room, "B".repeat(24), ROOM_DISK_BYTES - 1_005, Date.now());
    const results = await Promise.all([1, 2, 3].map(() => upload(room, [Buffer.alloc(300, "a"), Buffer.alloc(300, "b")])));
    expect(results.filter((result) => result.status === 200).length).toBeLessThanOrEqual(1);
    const total = new DatabaseSync(join(DATA_DIR, "rooms.db"));
    try {
      expect((total.prepare("SELECT SUM(bytes) AS bytes FROM room_files WHERE room_id = ?").get(room) as { bytes: number }).bytes).toBeLessThanOrEqual(ROOM_DISK_BYTES);
    } finally {
      total.close();
    }
  });

  it("cut a long name on a whole character, so the file still downloads", async () => {
    const room = createRoom("Team").id;
    const file = (await upload(room, png(100), { name: `${"a".repeat(199)}😀.png` })).json.file;
    expect(file.name).toBe("a".repeat(199));
    expect((await call("GET", `/rooms/${room}/files/${file.id}`)).status).toBe(200);
  });

  it("close the blob when a download is cut short", async () => {
    const room = createRoom("Team").id;
    const file = (await upload(room, Array.from({ length: 8 }, () => Buffer.alloc(1024 * 1024, "a")))).json.file;
    const destroy = vi.spyOn(ReadStream.prototype, "destroy");
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: `/rooms/${room}/files/${file.id}`, agent: false }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.end();
    });
    const deadline = Date.now() + 2_000;
    while (!destroy.mock.calls.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(destroy).toHaveBeenCalled();
    destroy.mockRestore();
  });
});

describe("room file writes, quota and retries", () => {
  it("keep every byte when the disk takes a write short", async () => {
    const room = createRoom("Team").id;
    const bytes = png(2048);
    disk.shortWrites = true;
    try {
      const file = (await upload(room, bytes)).json.file;
      expect(readFileSync(join(roomDir(room), file.id)).equals(bytes)).toBe(true);
      expect(sha((await call("GET", `/rooms/${room}/files/${file.id}`)).body)).toBe(sha(bytes));
    } finally {
      disk.shortWrites = false;
    }
  });

  it("let exactly one of two racing uploads take room for one", async () => {
    const room = createRoom("Team").id;
    expect((await upload(room, Buffer.from("first"))).status).toBe(200);
    exec("INSERT INTO room_files (room_id, id, owner, name, type, bytes, sha256, at) VALUES (?, ?, 'host', 'big', 'text/plain', ?, '', ?)", room, "D".repeat(24), ROOM_DISK_BYTES - 1_005, Date.now());
    const results = await Promise.all([1, 2].map(() => upload(room, [Buffer.alloc(300, "a"), Buffer.alloc(300, "b")])));
    expect(results.map((result) => result.status).sort()).toEqual([200, 507]);
    expect(results.find((result) => result.status === 507)!.json).toEqual({ error: "this room is out of space for files" });
    const total = new DatabaseSync(join(DATA_DIR, "rooms.db"));
    try {
      expect((total.prepare("SELECT SUM(bytes) AS bytes FROM room_files WHERE room_id = ?").get(room) as { bytes: number }).bytes).toBeLessThanOrEqual(ROOM_DISK_BYTES);
    } finally {
      total.close();
    }
  });

  it("turn down an upload with no uploadId", async () => {
    const room = createRoom("Team").id;
    expect(await call("POST", `/rooms/${room}/files?name=a.txt`, { body: Buffer.from("hello") })).toMatchObject({ status: 400, json: { error: "bad uploadId" } });
    expect(existsSync(roomDir(room))).toBe(false);
  });

  it("fail the upload before its row when the folder won't sync, but not where folders can't sync", async () => {
    const room = createRoom("Team").id;
    disk.failSync = { path: roomDir(room), code: "EIO" };
    try {
      expect(await upload(room, Buffer.from("hello"))).toMatchObject({ status: 500, json: { error: "couldn't save the file" } });
      expect(rows(room)).toEqual([]);
      expect(readdirSync(roomDir(room))).toEqual([]);
      disk.failSync = { path: roomDir(room), code: "EPERM" };
      expect((await upload(room, Buffer.from("hello"))).status).toBe(200);
    } finally {
      disk.failSync = null;
    }
  });
});
