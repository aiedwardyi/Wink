import { createHash, randomBytes } from "node:crypto";
import { closeSync, createReadStream, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as requestHttps, type Server } from "node:https";
import { createConnection, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { PHONE_RELAY_OFF } from "../../shared/relay-protocol.ts";
import { DATA_DIR } from "../config.ts";
import { PhoneAccess } from "../phone-access.ts";
import { httpsRequest } from "../phone-relay/https.ts";
import { loopbackLookup } from "../phone-relay/testing/fake-relay.ts";
import { listenLocal } from "../phone-relay/testing/net.ts";
import { TestCa } from "../phone-relay/testing/pki.ts";
import { isRelayRequest, markRelaySocket } from "../phone-relay/via.ts";
import { Store } from "../store.ts";
import { closeAsksDb, configureRoomAsks, roomAskHooks, type HostedGroup } from "./asks.ts";
import { appendRoomEntry, closeRoomsDb, recentRoomEntries, roomPeople } from "./db.ts";
import { broadcastDoorEntry } from "./door-streams.ts";
import { configureRoomDoor, handleRoomDoor, removeRoomPerson } from "./door.ts";
import { hostFileRoute } from "./file-routes.ts";
import { GuestClient } from "./guest-client.ts";
import { closeInvitesDb, createInvite } from "./invites.ts";
import { joinedFileRoute } from "./joined-files.ts";
import { joinedRoute } from "./joined-routes.ts";
import { closeJoinedDb, joinedEntries, joinedKey, joinedRoom, resetJoined } from "./joined.ts";
import { createPeopleOnlyRoom } from "./people-only.ts";
import { hostedSend } from "./send.ts";

const disk = vi.hoisted(() => ({ shortWrites: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (...args: Parameters<typeof fs.open>) =>
    new Proxy(await fs.open(...args), {
      get(target, key) {
        if (key === "write" && disk.shortWrites) return (buffer: Buffer, offset = 0, length = buffer.length - offset) => target.write(buffer, offset, Math.min(length, 7));
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return { ...fs, open };
});

const BASE = "wink.test";
const HOST = `abcdefghijklmnop.${BASE}`;

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json: any;
}

let door: Server;
let local: HttpServer;
let localPort = 0;
let caPem = "";
let access: PhoneAccess;
let store: Store;
let engine: Record<"sendTurn" | "generateText" | "generateReview" | "answerWords", ReturnType<typeof vi.fn>>;
let client: GuestClient | null = null;

const hop = {
  server: null as TcpServer | null,
  port: 0,
  up: true,
  pairs: new Set<Socket>(),
  drop() {
    for (const socket of this.pairs) socket.destroy();
    this.pairs.clear();
  },
};

async function app(req: IncomingMessage, res: ServerResponse) {
  if (isRelayRequest(req) && (await access.gate(req, res)).handled) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

/** Both PCs' local routes, mounted the way index.ts mounts them. */
async function localApp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  if (client && (await joinedFileRoute(req, res, method, url, client))) return;
  if (await hostFileRoute(req, res, method, url, { store, hostName: () => "Edward", botCaller: false })) return;
  res.writeHead(404).end();
}

beforeAll(async () => {
  const ca = await TestCa.create();
  caPem = ca.certPem;
  const { keyPem, certPem } = await ca.issue(HOST);
  door = createHttpsServer({ key: keyPem, cert: certPem }, (req, res) => void app(req, res));
  door.on("secureConnection", (socket: TLSSocket) => markRelaySocket(socket));
  const doorPort = await listenLocal(door);
  // The relay keeps half-closes open while the response tail drains.
  hop.server = createTcpServer({ allowHalfOpen: true }, (inbound) => {
    if (!hop.up) return inbound.destroy();
    const outbound = createConnection({ host: "127.0.0.1", port: doorPort, allowHalfOpen: true });
    for (const [a, b] of [[inbound, outbound], [outbound, inbound]] as const) {
      hop.pairs.add(a);
      a.on("error", () => {});
      a.on("close", () => {
        hop.pairs.delete(a);
        b.destroy();
      });
      a.pipe(b);
    }
  });
  hop.port = await listenLocal(hop.server);
  local = createServer((req, res) => void localApp(req, res));
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  localPort = (local.address() as AddressInfo).port;
  const relay = { status: () => ({ ...PHONE_RELAY_OFF, state: "connected" as const, host: HOST }), stop: async () => {} };
  access = new PhoneAccess({
    dataDir: DATA_DIR,
    env: {},
    staticDir: null,
    config: () => ({ base: BASE, enabled: true }),
    saveEnabled: () => {},
    start: () => relay,
    loadClient: async () => ({ start: () => relay, enroll: async () => {}, peer: () => "203.0.113.7" }),
    room: handleRoomDoor,
  });
  await access.start(app);
});

afterAll(async () => {
  await access.stop();
  hop.drop();
  door.closeAllConnections();
  local.closeAllConnections();
  await new Promise((resolve) => door.close(resolve));
  await new Promise((resolve) => hop.server!.close(resolve));
  await new Promise((resolve) => local.close(resolve));
});

const close = () => {
  client?.stop();
  client = null;
  configureRoomDoor(null);
  configureRoomAsks(null);
  closeAsksDb();
  closeInvitesDb();
  closeRoomsDb();
  closeJoinedDb();
};

/** The host PC's server coming up: asks, then the door. */
function hostUp() {
  engine = { sendTurn: vi.fn(), generateText: vi.fn(), generateReview: vi.fn(), answerWords: vi.fn() };
  configureRoomAsks({
    store,
    hostName: () => "Edward",
    instance: vi.fn(() => ({ ...engine, adapter: { sendTurn: engine.sendTurn } }) as never),
    dispatch: vi.fn(),
    stopTurn: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
  });
  configureRoomDoor({ store, hostName: () => "Edward" });
}

beforeEach(() => {
  close();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  hop.up = true;
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  roomAskHooks.words = vi.fn();
  hostUp();
});

afterEach(() => {
  delete roomAskHooks.words;
  vi.restoreAllMocks();
  hop.drop();
  door.closeAllConnections();
  close();
});

const teammate = () =>
  (client = new GuestClient({
    bases: () => [null, BASE],
    joiner: () => ({ name: "Mina", device: "pc-mina-0123456789abcdef" }),
    https: { ca: caPem, lookup: loopbackLookup, port: hop.port },
    timing: { retryMs: 50, maxRetryMs: 200 },
  }));

const until = async (test: () => boolean, ms = 4_000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

async function joinedTeam(name = "Mina") {
  const group = store.createGroup("Team", [], false, undefined, undefined, { roomId: createPeopleOnlyRoom("Team").id }) as HostedGroup;
  hostedSend(group, { kind: "host" }, "welcome");
  const c = teammate();
  // As the local routes do: start first, so a later start() can't follow the room twice.
  c.start();
  const { invite, secret } = createInvite(group.hosted.roomId, name, "chat", ["Edward"]);
  const result = await c.join(`wkr1:${HOST}:${invite.id}.${secret}`);
  if (!result.ok) throw new Error(result.error);
  await until(() => c.rooms()[0]?.link === "live");
  return { group, c, roomId: group.hosted.roomId };
}

function call(method: string, path: string, body?: Buffer, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: localPort, method, path, agent: false, headers: { ...headers, ...(body ? { "content-length": String(body.length) } : {}) } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => {
        const all = Buffer.concat(parts);
        let json: unknown = null;
        try {
          json = JSON.parse(all.toString("utf8"));
        } catch {}
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: all, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const png = (size: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(size - 8)]);
const pdf = (size: number) => Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(size - 9)]);

const newUploadId = () => randomBytes(12).toString("base64url");
const hostUpload = async (roomId: string, bytes: Buffer, name: string) => (await call("POST", `/api/rooms/${roomId}/files?uploadId=${newUploadId()}&name=${name}`, bytes)).json.file;
const guestUpload = (roomId: string, bytes: Buffer, name: string, uploadId = newUploadId()) =>
  call("POST", `/api/joined/rooms/${roomId}/files?${new URLSearchParams({ name, uploadId })}`, bytes);
const filesOf = (roomId: string, text: string) => joinedEntries(roomId, 500).find((entry) => entry.text === text)?.files ?? [];

function guestDelete(roomId: string, fileId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = requestHttps({ hostname: HOST, port: hop.port, ca: caPem, lookup: loopbackLookup, method: "DELETE",
      path: `/room/v1/rooms/${roomId}/files/${fileId}`, headers: { host: HOST, origin: `https://${HOST}`, authorization: `Bearer ${joinedKey(roomId)!.key}` } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end();
  });
}

async function streamUpload(base: string, source: string, bytes: number) {
  return new Promise<{ status: number; file?: any }>((resolve, reject) => {
    const body = createReadStream(source);
    let answered = false;
    const req = request({ host: "127.0.0.1", port: localPort, method: "POST", path: `${base}/files?uploadId=${newUploadId()}&name=large.pdf`, headers: { "content-length": String(bytes) }, agent: false }, (res) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        body.destroy();
        const done = () => resolve({ status: res.statusCode!, ...JSON.parse(Buffer.concat(chunks).toString()) });
        if (body.closed) done(); else body.once("close", done);
      });
      res.on("error", reject);
    });
    req.on("error", (error) => { body.destroy(); if (!answered) reject(error); });
    body.on("error", reject);
    body.pipe(req);
  });
}

async function streamDownload(path: string) {
  return new Promise<{ status: number; bytes: number; sha256: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: localPort, path, agent: false }, (res) => {
      const hash = createHash("sha256");
      let bytes = 0;
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); });
      res.on("end", () => resolve({ status: res.statusCode!, bytes, sha256: hash.digest("hex") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function sparseSource(bytes: number, head: Buffer): string {
  const path = join(process.env.ORBIT_SCRATCH ?? DATA_DIR, `room-files-${process.pid}-${newUploadId()}.bin`);
  const fd = openSync(path, "wx");
  try { ftruncateSync(fd, bytes); writeSync(fd, head); }
  finally { closeSync(fd); }
  return path;
}

describe("large room file streams", () => {
  it("accepts a 100 MB image and refuses 101 MB", async () => {
    const { roomId } = await joinedTeam();
    const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = sparseSource(100 * 1024 ** 2, head);
    try {
      expect(await streamUpload(`/api/rooms/${roomId}`, source, 100 * 1024 ** 2)).toMatchObject({ status: 200, file: { bytes: 100 * 1024 ** 2, type: "image/png" } });
      const fd = openSync(source, "r+");
      try { ftruncateSync(fd, 101 * 1024 ** 2); } finally { closeSync(fd); }
      expect(await streamUpload(`/api/joined/rooms/${roomId}`, source, 101 * 1024 ** 2)).toMatchObject({ status: 413 });
    } finally { rmSync(source, { force: true }); }
  }, 120_000);

  it("streams a gibibyte host upload, teammate upload and teammate download below 200 MB extra RSS", async () => {
    const { c, group, roomId } = await joinedTeam();
    const bytes = 1024 ** 3;
    const source = sparseSource(bytes, Buffer.from("%PDF-1.7\n"));
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const monitor = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
    const blobs: string[] = [];
    try {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(source)) hash.update(chunk);
      const sha256 = hash.digest("hex");
      const host = await streamUpload(`/api/rooms/${roomId}`, source, bytes);
      expect(host).toMatchObject({ status: 200, file: { bytes, sha256 } });
      blobs.push(join(DATA_DIR, "room-files", roomId, host.file.id), join(DATA_DIR, "joined-files", roomId, host.file.id));
      hostedSend(group, { kind: "host" }, "gigabyte", undefined, undefined, [host.file.id]);
      await until(() => filesOf(roomId, "gigabyte").length === 1);
      expect(await streamDownload(`/api/joined/rooms/${roomId}/files/${host.file.id}`)).toEqual({ status: 200, bytes, sha256 });
      const guest = await streamUpload(`/api/joined/rooms/${roomId}`, source, bytes);
      expect(guest).toMatchObject({ status: 200, file: { bytes, sha256 } });
      blobs.push(join(DATA_DIR, "room-files", roomId, guest.file.id));
      expect(await c.send(roomId, "guest gigabyte", undefined, undefined, [guest.file.id])).toMatchObject({ ok: true });
      expect(await streamDownload(`/api/rooms/${roomId}/files/${guest.file.id}`)).toEqual({ status: 200, bytes, sha256 });
      const extra = (peak - baseline) / 1024 ** 2;
      console.log(`ROOM-FILES 1 GiB host upload + teammate upload/download SHA256 matched; peak RSS +${extra.toFixed(1)} MB (baseline ${(baseline / 1024 ** 2).toFixed(1)} MB)`);
      expect(extra).toBeLessThan(200);
    } finally {
      clearInterval(monitor);
      rmSync(source, { force: true });
      for (const path of blobs) rmSync(path, { force: true });
    }
  }, 180_000);
});

describe("pictures and files in a team room, through the real door", () => {
  it("refuses teammate deletion with 403", async () => {
    const { roomId } = await joinedTeam();
    const file = await hostUpload(roomId, pdf(100), "plan.pdf");
    expect(await guestDelete(roomId, file.id)).toBe(403);
    expect((await call("DELETE", `/api/joined/rooms/${roomId}/files/${file.id}`)).status).toBe(403);
    expect(existsSync(join(DATA_DIR, "room-files", roomId, file.id))).toBe(true);
  });

  it("deletes a host file from disk and replaces it in host and teammate history", async () => {
    const { c, group, roomId } = await joinedTeam();
    const file = await hostUpload(roomId, pdf(100), "plan.pdf");
    hostedSend(group, { kind: "host" }, "delete me", undefined, undefined, [file.id]);
    await until(() => filesOf(roomId, "delete me").length === 1);
    expect(await c.file(roomId, file.id)).toMatchObject({ ok: true });
    expect((await call("DELETE", `/api/rooms/${roomId}/files/${file.id}`)).status).toBe(200);
    await until(() => filesOf(roomId, "delete me")[0]?.deleted === true);
    expect(existsSync(join(DATA_DIR, "room-files", roomId, file.id))).toBe(false);
    expect(store.messagesFor(group.threadId).at(-1)?.roomFiles?.[0]).toMatchObject({ deleted: true });
    closeRoomsDb();
    expect(recentRoomEntries(roomId, 10).at(-1)?.files?.[0]).toMatchObject({ deleted: true });
    expect(await c.file(roomId, file.id)).toMatchObject({ ok: false, status: 404 });
    expect((await call("GET", `/api/rooms/${roomId}/files-state`)).json.deleted).toContain(file.id);
  });

  it("keeps a teammate's 250 held lines when the host deletes a file", async () => {
    const { group, roomId } = await joinedTeam();
    const file = await hostUpload(roomId, pdf(100), "plan.pdf");
    hostedSend(group, { kind: "host" }, "delete me", undefined, undefined, [file.id]);
    for (let i = 0; i < 248; i += 1) hostedSend(group, { kind: "host" }, `line ${i}`);
    await until(() => joinedEntries(roomId, 500).length === 250);
    expect((await call("DELETE", `/api/rooms/${roomId}/files/${file.id}`)).status).toBe(200);
    await until(() => filesOf(roomId, "delete me")[0]?.deleted === true);
    expect(joinedEntries(roomId, 500)).toHaveLength(250);
  });

  it("lists every room file newest first and only lets the host delete", async () => {
    const { c, group, roomId } = await joinedTeam();
    const host = await hostUpload(roomId, pdf(100), "plan.pdf");
    const guest = (await guestUpload(roomId, png(100), "photo.png")).json.file;
    await c.send(roomId, "shared", undefined, undefined, [guest.id]);
    expect(await call("GET", `/api/rooms/${roomId}/files`)).toMatchObject({ status: 200, json: {
      used: 200, capacity: 100 * 1024 ** 3, files: [{ id: guest.id, sender: "Mina" }, { id: host.id, sender: "Edward" }],
    } });
    expect(await guestDelete(roomId, guest.id)).toBe(403);
    expect(await call("DELETE", `/api/rooms/${roomId}/files/${guest.id}`)).toMatchObject({ status: 200 });
    await until(() => filesOf(roomId, "shared")[0]?.deleted === true);
    expect(existsSync(join(DATA_DIR, "room-files", roomId, guest.id))).toBe(false);
    expect(store.messagesFor(group.threadId).at(-1)?.roomFiles?.[0]).toMatchObject({ deleted: true });
    expect(recentRoomEntries(roomId, 10).at(-1)?.files?.[0]).toMatchObject({ deleted: true });
    expect((await call("GET", `/api/joined/rooms/${roomId}/files/${guest.id}`)).status).toBe(404);
  });

  it("moves room files after verifying their size and sha256", async () => {
    const { roomId } = await joinedTeam();
    const bytes = pdf(200);
    const file = await hostUpload(roomId, bytes, "kept.pdf");
    const folder = join(DATA_DIR, "another-drive", "Wink room files");
    expect(await call("PUT", "/api/room-files-folder", Buffer.from(JSON.stringify({ path: join(DATA_DIR, "another-drive") })))).toMatchObject({ status: 200, json: { path: folder, error: null } });
    expect(sha(readFileSync(join(folder, roomId, file.id)))).toBe(file.sha256);
    expect(existsSync(join(DATA_DIR, "room-files", roomId, file.id))).toBe(false);
    expect((await call("GET", `/api/rooms/${roomId}/files/${file.id}`)).body).toEqual(bytes);
  });

  it("accepts 50 files in one message and refuses 51", async () => {
    const { c, roomId } = await joinedTeam();
    const files = [];
    for (let n = 0; n < 50; n++) files.push((await guestUpload(roomId, pdf(20), `plan-${n}.pdf`)).json.file);
    expect(files.every(Boolean)).toBe(true);
    const ids = files.map((file) => file.id);
    expect(await c.send(roomId, "fifty", undefined, undefined, ids)).toMatchObject({ ok: true });
    expect(await c.send(roomId, "fifty-one", undefined, undefined, [...ids, ids[0]])).toMatchObject({ ok: false, status: 400 });
    expect((await call("POST", `/api/rooms/${roomId}/send`, Buffer.from(JSON.stringify({ text: "fifty-one", fileIds: [...ids, ids[0]] })))).status).toBe(400);
  });

  it("fetches a room picture once per id, persists it and refuses removed or unrelated pictures", async () => {
    const { c, group, roomId } = await joinedTeam();
    const bytes = png(128);
    const file = await hostUpload(roomId, bytes, "room.png");
    store.patchGroup(group.id, { picture: file.id } as never);
    await until(() => (c.room(roomId)?.state as any)?.picture === file.id);
    const first = await call("GET", `/api/joined/rooms/${roomId}/picture`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual(bytes);
    expect((await call("GET", `/api/joined/rooms/${roomId}/files/${file.id}/preview`)).status).toBe(404);
    hop.up = false;
    hop.drop();
    closeJoinedDb();
    expect((await call("GET", `/api/joined/rooms/${roomId}/picture`)).body).toEqual(bytes);
    hop.up = true;
    await until(() => c.rooms()[0]?.link === "live");
    store.patchGroup(group.id, { picture: undefined } as never);
    await until(() => !(c.room(roomId)?.state as any)?.picture);
    expect((await call("GET", `/api/joined/rooms/${roomId}/picture`)).status).toBe(404);
  });

  it("clears the room picture when its file is deleted from the Files list", async () => {
    const { c, group, roomId } = await joinedTeam();
    const file = await hostUpload(roomId, png(128), "room.png");
    store.patchGroup(group.id, { picture: file.id } as never);
    await until(() => (c.room(roomId)?.state as any)?.picture === file.id);
    expect((await call("DELETE", `/api/rooms/${roomId}/files/${file.id}`)).status).toBe(200);
    expect(store.group(group.id)?.picture).toBeUndefined();
    await until(() => !(c.room(roomId)?.state as any)?.picture);
  });

  it("go both ways, and every byte matches by SHA-256", async () => {
    const { c, group, roomId } = await joinedTeam();
    const hostPicture = png(300 * 1024);
    const hostDoc = pdf(700 * 1024);
    const sent = await call("POST", `/api/rooms/${roomId}/send`, Buffer.from(JSON.stringify({
      text: "from host",
      fileIds: [(await hostUpload(roomId, hostPicture, "plan.png")).id, (await hostUpload(roomId, hostDoc, "plan.pdf")).id],
    })));
    expect(sent).toMatchObject({ status: 200, json: { entry: { text: "from host", files: [{ name: "plan.png", type: "image/png" }, { name: "plan.pdf", type: "application/pdf" }] } } });
    await until(() => filesOf(roomId, "from host").length === 2);
    const [picture, doc] = filesOf(roomId, "from host");
    const gotPicture = await call("GET", `/api/joined/rooms/${roomId}/files/${picture!.id}/preview`);
    expect(gotPicture.status, JSON.stringify(gotPicture.json)).toBe(200);
    expect(gotPicture.headers).toMatchObject({ "content-type": "image/png", "content-disposition": expect.stringMatching(/^inline;/), "x-content-type-options": "nosniff" });
    expect(sha(gotPicture.body)).toBe(sha(hostPicture));
    const gotDoc = await call("GET", `/api/joined/rooms/${roomId}/files/${doc!.id}`);
    expect(gotDoc.status, JSON.stringify(gotDoc.json)).toBe(200);
    expect(gotDoc.headers).toMatchObject({ "content-type": "application/octet-stream", "content-disposition": expect.stringMatching(/^attachment;/) });
    expect(sha(gotDoc.body)).toBe(sha(hostDoc));
    expect((await call("GET", `/api/joined/rooms/${roomId}/files/${doc!.id}/preview`)).status).toBe(404);

    const minaPicture = png(200 * 1024);
    const minaDoc = Buffer.from("name,amount\n김민아,3\n".repeat(2000));
    const up = [(await guestUpload(roomId, minaPicture, "photo.png")).json.file, (await guestUpload(roomId, minaDoc, "list.csv")).json.file];
    expect(up).toMatchObject([{ type: "image/png", sha256: sha(minaPicture) }, { type: "text/plain", sha256: sha(minaDoc) }]);
    expect(await c.send(roomId, "from Mina", undefined, undefined, up.map((file) => file.id))).toMatchObject({ ok: true, value: { files: up } });
    const mirrored = store.messagesFor(group.threadId).at(-1)!;
    expect(mirrored).toMatchObject({ text: "from Mina", author: { kind: "person", name: "Mina" }, roomFiles: up });
    expect(sha((await call("GET", `/api/rooms/${roomId}/files/${up[0].id}/preview`)).body)).toBe(sha(minaPicture));
    expect(sha((await call("GET", `/api/rooms/${roomId}/files/${up[1].id}`)).body)).toBe(sha(minaDoc));
    for (const [method, path] of [["POST", `/api/rooms/${roomId}/files/${up[0].id}`], ["GET", `/api/rooms/other/files/${up[0].id}`]]) {
      expect((await call(method!, path!)).status, `${method} ${path}`).toBe(404);
    }
    for (const spy of Object.values(engine)) expect(spy).not.toHaveBeenCalled();
  });

  it("refresh and restart keep the history and the bytes", async () => {
    const { c, roomId } = await joinedTeam();
    const picture = png(64 * 1024);
    const file = (await guestUpload(roomId, picture, "photo.png")).json.file;
    await c.send(roomId, "kept", undefined, undefined, [file.id]);
    await until(() => filesOf(roomId, "kept").length === 1);
    resetJoined(roomId);
    c.stop();
    c.start();
    await until(() => filesOf(roomId, "kept").length === 1);
    close();
    hostUp();
    const after = teammate();
    after.start();
    await until(() => after.rooms()[0]?.link === "live");
    expect(recentRoomEntries(roomId, 5).at(-1)).toMatchObject({ text: "kept", files: [file] });
    expect(sha((await call("GET", `/api/joined/rooms/${roomId}/files/${file.id}`)).body)).toBe(sha(picture));
    expect(sha((await call("GET", `/api/rooms/${roomId}/files/${file.id}`)).body)).toBe(sha(picture));
    hop.up = false;
    hop.drop();
    expect(sha((await call("GET", `/api/joined/rooms/${roomId}/files/${file.id}`)).body)).toBe(sha(picture));
  });

  it("a retried upload and a retried send add nothing", async () => {
    const { c, roomId } = await joinedTeam();
    const bytes = pdf(32 * 1024);
    const first = await guestUpload(roomId, bytes, "a.pdf", "upload-retry-000001");
    const again = await guestUpload(roomId, bytes, "a.pdf", "upload-retry-000001");
    expect(again.json).toEqual(first.json);
    expect(readdirSync(join(DATA_DIR, "room-files", roomId))).toEqual([first.json.file.id]);
    const sent = await c.send(roomId, "once", undefined, "send-retry-0000001", [first.json.file.id]);
    const resent = await c.send(roomId, "once", undefined, "send-retry-0000001", [first.json.file.id]);
    expect(resent).toEqual(sent);
    expect(recentRoomEntries(roomId, 5).map((entry) => entry.text)).toEqual(["welcome", "once"]);
  });

  it("Remove cuts later blob access, and a copy that doesn't match its entry is never kept", async () => {
    const { c, roomId, group } = await joinedTeam();
    const first = await hostUpload(roomId, png(4096), "a.png");
    const second = await hostUpload(roomId, png(4096), "b.png");
    hostedSend(group, { kind: "host" }, "two", undefined, undefined, [first.id, second.id]);
    await until(() => filesOf(roomId, "two").length === 2);
    writeFileSync(join(DATA_DIR, "room-files", roomId, second.id), png(4096));
    expect(await c.file(roomId, second.id)).toEqual({ ok: false, status: 503, error: "unavailable" });
    expect(readdirSync(join(DATA_DIR, "joined-files", roomId))).toEqual([]);
    const key = joinedKey(roomId)!.key;
    removeRoomPerson(roomId, roomPeople(roomId)[0]!.id);
    await until(() => joinedRoom(roomId)?.status === "removed");
    expect(await c.file(roomId, first.id)).toEqual({ ok: false, status: 409, error: "this room is read-only" });
    const direct = await httpsRequest(
      { method: "GET", url: `https://${HOST}/room/v1/rooms/${roomId}/files/${first.id}`, headers: { host: HOST, authorization: `Bearer ${key}` }, timeoutMs: 4_000, maxBytes: 1_000_000 },
      { ca: caPem, lookup: loopbackLookup, port: hop.port },
    );
    expect(direct.status).toBe(401);
    expect((await guestUpload(roomId, png(100), "late.png")).status).toBe(409);
  });

  it("the local send route carries the uploaded files", async () => {
    const { c, roomId } = await joinedTeam();
    const file = (await guestUpload(roomId, png(2048), "photo.png")).json.file;
    const reply = await joinedRoute("POST", `/api/joined/rooms/${roomId}/send`, c, async () => ({ text: "", fileIds: [file.id] }));
    expect(reply).toMatchObject({ status: 200, body: { entry: { files: [file] } } });
  });

  it("never takes in a host file whose type or size no upload could have", async () => {
    const { roomId } = await joinedTeam();
    const odd = { id: "C".repeat(24), name: "x", sha256: "0".repeat(64) };
    broadcastDoorEntry(roomId, appendRoomEntry(roomId, { author: { kind: "host", id: "host", name: "Edward" }, text: "bad type", files: [{ ...odd, type: "image/svg+xml", bytes: 10 }] }));
    broadcastDoorEntry(roomId, appendRoomEntry(roomId, { author: { kind: "host", id: "host", name: "Edward" }, text: "too big", files: [{ ...odd, type: "image/png", bytes: 101 * 1024 * 1024 }] }));
    hostedSend(store.groups[0] as HostedGroup, { kind: "host" }, "after");
    await until(() => joinedEntries(roomId, 10).some((entry) => entry.text === "after"));
    expect(joinedEntries(roomId, 10).map((entry) => entry.text)).toEqual(["welcome", "after"]);
  });
});

/** The entry 1.0.256 parses: one bad file type fails the whole line or snapshot. */
const olderEntry = z.object({
  seq: z.number().int().positive(),
  id: z.string().regex(/^[\w-]{1,64}$/),
  at: z.number(),
  author: z.object({ kind: z.enum(["host", "person", "bot"]), id: z.string().regex(/^[\w-]{1,64}$/), name: z.string().max(200) }),
  text: z.string().max(20_000),
  replyToId: z.string().regex(/^[\w-]{1,64}$/).optional(),
  files: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{24}$/),
    name: z.string().max(200),
    type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "application/zip", "application/x-ole-storage", "text/plain"]),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    deleted: z.boolean().optional(),
  })).max(50).optional(),
});
const olderSnapshot = z.object({ head: z.number().int().nonnegative(), entries: z.array(olderEntry).max(1_000), state: z.unknown() });

/** A 1.0.256 teammate's door request: it sends the large-files header and nothing newer. */
function olderDoor(roomId: string, path: string, body?: Buffer) {
  let text = "";
  let status = 0;
  const done = new Promise<void>((resolve) => {
    const req = requestHttps({
      hostname: HOST, port: hop.port, ca: caPem, lookup: loopbackLookup, method: body ? "POST" : "GET", path: `/room/v1/rooms/${roomId}/${path}`,
      headers: {
        host: HOST, origin: `https://${HOST}`, authorization: `Bearer ${joinedKey(roomId)!.key}`, "x-wink-device": "pc-mina-0123456789abcdef", "x-orbit-room-files": "1",
        ...(body ? { "content-length": String(body.length) } : {}),
      },
    }, (res) => {
      status = res.statusCode!;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", resolve);
      res.on("error", resolve);
    });
    req.on("error", () => resolve());
    req.end(body);
    older.push(req);
  });
  const frames = () => text.split("\n\n").slice(0, -1).filter((block) => block.startsWith("data: ")).map((block) => JSON.parse(block.slice(6)) as { kind: string; entry?: unknown });
  return { done, frames, status: () => status, json: () => JSON.parse(text) };
}

let older: Array<{ destroy(): void }> = [];
afterEach(() => {
  for (const req of older) req.destroy();
  older = [];
});

describe("a teammate on 1.0.256 and video or audio files", () => {
  const mp4 = (size: number) => Buffer.concat([Buffer.from("\0\0\0\x18ftypisom\0\0\x02\0isomiso2", "latin1"), randomBytes(size - 24)]);
  const mp3 = (size: number) => Buffer.concat([Buffer.from("ID3\x04\0\0\0\0\0\0", "latin1"), randomBytes(size - 10)]);

  it("keeps the room live and loadable, with the media named in the line", async () => {
    const { roomId } = await joinedTeam();
    const stream = olderDoor(roomId, `stream?after=${recentRoomEntries(roomId, 1)[0]!.seq}&with=bots`);
    await until(() => stream.frames().some((frame) => frame.kind === "state"));
    const fileIds = [(await hostUpload(roomId, mp4(4096), "clip.mp4")).id, (await hostUpload(roomId, mp3(4096), "song.mp3")).id, (await hostUpload(roomId, pdf(2048), "plan.pdf")).id];
    expect((await call("POST", `/api/rooms/${roomId}/send`, Buffer.from(JSON.stringify({ text: "watch this", fileIds })))).status).toBe(200);

    await until(() => filesOf(roomId, "watch this").length === 3);
    expect(filesOf(roomId, "watch this").map((file) => file.type)).toEqual(["video/mp4", "audio/mpeg", "application/pdf"]);
    await until(() => stream.frames().some((frame) => frame.kind === "entry"));
    const live = olderEntry.safeParse(stream.frames().find((frame) => frame.kind === "entry")!.entry);
    expect(live.success, JSON.stringify(live.error?.issues)).toBe(true);
    expect(live.data).toMatchObject({ text: "watch this\nclip.mp4\nsong.mp3", files: [{ name: "plan.pdf" }] });

    const snapshot = olderDoor(roomId, "snapshot?with=bots");
    await snapshot.done;
    const parsed = olderSnapshot.safeParse(snapshot.json());
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data!.entries.at(-1)).toMatchObject({ text: "watch this\nclip.mp4\nsong.mp3" });
  });

  it("refuses its video upload before keeping any bytes, while a current teammate's goes through", async () => {
    const { roomId } = await joinedTeam();
    const upload = olderDoor(roomId, `files?${new URLSearchParams({ uploadId: newUploadId(), name: "clip.mp4" })}`, mp4(4096));
    await upload.done;
    expect(upload.status()).toBe(415);
    expect((await call("GET", `/api/rooms/${roomId}/files`)).json.files).toEqual([]);
    expect(existsSync(join(DATA_DIR, "room-files", roomId)) ? readdirSync(join(DATA_DIR, "room-files", roomId)) : []).toEqual([]);
    expect((await guestUpload(roomId, mp4(4096), "clip.mp4")).json.file).toMatchObject({ type: "video/mp4" });
  });
});

describe("room file writes and retries, through the real door", () => {
  it("the teammate's copy keeps every byte when the disk takes a write short", async () => {
    const { roomId } = await joinedTeam();
    const bytes = pdf(4096);
    disk.shortWrites = true;
    try {
      const file = await hostUpload(roomId, bytes, "a.pdf");
      expect((await call("POST", `/api/rooms/${roomId}/send`, Buffer.from(JSON.stringify({ text: "short", fileIds: [file.id] })))).status).toBe(200);
      await until(() => filesOf(roomId, "short").length === 1);
      expect(sha((await call("GET", `/api/joined/rooms/${roomId}/files/${file.id}`)).body)).toBe(sha(bytes));
    } finally {
      disk.shortWrites = false;
    }
  });

  it("an upload must name its uploadId, and the same one twice keeps one blob", async () => {
    const { roomId } = await joinedTeam();
    expect(await call("POST", `/api/joined/rooms/${roomId}/files?name=a.pdf`, pdf(1024))).toMatchObject({ status: 400, json: { error: "bad uploadId" } });
    const bytes = pdf(1024);
    const first = await guestUpload(roomId, bytes, "a.pdf", "upload-twice-000001");
    expect((await guestUpload(roomId, bytes, "a.pdf", "upload-twice-000001")).json.file).toEqual(first.json.file);
    expect(readdirSync(join(DATA_DIR, "room-files", roomId))).toEqual([first.json.file.id]);
  });
});
