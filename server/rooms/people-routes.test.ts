import { readFileSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PHONE_RELAY_OFF } from "../../shared/relay-protocol.ts";
import { DATA_DIR } from "../config.ts";
import { PhoneAccess } from "../phone-access.ts";
import { relayVerdict } from "../phone-auth.ts";
import { isRelayRequest, markRelaySocket } from "../phone-relay/via.ts";
import { Store } from "../store.ts";
import type { HostedGroup } from "./asks.ts";
import { closeRoomsDb, createRoom, roomPeople } from "./db.ts";
import { configureRoomDoor, handleRoomDoor } from "./door.ts";
import type { DoorFrame } from "./door-streams.ts";
import { closeInvitesDb, roomInvites } from "./invites.ts";
import { createPeopleOnlyRoom } from "./people-only.ts";
import { peopleRoute } from "./people-routes.ts";

const HOST = "abcdefghijklmnop.wink.test";
const ORIGIN = `https://${HOST}`;
const BOT = "Bearer bot-token";
const CODE = /^wkr1:abcdefghijklmnop\.wink\.test:[\w-]{1,64}\.wki_[A-Za-z0-9_-]{43}$/;

let relayServer: Server;
let localServer: Server;
let relayPort = 0;
let localPort = 0;
let access: PhoneAccess;
let store: Store;
let relayHost: string | null = HOST;
const reached: string[] = [];

async function app(req: IncomingMessage, res: ServerResponse) {
  if (isRelayRequest(req) && (await access.gate(req, res)).handled) return;
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  reached.push(path);
  const deps = { store, hostName: () => "Edward", relayHost: () => relayHost, botCaller: req.headers.authorization === BOT };
  if (await peopleRoute(req, res, req.method ?? "GET", path, deps)) return;
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

interface Reply {
  status: number;
  body: any;
}

function call(path: string, init: { method?: string; body?: unknown; relay?: boolean; key?: string; authorization?: string } = {}): Promise<Reply> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = init.relay ? { host: HOST, ...(method === "GET" ? {} : { origin: ORIGIN }) } : { host: "127.0.0.1" };
  if (init.key) headers.authorization = `Bearer ${init.key}`;
  if (init.authorization) headers.authorization = init.authorization;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: init.relay ? relayPort : localPort, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end(init.body === undefined ? undefined : JSON.stringify(init.body));
  });
}

const invite = (roomId: string, name: unknown, authorization?: string) => call(`/api/rooms/${roomId}/invites`, { method: "POST", body: { name }, authorization });
const remove = (roomId: string, personId: string, authorization?: string) => call(`/api/rooms/${roomId}/people/${personId}`, { method: "DELETE", authorization });

interface Stream {
  frames: DoorFrame[];
  closed: Promise<void>;
  until(test: (frames: DoorFrame[]) => boolean): Promise<DoorFrame[]>;
}

function openStream(roomId: string, key: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: relayPort, path: `/room/v1/rooms/${roomId}/stream?after=0`, headers: { host: HOST, authorization: `Bearer ${key}` }, agent: false }, (res) => {
      const stream: Stream = {
        frames: [],
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
      };
      let text = "";
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        let cut: number;
        while ((cut = text.indexOf("\n\n")) >= 0) {
          const block = text.slice(0, cut);
          text = text.slice(cut + 2);
          if (block.startsWith("data: ")) stream.frames.push(JSON.parse(block.slice(6)));
        }
      });
      res.on("error", () => {});
      resolve(stream);
    });
    req.on("error", reject);
    req.end();
  });
}

function peopleRoom(name = "Team"): HostedGroup {
  return store.createGroup(name, [], false, undefined, undefined, { roomId: createPeopleOnlyRoom(name).id }) as HostedGroup;
}

async function joined(group: HostedGroup, name: string): Promise<{ key: string; personId: string }> {
  const { body } = await invite(group.hosted.roomId, name);
  const res = await call("/room/v1/join", { method: "POST", relay: true, body: { code: body.code } });
  expect(res.status).toBe(200);
  return { key: res.body.key, personId: res.body.person.id };
}

const close = () => {
  configureRoomDoor(null);
  closeInvitesDb();
  closeRoomsDb();
};

beforeAll(async () => {
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
    loadClient: async () => ({ start: () => relay, enroll: async () => {}, peer: () => "203.0.113.7" }),
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
});

beforeEach(() => {
  close();
  rmSync(DATA_DIR, { recursive: true, force: true });
  relayHost = HOST;
  reached.length = 0;
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  configureRoomDoor({ store, hostName: () => "Edward" });
});

afterEach(() => {
  vi.restoreAllMocks();
  relayServer.closeAllConnections();
  close();
});

describe("invite", () => {
  it("hands back a code that joins through the door as that name", async () => {
    const group = peopleRoom();
    const res = await invite(group.hosted.roomId, "Mina");
    expect(res.status).toBe(200);
    expect(res.body.invite).toMatchObject({ name: "Mina" });
    expect(res.body.code).toMatch(CODE);
    expect(roomInvites(group.hosted.roomId).map((row) => row.name)).toEqual(["Mina"]);
    const join = await call("/room/v1/join", { method: "POST", relay: true, body: { code: res.body.code } });
    expect(join).toMatchObject({ status: 200, body: { roomId: group.hosted.roomId, person: { name: "Mina" } } });
    expect(roomPeople(group.hosted.roomId).map((person) => person.name)).toEqual(["Mina"]);
  });

  it("is 409 while this PC has no relay host, and makes no invite", async () => {
    const group = peopleRoom();
    relayHost = null;
    expect(await invite(group.hosted.roomId, "Mina")).toEqual({ status: 409, body: { error: "phone access is off" } });
    expect(roomInvites(group.hosted.roomId)).toEqual([]);
  });

  it("refuses names the room can't take", async () => {
    const group = peopleRoom();
    expect((await invite(group.hosted.roomId, "Mina")).status).toBe(200);
    for (const name of ["", "  ", "Edward", "mina", "a@b", 42]) expect([name, (await invite(group.hosted.roomId, name)).status]).toEqual([name, 400]);
    expect(roomInvites(group.hosted.roomId).map((row) => row.name)).toEqual(["Mina"]);
  });

  it("never logs the code", async () => {
    const group = peopleRoom();
    const lines: string[] = [];
    const keep = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    for (const name of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, name).mockImplementation(keep);
    for (const out of [process.stdout, process.stderr]) vi.spyOn(out, "write").mockImplementation(((chunk: unknown) => (keep(chunk), true)) as typeof out.write);
    const { body } = await invite(group.hosted.roomId, "Mina");
    await call("/room/v1/join", { method: "POST", relay: true, body: { code: body.code } });
    vi.restoreAllMocks();
    const secret = String(body.code).split(".").at(-1)!;
    expect(secret).toMatch(/^wki_/);
    expect(lines.join("\n")).not.toContain(secret);
  });
});

describe("remove", () => {
  it("ends the person's streams and key, then is 404", async () => {
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    const stream = await openStream(group.hosted.roomId, mina.key);
    await stream.until((frames) => frames.length >= 1);
    expect(await remove(group.hosted.roomId, mina.personId)).toEqual({ status: 200, body: { ok: true } });
    expect((await stream.until((frames) => frames.at(-1)?.kind === "ended")).map((frame) => frame.kind)).toEqual(["state", "ended"]);
    await stream.closed;
    expect(roomPeople(group.hosted.roomId)).toEqual([]);
    expect((await call(`/room/v1/rooms/${group.hosted.roomId}/snapshot`, { relay: true, key: mina.key })).status).toBe(401);
    expect(await remove(group.hosted.roomId, mina.personId)).toEqual({ status: 404, body: { error: "not found" } });
  });
});

describe("who reaches them", () => {
  it("is 404 with team rooms off, for other rooms and other methods", async () => {
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    const botRoom = store.createGroup("Bots", [], false, undefined, undefined, { roomId: createRoom("Bots").id }) as HostedGroup;
    const id = group.hosted.roomId;
    const misses: Array<[string, string]> = [
      ["GET", `/api/rooms/${id}/invites`], ["DELETE", `/api/rooms/${id}/invites`], ["POST", `/api/rooms/${id}/people/${mina.personId}`],
      ["GET", `/api/rooms/${id}/people/${mina.personId}`], ["POST", `/api/rooms/${botRoom.hosted.roomId}/invites`], ["POST", "/api/rooms/nope/invites"],
    ];
    for (const [method, path] of misses) expect([method, path, (await call(path, { method, body: { name: "Joon" } })).status]).toEqual([method, path, 404]);
    expect(roomInvites(id)).toEqual([]);
    expect(roomInvites(botRoom.hosted.roomId)).toEqual([]);
    expect(roomPeople(id).map((person) => person.name)).toEqual(["Mina"]);
  });

  it("refuses a bot's comms token", async () => {
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    expect(await invite(group.hosted.roomId, "Joon", BOT)).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(await remove(group.hosted.roomId, mina.personId, BOT)).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(roomInvites(group.hosted.roomId)).toEqual([]);
    expect(roomPeople(group.hosted.roomId).map((person) => person.name)).toEqual(["Mina"]);
  });

  it("is never reachable through the relay", async () => {
    const group = peopleRoom();
    const mina = await joined(group, "Mina");
    reached.length = 0;
    const id = group.hosted.roomId;
    for (const [method, path] of [["POST", `/api/rooms/${id}/invites`], ["DELETE", `/api/rooms/${id}/people/${mina.personId}`]] as const) {
      expect(relayVerdict({ method, url: path, rawHeaders: ["host", HOST, "origin", ORIGIN] }, HOST)).toEqual({ kind: "deny", status: 404, error: "not found" });
      expect((await call(path, { method, relay: true, body: { name: "Joon" }, key: mina.key })).status).toBe(404);
    }
    expect(reached).toEqual([]);
    expect(roomInvites(id)).toEqual([]);
    expect(roomPeople(id).map((person) => person.name)).toEqual(["Mina"]);
  });
});

describe("wiring", () => {
  const index = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8").replace(/\r\n/g, "\n");

  it("index.ts mounts the people routes before the room file routes, owner only", () => {
    const people = index.indexOf("await peopleRoute(req, res, method, path, {");
    expect(people).toBeGreaterThan(0);
    expect(people).toBeLessThan(index.indexOf("await hostFileRoute("));
    const line = index.slice(people, index.indexOf("\n", people));
    expect(line).toContain("botCaller: Boolean(commsCallers.resolve(req.headers.authorization))");
    expect(line).toContain("relayHost: () => phoneAccess.presenceHost()");
  });
});
