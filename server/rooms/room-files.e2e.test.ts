import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createConnection, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  if (await hostFileRoute(req, res, method, url, { store })) return;
  res.writeHead(404).end();
}

beforeAll(async () => {
  const ca = await TestCa.create();
  caPem = ca.certPem;
  const { keyPem, certPem } = await ca.issue(HOST);
  door = createHttpsServer({ key: keyPem, cert: certPem }, (req, res) => void app(req, res));
  door.on("secureConnection", (socket: TLSSocket) => markRelaySocket(socket));
  const doorPort = await listenLocal(door);
  hop.server = createTcpServer((inbound) => {
    if (!hop.up) return inbound.destroy();
    const outbound = createConnection({ host: "127.0.0.1", port: doorPort });
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
    driverKind: () => "claudeAgent",
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

describe("pictures and files in a team room, through the real door", () => {
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
    expect(gotPicture.headers).toMatchObject({ "content-type": "image/png", "content-disposition": expect.stringMatching(/^inline;/), "x-content-type-options": "nosniff" });
    expect(sha(gotPicture.body)).toBe(sha(hostPicture));
    const gotDoc = await call("GET", `/api/joined/rooms/${roomId}/files/${doc!.id}`);
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
    for (const [method, path] of [["GET", `/api/rooms/${roomId}/files`], ["POST", `/api/rooms/${roomId}/files/${up[0].id}`], ["GET", `/api/rooms/other/files/${up[0].id}`]]) {
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
    broadcastDoorEntry(roomId, appendRoomEntry(roomId, { author: { kind: "host", id: "host", name: "Edward" }, text: "too big", files: [{ ...odd, type: "image/png", bytes: 30 * 1024 * 1024 }] }));
    hostedSend(store.groups[0] as HostedGroup, { kind: "host" }, "after");
    await until(() => joinedEntries(roomId, 10).some((entry) => entry.text === "after"));
    expect(joinedEntries(roomId, 10).map((entry) => entry.text)).toEqual(["welcome", "after"]);
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
