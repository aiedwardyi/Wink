import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { Agent, createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PHONE_RELAY_OFF } from "../../shared/relay-protocol.ts";
import { DATA_DIR } from "../config.ts";
import { PhoneAccess } from "../phone-access.ts";
import { requestCredentials, roomDoorPath } from "../phone-auth.ts";
import { isRelayRequest, markRelaySocket } from "../phone-relay/via.ts";
import { apiRequestAuthorized } from "../remote-access.ts";
import { Store } from "../store.ts";
import { closeAsksDb, configureRoomAsks, roomAsks, roomAskHooks, type HostedGroup, type RoomAskDeps } from "./asks.ts";
import { appendRoomEntry, closeRoomsDb, createRoom, recentRoomEntries, roomPeople } from "./db.ts";
import { configureRoomDoor, handleRoomDoor, removeRoomPerson } from "./door.ts";
import * as roomDoor from "./door.ts";
import { ENDED_FLUSH_MS, endDoorPerson, goLive, HEARTBEAT_MS, MAX_BACKLOG_BYTES, openDoorStream, writeFrame, type DoorFrame } from "./door-streams.ts";
import { hostedRoomView } from "./guards.ts";
import { closeInvitesDb, createInvite, revokeGuestKeys, roomCode, roomInvites } from "./invites.ts";
import { writeRoomEntry } from "./mirror.ts";
import { createPeopleOnlyRoom } from "./people-only.ts";

const HOST = "abcdefghijklmnop.wink.test";
const ORIGIN = `https://${HOST}`;
const PEER = "203.0.113.7";
const COMMS = "c".repeat(48);
const REMOTE_KEY = "a".repeat(64);
const MINUTE = 60_000;

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: any;
}

let relayServer: Server;
let localServer: Server;
let access: PhoneAccess;
let store: Store;
let deps: RoomAskDeps;
let engine: Record<"sendTurn" | "generateText" | "generateReview" | "answerWords", ReturnType<typeof vi.fn>>;
const reached: string[] = [];

/** The order of checks in server/index.ts, around fake routes. */
async function app(req: IncomingMessage, res: ServerResponse) {
  const relay = isRelayRequest(req);
  let phone = null;
  if (relay) {
    const gate = await access.gate(req, res);
    if (gate.handled) return;
    phone = gate.phone;
  }
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method ?? "GET";
  const credentials = requestCredentials(relay, phone !== null, req.headers.authorization === `Bearer ${COMMS}`, REMOTE_KEY);
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (!relay && roomDoorPath(path)) return reply(404, { error: "not found" });
  if (path.startsWith("/api/") && !(method === "GET" && path === "/api/health") && !credentials.phoneSession && !apiRequestAuthorized(credentials.bearerOk, req.headers.cookie, credentials.remoteKey, path)) {
    return reply(401, { error: "unauthorized" });
  }
  if (await access.handle(req, res, path, method, credentials.bearerOk)) return;
  reached.push(path);
  reply(200, { reached: path, phone: phone !== null });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

let clock = Date.now();
let relayPort = 0;
let localPort = 0;

function call(path: string, init: { method?: string; headers?: Record<string, string | undefined>; body?: string | Buffer; key?: string; local?: boolean; agent?: Agent } = {}): Promise<Reply> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = init.local ? { host: "127.0.0.1" } : { host: HOST, ...(method === "POST" ? { origin: ORIGIN } : {}) };
  if (init.key) headers.authorization = `Bearer ${init.key}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  for (const [name, value] of Object.entries(init.headers ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: init.local ? localPort : relayPort, method, path, headers, agent: init.agent ?? false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

const post = (path: string, body: unknown, init: Parameters<typeof call>[1] = {}) => call(path, { ...init, method: "POST", body: JSON.stringify(body) });

interface Stream {
  status: number;
  frames: DoorFrame[];
  pings: number;
  closed: Promise<void>;
  until(test: (frames: DoorFrame[]) => boolean): Promise<DoorFrame[]>;
  close(): void;
}

function openStream(roomId: string, key: string, after: number | string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: relayPort, path: `/room/v1/rooms/${roomId}/stream?after=${after}`, headers: { host: HOST, authorization: `Bearer ${key}` }, agent: false }, (res) => {
      const stream: Stream = {
        status: res.statusCode ?? 0,
        frames: [],
        pings: 0,
        closed: new Promise((done) => res.on("close", () => done())),
        until: (test) => new Promise((done, fail) => {
          const check = () => {
            if (!test(stream.frames)) return;
            res.off("data", check);
            done(stream.frames);
          };
          res.on("data", check);
          void stream.closed.then(() => (test(stream.frames) ? done(stream.frames) : fail(new Error(`stream closed: ${JSON.stringify(stream.frames)}`))));
          setImmediate(check);
        }),
        close: () => req.destroy(),
      };
      let text = "";
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        let cut: number;
        while ((cut = text.indexOf("\n\n")) >= 0) {
          const block = text.slice(0, cut);
          text = text.slice(cut + 2);
          if (block.startsWith(": ")) stream.pings += 1;
          else if (block.startsWith("data: ")) stream.frames.push(JSON.parse(block.slice(6)));
        }
      });
      res.on("error", () => {});
      resolve(stream);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Closes a stream and gives the server a beat to see it go. */
async function shut(stream: Stream): Promise<void> {
  stream.close();
  await stream.closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const kinds = (frames: DoorFrame[]) => frames.map((frame) => (frame.kind === "entry" ? `entry:${frame.entry.text}` : frame.kind));

function peopleRoom(name = "Team"): HostedGroup {
  return store.createGroup(name, [], false, undefined, undefined, { roomId: createPeopleOnlyRoom(name).id }) as HostedGroup;
}

function code(group: HostedGroup, name: string): { code: string; inviteId: string; secret: string } {
  const { invite, secret } = createInvite(group.hosted.roomId, name, "chat", ["Edward"]);
  return { code: `wkr1:${HOST}:${invite.id}.${secret}`, inviteId: invite.id, secret };
}

async function joined(group: HostedGroup, name: string): Promise<{ key: string; personId: string }> {
  const res = await post("/room/v1/join", { code: code(group, name).code });
  expect(res.status).toBe(200);
  return { key: res.body.key, personId: res.body.person.id };
}

const hostSays = (group: HostedGroup, text: string) => appendRoomEntry(group.hosted.roomId, { author: { kind: "host", id: "host", name: "Edward" }, text });

const close = () => {
  configureRoomDoor(null);
  configureRoomAsks(null);
  closeAsksDb();
  closeInvitesDb();
  closeRoomsDb();
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  relayServer = createServer(app);
  relayServer.on("connection", markRelaySocket);
  localServer = createServer(app);
  relayPort = await listen(relayServer);
  localPort = await listen(localServer);
  const relay = { status: () => ({ ...PHONE_RELAY_OFF, state: "connected" as const, host: HOST }), stop: async () => {} };
  access = new PhoneAccess({
    dataDir: DATA_DIR,
    env: {},
    staticDir: null,
    config: () => ({ base: "wink.test", enabled: true }),
    saveEnabled: () => {},
    start: () => relay,
    loadClient: async () => ({ start: () => relay, enroll: async () => {}, peer: () => PEER }),
    room: handleRoomDoor,
  });
  await access.start(app);
});

afterAll(async () => {
  await access.stop();
  for (const server of [relayServer, localServer]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.useRealTimers();
});

beforeEach(() => {
  close();
  // Monotonic, so a test that swaps fake timers can't move the limiters' clock back.
  clock = Math.max(clock, Date.now()) + 5 * MINUTE;
  vi.setSystemTime(clock);
  rmSync(DATA_DIR, { recursive: true, force: true });
  reached.length = 0;
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  engine = { sendTurn: vi.fn(), generateText: vi.fn(), generateReview: vi.fn(), answerWords: vi.fn() };
  deps = {
    store,
    hostName: () => "Edward",
    instance: vi.fn(() => ({ ...engine, adapter: { sendTurn: engine.sendTurn } }) as never),
    dispatch: vi.fn(),
    stopTurn: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
  };
  roomAskHooks.words = vi.fn();
  configureRoomAsks(deps);
  configureRoomDoor({ store, hostName: () => "Edward" });
});

afterEach(() => {
  delete roomAskHooks.words;
  vi.restoreAllMocks();
  relayServer.closeAllConnections();
  close();
});

describe("door routes", () => {
  it("shares only the picture id and pushes replacement and removal to both guests", async () => {
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    const daniel = await joined(group, "Daniel");
    const first = await openStream(group.hosted.roomId, mina.key, 0);
    const second = await openStream(group.hosted.roomId, daniel.key, 0);
    try {
      store.patchGroup(group.id, { picture: "P".repeat(24) } as never);
      const snapshot = await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key: mina.key });
      expect(snapshot.body.state.picture).toBe("P".repeat(24));
      for (const stream of [first, second]) {
        await stream.until((frames) => frames.some((frame) => frame.kind === "state" && (frame.state as any).picture === "P".repeat(24)));
        expect(Buffer.byteLength(JSON.stringify(stream.frames))).toBeLessThan(256 * 1024);
      }
      store.patchGroup(group.id, { picture: undefined } as never);
      for (const stream of [first, second]) await stream.until((frames) => frames.filter((frame) => frame.kind === "state").length >= 3);
      expect((await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key: mina.key })).body.state).not.toHaveProperty("picture");
    } finally {
      await shut(first);
      await shut(second);
    }
  });

  it("answers 404 for every path it does not list, before reading a key", async () => {
    const group = peopleRoom();
    const id = group.hosted.roomId;
    const misses: Array<[string, string]> = [
      ["GET", "/room"], ["GET", "/room/"], ["GET", "/room/v1"], ["POST", "/room/v2/join"], ["GET", "/room/v1/join"],
      ["GET", `/room/v1/rooms/${id}`], ["GET", `/room/v1/rooms/${id}/other`], ["GET", `/room/v1/rooms/${id}/snapshot/x`],
      ["POST", `/room/v1/rooms/${id}/snapshot`], ["POST", `/room/v1/rooms/${id}/stream`], ["GET", `/room/v1/rooms/${id}/send`],
      ["GET", `/room/v1/rooms/${id}/leave`], ["GET", `/room/v1/rooms/${id}/asks/a1/cancel`], ["POST", `/room/v1/rooms/${id}/asks/a1`],
      ["HEAD", `/room/v1/rooms/${id}/snapshot`], ["GET", "/room/v1/rooms/a.b/snapshot"],
    ];
    for (const [method, path] of misses) expect([method, path, (await call(path, { method })).status]).toEqual([method, path, 404]);
    expect((await call(`/room/v1/rooms/${id}/snapshot`)).status).toBe(401);
    expect(reached).toEqual([]);
  });

  it("lets a guest join with no team rooms switch in config", async () => {
    const group = peopleRoom();
    const { key } = await joined(group, "Mina");
    expect((await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key })).status).toBe(200);
  });

  it("is 404 on loopback", async () => {
    const group = peopleRoom();
    const { key } = await joined(group, "Mina");
    for (const path of ["/room", "/room/v1/join", `/room/v1/rooms/${group.hosted.roomId}/snapshot`]) {
      expect((await call(path, { local: true, key })).status).toBe(404);
      expect((await post(path, { code: code(group, `x${path.length}`).code }, { local: true })).status).toBe(404);
    }
    expect(reached).toEqual([]);
  });

  it("needs the relay Host, and this relay's Origin on every POST", async () => {
    const group = peopleRoom();
    const invite = code(group, "Mina");
    expect((await post("/room/v1/join", { code: invite.code }, { headers: { origin: undefined } })).body).toEqual({ error: "forbidden: origin required" });
    expect((await post("/room/v1/join", { code: invite.code }, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await post("/room/v1/join", { code: invite.code }, { headers: { origin: `http://${HOST}` } })).status).toBe(403);
    expect((await post("/room/v1/join", { code: invite.code }, { headers: { host: "other1234567890a.wink.test" } })).status).toBe(403);
    expect(roomPeople(group.hosted.roomId)).toEqual([]);
    const { key } = await joined(group, "Joon");
    expect((await post(`/room/v1/rooms/${group.hosted.roomId}/send`, { text: "hi" }, { key, headers: { origin: undefined } })).status).toBe(403);
    expect((await post(`/room/v1/rooms/${group.hosted.roomId}/leave`, {}, { key, headers: { origin: "null" } })).status).toBe(403);
    expect(recentRoomEntries(group.hosted.roomId, 5)).toEqual([]);
    expect((await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key })).status).toBe(200);
  });

  it("serves a hosted group with bots, and nothing for a room no group hosts", async () => {
    const botRoom = store.createGroup("Bots", [], false, undefined, undefined, { roomId: createRoom("Bots").id }) as HostedGroup;
    expect((await post("/room/v1/join", { code: code(botRoom, "Mina").code })).status).toBe(200);
    expect(roomPeople(botRoom.hosted.roomId).map((person) => person.name)).toEqual(["Mina"]);
    const loose = createRoom("Loose");
    const { invite, secret } = createInvite(loose.id, "Joon", "chat", ["Edward"]);
    expect(await post("/room/v1/join", { code: `wkr1:${HOST}:${invite.id}.${secret}` })).toMatchObject({ status: 404, body: { error: "no-invite" } });
    expect(roomInvites(loose.id).map((row) => row.id)).toEqual([invite.id]);
  });
});

describe("a shared bot group", () => {
  const newBot = (name: string) => store.patchBot(store.createBot().id, { name })!;
  const crew = (botIds: string[]) => store.createGroup("Crew", botIds, false, undefined, undefined, { roomId: createRoom("Crew").id }) as HostedGroup;
  const botSays = (group: HostedGroup, bot: { id: string; name: string }, text: string, replyToId?: string) =>
    appendRoomEntry(group.hosted.roomId, { author: { kind: "bot", id: bot.id, name: bot.name }, text, ...(replyToId ? { replyToId } : {}) });
  const alias = (bot: { id: string; name: string }) => ({ kind: "person", id: `bot-${bot.id}`, name: bot.name });

  it("never gives a guest a bot's name by room code or rename", async () => {
    const wink = newBot("Wink");
    const group = crew([wink.id]);
    const shared = roomCode(group.hosted.roomId);
    const first = await post("/room/v1/join", { code: `wkr1:${HOST}:${shared.id}.${shared.secret}`, name: "wink", device: "pc-wink-0123456789abcdef" });
    expect(first.body.person.name).toBe("wink 2");
    const mina = await joined(group, "Mina");
    expect((await post(`/room/v1/rooms/${group.hosted.roomId}/name`, { name: "Wink" }, { key: mina.key })).body).toEqual({ name: "Wink 3" });
  });

  it("gives older guests a person alias for each bot line, newer guests the bot, and both the roster", async () => {
    const wink = newBot("Wink");
    const group = crew([wink.id]);
    store.patchGroup(group.id, { bulletin: "Ship it" });
    const { key } = await joined(group, "Mina");
    const hi = hostSays(group, "hi");
    const reply = botSays(group, wink, "on it", hi.id);
    const path = `/room/v1/rooms/${group.hosted.roomId}/snapshot`;
    const old = (await call(path, { key })).body;
    const fresh = (await call(`${path}?with=bots`, { key })).body;
    const wire = { seq: reply.seq, id: reply.id, at: reply.at, text: "on it", replyToId: hi.id };
    expect(old.entries[1]).toEqual({ ...wire, author: alias(wink) });
    expect(fresh.entries[1]).toEqual({ ...wire, author: { kind: "bot", id: wink.id, name: "Wink" } });
    expect(old.entries[0]).toEqual(fresh.entries[0]);
    for (const body of [old, fresh]) {
      expect(body.state).toMatchObject({ instructions: "Ship it", bots: [{ id: wink.id, name: "Wink", color: wink.color }] });
    }
  });

  it("serializes replay, held and live frames per viewer", async () => {
    const wink = newBot("Wink");
    const group = crew([wink.id]);
    const { key } = await joined(group, "Mina");
    botSays(group, wink, "replayed");
    const old = await openStream(group.hosted.roomId, key, 0);
    const fresh = await openStream(group.hosted.roomId, key, "0&with=bots");
    await Promise.all([old.until((frames) => frames.length >= 2), fresh.until((frames) => frames.length >= 2)]);
    writeRoomEntry(store, group, { author: { kind: "bot", id: wink.id, name: "Wink" }, text: "live" });
    const authors = async (stream: Stream) =>
      (await stream.until((frames) => frames.length >= 3)).flatMap((frame) => (frame.kind === "entry" ? [[frame.entry.text, frame.entry.author]] : []));
    expect(await authors(old)).toEqual([["replayed", alias(wink)], ["live", alias(wink)]]);
    expect(await authors(fresh)).toEqual([["replayed", { kind: "bot", id: wink.id, name: "Wink" }], ["live", { kind: "bot", id: wink.id, name: "Wink" }]]);
    for (const stream of [old, fresh]) await shut(stream);
  });

  it("moves the shared state version when the bot roster changes", async () => {
    const wink = newBot("Wink");
    const pip = newBot("Pip");
    const group = crew([wink.id]);
    const { key } = await joined(group, "Mina");
    const stream = await openStream(group.hosted.roomId, key, 0);
    const [first] = await stream.until((frames) => frames.length >= 1);
    store.patchGroup(group.id, { memberIds: [wink.id, pip.id] });
    const frames = await stream.until((all) => all.length >= 2);
    const [before, after] = frames.map((frame) => (frame.kind === "state" ? frame.state : null));
    expect(first!.kind).toBe("state");
    expect(after!.version).toBeGreaterThan(before!.version);
    expect(after!.bots.map((bot) => bot.name)).toEqual(["Wink", "Pip"]);
    await shut(stream);
  });

  it("keeps a 200-line Korean bot snapshot under an older guest's 4 MiB reply limit", async () => {
    const wink = newBot("Wink");
    const group = crew([wink.id]);
    const { key } = await joined(group, "Mina");
    for (let i = 0; i < 200; i += 1) botSays(group, wink, `${i} ${"한".repeat(19_990)}`);
    const res = await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key });
    expect(res.status).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(res.body))).toBeLessThan(4 * 1024 * 1024);
    expect(res.body.head).toBe(200);
    const seqs = res.body.entries.map((entry: { seq: number }) => entry.seq);
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs).toEqual(seqs.map((_: number, at: number) => 201 - seqs.length + at));
  });

  it("records each person's first join for the host, once, and tells the host on join and remove", async () => {
    const group = crew([newBot("Wink").id]);
    const changed: string[] = [];
    store.onChange((change) => {
      if (change.type === "group") changed.push(change.groupId);
    });
    const shared = roomCode(group.hosted.roomId);
    const join = { code: `wkr1:${HOST}:${shared.id}.${shared.secret}`, name: "Mina", device: "pc-mina-0123456789abcdef" };
    const first = await post("/room/v1/join", join);
    expect(first.status).toBe(200);
    expect(changed).toContain(group.id);
    expect((await post("/room/v1/join", join)).status).toBe(200);
    const view = { people: [{ name: "Mina" }], joins: [{ personId: first.body.person.id, name: "Mina", at: expect.any(Number) }] };
    expect(hostedRoomView(group.hosted)).toMatchObject(view);
    changed.length = 0;
    expect(removeRoomPerson(group.hosted.roomId, first.body.person.id)).toBe(true);
    expect(changed).toContain(group.id);
    expect(hostedRoomView(group.hosted)).toMatchObject({ people: [], joins: view.joins });
  });

  it("never gives a teammate a bot's name, so an @ reaches the bot", async () => {
    const group = crew([newBot("Wink").id]);
    const shared = roomCode(group.hosted.roomId);
    const res = await post("/room/v1/join", { code: `wkr1:${HOST}:${shared.id}.${shared.secret}`, name: "Wink", device: "pc-wink-0123456789abcdef" });
    expect(res.body.person.name).not.toBe("Wink");
  });
});

describe("the guest key", () => {
  it("opens no /api, internal or approval route, and not /api/health beyond its public answer", async () => {
    const group = peopleRoom();
    const { key } = await joined(group, "Mina");
    const routes: Array<[string, string, number]> = [
      ["GET", "/api/bots", 401],
      ["GET", `/api/threads/${group.threadId}/messages`, 401],
      ["POST", `/api/threads/${group.threadId}/requests/r1/answer`, 401],
      ["POST", "/api/approvals/a1", 401],
      ["GET", "/api/events", 401],
      ["GET", "/api/internal/agents", 404],
      ["POST", "/api/mailbox", 404],
      ["GET", "/api/phone/devices", 404],
    ];
    for (const [method, path, status] of routes) {
      const res = await call(path, { method, key, ...(method === "POST" ? { body: "{}" } : {}) });
      expect([path, res.status, res.headers["set-cookie"]]).toEqual([path, status, undefined]);
    }
    const health = await call("/api/health", { key });
    expect([health.status, health.body, health.headers["set-cookie"]]).toEqual([200, { ok: true }, undefined]);
    expect(await call("/api/health")).toMatchObject({ status: 200, body: { ok: true } });
    expect(reached).toEqual([]);
  });

  it("is never a phone cookie, never yields one, and a phone cookie never opens the door", async () => {
    const group = peopleRoom();
    const join = await post("/room/v1/join", { code: code(group, "Mina").code });
    expect(join.headers["set-cookie"]).toBeUndefined();
    const { key } = join.body;
    for (const cookie of [`__Host-wink_phone=${key}`, `wink_phone=${key}`]) {
      expect((await call("/api/bots", { headers: { cookie } })).status).toBe(401);
    }
    const snapshot = await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key });
    expect([snapshot.status, snapshot.headers["set-cookie"]]).toEqual([200, undefined]);
    const pairing = await post("/api/phone/pairing", {}, { local: true, headers: { authorization: `Bearer ${COMMS}` } });
    const token = new URL(pairing.body.url).hash.slice("#k=".length);
    const paired = await post("/api/phone/pair", { credential: token, name: "Pixel" });
    const phone = String(paired.headers["set-cookie"]).split(";")[0]!;
    expect((await call("/api/bots", { headers: { cookie: phone } })).status).toBe(200);
    expect((await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { headers: { cookie: phone } })).status).toBe(401);
    expect((await post(`/room/v1/rooms/${group.hosted.roomId}/send`, { text: "hi" }, { headers: { cookie: phone } })).status).toBe(401);
    expect(recentRoomEntries(group.hosted.roomId, 5)).toEqual([]);
  });

  it("opens no linked-file grant", async () => {
    const group = peopleRoom();
    const { key } = await joined(group, "Mina");
    for (const path of [`/api/threads/${group.threadId}/linked-file`, `/api/threads/${group.threadId}/linked-file/${key}/x/clip.mp4`, `/api/threads/t1/linked-file/a/b/clip.mp4`]) {
      expect((await call(path, { key })).status).toBe(401);
    }
    expect(reached).toEqual([]);
  });

  it("is refused once missing, wrong, or past 20 bad tries from one peer", async () => {
    const group = peopleRoom();
    const path = `/room/v1/rooms/${group.hosted.roomId}/snapshot`;
    expect((await call(path)).body).toEqual({ error: "unauthorized" });
    expect((await call(path, { headers: { authorization: "Basic abc" } })).status).toBe(401);
    for (let i = 0; i < 19; i += 1) expect((await call(path, { key: `wkg_${"x".repeat(43)}` })).status).toBe(401);
    expect((await call(path, { key: "nope" })).status).toBe(401);
    expect((await call(path, { key: "nope" })).body).toEqual({ error: "rate-limited" });
    const { key } = await joined(group, "Mina");
    expect((await call(path, { key })).status).toBe(200);
  });

  it("caps unauthenticated door traffic at 120 a minute", async () => {
    const group = peopleRoom();
    const path = `/room/v1/rooms/${group.hosted.roomId}/snapshot`;
    for (let i = 0; i < 120; i += 1) expect((await call(path)).status).toBe(401);
    expect((await call(path)).status).toBe(429);
    expect((await post("/room/v1/join", { code: code(group, "Mina").code })).status).toBe(429);
    vi.setSystemTime(Date.now() + MINUTE);
    expect((await call(path)).status).toBe(401);
  });
});

describe("cross-room and foreign targets", () => {
  it("are 404 before any lookup or effect", async () => {
    const a = peopleRoom("A");
    const b = peopleRoom("B");
    const { key } = await joined(a, "Mina");
    await joined(b, "Joon");
    const other = hostSays(b, "B only");
    for (const action of ["snapshot", "stream?after=0"]) expect((await call(`/room/v1/rooms/${b.hosted.roomId}/${action}`, { key })).status).toBe(404);
    expect((await post(`/room/v1/rooms/${b.hosted.roomId}/send`, { text: "into B" }, { key })).status).toBe(404);
    expect((await post(`/room/v1/rooms/${b.hosted.roomId}/leave`, {}, { key })).status).toBe(404);
    expect((await post(`/room/v1/rooms/unknown-room/send`, { text: "x" }, { key })).status).toBe(404);
    expect((await post(`/room/v1/rooms/${a.hosted.roomId}/send`, { text: "reply", replyToId: other.id }, { key })).body).toEqual({ error: "no such message in this room" });
    expect((await post(`/room/v1/rooms/${a.hosted.roomId}/send`, { text: "reply", replyToId: "../x" }, { key })).status).toBe(404);
    expect((await post(`/room/v1/rooms/${a.hosted.roomId}/asks/${other.id}/cancel`, {}, { key })).body).toEqual({ error: "no such ask" });
    expect(recentRoomEntries(a.hosted.roomId, 5)).toEqual([]);
    expect(recentRoomEntries(b.hosted.roomId, 5).map((entry) => entry.text)).toEqual(["B only"]);
    expect(roomPeople(b.hosted.roomId).map((person) => person.name)).toEqual(["Joon"]);
    expect(store.messagesFor(a.threadId)).toEqual([]);
  });
});

describe("join", () => {
  it("swaps a live code for a key once, and refuses a replay", async () => {
    const group = peopleRoom();
    const invite = code(group, "Mina");
    const res = await post("/room/v1/join", { code: invite.code });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ roomId: group.hosted.roomId, person: { id: expect.any(String), name: "Mina" }, key: expect.stringMatching(/^wkg_[A-Za-z0-9_-]{43}$/) });
    expect(await post("/room/v1/join", { code: invite.code })).toMatchObject({ status: 404, body: { error: "no-invite" } });
    expect(roomPeople(group.hosted.roomId).map((person) => person.name)).toEqual(["Mina"]);
  });

  it("refuses an expired code", async () => {
    const group = peopleRoom();
    const invite = code(group, "Mina");
    vi.setSystemTime(Date.now() + 7 * 24 * 60 * MINUTE);
    expect(await post("/room/v1/join", { code: invite.code })).toMatchObject({ status: 404, body: { error: "no-invite" } });
    expect(roomPeople(group.hosted.roomId)).toEqual([]);
  });

  it("kills a code after 5 wrong secrets", async () => {
    const group = peopleRoom();
    const invite = code(group, "Mina");
    const wrong = `wkr1:${HOST}:${invite.inviteId}.wki_${"A".repeat(43)}`;
    for (let i = 0; i < 4; i += 1) expect(await post("/room/v1/join", { code: wrong })).toMatchObject({ status: 401, body: { error: "wrong-secret" } });
    expect(await post("/room/v1/join", { code: wrong })).toMatchObject({ status: 401, body: { error: "too-many-tries" } });
    expect(await post("/room/v1/join", { code: invite.code })).toMatchObject({ status: 404, body: { error: "no-invite" } });
    expect(roomPeople(group.hosted.roomId)).toEqual([]);
  });

  it("takes only this relay's code, under 1 KB", async () => {
    const group = peopleRoom();
    const invite = code(group, "Mina");
    for (const bad of [invite.code.replace(HOST, "other1234567890a.wink.test"), invite.code.toUpperCase(), ` ${invite.code}`, invite.code.replace("wkr1", "wkr2"), `${invite.inviteId}.${invite.secret}`, 42]) {
      expect(await post("/room/v1/join", { code: bad })).toMatchObject({ status: 400, body: { error: "bad-code" } });
    }
    expect((await call("/room/v1/join", { method: "POST", body: "not json" })).status).toBe(400);
    expect(await post("/room/v1/join", { code: invite.code, pad: "x".repeat(1024) })).toMatchObject({ status: 413, body: { error: "too large" } });
    expect((await post("/room/v1/join", { code: invite.code })).status).toBe(200);
  });

  it("is rate limited at 20 a minute", async () => {
    const group = peopleRoom();
    for (let i = 0; i < 20; i += 1) expect((await post("/room/v1/join", { code: `wkr1:${HOST}:nope${i}.wki_${"A".repeat(43)}` })).status).toBe(404);
    const invite = code(group, "Mina");
    expect(await post("/room/v1/join", { code: invite.code })).toMatchObject({ status: 429, body: { error: "busy" } });
    vi.setSystemTime(Date.now() + MINUTE);
    expect((await post("/room/v1/join", { code: invite.code })).status).toBe(200);
  });
});

describe("snapshot and stream", () => {
  it("snapshot: head, the last 200 entries and full state, 30 a minute", async () => {
    const group = peopleRoom();
    store.patchGroup(group.id, { bulletin: "Be kind" });
    const { key, personId } = await joined(group, "Mina");
    for (let i = 1; i <= 205; i += 1) hostSays(group, `line ${i}`);
    const res = await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key });
    expect(res.status).toBe(200);
    expect(res.body.head).toBe(205);
    expect(res.body.entries).toHaveLength(200);
    expect(res.body.entries[0]).toEqual({ seq: 6, id: expect.any(String), at: expect.any(Number), author: { kind: "host", id: "host", name: "Edward" }, text: "line 6" });
    expect(res.body.state).toEqual({
      version: expect.any(Number), roomName: "Team", instructions: "Be kind", host: "Edward",
      me: { id: personId, name: "Mina" }, people: [{ id: personId, name: "Mina" }], bots: [], myAsks: [],
    });
    for (let i = 1; i < 30; i += 1) expect((await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key })).status).toBe(200);
    expect((await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key })).body).toEqual({ error: "rate-limited" });
  });

  it("stream: state, replay after seq, then live; an entry written after the snapshot arrives once", async () => {
    const group = peopleRoom();
    const { key } = await joined(group, "Mina");
    hostSays(group, "one");
    const snap = await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key });
    const late = await post(`/room/v1/rooms/${group.hosted.roomId}/send`, { text: "two" }, { key });
    expect(late.status).toBe(200);
    const stream = await openStream(group.hosted.roomId, key, snap.body.head);
    expect(stream.status).toBe(200);
    await stream.until((frames) => frames.length >= 2);
    writeRoomEntry(store, group, { author: { kind: "host", id: "host", name: "Edward" }, text: "three" });
    const frames = await stream.until((all) => all.length >= 3);
    expect(kinds(frames)).toEqual(["state", "entry:two", "entry:three"]);
    expect(frames.flatMap((frame) => (frame.kind === "entry" ? [frame.entry.seq] : []))).toEqual([2, 3]);
    stream.close();
  });

  it("stream: reset when after is past head or over 1,000 behind, then live", async () => {
    const group = peopleRoom();
    const { key } = await joined(group, "Mina");
    hostSays(group, "one");
    const ahead = await openStream(group.hosted.roomId, key, 5);
    expect(kinds(await ahead.until((frames) => frames.length >= 2))).toEqual(["state", "reset"]);
    await shut(ahead);
    for (let i = 0; i < 1_001; i += 1) hostSays(group, `x${i}`);
    const behind = await openStream(group.hosted.roomId, key, 0);
    expect(kinds(await behind.until((frames) => frames.length >= 2))).toEqual(["state", "reset"]);
    await post(`/room/v1/rooms/${group.hosted.roomId}/send`, { text: "live" }, { key });
    expect(kinds(await behind.until((frames) => frames.length >= 3))).toEqual(["state", "reset", "entry:live"]);
    await shut(behind);
    const edge = await openStream(group.hosted.roomId, key, 3);
    expect(edge.status).toBe(200);
    const frames = await edge.until((all) => all.length >= 1001);
    expect(frames.filter((frame) => frame.kind === "entry")).toHaveLength(1000);
    expect(kinds(frames).includes("reset")).toBe(false);
    edge.close();
  });

  it("stream: after is required, 2 open per person, 10 connects a minute", async () => {
    const group = peopleRoom();
    const { key } = await joined(group, "Mina");
    for (const after of ["", "-1", "x", "1e3"]) expect((await call(`/room/v1/rooms/${group.hosted.roomId}/stream?after=${after}`, { key })).body).toEqual({ error: "bad after" });
    const first = await openStream(group.hosted.roomId, key, 0);
    const second = await openStream(group.hosted.roomId, key, 0);
    await Promise.all([first.until((f) => f.length > 0), second.until((f) => f.length > 0)]);
    expect((await call(`/room/v1/rooms/${group.hosted.roomId}/stream?after=0`, { key })).body).toEqual({ error: "too many streams" });
    for (const open of [first, second]) await shut(open);
    for (let i = 0; i < 7; i += 1) {
      const next = await openStream(group.hosted.roomId, key, 0);
      expect(next.status).toBe(200);
      await shut(next);
    }
    expect((await call(`/room/v1/rooms/${group.hosted.roomId}/stream?after=0`, { key })).body).toEqual({ error: "rate-limited" });
  });

  it("a room change reaches open streams as full state with a higher version, with no message", async () => {
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    const stream = await openStream(group.hosted.roomId, mina.key, 0);
    const [first] = await stream.until((frames) => frames.length >= 1);
    store.patchGroup(group.id, { unread: true });
    store.patchGroup(group.id, { name: "Lunch crew", bulletin: "Fridays" });
    const renamed = await stream.until((frames) => frames.length >= 2);
    const joon = await joined(group, "Joon");
    const after = await stream.until((frames) => frames.length >= 3);
    expect(kinds(after)).toEqual(["state", "state", "state"]);
    const versions = after.map((frame) => (frame.kind === "state" ? frame.state.version : 0));
    expect(versions[1]).toBeGreaterThan(versions[0]!);
    expect(versions[2]).toBeGreaterThan(versions[1]!);
    expect(renamed[1]).toMatchObject({ kind: "state", state: { roomName: "Lunch crew", instructions: "Fridays" } });
    expect(after[2]).toMatchObject({ kind: "state", state: { me: { id: mina.personId }, people: [{ id: mina.personId, name: "Mina" }, { id: joon.personId, name: "Joon" }] } });
    expect(first).toMatchObject({ kind: "state" });
    expect(recentRoomEntries(group.hosted.roomId, 5)).toEqual([]);
    stream.close();
  });

  it("room delete sends ended", async () => {
    const group = peopleRoom();
    const { key } = await joined(group, "Mina");
    const stream = await openStream(group.hosted.roomId, key, 0);
    await stream.until((frames) => frames.length >= 1);
    store.deleteGroup(group.id);
    expect(kinds(await stream.until((frames) => frames.at(-1)?.kind === "ended"))).toEqual(["state", "ended"]);
    await stream.closed;
    expect((await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key })).status).toBe(404);
  });
});

describe("stream internals", () => {
  class FakeRes extends EventEmitter {
    written: string[] = [];
    writableLength = 0;
    writableEnded = false;
    destroyed = false;
    socket = null;
    write(chunk: string) {
      this.written.push(chunk);
      return true;
    }
    end() {
      this.writableEnded = true;
    }
    destroy() {
      this.destroyed = true;
      this.emit("close");
    }
  }

  it("flushes buffered live frames after replay, minus entries already sent", () => {
    const res = new FakeRes();
    const stream = openDoorStream("r", "p", res as unknown as ServerResponse);
    const entry = (seq: number) => ({ seq, id: `e${seq}`, at: 1, author: { kind: "host" as const, id: "host", name: "E" }, text: `t${seq}` });
    stream.buffer!.push({ kind: "entry", entry: entry(2) }, { kind: "state", state: {} as never }, { kind: "entry", entry: entry(3) });
    writeFrame(stream, { kind: "entry", entry: entry(2) });
    goLive(stream, 2);
    expect(res.written.map((chunk) => JSON.parse(chunk.slice(6)).kind + (JSON.parse(chunk.slice(6)).entry?.seq ?? ""))).toEqual(["entry2", "state", "entry3"]);
    res.destroy();
  });

  it("destroys a removed person's stream socket once the ended flush deadline passes", () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const res = new FakeRes();
      const socket = { destroy: vi.fn(), once: vi.fn() };
      Object.assign(res, { socket, end: (chunk: string) => res.written.push(chunk) });
      openDoorStream("r", "p", res as unknown as ServerResponse);
      endDoorPerson("r", "p");
      expect(res.written.at(-1)).toBe(`data: {"kind":"ended"}

`);
      vi.advanceTimersByTime(ENDED_FLUSH_MS - 1);
      expect(socket.destroy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(socket.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useFakeTimers({ toFake: ["Date"] });
    }
  });

  it("sends a comment heartbeat every 15 s and cuts a reader past 1 MB behind", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const res = new FakeRes();
      const stream = openDoorStream("r", "p", res as unknown as ServerResponse);
      goLive(stream, 0);
      vi.advanceTimersByTime(HEARTBEAT_MS * 2);
      expect(res.written).toEqual([": ping\n\n", ": ping\n\n"]);
      res.writableLength = MAX_BACKLOG_BYTES + 1;
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(res.destroyed).toBe(true);
      vi.advanceTimersByTime(HEARTBEAT_MS * 4);
      expect(res.written).toHaveLength(3);
    } finally {
      vi.useFakeTimers({ toFake: ["Date"] });
    }
  });
});

describe("send", () => {
  it("commits and broadcasts only: 0 sendTurn, generateText, loopback or worker calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    const joon = await joined(group, "Joon");
    const watch = await openStream(group.hosted.roomId, joon.key, 0);
    await watch.until((frames) => frames.length >= 1);
    const res = await post(`/room/v1/rooms/${group.hosted.roomId}/send`, { text: "  @Wink lunch?\r\n " }, { key: mina.key });
    expect(res.body).toEqual({ entry: { seq: 1, id: expect.any(String), at: expect.any(Number), author: { kind: "person", id: mina.personId, name: "Mina" }, text: "@Wink lunch?" } });
    const reply = await post(`/room/v1/rooms/${group.hosted.roomId}/send`, { text: "@everyone yes", replyToId: res.body.entry.id }, { key: joon.key });
    const frames = await watch.until((all) => all.length >= 3);
    expect(frames.slice(1)).toEqual([{ kind: "entry", entry: res.body.entry }, { kind: "entry", entry: reply.body.entry }]);
    expect(recentRoomEntries(group.hosted.roomId, 5).map((entry) => ({ seq: entry.seq, id: entry.id, at: entry.at, author: entry.author, text: entry.text, ...(entry.replyToId ? { replyToId: entry.replyToId } : {}) })))
      .toEqual([res.body.entry, reply.body.entry]);
    expect(store.messagesFor(group.threadId).map((message) => [message.origin, message.text])).toEqual([["person", "@Wink lunch?"], ["person", "@everyone yes"]]);
    expect(roomAsks(group.hosted.roomId, ["held", "queued", "running", "stopping", "done", "failed", "cancelled"])).toEqual([]);
    for (const spy of [deps.dispatch, deps.instance, deps.stopTurn, deps.endSession, roomAskHooks.words!, fetchSpy, ...Object.values(engine)]) expect(spy).not.toHaveBeenCalled();
    watch.close();
  });

  /** A send whose body arrives in two parts, with `between` run while it uploads. */
  function slowSend(group: HostedGroup, key: string, between: () => void): Promise<Reply> {
    return new Promise((resolve) => {
      const req = request({
        host: "127.0.0.1", port: relayPort, method: "POST", path: `/room/v1/rooms/${group.hosted.roomId}/send`, agent: false,
        headers: { host: HOST, origin: ORIGIN, authorization: `Bearer ${key}`, "content-type": "application/json" },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      // Remove and revoke cut this socket too; a cut reads as status 0.
      req.on("error", () => resolve({ status: 0, headers: {}, body: null }));
      req.write('{"text":');
      setTimeout(() => {
        between();
        req.end('"too late"}');
      }, 50);
    });
  }

  it("refuses a send whose room was deleted while its body was uploading", async () => {
    const group = peopleRoom();
    const { key } = await joined(group, "Mina");
    expect((await slowSend(group, key, () => store.deleteGroup(group.id))).status).toBe(404);
    expect(recentRoomEntries(group.hosted.roomId, 5)).toEqual([]);
  });

  /** Deletes rows straight from rooms.db, so no stream or socket is cut. */
  function dropRows(sql: string, ...params: string[]): void {
    const db = new DatabaseSync(join(DATA_DIR, "rooms.db"));
    db.prepare(sql).run(...params);
    db.close();
  }

  for (const [what, cut, drop] of [
    ["revoked", revokeGuestKeys, "DELETE FROM guest_keys WHERE room_id = ? AND person_id = ?"],
    ["removed", removeRoomPerson, "DELETE FROM people WHERE room_id = ? AND id = ?"],
  ] as const) {
    it(`commits nothing when the key is ${what} while a send body uploads`, async () => {
      const group = peopleRoom();
      const mina = await joined(group, "Mina");
      const joon = await joined(group, "Joon");
      const watch = await openStream(group.hosted.roomId, joon.key, 0);
      await watch.until((frames) => frames.length >= 1);
      const quiet = await slowSend(group, mina.key, () => dropRows(drop, group.hosted.roomId, mina.personId));
      expect(quiet).toMatchObject({ status: 401, body: { error: "unauthorized" } });
      const second = await joined(group, "Mina2");
      const cutOff = await slowSend(group, second.key, () => cut(group.hosted.roomId, second.personId));
      expect([0, 401]).toContain(cutOff.status);
      expect(recentRoomEntries(group.hosted.roomId, 5)).toEqual([]);
      expect(store.messagesFor(group.threadId)).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(watch.frames.filter((frame) => frame.kind === "entry")).toEqual([]);
      watch.close();
    });
  }

  it("dedupes a retried sendId and refuses its reuse for other text", async () => {
    const group = peopleRoom();
    const { key } = await joined(group, "Mina");
    const sendId = "send-0123456789abcdef";
    const first = await post(`/room/v1/rooms/${group.hosted.roomId}/send`, { text: "hi", sendId }, { key });
    const again = await post(`/room/v1/rooms/${group.hosted.roomId}/send`, { text: "hi", sendId }, { key });
    expect(again.body).toEqual(first.body);
    expect(await post(`/room/v1/rooms/${group.hosted.roomId}/send`, { text: "bye", sendId }, { key })).toMatchObject({ status: 409, body: { error: "sendId was used for another message" } });
    expect((await post(`/room/v1/rooms/${group.hosted.roomId}/send`, { text: "hi", sendId: "short" }, { key })).body).toEqual({ error: "bad sendId" });
    expect(recentRoomEntries(group.hosted.roomId, 5).map((entry) => entry.text)).toEqual(["hi"]);
  });

  it("cuts bodies over 16 KB before parse and refuses bad lines", async () => {
    const group = peopleRoom();
    const { key } = await joined(group, "Mina");
    const path = `/room/v1/rooms/${group.hosted.roomId}/send`;
    expect(await post(path, { text: "x".repeat(16 * 1024) }, { key })).toMatchObject({ status: 413, body: { error: "too large" } });
    expect((await call(path, { method: "POST", key, body: "{" })).body).toEqual({ error: "bad request" });
    expect((await post(path, { text: 5 }, { key })).body).toEqual({ error: "bad request" });
    expect(await post(path, { text: "   " }, { key })).toMatchObject({ status: 400, body: { error: "message is empty" } });
    expect(await post(path, { text: "<attached-file>x" }, { key })).toMatchObject({ status: 400, body: { error: "team rooms don't take attachments" } });
    expect((await post(path, { text: "y".repeat(5000) }, { key })).body.entry.text).toHaveLength(4000);
    expect(recentRoomEntries(group.hosted.roomId, 5)).toHaveLength(1);
  });
});

describe("files", () => {
  const upload = (roomId: string, key: string, body: string | Buffer, name = "notes.txt") => call(`/room/v1/rooms/${roomId}/files?uploadId=${randomBytes(12).toString("base64url")}&name=${name}`, { method: "POST", key, body });

  it("open only to current members of that room, before any read", async () => {
    const a = peopleRoom("A");
    const b = peopleRoom("B");
    const mina = await joined(a, "Mina");
    const pat = await joined(a, "Pat");
    const joe = await joined(b, "Joe");
    const up = await upload(a.hosted.roomId, mina.key, "hello team");
    expect(up).toMatchObject({ status: 200, body: { file: { name: "notes.txt", type: "text/plain", bytes: 10 } } });
    const path = `/room/v1/rooms/${a.hosted.roomId}/files/${up.body.file.id}`;
    expect(await call(path, { key: pat.key })).toMatchObject({
      status: 200,
      body: "hello team",
      headers: { "content-type": "application/octet-stream", "content-disposition": expect.stringMatching(/^attachment;/), "x-content-type-options": "nosniff" },
    });
    expect((await call(`${path}/preview`, { key: pat.key })).status).toBe(404);
    expect(await call(path, { key: joe.key })).toMatchObject({ status: 404, body: { error: "not found" } });
    expect(await call(`/room/v1/rooms/${b.hosted.roomId}/files/${up.body.file.id}`, { key: joe.key })).toMatchObject({ status: 404, body: { error: "not found" } });
    expect(await call(path)).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    for (const method of ["HEAD", "PUT", "POST"]) expect((await call(path, { method, key: mina.key, headers: { origin: ORIGIN } })).status, method).toBe(404);
    expect((await call(path, { method: "DELETE", key: mina.key, headers: { origin: ORIGIN } })).status).toBe(403);
    expect((await call(`/room/v1/rooms/${a.hosted.roomId}/files`, { key: mina.key })).status).toBe(404);
    expect((await upload(b.hosted.roomId, mina.key, "wrong room")).status).toBe(404);
    removeRoomPerson(a.hosted.roomId, mina.personId);
    expect(await call(path, { key: mina.key })).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect((await upload(a.hosted.roomId, mina.key, "after remove")).status).toBe(401);
    revokeGuestKeys(a.hosted.roomId, pat.personId);
    expect((await call(path, { key: pat.key })).status).toBe(401);
  });

  it("ride on a send to every reader; someone else's file, an empty line and a reused sendId are refused", async () => {
    const group = peopleRoom();
    const roomId = group.hosted.roomId;
    const mina = await joined(group, "Mina");
    const pat = await joined(group, "Pat");
    const mine = await upload(roomId, mina.key, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]), "cat.png");
    const theirs = await upload(roomId, pat.key, "pat's notes");
    expect([mine.status, theirs.status]).toEqual([200, 200]);
    expect(mine.body.file).toMatchObject({ type: "image/png", bytes: 16 });
    const stream = await openStream(roomId, pat.key, 0);
    const path = `/room/v1/rooms/${roomId}/send`;
    const sendId = "send-with-a-file-0001";
    const sent = await post(path, { text: "", fileIds: [mine.body.file.id], sendId }, { key: mina.key });
    expect(sent).toMatchObject({ status: 200, body: { entry: { text: "", files: [mine.body.file] } } });
    await stream.until((frames) => frames.some((frame) => frame.kind === "entry" && frame.entry.files?.[0]?.id === mine.body.file.id));
    expect((await post(path, { text: "", fileIds: [mine.body.file.id], sendId }, { key: mina.key })).body).toEqual(sent.body);
    expect(await post(path, { text: "", sendId }, { key: mina.key })).toMatchObject({ status: 409, body: { error: "sendId was used for another message" } });
    expect(await post(path, { text: "look", fileIds: [theirs.body.file.id] }, { key: mina.key })).toMatchObject({ status: 404, body: { error: "no such file in this room" } });
    expect(await post(path, { text: " ", fileIds: [] }, { key: mina.key })).toMatchObject({ status: 400, body: { error: "message is empty" } });
    expect(await post(path, { text: "x", fileIds: "nope" }, { key: mina.key })).toMatchObject({ status: 400, body: { error: "bad request" } });
    expect(await post(path, { text: "x", fileIds: Array.from({ length: 51 }, () => mine.body.file.id) }, { key: mina.key })).toMatchObject({ status: 400 });
    expect(recentRoomEntries(roomId, 5).map((entry) => entry.files?.map((file) => file.id))).toEqual([[mine.body.file.id]]);
    expect(store.messagesFor(group.threadId).at(-1)).toMatchObject({ roomFiles: [mine.body.file] });
    const preview = await call(`/room/v1/rooms/${roomId}/files/${mine.body.file.id}/preview`, { key: pat.key });
    expect(preview.headers).toMatchObject({ "content-type": "image/png", "content-disposition": expect.stringMatching(/^inline;/), "x-content-type-options": "nosniff" });
    await shut(stream);
  });
});

describe("remove, leave and revoke", () => {
  it("remove deletes the key, sends ended, closes streams and keep-alive sockets", async () => {
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    const joon = await joined(group, "Joon");
    const streams = [await openStream(group.hosted.roomId, mina.key, 0), await openStream(group.hosted.roomId, mina.key, 0)];
    const other = await openStream(group.hosted.roomId, joon.key, 0);
    await Promise.all([...streams, other].map((stream) => stream.until((frames) => frames.length >= 1)));
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    expect((await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key: mina.key, agent })).status).toBe(200);
    const [socket] = Object.values(agent.freeSockets).flat() as Socket[];
    const cut = new Promise((resolve) => socket!.once("close", resolve));
    expect(removeRoomPerson(group.hosted.roomId, mina.personId)).toBe(true);
    for (const stream of streams) {
      expect(kinds(await stream.until((frames) => frames.at(-1)?.kind === "ended"))).toEqual(["state", "ended"]);
      await stream.closed;
    }
    await cut;
    const seen = await other.until((frames) => frames.length >= 2);
    expect(seen[1]).toMatchObject({ kind: "state", state: { people: [{ id: joon.personId, name: "Joon" }] } });
    expect((await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key: mina.key })).status).toBe(401);
    expect((await post(`/room/v1/rooms/${group.hosted.roomId}/send`, { text: "still here?" }, { key: mina.key })).status).toBe(401);
    expect(recentRoomEntries(group.hosted.roomId, 5)).toEqual([]);
    agent.destroy();
    other.close();
  });

  it("revoke ends the person's streams and their key", async () => {
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    const stream = await openStream(group.hosted.roomId, mina.key, 0);
    await stream.until((frames) => frames.length >= 1);
    expect(revokeGuestKeys(group.hosted.roomId, mina.personId)).toBe(true);
    expect(kinds(await stream.until((frames) => frames.at(-1)?.kind === "ended"))).toEqual(["state", "ended"]);
    await stream.closed;
    expect((await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { key: mina.key })).status).toBe(401);
  });

  it("leave answers, then ends the person's streams and key", async () => {
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    const stream = await openStream(group.hosted.roomId, mina.key, 0);
    await stream.until((frames) => frames.length >= 1);
    expect(await post(`/room/v1/rooms/${group.hosted.roomId}/leave`, {}, { key: mina.key })).toMatchObject({ status: 200, body: { ok: true } });
    expect(kinds(await stream.until((frames) => frames.at(-1)?.kind === "ended"))).toEqual(["state", "ended"]);
    expect(roomPeople(group.hosted.roomId)).toEqual([]);
    expect((await post(`/room/v1/rooms/${group.hosted.roomId}/leave`, {}, { key: mina.key })).status).toBe(401);
  });
});

describe("wiring", () => {
  const source = (file: string) => readFileSync(join(import.meta.dirname, "..", file), "utf8");

  it("index.ts mounts the door on the gate and 404s loopback /room", () => {
    const index = source("index.ts");
    expect(index).toContain("room: handleRoomDoor,");
    expect(index).toContain("configureRoomDoor({ store,");
    expect(index).toMatch(/if \(!relay && roomDoorPath\(path\)\) return json\(res, 404, \{ error: "not found" \}\);/);
  });
});


describe("own name", () => {
  it("cleans and numbers the caller's name and limits changes", async () => {
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    const other = await joined(group, "민아");
    const path = `/room/v1/rooms/${group.hosted.roomId}/name`;
    const rename = (name: unknown) => post(path, { name }, { key: mina.key });
    expect((await rename("@민아")).body).toEqual({ name: "민아 2" });
    expect((await rename("민아 2")).body).toEqual({ name: "민아 2" });
    expect((await rename("")).body).toEqual({ name: "Guest" });
    expect(roomPeople(group.hosted.roomId).find((person) => person.id === other.personId)?.name).toBe("민아");
    expect((await rename(12)).status).toBe(400);
    expect((await call(path, { key: mina.key })).status).toBe(404);
    expect((await post(path, { name: "x" })).status).toBe(401);
    for (let i = 0; i < 10; i++) await rename("Guest");
    expect((await rename("Guest")).status).toBe(429);
  });

  it("pushes renamed people to both live viewers", async () => {
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    const other = await joined(group, "Daniel");
    const streams = await Promise.all([openStream(group.hosted.roomId, mina.key, 0), openStream(group.hosted.roomId, other.key, 0)]);
    try {
      expect((await post(`/room/v1/rooms/${group.hosted.roomId}/name`, { name: "민아" }, { key: mina.key })).status).toBe(200);
      for (const stream of streams) {
        const frames = await stream.until((frames) => frames.some((frame) => frame.kind === "state" && frame.state.people.some((person) => person.name === "민아")));
        expect(Buffer.byteLength(JSON.stringify(frames.at(-1)))).toBeLessThan(256 * 1024);
      }
    } finally {
      streams.forEach((stream) => stream.close());
    }
  });

  it("pushes a profile rename without a group edit", async () => {
    let host = "Edward";
    configureRoomDoor({ store, hostName: () => host });
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    const stream = await openStream(group.hosted.roomId, mina.key, 0);
    try {
      expect(typeof roomDoor.hostNameChanged).toBe("function");
      host = "에드워드";
      roomDoor.hostNameChanged();
      await stream.until((frames) => frames.some((frame) => frame.kind === "state" && frame.state.host === host));
    } finally {
      stream.close();
    }
  });
});
