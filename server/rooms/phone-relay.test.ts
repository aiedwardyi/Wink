import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { createGroupRoutes } from "../group-routes.ts";
import { json, readBody } from "../http-helpers.ts";
import { PhoneAccess } from "../phone-access.ts";
import { requestCredentials, roomDoorPath } from "../phone-auth.ts";
import { createPhoneRelay } from "../phone-relay/runtime.ts";
import { loopbackLookup } from "../phone-relay/testing/fake-relay.ts";
import { FakeClock } from "../phone-relay/testing/fake-clock.ts";
import { rig, StatusLog, type Rig } from "../phone-relay/testing/harness.ts";
import { isRelayRequest } from "../phone-relay/via.ts";
import { apiRequestAuthorized } from "../remote-access.ts";
import { Store, type GroupRecord } from "../store.ts";
import { createThreadRoutes } from "../thread-routes.ts";
import { closeAsksDb, configureRoomAsks, type HostedGroup } from "./asks.ts";
import { closeRoomsDb, recentRoomEntries, roomPeople } from "./db.ts";
import { configureRoomDoor, handleRoomDoor } from "./door.ts";
import { hostFileRoute } from "./file-routes.ts";
import { GuestClient } from "./guest-client.ts";
import { closeInvitesDb, roomCode } from "./invites.ts";
import { joinedFileRoute } from "./joined-files.ts";
import { joinedRoute } from "./joined-routes.ts";
import { closeJoinedDb } from "./joined.ts";
import { createPeopleOnlyRoom } from "./people-only.ts";
import { peopleRoute } from "./people-routes.ts";

const COMMS = "c".repeat(48);
const BOT = "Bearer bot-token";
const source = readFileSync(join(import.meta.dirname, "..", "index.ts"), "utf8");
const index = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
let statements: readonly ts.Statement[] = [];
const walk = (node: ts.Node): void => {
  if (ts.isTryStatement(node) && node.tryBlock.statements.some((s) => s.getText(index).startsWith("const relay = isRelayRequest(req)"))) statements = node.tryBlock.statements;
  ts.forEachChild(node, walk);
};
walk(index);

function app(deps: Record<string, unknown>) {
  const texts = statements.map((s) => s.getText(index));
  const start = texts.findIndex((s) => s.startsWith("const relay ="));
  const end = texts.findIndex((s) => s.startsWith("const startupWait ="));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  // Selected routes must stay top-level in the request handler.
  const wanted = [
    'if (path.startsWith("/api/") &&', 'if (await phoneAccess.handle(', 'if (method === "GET" && path === "/api/bots")',
    'if (await joinedFileRoute(', 'if (await peopleRoute(', 'if (await hostFileRoute(', 'const joinedReply =', 'if (joinedReply)',
  ].map((prefix) => {
    const matches = texts.filter((text) => text.startsWith(prefix));
    expect(matches, prefix).toHaveLength(1);
    return matches[0];
  });
  const messages = texts.findIndex((s) => s === 'm = path.match(/^\\/api\\/threads\\/([\\w-]+)\\/messages$/);');
  expect(messages).toBeGreaterThan(0);
  const create = texts.find((s) => s.startsWith('if (method === "POST" && path === "/api/groups")'))!;
  expect(create).toBeDefined();
  const code = `async function serve(req, res) { let m; ${[...texts.slice(start, end), ...wanted, create, ...texts.slice(messages, messages + 2)].join("\n")} res.writeHead(404).end(); }`;
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(deps), `${js}\nreturn serve;`)(...Object.values(deps)) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

let r: Rig;
let access: PhoneAccess;
let local: Server;
let port: number;
let store: Store;
let group: HostedGroup;
let guest: GuestClient;
let cookie = "";

interface Reply { status: number; body: any; bytes: Buffer; headers: IncomingMessage["headers"] }

function call(path: string, { method = "GET", body, session = true, relay = true, authorization }: {
  method?: string; body?: unknown; session?: boolean; relay?: boolean; authorization?: string;
} = {}): Promise<Reply> {
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const headers = {
    host: relay ? r.host : "127.0.0.1", ...(relay ? { origin: `https://${r.host}` } : {}),
    ...(session && cookie ? { cookie } : {}), ...(authorization ? { authorization } : {}),
    ...(bytes ? { "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json", "content-length": String(bytes.length) } : {}),
  };
  return new Promise((resolve, reject) => {
    const socket = relay ? r.relay.phone(r.host) : undefined;
    socket?.on("error", reject);
    const req = request({ host: relay ? r.host : "127.0.0.1", port: relay ? 443 : port, path, method, headers,
      ...(socket ? { createConnection: () => socket } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        socket?.destroy();
        const bytes = Buffer.concat(chunks);
        let body: unknown = bytes.toString();
        try { body = JSON.parse(bytes.toString()); } catch {}
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, bytes });
      });
    });
    req.on("error", reject);
    req.end(bytes);
  });
}

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(() => ({ instanceId: "fake", model: "m" }));
  group = store.createGroup("팀과 함께하는 아주 긴 출시 준비 대화방", [], false, undefined, undefined, { roomId: createPeopleOnlyRoom("팀과 함께하는 아주 긴 출시 준비 대화방").id }) as HostedGroup;
  configureRoomAsks({ store, hostName: () => "Edward", driverKind: () => undefined, instance: () => null, dispatch: () => {}, stopTurn: async () => {}, endSession: async () => {} });
  configureRoomDoor({ store, hostName: () => "Edward" });
  r = await rig();
  const statuses = new StatusLog();
  access = new PhoneAccess({
    dataDir: r.dataDir, env: {}, staticDir: null, config: () => r.config, saveEnabled: () => {}, room: handleRoomDoor,
    onChange: () => statuses.push(access.status()),
    start: (options) => createPhoneRelay(options, { clock: new FakeClock(), env: {}, connector: r.relay.connector(), ctSource: null, acmeInsecureDirectories: true }),
  });
  guest = new GuestClient({ bases: () => [null, "wink.test"], joiner: () => ({ name: "Mina", device: "pc-mina-0123456789abcdef" }),
    https: { ca: r.ca.certPem, lookup: loopbackLookup, port: r.relay.port },
    onChange: () => {}, timing: { retryMs: 50, maxRetryMs: 200 },
  });
  const handler = app({
    PORT: 0, REMOTE_HOST: undefined, REMOTE_KEY: undefined, phoneAccess: access, store, guestClient: guest,
    isRelayRequest, requestCredentials, roomDoorPath, json, readBody, apiRequestAuthorized,
    authorizedComms: (value: string) => value === `Bearer ${COMMS}` || value === BOT,
    isLoopbackHost: () => true, hostMatchesRemote: () => false, isAllowedOrigin: () => true, originAllowedByRemote: () => false, linkedFileGrant: () => null,
    peopleRoute, hostFileRoute, joinedRoute, joinedFileRoute, commsCallers: { resolve: (value: string) => value === BOT },
    traceOpenBots: () => {}, pageSize: () => undefined, OPEN_CHAT_HEADER: "x-open-chat", offscreenLimit: () => 0,
    publicBotRecord: (bot: unknown) => bot, messagePage: (id: string) => ({ messages: store.messagesFor(id) }), publicGroupState: (group: unknown) => group,
    computerControl: { snapshot: () => ({ held: false }) }, STREAM_ID: "s", lastSeq: 0,
    groupRoutes: createGroupRoutes({ store, publicGroupState: (group: GroupRecord) => group } as unknown as Parameters<typeof createGroupRoutes>[0]),
    threadRoutes: createThreadRoutes({ store, dataDir: DATA_DIR, threadSyncGate: { enabled: false }, pullSyncedThread: () => {}, DEFAULT_PAGE: 200,
      pageSize: () => undefined, messagePage: (id: string) => ({ messages: store.messagesFor(id) }),
    } as unknown as Parameters<typeof createThreadRoutes>[0]),
  });
  local = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  port = (local.address() as { port: number }).port;
  await access.start(handler);
  await statuses.until((s) => s.state === "connected");
  const pairing = await call("/api/phone/pairing", { relay: false, method: "POST", authorization: `Bearer ${COMMS}` });
  expect(pairing.status).toBe(200);
  const paired = await call("/api/phone/pair", { method: "POST", session: false, body: { credential: pairing.body.code, name: "Pixel", requestId: randomUUID() } });
  expect(paired.status).toBe(200);
  cookie = paired.headers["set-cookie"]![0].split(";")[0];
});

afterAll(async () => {
  guest?.stop();
  await access?.stop();
  local?.closeAllConnections();
  if (local) await new Promise<void>((resolve) => local.close(() => resolve()));
  await r?.close();
  configureRoomDoor(null);
  configureRoomAsks(null);
  closeAsksDb();
  closeInvitesDb();
  closeRoomsDb();
  closeJoinedDb();
});

describe("rooms through the fake phone relay", () => {
  it("lists hosted rooms for a paired relay phone", async () => {
    const result = await call("/api/bots");
    expect(result.status).toBe(200);
    expect(result.body.groups.map((g: HostedGroup) => g.id)).toContain(group.id);
    expect((await call(`/api/threads/${group.threadId}/messages`)).status).toBe(200);
  });

  it("creates a listed room and sends its first line from the phone", async () => {
    const created = await call("/api/groups", { method: "POST", body: { name: "Phone launch", hosted: true, peopleOnly: true, memberIds: [] } });
    expect(created.status).toBe(201);
    const room = created.body.group;
    expect((await call("/api/bots")).body.groups.map((g: HostedGroup) => g.id)).toContain(room.id);
    expect((await call(`/api/rooms/${room.hosted.roomId}/send`, { method: "POST", body: { text: "hello" } })).status).toBe(200);
  });

  it("sends text, a picture and a file as the host", async () => {
    const base = `/api/rooms/${group.hosted.roomId}`;
    expect((await call(`${base}/send`, { method: "POST", body: { text: "from the phone" } })).status).toBe(200);
    for (const [name, bytes] of [["phone.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64")], ["notes.txt", Buffer.from("Notes from the phone\n")]] as const) {
      const upload = await call(`${base}/files?name=${name}&uploadId=${randomUUID()}`, { method: "POST", body: bytes });
      expect(upload.status).toBe(200);
      const sent = await call(`${base}/send`, { method: "POST", body: { text: name, fileIds: [upload.body.file.id] } });
      expect(sent.status).toBe(200);
      expect((await call(`${base}/files/${upload.body.file.id}`)).bytes).toEqual(bytes);
    }
    expect(recentRoomEntries(group.hosted.roomId, 10).map((e) => e.text)).toEqual(["from the phone", "phone.png", "notes.txt"]);
    expect((await call(`/api/threads/${group.threadId}/messages`)).body.messages.map((m: { text: string }) => m.text)).toEqual(["from the phone", "phone.png", "notes.txt"]);
    const heic = await call(`${base}/files?name=iphone.heic&uploadId=${randomUUID()}`, { method: "POST", body: Buffer.from("00000018667479706865696300000000", "hex") });
    expect(heic.status).toBe(415);
  });

  it("joins by code, lists and reads the joined room, sends and leaves", async () => {
    const code = roomCode(group.hosted.roomId);
    const result = await call("/api/joined/join", { method: "POST", body: { code: `wkr1:${r.host}:${code.id}.${code.secret}` } });
    expect(result.status).toBe(200);
    const base = `/api/joined/rooms/${group.hosted.roomId}`;
    await expect.poll(() => guest.room(group.hosted.roomId)?.link).toBe("live");
    expect((await call("/api/joined/rooms")).body.rooms.map((room: { roomId: string }) => room.roomId)).toContain(group.hosted.roomId);
    expect((await call(base)).body.room.state.roomName).toBe(group.name);
    expect((await call(`${base}/send`, { method: "POST", body: { text: "from Mina's phone" } })).status).toBe(200);
    for (const [name, bytes] of [["mina.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64")], ["mina.txt", Buffer.from("Mina's notes\n")]] as const) {
      const upload = await call(`${base}/files?name=${name}&uploadId=${randomUUID()}`, { method: "POST", body: bytes });
      expect(upload.status).toBe(200);
      expect((await call(`${base}/send`, { method: "POST", body: { text: name, fileIds: [upload.body.file.id] } })).status).toBe(200);
      expect((await call(`${base}/files/${upload.body.file.id}`)).bytes).toEqual(bytes);
    }
    expect((await call(`${base}/leave`, { method: "POST", body: {} })).status).toBe(200);
    expect(guest.room(group.hosted.roomId)?.status).toBe("left");
  });

  it("refuses room routes without a phone session even with an owner bearer", async () => {
    for (const [path, method] of [["/api/bots", "GET"], ["/api/joined/rooms", "GET"], ["/api/joined/join", "POST"], [`/api/rooms/${group.hosted.roomId}/send`, "POST"], [`/api/rooms/${group.hosted.roomId}/invites`, "POST"]]) {
      expect((await call(path, { method, session: false, authorization: `Bearer ${COMMS}`, ...(method === "POST" ? { body: {} } : {}) })).status, path).toBe(401);
    }
  });

  it("serves People codes and Remove to the phone while refusing bot invites and the off-relay door", async () => {
    const base = `/api/rooms/${group.hosted.roomId}`;
    const invite = await call(`${base}/invites`, { method: "POST" });
    expect(invite.status).toBe(200);
    expect(invite.body.code).toMatch(/^wkr1:/);
    expect((await call(`${base}/invites`, { relay: false, method: "POST", authorization: BOT })).status).toBe(403);
    expect((await call("/room/rooms", { relay: false })).status).toBe(404);
    const code = roomCode(group.hosted.roomId);
    expect((await guest.join(`wkr1:${r.host}:${code.id}.${code.secret}`)).ok).toBe(true);
    const person = roomPeople(group.hosted.roomId)[0];
    expect((await call(`${base}/people/${person.id}`, { method: "DELETE" })).status).toBe(200);
    expect(roomPeople(group.hosted.roomId)).toEqual([]);
  });
});
