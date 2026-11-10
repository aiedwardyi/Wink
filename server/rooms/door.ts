// The relay-facing door to people-only team rooms: a teammate's PC joins with
// an invite code, then reads and sends in that one room. Routes and frames are
// frozen in the door protocol; the guest key opens nothing else.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { RateLimiter, rateKey } from "../phone-auth.ts";
import { parseSendId } from "../send-idempotency.ts";
import type { Store } from "../store.ts";
import type { HostedGroup } from "./asks.ts";
import { committedRoomText, recentRoomEntries, roomEntriesAfter, roomEntry, roomPeople, type RoomPerson } from "./db.ts";
import {
  anyDoorStreams,
  doorEntry,
  doorStreamCount,
  endDoorRoom,
  goLive,
  openDoorStream,
  sendDoorState,
  trackDoorSocket,
  writeFrame,
  type DoorState,
} from "./door-streams.ts";
import { FILE_PATH, fileAction, fileIdsOf, fileRoute } from "./file-routes.ts";
import { guestByKey, inviteRoomId, joinRoom, removeGuest, type JoinResult } from "./invites.ts";
import { peopleOnlyRoom } from "./people-only.ts";
import { hostedSend } from "./send.ts";

const MINUTE = 60_000;
const BODY_BYTES = 16 * 1024;
const JOIN_BODY_BYTES = 1024;
const SNAPSHOT_ENTRIES = 200;
const REPLAY_ENTRIES = 1_000;
const MAX_STREAMS = 2;
const ROUTE = /^\/room\/v1\/rooms\/([\w-]{1,64})\/(snapshot|stream|send|leave|asks\/[\w-]{1,64}\/cancel)$/;
const METHODS: Record<string, string> = { snapshot: "GET", stream: "GET", send: "POST", leave: "POST", cancel: "POST", upload: "POST", download: "GET", preview: "GET" };
const CODE = /^wkr1:([a-z0-9.-]{1,253}):([\w-]{1,64})\.(wki_[A-Za-z0-9_-]{43})$/;
const JOIN_STATUS = {
  busy: 429,
  "no-invite": 404,
  "wrong-secret": 401,
  "too-many-tries": 401,
  "room-full": 409,
  "name-taken": 409,
} satisfies Record<Extract<JoinResult, { ok: false }>["error"], number>;

export interface RoomDoorDeps {
  store: Pick<Store, "groups" | "messagesFor" | "onChange">;
  teamRooms(): boolean;
  hostName(): string;
}

type Guest = { roomId: string; person: RoomPerson };

let door: {
  deps: RoomDoorDeps;
  unauthenticated: RateLimiter;
  badKeys: RateLimiter;
  snapshots: RateLimiter;
  connects: RateLimiter;
  versions: Map<string, { version: number; shared: string }>;
  /** Group id to room id, for rooms that had a stream. */
  watched: Map<string, string>;
  unsubscribe: () => void;
} | null = null;

export function configureRoomDoor(deps: RoomDoorDeps | null): void {
  door?.unsubscribe();
  door = null;
  if (!deps) return;
  const now = () => Date.now();
  door = {
    deps,
    unauthenticated: new RateLimiter(120, MINUTE, now, 1),
    badKeys: new RateLimiter(20, MINUTE, now),
    snapshots: new RateLimiter(30, MINUTE, now),
    connects: new RateLimiter(10, MINUTE, now),
    versions: new Map(),
    watched: new Map(),
    unsubscribe: deps.store.onChange((change) => {
      const roomId = (change.type === "group" || change.type === "group.deleted") && door?.watched.get(change.groupId);
      if (!roomId || !anyDoorStreams()) return;
      if (doorGroup(roomId)) return pushRoomState(roomId);
      endDoorRoom(roomId);
      door!.versions.delete(roomId);
      door!.watched.delete(change.groupId);
    }),
  };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

const notFound = (res: ServerResponse) => send(res, 404, { error: "not found" });

/** A people-only hosted room the door serves; anything else reads as absent. */
function doorGroup(roomId: string): HostedGroup | null {
  const group = door?.deps.store.groups.find((candidate) => candidate.hosted?.roomId === roomId);
  return group && peopleOnlyRoom(roomId) ? (group as HostedGroup) : null;
}

function sharedState(group: HostedGroup) {
  const people = roomPeople(group.hosted.roomId).map((person) => ({ id: person.id, name: person.name }));
  return { roomName: group.name, instructions: group.bulletin ?? "", host: door!.deps.hostName(), people };
}

/** Full state for one viewer. The version moves only when what everyone sees changed. */
function doorState(group: HostedGroup, person: RoomPerson): DoorState {
  const roomId = group.hosted.roomId;
  const shared = sharedState(group);
  const text = JSON.stringify(shared);
  const last = door!.versions.get(roomId);
  const version = last?.shared === text ? last.version : Math.max((last?.version ?? 0) + 1, Date.now());
  door!.versions.set(roomId, { version, shared: text });
  return { version, ...shared, me: { id: person.id, name: person.name }, bots: [], myAsks: [] };
}

function pushRoomState(roomId: string): void {
  const group = doorGroup(roomId);
  if (!group) return;
  const last = door!.versions.get(roomId);
  if (last && last.shared === JSON.stringify(sharedState(group))) return;
  const people = roomPeople(roomId);
  sendDoorState(roomId, (personId) => {
    const person = people.find((candidate) => candidate.id === personId);
    return person ? doorState(group, person) : null;
  });
}

type Body = { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

/** Counted while reading; past `max` it answers 413 and never parses. */
function readJson(req: IncomingMessage, max: number): Promise<Body> {
  return new Promise((resolve) => {
    if (Number(req.headers["content-length"] ?? 0) > max) return resolve({ ok: false, status: 413 });
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (body: Body) => {
      if (done) return;
      done = true;
      resolve(body);
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) return finish({ ok: false, status: 413 });
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        finish({ ok: false, status: 400 });
      }
    });
    req.on("error", () => finish({ ok: false, status: 400 }));
  });
}

function bodyError(res: ServerResponse, status: 400 | 413): void {
  if (status === 413) send(res, 413, { error: "too large" }, { connection: "close" });
  else send(res, 400, { error: "bad request" });
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

async function join(req: IncomingMessage, res: ServerResponse, relayHost: string): Promise<void> {
  const { deps, unauthenticated } = door!;
  if (!unauthenticated.take("door")) return send(res, 429, { error: "rate-limited" });
  const body = await readJson(req, JOIN_BODY_BYTES);
  if (!body.ok) return bodyError(res, body.status);
  const code = record(body.value)?.code;
  const parts = typeof code === "string" ? CODE.exec(code) : null;
  if (!parts || parts[1] !== relayHost) return send(res, 400, { error: "bad-code" });
  // An unknown invite still goes through joinRoom, so it spends the join limit.
  const roomId = inviteRoomId(parts[2]!);
  if (roomId && !doorGroup(roomId)) return send(res, 404, { error: "no-invite" });
  const result = joinRoom(parts[2]!, parts[3]!, [deps.hostName()]);
  if (!result.ok) return send(res, JOIN_STATUS[result.error], { error: result.error });
  pushRoomState(result.roomId);
  send(res, 200, { roomId: result.roomId, person: { id: result.person.id, name: result.person.name }, key: result.key });
}

const bearerOf = (req: IncomingMessage) => /^Bearer (\S{1,256})$/.exec(req.headers.authorization ?? "")?.[1];

function guestFor(req: IncomingMessage, res: ServerResponse, peer: string | null): Guest | null {
  const { unauthenticated, badKeys } = door!;
  const bearer = bearerOf(req);
  const guest = bearer ? guestByKey(bearer) : null;
  if (guest) return guest;
  const limited = !unauthenticated.take("door") || (bearer !== undefined && !badKeys.take(rateKey(peer)));
  send(res, limited ? 429 : 401, { error: limited ? "rate-limited" : "unauthorized" });
  return null;
}

function snapshot(res: ServerResponse, group: HostedGroup, person: RoomPerson): void {
  if (!door!.snapshots.take(person.id)) return send(res, 429, { error: "rate-limited" });
  const entries = recentRoomEntries(group.hosted.roomId, SNAPSHOT_ENTRIES);
  send(res, 200, { head: entries.at(-1)?.seq ?? 0, entries: entries.map(doorEntry), state: doorState(group, person) });
}

/** Register and buffer, state, replay after `after` (or reset), flush, live. */
function stream(res: ServerResponse, url: URL, group: HostedGroup, person: RoomPerson): void {
  const roomId = group.hosted.roomId;
  const raw = url.searchParams.get("after") ?? "";
  if (!/^\d{1,15}$/.test(raw)) return send(res, 400, { error: "bad after" });
  if (!door!.connects.take(person.id)) return send(res, 429, { error: "rate-limited" });
  if (doorStreamCount(roomId, person.id) >= MAX_STREAMS) return send(res, 429, { error: "too many streams" });
  const after = Number(raw);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  door!.watched.set(group.id, roomId);
  const open = openDoorStream(roomId, person.id, res);
  writeFrame(open, { kind: "state", state: doorState(group, person) });
  const head = recentRoomEntries(roomId, 1)[0]?.seq ?? 0;
  if (after > head || head - after > REPLAY_ENTRIES) {
    writeFrame(open, { kind: "reset" });
    return goLive(open, head);
  }
  for (const entry of roomEntriesAfter(roomId, after, REPLAY_ENTRIES)) writeFrame(open, { kind: "entry", entry: doorEntry(entry) });
  goLive(open, head);
}

async function sendLine(req: IncomingMessage, res: ServerResponse, roomId: string, person: RoomPerson): Promise<void> {
  const body = await readJson(req, BODY_BYTES);
  if (!body.ok) return bodyError(res, body.status);
  // The room, key or person may have gone while the body was uploading.
  const group = doorGroup(roomId);
  if (!group) return notFound(res);
  const bearer = bearerOf(req);
  const still = bearer ? guestByKey(bearer) : null;
  if (still?.roomId !== roomId || still.person.id !== person.id) return send(res, 401, { error: "unauthorized" });
  const fields = record(body.value);
  const text = fields?.text;
  const replyToId = fields?.replyToId;
  const fileIds = fileIdsOf(fields?.fileIds);
  if (typeof text !== "string" || !fileIds || (replyToId !== undefined && typeof replyToId !== "string")) return send(res, 400, { error: "bad request" });
  if (replyToId !== undefined && !/^[\w-]{1,64}$/.test(replyToId)) return send(res, 404, { error: "no such message in this room" });
  let sendId: string | undefined;
  try {
    sendId = parseSendId(fields?.sendId === undefined ? undefined : String(fields.sendId));
  } catch {
    return send(res, 400, { error: "bad sendId" });
  }
  try {
    const earlier = sendId ? door!.deps.store.messagesFor(group.threadId).find((message) => message.sendId === sendId && message.author?.id === person.id) : undefined;
    if (earlier) {
      const entry = earlier.roomEntryId ? roomEntry(roomId, earlier.roomEntryId) : null;
      const files = (entry?.files ?? []).map((file) => file.id);
      if (!entry || entry.text !== committedRoomText("person", text) || entry.replyToId !== replyToId || files.join() !== fileIds.join()) {
        return send(res, 409, { error: "sendId was used for another message" });
      }
      return send(res, 200, { entry: doorEntry(entry) });
    }
    const { entry } = hostedSend(group, { kind: "person", id: person.id }, text, replyToId, sendId, fileIds);
    send(res, 200, { entry: doorEntry(entry) });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === undefined) throw error;
    send(res, status, { error: (error as Error).message });
  }
}

/** Remove and Leave: the person and keys go, `ended` goes out, their sockets are cut. */
export function removeRoomPerson(roomId: string, personId: string, keep?: Duplex): boolean {
  const removed = removeGuest(roomId, personId, keep);
  if (removed) pushRoomState(roomId);
  return removed;
}

/** Every relay request under /room. Unknown paths and other rooms are 404 before any room lookup. */
export async function handleRoomDoor(req: IncomingMessage, res: ServerResponse, relay: { host: string; peer: string | null }): Promise<void> {
  if (!door?.deps.teamRooms()) return notFound(res);
  const url = new URL(req.url ?? "/", "https://relay.invalid");
  const method = req.method ?? "GET";
  if (url.pathname === "/room/v1/join") return method === "POST" ? join(req, res, relay.host) : notFound(res);
  const file = url.pathname.startsWith("/room/v1/") ? FILE_PATH.exec(url.pathname.slice("/room/v1".length)) : null;
  const route = file ?? ROUTE.exec(url.pathname);
  const action = file ? fileAction(file) : route?.[2]?.startsWith("asks/") ? "cancel" : route?.[2];
  if (!route || !action || method !== (METHODS[action] ?? "POST")) return notFound(res);
  const guest = guestFor(req, res, relay.peer);
  if (!guest) return;
  if (guest.roomId !== route[1]) return notFound(res);
  const group = doorGroup(guest.roomId);
  if (!group) return notFound(res);
  trackDoorSocket(guest.roomId, guest.person.id, req.socket);
  if (file) return fileRoute(file, req, res, url, guest.roomId, guest.person.id, () => guestByKey(bearerOf(req) ?? "")?.person.id === guest.person.id && doorGroup(guest.roomId) !== null);
  if (action === "snapshot") return snapshot(res, group, guest.person);
  if (action === "stream") return stream(res, url, group, guest.person);
  if (action === "send") return sendLine(req, res, guest.roomId, guest.person);
  if (action === "cancel") return send(res, 404, { error: "no such ask" });
  removeRoomPerson(guest.roomId, guest.person.id, req.socket);
  send(res, 200, { ok: true }, { connection: "close" });
}
