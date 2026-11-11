import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createConnection, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PHONE_RELAY_OFF } from "../../shared/relay-protocol.ts";
import { DATA_DIR } from "../config.ts";
import { PhoneAccess } from "../phone-access.ts";
import { loopbackLookup } from "../phone-relay/testing/fake-relay.ts";
import { listenLocal } from "../phone-relay/testing/net.ts";
import { TestCa } from "../phone-relay/testing/pki.ts";
import { isRelayRequest, markRelaySocket } from "../phone-relay/via.ts";
import { Store } from "../store.ts";
import { closeAsksDb, configureRoomAsks, roomAskHooks, type HostedGroup } from "./asks.ts";
import { appendRoomEntry, closeRoomsDb, createRoom, recentRoomEntries, roomPeople } from "./db.ts";
import { configureRoomDoor, handleRoomDoor, removeRoomPerson } from "./door.ts";
import { ENDED_FLUSH_MS } from "./door-streams.ts";
import { GuestClient } from "./guest-client.ts";
import { barRoomPerson, closeInvitesDb, createInvite, revokeGuestKeys, roomCode } from "./invites.ts";
import { joinedRoute } from "./joined-routes.ts";
import { addJoinedEntries, closeJoinedDb, joinedEntries, joinedKey, joinedRoom, saveJoined } from "./joined.ts";
import { writeRoomEntry } from "./mirror.ts";
import { createPeopleOnlyRoom } from "./people-only.ts";
import { hostedSend } from "./send.ts";

const BASE = "wink.test";
const HOST = `abcdefghijklmnop.${BASE}`;

let door: Server;
let caPem = "";
let access: PhoneAccess;
let store: Store;
let engine: Record<"sendTurn" | "generateText" | "generateReview" | "answerWords", ReturnType<typeof vi.fn>>;
let doorHeaders: IncomingHttpHeaders[] = [];
let client: GuestClient | null = null;
let changes: unknown[] = [];

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

beforeEach(() => {
  close();
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  hop.up = true;
  doorHeaders = [];
  changes = [];
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  engine = { sendTurn: vi.fn(), generateText: vi.fn(), generateReview: vi.fn(), answerWords: vi.fn() };
  roomAskHooks.words = vi.fn();
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
});

afterEach(() => {
  delete roomAskHooks.words;
  vi.restoreAllMocks();
  hop.drop();
  door.closeAllConnections();
  close();
});

const teammate = (timing?: { silenceMs?: number; retryMs?: number; maxRetryMs?: number }) =>
  (client = new GuestClient({
    bases: () => [null, BASE],
    joiner: () => ({ name: "Mina", device: "pc-mina-0123456789abcdef" }),
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
});

describe("an older teammate build in a shared bot group", () => {
  // The join limiter is per process; the file's earlier joins have spent this minute.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60_000);
  });
  afterEach(() => vi.useRealTimers());

  const crew = () => {
    const wink = store.patchBot(store.createBot().id, { name: "Wink" })!;
    const group = store.createGroup("Crew", [wink.id], false, undefined, undefined, { roomId: createRoom("Crew").id }) as HostedGroup;
    return { wink, group, roomId: group.hosted.roomId, says: (text: string) => appendRoomEntry(group.hosted.roomId, { author: { kind: "bot", id: wink.id, name: "Wink" }, text }) };
  };

  it("reads bot lines from the snapshot and the stream as named people, never as itself", async () => {
    const { wink, group, roomId, says } = crew();
    appendRoomEntry(roomId, { author: { kind: "host", id: "host", name: "Edward" }, text: "welcome" });
    says("hello from the bot");
    const c = teammate();
    c.start();
    expect((await c.join(codeFor(group, "Mina"))).ok).toBe(true);
    await live(c, roomId);
    writeRoomEntry(store, group, { author: { kind: "bot", id: wink.id, name: "Wink" }, text: "live bot line" });
    await until(() => texts(roomId).includes("live bot line"));
    expect(joinedEntries(roomId, 10).map((entry) => [entry.text, entry.author])).toEqual([
      ["welcome", { kind: "host", id: "host", name: "Edward" }],
      ["hello from the bot", { kind: "person", id: `bot-${wink.id}`, name: "Wink" }],
      ["live bot line", { kind: "person", id: `bot-${wink.id}`, name: "Wink" }],
    ]);
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
});
