import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, type Server } from "node:https";
import { createConnection, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { PHONE_RELAY_OFF } from "../../shared/relay-protocol.ts";
import { DATA_DIR } from "../config.ts";
import { PhoneAccess } from "../phone-access.ts";
import { loopbackLookup } from "../phone-relay/testing/fake-relay.ts";
import { listenLocal } from "../phone-relay/testing/net.ts";
import { TestCa } from "../phone-relay/testing/pki.ts";
import { isRelayRequest, markRelaySocket } from "../phone-relay/via.ts";
import { Store, type Message } from "../store.ts";
import { closeAsksDb, configureRoomAsks, roomAskHooks, roomAsks, startAsk, stopRoomAsks, type HostedGroup, type RoomAsk } from "./asks.ts";
import { appendRoomEntry, closeRoomsDb, createRoom, recentRoomEntries, roomPeople } from "./db.ts";
import { configureRoomDoor, handleRoomDoor, hostNameChanged, removeRoomPerson } from "./door.ts";
import { ENDED_FLUSH_MS } from "./door-streams.ts";
import { GuestClient } from "./guest-client.ts";
import { barRoomPerson, closeInvitesDb, createInvite, revokeGuestKeys, roomCode } from "./invites.ts";
import { joinedRoute } from "./joined-routes.ts";
import { addJoinedEntries, closeJoinedDb, joinedCursor, joinedEntries, joinedKey, joinedRoom, saveJoined } from "./joined.ts";
import { publishTurnAnswer } from "./multiplayer.ts";
import { createPeopleOnlyRoom } from "./people-only.ts";
import { MyRoomBotTurns } from "./my-room-bots.ts";
import { hostedSend, stopBotChain } from "./send.ts";

const BASE = "wink.test";
/** The entry an older guest build accepts. */
const olderEntry = z.object({
  seq: z.number().int().positive(),
  id: z.string().regex(/^[\w-]{1,64}$/),
  at: z.number(),
  author: z.object({ kind: z.enum(["host", "person"]), id: z.string().regex(/^[\w-]{1,64}$/), name: z.string().max(200) }),
  text: z.string().max(20_000),
  replyToId: z.string().optional(),
});
const HOST = `abcdefghijklmnop.${BASE}`;

let door: Server;
let caPem = "";
let access: PhoneAccess;
let store: Store;
let engine: Record<"sendTurn" | "generateText" | "generateReview" | "answerWords", ReturnType<typeof vi.fn>>;
let doorHeaders: IncomingHttpHeaders[] = [];
let client: GuestClient | null = null;
let changes: unknown[] = [];
let ownName = "Mina";

/** The relay hop: splices TCP to the PC, which ends TLS, as the real relay does. */
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

/** The PC: relay traffic goes through the gate, which hands /room to the door. Nothing else is served. */
async function app(req: IncomingMessage, res: ServerResponse) {
  if (isRelayRequest(req)) {
    doorHeaders.push(req.headers);
    if ((await access.gate(req, res)).handled) return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
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
  await new Promise((resolve) => door.close(resolve));
  await new Promise((resolve) => hop.server!.close(resolve));
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

// The join limiter is per process, so each test starts on a later minute.
let skew = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.now() + (skew += 2 * 60_000));
  close();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  hop.up = true;
  doorHeaders = [];
  changes = [];
  ownName = "Mina";
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  engine = { sendTurn: vi.fn(), generateText: vi.fn(), generateReview: vi.fn(), answerWords: vi.fn() };
  roomAskHooks.words = vi.fn();
  configureRoomAsks({
    store,
    hostName: () => "Edward",
    instance: vi.fn(() => ({ ...engine, adapter: { sendTurn: engine.sendTurn } }) as never),
    dispatch: vi.fn(),
    stopTurn: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
  });
  configureRoomDoor({ store, hostName: () => "Edward" });
});

afterEach(() => {
  vi.useRealTimers();
  delete roomAskHooks.words;
  vi.restoreAllMocks();
  hop.drop();
  door.closeAllConnections();
  close();
});

const teammate = (timing?: { silenceMs?: number; retryMs?: number; maxRetryMs?: number }) =>
  (client = new GuestClient({
    bases: () => [null, BASE],
    joiner: () => ({ name: ownName, device: "pc-mina-0123456789abcdef" }),
    https: { ca: caPem, lookup: loopbackLookup, port: hop.port },
    onChange: (roomId) => changes.push({ kind: "joined", hosted: true, roomId }),
    timing: { retryMs: 50, maxRetryMs: 200, ...timing },
  }));

function teamRoom(name = "Team"): HostedGroup {
  return store.createGroup(name, [], false, undefined, undefined, { roomId: createPeopleOnlyRoom(name).id }) as HostedGroup;
}

const codeFor = (group: HostedGroup, name: string) => {
  const { invite, secret } = createInvite(group.hosted.roomId, name, "chat", ["Edward"]);
  return `wkr1:${HOST}:${invite.id}.${secret}`;
};

const hostSays = (group: HostedGroup, text: string) => hostedSend(group, { kind: "host" }, text).entry;

const until = async (test: () => boolean, ms = 4_000) => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const texts = (roomId: string) => joinedEntries(roomId, 500).map((entry) => entry.text);
const seqs = (roomId: string) => joinedEntries(roomId, 500).map((entry) => entry.seq);
const live = (c: GuestClient, roomId: string) => until(() => c.rooms().find((room) => room.roomId === roomId)?.link === "live");

async function joinedTeam(name = "Mina") {
  const group = teamRoom();
  hostSays(group, "welcome");
  const c = teammate();
  c.start();
  const result = await c.join(codeFor(group, name));
  if (!result.ok) throw new Error(result.error);
  await live(c, group.hosted.roomId);
  return { group, c, roomId: group.hosted.roomId };
}

describe("teammate and the real door", () => {
  it("saves an old left copy's code once and reuses it after restart", async () => {
    const group = teamRoom();
    const shared = roomCode(group.hosted.roomId);
    const code = `wkr1:${HOST}:${shared.id}.${shared.secret}`;
    const c = teammate();
    c.start();
    expect((await c.join(code)).ok).toBe(true);
    await live(c, group.hosted.roomId);
    const room = joinedRoom(group.hosted.roomId)!;
    expect((await c.leave(room.roomId)).ok).toBe(true);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(DATA_DIR, "joined.db"));
    db.prepare("DELETE FROM joined_codes WHERE room_id = ?").run(room.roomId);
    db.close();
    expect((await joinedRoute("POST", `/api/joined/rooms/${room.roomId}/rejoin`, c, async () => ({})))?.body).toEqual({ error: "no-saved-code" });
    const recovered = await joinedRoute("POST", `/api/joined/rooms/${room.roomId}/rejoin`, c, async () => ({ code }));
    expect(recovered?.status).toBe(200);
    await live(c, room.roomId);
    expect((await c.leave(room.roomId)).ok).toBe(true);
    c.stop();
    closeJoinedDb();
    const restarted = teammate();
    expect((await joinedRoute("POST", `/api/joined/rooms/${room.roomId}/rejoin`, restarted, async () => ({})))?.status).toBe(200);
    await live(restarted, room.roomId);
  });

  it("rejects another room's code before creating a membership", async () => {
    const { c, roomId } = await joinedTeam();
    expect((await c.leave(roomId)).ok).toBe(true);
    const other = teamRoom();
    const shared = roomCode(other.hosted.roomId);
    const code = `wkr1:${HOST}:${shared.id}.${shared.secret}`;
    const result = await joinedRoute("POST", `/api/joined/rooms/${roomId}/rejoin`, c, async () => ({ code }));
    expect(result?.status).toBe(400);
    expect(roomPeople(other.hosted.roomId)).toEqual([]);
    expect(joinedRoom(other.hosted.roomId)).toBeNull();
  });

  it("rejoins after leave using the saved room code after a client restart, with history", async () => {
    const group = teamRoom();
    const shared = roomCode(group.hosted.roomId);
    const code = `wkr1:${HOST}:${shared.id}.${shared.secret}`;
    const c = teammate();
    hostSays(group, "before leaving");
    expect((await c.join(code)).ok).toBe(true);
    await live(c, group.hosted.roomId);
    expect((await c.leave(group.hosted.roomId)).ok).toBe(true);
    c.stop();
    closeJoinedDb();
    hostSays(group, "while away");
    const restarted = teammate();
    const result = await joinedRoute("POST", `/api/joined/rooms/${group.hosted.roomId}/rejoin`, restarted, async () => ({}));
    expect(result?.status).toBe(200);
    await live(restarted, group.hosted.roomId);
    expect(texts(group.hosted.roomId)).toEqual(["before leaving", "while away"]);
    expect(roomPeople(group.hosted.roomId)).toHaveLength(1);
    expect(JSON.stringify(restarted.rooms())).not.toContain(shared.secret);
  });

  it("keeps a host-removed PC barred from the same code", async () => {
    const group = teamRoom();
    const shared = roomCode(group.hosted.roomId);
    const code = `wkr1:${HOST}:${shared.id}.${shared.secret}`;
    const c = teammate();
    expect((await c.join(code)).ok).toBe(true);
    await live(c, group.hosted.roomId);
    const person = roomPeople(group.hosted.roomId)[0]!;
    removeRoomPerson(group.hosted.roomId, person.id);
    barRoomPerson(group.hosted.roomId, person.id);
    await until(() => joinedRoom(group.hosted.roomId)?.status === "removed");
    expect(await c.join(code)).toMatchObject({ ok: false, status: 403, error: "removed" });
    expect(roomPeople(group.hosted.roomId)).toEqual([]);
  });

  it("removes only the ended local copy, leaving the host history and other copies intact", async () => {
    const { c, group, roomId } = await joinedTeam();
    const hosted = recentRoomEntries(roomId, 100);
    const other = "other-local-room";
    saveJoined(other, HOST, { id: "other", name: "Other" }, `wkg_${"z".repeat(43)}`);
    expect((await joinedRoute("DELETE", `/api/joined/rooms/${roomId}`, c, async () => ({})))?.status).toBe(409);
    expect((await c.leave(roomId)).ok).toBe(true);
    const cache = join(DATA_DIR, "joined-files", roomId);
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "fake-file"), "local copy");
    const result = await joinedRoute("DELETE", `/api/joined/rooms/${roomId}`, c, async () => ({}));
    expect(result?.status).toBe(200);
    expect(c.room(roomId)).toBeNull();
    expect(joinedEntries(roomId, 100)).toEqual([]);
    expect(existsSync(cache)).toBe(false);
    expect(joinedRoom(other)).not.toBeNull();
    expect(recentRoomEntries(roomId, 100)).toEqual(hosted);
    expect(store.groups.find((each) => each.id === group.id)).toBeDefined();
  });

  it("counts three remote lines, ignores own sends and shares the local read marker", async () => {
    const { group, c, roomId } = await joinedTeam();
    expect(c.read(roomId, c.room(roomId)!.lastEntry!.seq).ok).toBe(true);
    hostSays(group, "first");
    hostSays(group, "second");
    const last = hostSays(group, "third");
    await until(() => c.room(roomId)?.lastEntry?.id === last.id);
    expect(c.rooms()[0].unread).toBe(3);
    await c.send(roomId, "my own line");
    expect(c.room(roomId)?.unread).toBe(3);
    const other = new GuestClient({ bases: () => [BASE], joiner: () => ({ name: "Mina", device: "other" }) });
    const read = await joinedRoute("POST", `/api/joined/rooms/${roomId}/read`, c, async () => ({ seq: c.room(roomId)!.lastEntry!.seq }));
    expect(read?.status).toBe(200);
    expect(c.room(roomId)?.unread).toBe(0);
    expect(other.rooms()[0].unread).toBe(0);
    expect(changes).toContainEqual(expect.objectContaining({ roomId }));
  });

  it("joins from the pasted code alone and syncs the snapshot and state", async () => {
    const { group, c, roomId } = await joinedTeam();
    expect(texts(roomId)).toEqual(["welcome"]);
    expect(c.room(roomId)).toMatchObject({ status: "joined", link: "live", me: { name: "Mina" }, state: { roomName: "Team", host: "Edward", people: [{ name: "Mina" }] } });
    expect(roomPeople(roomId).map((person) => person.name)).toEqual(["Mina"]);
    expect(store.groups.map((candidate) => candidate.id)).toEqual([group.id]);
  });

  it("carries messages both ways, and a retried sendId adds nothing", async () => {
    const { c, group, roomId } = await joinedTeam();
    hostSays(group, "from host");
    await until(() => texts(roomId).includes("from host"));
    const sent = await c.send(roomId, "from Mina");
    expect(sent).toMatchObject({ ok: true, value: { text: "from Mina", author: { kind: "person", name: "Mina" } } });
    const again = await c.send(roomId, "from Mina", undefined, sent.sendId);
    expect(again).toMatchObject({ ok: true, value: { seq: sent.ok ? sent.value.seq : -1 } });
    expect(recentRoomEntries(roomId, 10).map((entry) => entry.text)).toEqual(["welcome", "from host", "from Mina"]);
    const reply = await c.send(roomId, "re", sent.ok ? sent.value.id : undefined);
    expect(reply).toMatchObject({ ok: true, value: { replyToId: sent.ok ? sent.value.id : "" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seqs(roomId)).toEqual([1, 2, 3, 4]);
  });

  it("keeps sends in order", async () => {
    const { c, roomId } = await joinedTeam();
    const results = await Promise.all(["one", "two", "three", "four"].map((text) => c.send(roomId, text)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(recentRoomEntries(roomId, 10).map((entry) => entry.text)).toEqual(["welcome", "one", "two", "three", "four"]);
  });

  it("reconnects after a dropped stream with nothing lost or doubled", async () => {
    const { c, group, roomId } = await joinedTeam();
    hostSays(group, "before");
    await until(() => texts(roomId).includes("before"));
    hop.up = false;
    hop.drop();
    await until(() => c.rooms()[0]?.link === "offline");
    hostSays(group, "while away 1");
    hostSays(group, "while away 2");
    hop.up = true;
    await until(() => texts(roomId).includes("while away 2"));
    hostSays(group, "after");
    await until(() => texts(roomId).includes("after"));
    expect(texts(roomId)).toEqual(["welcome", "before", "while away 1", "while away 2", "after"]);
    expect(seqs(roomId)).toEqual([1, 2, 3, 4, 5]);
  });

  it("a send while the stream is down never moves the replay point past unseen entries", async () => {
    const { c, group, roomId } = await joinedTeam();
    c.stop();
    hostSays(group, "unseen");
    expect(await c.send(roomId, "mine")).toMatchObject({ ok: true, value: { seq: 3 } });
    c.start();
    await until(() => texts(roomId).includes("unseen"));
    expect(texts(roomId)).toEqual(["welcome", "unseen", "mine"]);
  });

  it("fails a send while the host is offline and never sends it later", async () => {
    const { c, roomId } = await joinedTeam();
    hop.up = false;
    hop.drop();
    const failed = await c.send(roomId, "lost");
    expect(failed).toMatchObject({ ok: false, status: 503, error: "unavailable", sendId: expect.any(String) });
    hop.up = true;
    await live(c, roomId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(recentRoomEntries(roomId, 10).map((entry) => entry.text)).toEqual(["welcome"]);
  });

  it("pages a new teammate back past the 200-line snapshot, local rows first", async () => {
    const group = teamRoom();
    for (let i = 1; i <= 450; i += 1) hostSays(group, `line ${i}`);
    const c = teammate();
    c.start();
    const roomId = group.hosted.roomId;
    expect((await c.join(codeFor(group, "Mina"))).ok).toBe(true);
    await live(c, roomId);
    expect(c.room(roomId)).toMatchObject({ hasMore: true, entries: expect.arrayContaining([expect.objectContaining({ seq: 251 })]) });
    const older = (before: number) => joinedRoute("POST", `/api/joined/rooms/${roomId}/older`, c, async () => ({ before }));
    expect((await older(251))?.body).toEqual({ more: true });
    const page = await joinedRoute("GET", `/api/joined/rooms/${roomId}`, c, async () => ({}), new URLSearchParams({ limit: "400" }));
    expect((page?.body as { room: { entries: Array<{ seq: number }> } }).room.entries[0]?.seq).toBe(51);
    hop.up = false;
    hop.drop();
    expect((await older(100))?.body).toEqual({ more: true });
    hop.up = true;
    expect((await older(51))?.body).toEqual({ more: true });
    expect(c.room(roomId, 600)).toMatchObject({ hasMore: false });
    expect(c.room(roomId, 600)!.entries.map((entry) => entry.seq)).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
    expect((await older(1))?.body).toEqual({ more: false });
  });

  it("reloads a snapshot on reset", async () => {
    const { c, group, roomId } = await joinedTeam();
    c.stop();
    addJoinedEntries(roomId, [{ seq: 99, id: "ghost", at: 1, author: { kind: "host", id: "host", name: "Edward" }, text: "ghost" }], 99);
    hostSays(group, "real");
    c.start();
    await until(() => texts(roomId).includes("real") && !texts(roomId).includes("ghost"));
    expect(seqs(roomId)).toEqual([1, 2]);
    await live(c, roomId);
  });

  it("Remove cuts the teammate within the deadline and leaves the room read-only", async () => {
    const { c, roomId } = await joinedTeam();
    const person = roomPeople(roomId)[0]!;
    const started = Date.now();
    removeRoomPerson(roomId, person.id);
    await until(() => joinedRoom(roomId)?.status === "removed", ENDED_FLUSH_MS);
    expect(Date.now() - started).toBeLessThan(ENDED_FLUSH_MS);
    expect(joinedKey(roomId)).toBeNull();
    expect(await c.send(roomId, "still here?")).toEqual({ ok: false, status: 409, error: "this room is read-only" });
    expect(texts(roomId)).toEqual(["welcome"]);
  });

  it("a key revoked while away reads as removed", async () => {
    const { c, roomId } = await joinedTeam();
    c.stop();
    revokeGuestKeys(roomId, roomPeople(roomId)[0]!.id);
    teammate().start();
    await until(() => joinedRoom(roomId)?.status === "removed");
    expect(joinedKey(roomId)).toBeNull();
  });

  it("leave goes through the door and leaves a read-only copy", async () => {
    const { c, roomId } = await joinedTeam();
    expect(await c.leave(roomId)).toMatchObject({ ok: true, value: { status: "left", link: null } });
    expect(roomPeople(roomId)).toEqual([]);
    expect(joinedKey(roomId)).toBeNull();
    expect(texts(roomId)).toEqual(["welcome"]);
    expect(await c.send(roomId, "bye")).toMatchObject({ ok: false, status: 409 });
  });

  it("leaves and removes a room the host deleted while this PC was off, and says it is gone", async () => {
    const { c, group, roomId } = await joinedTeam();
    c.stop();
    store.deleteGroup(group.id);
    c.start();
    expect(await c.leave(roomId)).toMatchObject({ ok: true, value: { status: "left", gone: true } });
    expect(joinedKey(roomId)).toBeNull();
    expect(await c.remove(roomId)).toEqual({ ok: true, value: true });
    expect(joinedRoom(roomId)).toBeNull();
  });

  it("leaves on this PC when the host can't be reached", async () => {
    const { c, roomId } = await joinedTeam();
    hop.up = false;
    hop.drop();
    const left = await c.leave(roomId);
    expect(left).toMatchObject({ ok: true, value: { status: "left" } });
    expect(left.ok && "gone" in left.value).toBe(false);
    expect(await c.remove(roomId)).toEqual({ ok: true, value: true });
  });

  it("never runs a model, a loopback fetch or a group, and the key stays in joined.db", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const { c, group, roomId } = await joinedTeam();
    const key = joinedKey(roomId)!.key;
    hostSays(group, "hi");
    await c.send(roomId, "hello");
    const bodies: unknown[] = [];
    const route = async (method: string, path: string, body: unknown = {}) => {
      const reply = await joinedRoute(method, path, c, async () => body);
      bodies.push(reply);
      return reply;
    };
    await route("GET", "/api/joined/rooms");
    await route("GET", `/api/joined/rooms/${roomId}`);
    await route("POST", `/api/joined/rooms/${roomId}/send`, { text: "via route", sendId: "route-send-0000001" });
    await route("POST", `/api/joined/rooms/${roomId}/leave`);
    await route("GET", `/api/joined/rooms/${roomId}`);
    expect(bodies.map((reply) => (reply as { status: number }).status)).toEqual([200, 200, 200, 200, 200]);
    for (const spy of Object.values(engine)) expect(spy).not.toHaveBeenCalled();
    expect(roomAskHooks.words).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.groups.map((candidate) => candidate.id)).toEqual([group.id]);
    expect(JSON.stringify(bodies)).not.toContain(key);
    expect(JSON.stringify(changes)).not.toContain(key);
    expect(JSON.stringify(logs.map((spy) => spy.mock.calls))).not.toContain(key);
    expect(doorHeaders.every((headers) => headers.cookie === undefined)).toBe(true);
  });

  it("leaves paths outside /api/joined/ alone", async () => {
    expect(await joinedRoute("GET", "/api/joinedx", teammate(), async () => ({}))).toBeNull();
  });

  it("carries own and host renames over TLS within a second and keeps new author names", async () => {
    let hostName = "Edward";
    configureRoomDoor({ store, hostName: () => hostName });
    const { c, roomId } = await joinedTeam();
    await live(c, roomId);
    await c.send(roomId, "before rename");
    const started = Date.now();
    ownName = "민아";
    await c.nameChanged();
    await until(() => c.room(roomId)?.me.name === ownName);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(roomPeople(roomId)[0]?.name).toBe(ownName);
    expect(await c.send(roomId, "after rename")).toMatchObject({ ok: true, value: { author: { name: ownName } } });
    hostName = "에드워드";
    hostNameChanged();
    await until(() => c.room(roomId)?.state?.host === hostName);
    expect(joinedEntries(roomId, 10).find((entry) => entry.text === "before rename")?.author.name).toBe("Mina");
  });

  it("delivers an offline name change when the relay reconnects", async () => {
    const { c, roomId } = await joinedTeam();
    await live(c, roomId);
    hop.up = false;
    hop.drop();
    ownName = "민아";
    await c.nameChanged();
    expect(roomPeople(roomId)[0]?.name).toBe("Mina");
    hop.up = true;
    await until(() => c.room(roomId)?.me.name === ownName);
    expect(roomPeople(roomId)[0]?.name).toBe(ownName);
    expect(await c.send(roomId, "after reconnect")).toMatchObject({ ok: true, value: { author: { name: ownName } } });
  });
});

describe("a shared bot group", () => {
  const crew = () => {
    const wink = store.patchBot(store.createBot().id, { name: "Wink" })!;
    const group = store.createGroup("Crew", [wink.id], false, undefined, undefined, { roomId: createRoom("Crew").id }) as HostedGroup;
    return { wink, group, roomId: group.hosted.roomId, says: (text: string) => appendRoomEntry(group.hosted.roomId, { author: { kind: "bot", id: wink.id, name: "Wink" }, text }) };
  };

  /** A guest from before bots in rooms: no `with=bots`, and only host and person authors parse. */
  function olderStream(roomId: string, key: string) {
    const frames: Array<{ kind: string; entry?: unknown }> = [];
    const req = httpsRequest({
      host: "127.0.0.1", port: hop.port, servername: HOST, ca: caPem, path: `/room/v1/rooms/${roomId}/stream?after=0`,
      headers: { host: HOST, accept: "text/event-stream", authorization: `Bearer ${key}`, "x-wink-device": "pc-old-0123456789abcdef" },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
        for (let cut; (cut = text.indexOf("\n\n")) >= 0; text = text.slice(cut + 2)) {
          const block = text.slice(0, cut);
          if (block.startsWith("data: ")) frames.push(JSON.parse(block.slice(6)));
        }
      });
    });
    req.on("error", () => {});
    req.end();
    return { frames, close: () => req.destroy() };
  }

  it("answers a teammate's @ with the bot's line on the teammate PC while an older build reads it as a named person", async () => {
    const { wink, group, roomId } = crew();
    appendRoomEntry(roomId, { author: { kind: "host", id: "host", name: "Edward" }, text: "welcome" });
    const c = teammate();
    c.start();
    expect((await c.join(codeFor(group, "Mina"))).ok).toBe(true);
    await live(c, roomId);
    const older = olderStream(roomId, joinedKey(roomId)!.key);
    await until(() => older.frames.some((frame) => frame.kind === "entry"));
    expect((await c.send(roomId, "@Wink what's left?")).ok).toBe(true);
    const [ask] = roomAsks(roomId, ["queued"]);
    expect(ask).toMatchObject({ botId: wink.id, grant: "work" });
    expect(startAsk(ask!.id)).toBe(true);
    const since = store.messagesFor(group.threadId).length;
    store.appendMessage(group.threadId, { role: "bot", kind: "text", text: "Two cards left.", from: { botId: wink.id, name: "Wink", color: wink.color } });
    publishTurnAnswer(store, group, group.threadId, wink, since, ask!.id);
    await until(() => texts(roomId).includes("Two cards left.") && older.frames.filter((frame) => frame.kind === "entry").length === 3);
    expect(joinedEntries(roomId, 10).map((entry) => [entry.text, entry.author.kind, entry.author.name])).toEqual([
      ["welcome", "host", "Edward"],
      ["@Wink what's left?", "person", "Mina"],
      ["Two cards left.", "bot", "Wink"],
    ]);
    expect(joinedRoom(roomId)!.state!.bots).toEqual([{ id: wink.id, name: "Wink", color: wink.color }]);
    const answer = older.frames.filter((frame) => frame.kind === "entry").at(-1)!.entry;
    expect(olderEntry.safeParse(answer).success).toBe(true);
    expect(answer).toMatchObject({ text: "Two cards left.", author: { kind: "person", id: `bot-${wink.id}`, name: "Wink" } });
    older.close();
  });

  it("lands a 200-line Korean bot history", async () => {
    const { group, roomId, says } = crew();
    for (let i = 0; i < 200; i += 1) says(`${i} ${"한".repeat(19_990)}`);
    const c = teammate();
    c.start();
    expect((await c.join(codeFor(group, "Mina"))).ok).toBe(true);
    await live(c, roomId);
    expect(seqs(roomId).at(-1)).toBe(200);
  });

  it("lands a 1.2 MB catch-up for a teammate who was away, and an older build reads it too", async () => {
    const { group, roomId, says } = crew();
    says("welcome");
    const c = teammate();
    c.start();
    expect((await c.join(codeFor(group, "Mina"))).ok).toBe(true);
    await live(c, roomId);
    c.stop();
    for (let i = 0; i < 60; i += 1) says(`${i} ${"a".repeat(19_990)}`);
    c.start();
    await until(() => joinedCursor(roomId) === 61, 10_000);
    expect(seqs(roomId)).toHaveLength(61);
    const older = olderStream(roomId, joinedKey(roomId)!.key);
    await until(() => older.frames.filter((frame) => frame.kind === "entry").length === 61, 10_000);
    older.close();
  });
});

describe("reactions and the notice on a teammate", () => {
  const mirrorOf = (group: HostedGroup, entryId: string) => store.messagesFor(group.threadId).find((message) => message.roomEntryId === entryId)!;
  const marks = (c: GuestClient, roomId: string, entryId: string) => c.room(roomId)?.entries.find((entry) => entry.id === entryId)?.reactions ?? [];

  it("carries Mina's reaction and the host's own both ways and keeps 20 lines of them across a reconnect", async () => {
    const { group, c, roomId } = await joinedTeam("Mina Park");
    await until(() => c.room(roomId)?.canReact === true);
    const me = c.room(roomId)!.me.id;
    const welcome = recentRoomEntries(roomId, 1)[0]!;
    expect(await c.react(roomId, welcome.id, "👍")).toMatchObject({ ok: true });
    expect(mirrorOf(group, welcome.id).reactions).toEqual([{ emoji: "👍", by: `person:${me}` }]);
    await until(() => marks(c, roomId, welcome.id).length === 1);
    store.toggleReaction(group.threadId, mirrorOf(group, welcome.id).id, "❤️", "user");
    await until(() => marks(c, roomId, welcome.id).some((mark) => mark.by === "host"));
    const ids = [welcome.id];
    for (let index = 0; index < 19; index++) {
      const entry = hostSays(group, `line ${index}`);
      ids.push(entry.id);
      await until(() => texts(roomId).includes(`line ${index}`));
      expect((await c.react(roomId, entry.id, "🔥")).ok).toBe(true);
    }
    hop.up = false;
    hop.drop();
    await until(() => c.room(roomId)?.link === "offline");
    expect(c.room(roomId)?.canReact).toBe(false);
    store.toggleReaction(group.threadId, mirrorOf(group, welcome.id).id, "❤️", "user");
    hop.up = true;
    await live(c, roomId);
    await until(() => marks(c, roomId, welcome.id).length === 1);
    for (const id of ids) expect(marks(c, roomId, id)).toHaveLength(1);
    expect(c.room(roomId)?.canReact).toBe(true);
  });

  it("pins a notice through the door and shows its line", async () => {
    const { group, c, roomId } = await joinedTeam("Mina Park");
    await until(() => c.room(roomId)?.canReact === true);
    const welcome = recentRoomEntries(roomId, 1)[0]!;
    expect(await c.notice(roomId, welcome.id)).toMatchObject({ ok: true });
    await until(() => c.room(roomId)?.state?.notice?.entryId === welcome.id);
    expect(c.room(roomId)?.noticeEntry?.text).toBe("welcome");
    expect(c.room(roomId)?.state?.notice?.text).toBe("welcome");
    expect(store.groups.find((candidate) => candidate.id === group.id)?.notice?.by).toBe(`person:${c.room(roomId)!.me.id}`);
    expect(await c.notice(roomId, null)).toMatchObject({ ok: true });
    await until(() => !c.room(roomId)?.state?.notice);
  });
});

describe("bots in two homes hand work to each other", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Edward hosts Rando; JJ's PC joins and runs 스타줌. Both engines answer from a script. */
  async function homes(rando: (ask: RoomAsk) => string, starzoom: (prompt: string) => string) {
    const bot = store.patchBot(store.createBot().id, { name: "Rando" })!;
    const group = store.createGroup("Dinner", [bot.id], false, undefined, undefined, { roomId: createRoom("Dinner").id }) as HostedGroup;
    const roomId = group.hosted.roomId;
    const answer = (text: string, askId?: string) => {
      const since = store.messagesFor(group.threadId).length;
      store.appendMessage(group.threadId, { role: "bot", kind: "text", text, from: { botId: bot.id, name: "Rando", color: bot.color } });
      publishTurnAnswer(store, group, group.threadId, bot, since, askId);
    };
    configureRoomAsks({
      store,
      hostName: () => "Edward",
      instance: () => null,
      dispatch: (ask) => void wait(20).then(() => startAsk(ask.id) && answer(rando(ask), ask.id)),
      stopTurn: vi.fn(async () => {}),
      endSession: vi.fn(async () => {}),
    });
    const thread: Message[] = [];
    const turns: MyRoomBotTurns = new MyRoomBotTurns({
      client: { botSend: (...args) => c.botSend(...args), file: (...args) => c.file(...args) },
      bot: (botId) => (botId === "jj-local" ? { id: botId, name: "스타줌" } : null),
      busy: () => false,
      hasTask: (_botId, threadId) => threadId === "jj-task",
      createTask: () => ({ threadId: "jj-task" }),
      startTurn: async (_botId, threadId, prompt, typed) => {
        thread.push({ id: `u${thread.length}`, at: Date.now(), role: "user", kind: "text", text: typed });
        void wait(20).then(() => {
          thread.push({ id: `b${thread.length}`, at: Date.now(), role: "bot", kind: "text", text: starzoom(prompt) });
          return turns.settled(threadId, true);
        });
      },
      messagesFor: () => thread,
      changed: () => {},
      interrupt: async () => {},
    });
    const c: GuestClient = (client = new GuestClient({
      bases: () => [null, BASE],
      joiner: () => ({ name: "JJ", device: "pc-jj-0123456789abcdef" }),
      https: { ca: caPem, lookup: loopbackLookup, port: hop.port },
      onBotLine: (id, entry) => setImmediate(() => turns.heard(id, entry)),
      onStop: (id) => turns.stop(id),
      timing: { retryMs: 50, maxRetryMs: 200 },
    }));
    c.start();
    expect((await c.join(codeFor(group, "JJ"))).ok).toBe(true);
    await live(c, roomId);
    expect((await c.addBot(roomId, "jj-local", "스타줌", "teal")).ok).toBe(true);
    await until(() => Boolean(joinedRoom(roomId)?.state?.teamBots?.length));
    const log = () => recentRoomEntries(roomId, 100).map((entry) => `${entry.author.name}: ${entry.text}`);
    const joinedLog = () => joinedEntries(roomId, 100).map((entry) => `${entry.author.name}: ${entry.text}`);
    return { roomId, answer, log, joinedLog };
  }

  it("asks back and forth with no person in between, and a line with no bot tag ends it", async () => {
    const randos = ["@스타줌 7:30 at Mapo works, booking it."];
    const starzooms = ["@Rando JJ is free Sat after 7. 7:30 at Mapo?", "Done: Sat 7:30 at Mapo. @Edward @JJ"];
    const prompts: string[] = [];
    const { answer, log, joinedLog } = await homes(() => randos.shift()!, (prompt) => (prompts.push(prompt), starzooms.shift()!));
    hostSays(store.groups.find((group) => group.name === "Dinner") as HostedGroup, "@Rando work with 스타줌 on Saturday dinner");
    answer("@스타줌 Edward is free Sat after 6, likes Korean. What works for JJ?");
    await until(() => log().length === 5 && joinedLog().length === 5);
    await wait(300);
    expect(log()).toEqual([
      "Edward: @Rando work with 스타줌 on Saturday dinner",
      "Rando: @스타줌 Edward is free Sat after 6, likes Korean. What works for JJ?",
      "스타줌: @Rando JJ is free Sat after 7. 7:30 at Mapo?",
      "Rando: @스타줌 7:30 at Mapo works, booking it.",
      "스타줌: Done: Sat 7:30 at Mapo. @Edward @JJ",
    ]);
    expect(joinedLog()).toEqual(log());
    expect(prompts[0]).toContain('"Rando" ("Edward"\'s bot) asked you: @스타줌 Edward is free Sat after 6');
  });

  it("goes on with no line limit until the room's Stop ends it on both PCs", async () => {
    let pings = 0;
    let pongs = 0;
    const { roomId, answer, log, joinedLog } = await homes(() => `@스타줌 ping ${++pings}`, () => `@Rando pong ${++pongs}`);
    answer("@스타줌 ping 0");
    await until(() => log().length >= 12 && log().at(-1)!.startsWith("Rando:"), 8_000);
    stopBotChain(roomId);
    stopRoomAsks(roomId);
    await wait(300);
    const stopped = log().length;
    await wait(500);
    expect(log()).toHaveLength(stopped);
    expect(joinedLog()).toEqual(log());
    expect(roomAsks(roomId, ["queued", "running"])).toEqual([]);
  });
});
