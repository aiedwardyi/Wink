// The relay-facing door to hosted team rooms: a teammate's PC joins with
// an invite code, then reads and sends in that one room. Routes and frames are
// frozen in the door protocol; the guest key opens nothing else.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { EXTENDED_REACTIONS } from "../../shared/reactions.ts";
import { RateLimiter, rateKey } from "../phone-auth.ts";
import { parseSendId } from "../send-idempotency.ts";
import type { Message, Store } from "../store.ts";
import type { HostedGroup } from "./asks.ts";
import { committedRoomText, noticeText, recentRoomEntries, renameRoomPerson, roomEntriesAfter, roomEntry, RoomError, roomPeople, type RoomPerson } from "./db.ts";
import {
  anyDoorStreams,
  broadcastDoorReactions,
  compatibleDoorEntry,
  doorEntry,
  doorStreamCount,
  endDoorRoom,
  goLive,
  openDoorStream,
  sendDoorState,
  trackDoorSocket,
  writeFrame,
  type DoorEntry,
  type DoorFrame,
  type DoorState,
  type LineReactions,
} from "./door-streams.ts";
import { FILE_PATH, fileAction, fileIdsOf, fileRoute, sameFiles } from "./file-routes.ts";
import { deletedRoomFiles } from "./files.ts";
import { guestByKey, inviteRoomId, joinRoom, removeGuest, shortCodeTarget, type JoinResult } from "./invites.ts";
import { hostedSend, teamBotSend } from "./send.ts";
import { recordRoomJoin } from "./share.ts";
import { addTeamBot, removePersonTeamBots, removeTeamBot, teamBot, teamBots } from "./team-bots.ts";

const MINUTE = 60_000;
const BODY_BYTES = 16 * 1024;
/** A bot answer is up to 20k characters of any script. */
const BOT_BODY_BYTES = 96 * 1024;
const JOIN_BODY_BYTES = 1024;
const SNAPSHOT_ENTRIES = 200;
/** Under the 4 MiB reply cap older guests read, with room left for state. */
const SNAPSHOT_BYTES = 3 * 1024 * 1024;
const REPLAY_ENTRIES = 1_000;
const MAX_STREAMS = 2;
/** Under the 256 KB frame cap guests read. */
const REACTION_FRAME_BYTES = 192 * 1024;
const ROUTE = /^\/room\/v1\/rooms\/([\w-]{1,64})\/(snapshot|stream|send|leave|name|react|notice|bots|bot-send|asks\/[\w-]{1,64}\/cancel|bots\/([\w-]{1,64})\/remove)$/;
const METHODS: Record<string, string> = { snapshot: "GET", stream: "GET", send: "POST", leave: "POST", name: "POST", react: "POST", notice: "POST", bots: "POST", "bot-send": "POST", "remove-bot": "POST", cancel: "POST", upload: "POST", download: "GET", preview: "GET" };
const CODE = /^wkr1:([a-z0-9.-]{1,253}):([\w-]{1,64})\.(wki_[A-Za-z0-9_-]{43})$/;
const SHORT = /^[2-9A-HJ-NP-Z]{6}$/i;
const JOIN_STATUS = {
  busy: 429,
  "no-invite": 404,
  "wrong-secret": 401,
  "too-many-tries": 401,
  "room-full": 409,
  "name-taken": 409,
  "bad-code": 400,
  removed: 403,
} satisfies Record<Extract<JoinResult, { ok: false }>["error"], number>;

export interface RoomDoorDeps {
  store: Pick<Store, "groups" | "messagesFor" | "onChange" | "emit" | "bot" | "toggleReaction" | "patchGroup">;
  hostName(): string;
  onPeopleChanged?(group: HostedGroup): void;
}

type Guest = { roomId: string; person: RoomPerson };

let door: {
  deps: RoomDoorDeps;
  unauthenticated: RateLimiter;
  badKeys: RateLimiter;
  snapshots: RateLimiter;
  connects: RateLimiter;
  names: RateLimiter;
  reacts: RateLimiter;
  notices: RateLimiter;
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
    names: new RateLimiter(10, MINUTE, now),
    reacts: new RateLimiter(60, MINUTE, now),
    notices: new RateLimiter(10, MINUTE, now),
    versions: new Map(),
    watched: new Map(),
    unsubscribe: deps.store.onChange((change) => {
      if (change.type === "message.patch") {
        if (!change.message.roomEntryId || !anyDoorStreams()) return;
        const group = deps.store.groups.find((candidate) => candidate.hosted && candidate.threadId === change.threadId) as HostedGroup | undefined;
        if (group) broadcastDoorReactions(group.hosted.roomId, [lineReactions(change.message)]);
        return;
      }
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

/** The hosted group the door serves for a room; anything else reads as absent. */
function doorGroup(roomId: string): HostedGroup | null {
  return (door?.deps.store.groups.find((candidate) => candidate.hosted?.roomId === roomId) as HostedGroup | undefined) ?? null;
}

/** The host's and the bots' names, which no guest may take. */
const takenNames = (group: HostedGroup) => [
  door!.deps.hostName(), ...group.memberIds.flatMap((id) => door!.deps.store.bot(id)?.name ?? []), ...teamBots(group.hosted.roomId).map((bot) => bot.name),
];

function sharedState(group: HostedGroup) {
  const people = roomPeople(group.hosted.roomId).map((person) => ({ id: person.id, name: person.name }));
  const bots = group.memberIds.flatMap((id) => {
    const bot = door!.deps.store.bot(id);
    return bot && !bot.hidden ? [{ id: bot.id, name: bot.name, color: bot.color }] : [];
  });
  const teamBotList = teamBots(group.hosted.roomId).map(({ id, name, color, owner }) => ({ id, name, color, owner }));
  return {
    roomName: group.name, instructions: group.bulletin ?? "", host: door!.deps.hostName(), people, bots, teamBots: teamBotList,
    ...(group.picture ? { picture: group.picture } : {}),
    ...(group.notice ? { notice: group.notice } : {}),
  };
}

/** Full state for one viewer. The version moves only when what everyone sees changed. */
function doorState(group: HostedGroup, person: RoomPerson): DoorState {
  const roomId = group.hosted.roomId;
  const shared = sharedState(group);
  const text = JSON.stringify(shared);
  const last = door!.versions.get(roomId);
  const version = last?.shared === text ? last.version : Math.max((last?.version ?? 0) + 1, Date.now());
  door!.versions.set(roomId, { version, shared: text });
  return { version, ...shared, me: { id: person.id, name: person.name }, myAsks: [] };
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

/** The store keeps the host's own marks as "user" and a bot's as its id. */
const wireBy = (by: string) => (by === "user" ? "host" : by.startsWith("person:") ? by : `bot:${by}`);

const lineReactions = (message: Message): LineReactions => ({
  id: message.roomEntryId!,
  marks: (message.reactions ?? []).map((mark) => ({ emoji: mark.emoji, by: wireBy(mark.by) })),
});

/** Every reaction in the room, a reset frame first. */
function reactionFrames(group: HostedGroup): DoorFrame[] {
  const frames: Array<{ kind: "reactions"; reset?: true; lines: LineReactions[] }> = [{ kind: "reactions", reset: true, lines: [] }];
  let bytes = 0;
  for (const message of door!.deps.store.messagesFor(group.threadId)) {
    if (!message.roomEntryId || !message.reactions?.length) continue;
    const line = lineReactions(message);
    const size = Buffer.byteLength(JSON.stringify(line)) + 1;
    if (bytes + size > REACTION_FRAME_BYTES && frames.at(-1)!.lines.length) {
      frames.push({ kind: "reactions", lines: [] });
      bytes = 0;
    }
    frames.at(-1)!.lines.push(line);
    bytes += size;
  }
  return frames;
}

export function hostNameChanged(): void {
  for (const group of door?.deps.store.groups ?? []) if (group.hosted) pushRoomState(group.hosted.roomId);
}

async function rename(req: IncomingMessage, res: ServerResponse, roomId: string, person: RoomPerson): Promise<void> {
  if (!door!.names.take(person.id)) return send(res, 429, { error: "rate-limited" });
  const body = await readJson(req, JOIN_BODY_BYTES);
  if (!body.ok) return bodyError(res, body.status);
  const group = doorGroup(roomId);
  const still = guestByKey(bearerOf(req) ?? "");
  if (!group || still?.roomId !== roomId || still.person.id !== person.id) return send(res, 401, { error: "unauthorized" });
  const value = record(body.value)?.name;
  if (typeof value !== "string") return send(res, 400, { error: "bad request" });
  const name = renameRoomPerson(roomId, person.id, value, takenNames(group));
  pushRoomState(roomId);
  door!.deps.onPeopleChanged?.(group);
  send(res, 200, { name });
}

/** A react or notice body, once the room and person are checked again after the upload. */
async function guestFields(req: IncomingMessage, res: ServerResponse, roomId: string, person: RoomPerson): Promise<{ group: HostedGroup; fields: Record<string, unknown> } | null> {
  const body = await readJson(req, JOIN_BODY_BYTES);
  const group = doorGroup(roomId);
  const still = guestByKey(bearerOf(req) ?? "");
  if (!body.ok) bodyError(res, body.status);
  else if (!group) notFound(res);
  else if (still?.roomId !== roomId || still.person.id !== person.id) send(res, 403, { error: "removed" });
  else return { group, fields: record(body.value) ?? {} };
  return null;
}

async function react(req: IncomingMessage, res: ServerResponse, roomId: string, person: RoomPerson): Promise<void> {
  if (!door!.reacts.take(person.id)) return send(res, 429, { error: "rate-limited" });
  const call = await guestFields(req, res, roomId, person);
  if (!call) return;
  const { entryId, emoji } = call.fields;
  if (typeof entryId !== "string" || typeof emoji !== "string" || !(EXTENDED_REACTIONS as readonly string[]).includes(emoji)) return send(res, 400, { error: "bad request" });
  const message = door!.deps.store.messagesFor(call.group.threadId).find((candidate) => candidate.roomEntryId === entryId);
  if (!message) return send(res, 404, { error: "no such message in this room" });
  const patched = door!.deps.store.toggleReaction(call.group.threadId, message.id, emoji, `person:${person.id}`) ?? message;
  send(res, 200, { marks: lineReactions(patched).marks });
}

/** Anyone pins and the newest wins; here only the pinner unpins, the host unpins any from its own UI. */
async function pinNotice(req: IncomingMessage, res: ServerResponse, roomId: string, person: RoomPerson): Promise<void> {
  if (!door!.notices.take(person.id)) return send(res, 429, { error: "rate-limited" });
  const call = await guestFields(req, res, roomId, person);
  if (!call) return;
  const { entryId } = call.fields;
  const by = `person:${person.id}`;
  if (entryId === null) {
    if (call.group.notice && call.group.notice.by !== by) return send(res, 403, { error: "forbidden" });
    door!.deps.store.patchGroup(call.group.id, { notice: undefined });
    return send(res, 200, { notice: null });
  }
  if (typeof entryId !== "string") return send(res, 400, { error: "bad request" });
  const entry = /^[\w-]{1,64}$/.test(entryId) ? roomEntry(roomId, entryId) : null;
  if (!entry) return send(res, 404, { error: "no such message in this room" });
  const notice = { entryId, by, at: Date.now(), text: noticeText(entry.text) };
  door!.deps.store.patchGroup(call.group.id, { notice });
  send(res, 200, { notice });
}

/** A teammate adds one of their own bots; it answers only them, from their PC. */
async function addBot(req: IncomingMessage, res: ServerResponse, roomId: string, person: RoomPerson): Promise<void> {
  if (!door!.names.take(person.id)) return send(res, 429, { error: "rate-limited" });
  const call = await guestFields(req, res, roomId, person);
  if (!call) return;
  try {
    const people = roomPeople(roomId).map((candidate) => candidate.name);
    const bot = addTeamBot(roomId, person.id, call.fields.name, call.fields.color, [...takenNames(call.group), ...people]);
    pushRoomState(roomId);
    tellHost(roomId);
    send(res, 200, { bot });
  } catch (error) {
    if (!(error instanceof RoomError)) throw error;
    send(res, error.status, { error: error.message });
  }
}

async function removeBot(req: IncomingMessage, res: ServerResponse, roomId: string, person: RoomPerson, botId: string): Promise<void> {
  const call = await guestFields(req, res, roomId, person);
  if (!call) return;
  if (!removeTeamBot(roomId, botId, person.id)) return notFound(res);
  pushRoomState(roomId);
  tellHost(roomId);
  send(res, 200, { ok: true });
}

/** The host's Remove for any teammate's bot. */
export function removeRoomTeamBot(roomId: string, botId: string): boolean {
  const removed = removeTeamBot(roomId, botId);
  if (removed) {
    pushRoomState(roomId);
    tellHost(roomId);
  }
  return removed;
}

async function botSend(req: IncomingMessage, res: ServerResponse, roomId: string, person: RoomPerson): Promise<void> {
  const body = await readJson(req, BOT_BODY_BYTES);
  if (!body.ok) return bodyError(res, body.status);
  const group = doorGroup(roomId);
  if (!group) return notFound(res);
  const bearer = bearerOf(req);
  const still = bearer ? guestByKey(bearer) : null;
  if (still?.roomId !== roomId || still.person.id !== person.id) return send(res, 401, { error: "unauthorized" });
  const fields = record(body.value);
  const { botId, text, replyToId } = fields ?? {};
  if (typeof botId !== "string" || typeof text !== "string" || (replyToId !== undefined && typeof replyToId !== "string")) return send(res, 400, { error: "bad request" });
  const bot = /^[\w-]{1,64}$/.test(botId) ? teamBot(roomId, botId) : null;
  if (!bot || bot.owner !== person.id) return send(res, 403, { error: "forbidden" });
  if (replyToId !== undefined && !/^[\w-]{1,64}$/.test(replyToId)) return send(res, 404, { error: "no such message in this room" });
  let sendId: string | undefined;
  try {
    sendId = parseSendId(fields?.sendId === undefined ? undefined : String(fields.sendId));
  } catch {
    return send(res, 400, { error: "bad sendId" });
  }
  try {
    const earlier = sendId ? door!.deps.store.messagesFor(group.threadId).find((message) => message.sendId === sendId && message.author?.id === bot.id) : undefined;
    const entry = earlier?.roomEntryId ? roomEntry(roomId, earlier.roomEntryId) : earlier ? null : teamBotSend(group, person, bot, text, replyToId, sendId);
    if (!entry) return send(res, 409, { error: "sendId was used for another message" });
    send(res, 200, { entry: doorEntry(entry) });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === undefined) throw error;
    send(res, status, { error: (error as Error).message });
  }
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
  const fields = record(body.value);
  const text = fields?.code;
  // An unknown short code becomes an empty one, so joinRoom still spends the join limit on it.
  const short = typeof text === "string" && SHORT.test(text) ? (shortCodeTarget(text) ?? { id: "", secret: "" }) : null;
  const parts = short || typeof text !== "string" ? null : CODE.exec(text);
  if (!short && (!parts || parts[1] !== relayHost)) return send(res, 400, { error: "bad-code" });
  const [codeId, secret] = short ? [short.id, short.secret] : [parts![2]!, parts![3]!];
  // An unknown invite still goes through joinRoom, so it spends the join limit.
  const roomId = inviteRoomId(codeId);
  if (fields?.roomId !== undefined && fields.roomId !== roomId) return send(res, 400, { error: "bad-code" });
  const group = roomId ? doorGroup(roomId) : null;
  if (roomId && !group) return send(res, 404, { error: "no-invite" });
  const result = joinRoom(codeId, secret, group ? takenNames(group) : [deps.hostName()], { name: fields?.name, device: fields?.device });
  if (!result.ok) return send(res, JOIN_STATUS[result.error], { error: result.error });
  recordRoomJoin(result.roomId, result.person);
  pushRoomState(result.roomId);
  tellHost(result.roomId);
  send(res, 200, { roomId: result.roomId, person: { id: result.person.id, name: result.person.name }, key: result.key, ...(short ? { code: `wkr1:${relayHost}:${codeId}.${secret}` } : {}) });
}

const bearerOf = (req: IncomingMessage) => /^Bearer (\S{1,256})$/.exec(req.headers.authorization ?? "")?.[1];

function guestFor(req: IncomingMessage, res: ServerResponse, peer: string | null): Guest | null {
  const { unauthenticated, badKeys } = door!;
  const bearer = bearerOf(req);
  const guest = bearer ? guestByKey(bearer, req.headers["x-wink-device"]) : null;
  if (guest) return guest;
  const limited = !unauthenticated.take("door") || (bearer !== undefined && !badKeys.take(rateKey(peer)));
  send(res, limited ? 429 : 401, { error: limited ? "rate-limited" : "unauthorized" });
  return null;
}

/** The newest entries that fit SNAPSHOT_BYTES, oldest first. */
function newestThatFit(entries: DoorEntry[]): DoorEntry[] {
  let bytes = 0;
  let from = entries.length;
  for (; from > 0; from--) {
    const size = Buffer.byteLength(JSON.stringify(entries[from - 1])) + 1;
    if (bytes + size > SNAPSHOT_BYTES) break;
    bytes += size;
  }
  return entries.slice(from);
}

function snapshot(res: ServerResponse, url: URL, group: HostedGroup, person: RoomPerson, largeFiles: boolean, media: boolean): void {
  if (!door!.snapshots.take(person.id)) return send(res, 429, { error: "rate-limited" });
  const entries = recentRoomEntries(group.hosted.roomId, SNAPSHOT_ENTRIES);
  const bots = url.searchParams.get("with") === "bots";
  send(res, 200, { head: entries.at(-1)?.seq ?? 0, entries: newestThatFit(entries.map((entry) => compatibleDoorEntry(doorEntry(entry, bots), largeFiles, media))), state: doorState(group, person) });
}

/** Register and buffer, state, replay after `after` (or reset), flush, live. */
function stream(res: ServerResponse, url: URL, group: HostedGroup, person: RoomPerson, largeFiles: boolean, media: boolean): void {
  const roomId = group.hosted.roomId;
  const raw = url.searchParams.get("after") ?? "";
  if (!/^\d{1,15}$/.test(raw)) return send(res, 400, { error: "bad after" });
  if (!door!.connects.take(person.id)) return send(res, 429, { error: "rate-limited" });
  if (doorStreamCount(roomId, person.id) >= MAX_STREAMS) return send(res, 429, { error: "too many streams" });
  const after = Number(raw);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  door!.watched.set(group.id, roomId);
  const open = openDoorStream(roomId, person.id, res, url.searchParams.get("with") === "bots", largeFiles, media);
  writeFrame(open, { kind: "state", state: doorState(group, person) });
  for (const frame of reactionFrames(group)) writeFrame(open, frame);
  // A teammate who was away missed the reset a delete sends.
  const seen = url.searchParams.get("deleted") ?? "";
  const deleted = deletedRoomFiles(roomId, /^\d{1,15}$/.test(seen) ? Number(seen) : 0);
  if (deleted.ids.length) writeFrame(open, { kind: "deleted", ...deleted });
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
      if (!entry || entry.text !== committedRoomText("person", text) || entry.replyToId !== replyToId || !sameFiles((entry.files ?? []).map((file) => file.id), fileIds)) {
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

/** The host's own views read the room's people from the group frame. */
function tellHost(roomId: string): void {
  const group = doorGroup(roomId);
  if (group) door!.deps.store.emit({ type: "group", groupId: group.id });
}

/** Remove and Leave: the person and keys go, `ended` goes out, their sockets are cut. */
export function removeRoomPerson(roomId: string, personId: string, keep?: Duplex): boolean {
  const removed = removeGuest(roomId, personId, keep);
  if (removed) {
    removePersonTeamBots(roomId, personId);
    pushRoomState(roomId);
    tellHost(roomId);
  }
  return removed;
}

/** Every relay request under /room. Unknown paths and other rooms are 404 before any room lookup. */
export async function handleRoomDoor(req: IncomingMessage, res: ServerResponse, relay: { host: string; peer: string | null }): Promise<void> {
  if (!door) return notFound(res);
  const url = new URL(req.url ?? "/", "https://relay.invalid");
  const method = req.method ?? "GET";
  if (url.pathname === "/room/v1/join") return method === "POST" ? join(req, res, relay.host) : notFound(res);
  const file = url.pathname.startsWith("/room/v1/") ? FILE_PATH.exec(url.pathname.slice("/room/v1".length)) : null;
  const route = file ?? ROUTE.exec(url.pathname);
  const action = file ? fileAction(file) : route?.[2]?.startsWith("asks/") ? "cancel" : route?.[3] ? "remove-bot" : route?.[2];
  if (!route || !action || (method !== (METHODS[action] ?? "POST") && !(file && method === "DELETE"))) return notFound(res);
  const guest = guestFor(req, res, relay.peer);
  if (!guest) return;
  if (guest.roomId !== route[1]) return notFound(res);
  if (file && method === "DELETE") return send(res, 403, { error: "forbidden" });
  const group = doorGroup(guest.roomId);
  if (!group) return notFound(res);
  trackDoorSocket(guest.roomId, guest.person.id, req.socket);
  // Not a new x-orbit-room-files value: older hosts give large files only when that header is exactly "1".
  const media = req.headers["x-orbit-room-media"] === "1";
  if (file) return fileRoute(file, req, res, url, guest.roomId, guest.person.id, () => guestByKey(bearerOf(req) ?? "")?.person.id === guest.person.id && doorGroup(guest.roomId) !== null, media);
  const largeFiles = req.headers["x-orbit-room-files"] === "1";
  if (action === "snapshot") return snapshot(res, url, group, guest.person, largeFiles, media);
  if (action === "stream") return stream(res, url, group, guest.person, largeFiles, media);
  if (action === "send") return sendLine(req, res, guest.roomId, guest.person);
  if (action === "name") return rename(req, res, guest.roomId, guest.person);
  if (action === "react") return react(req, res, guest.roomId, guest.person);
  if (action === "notice") return pinNotice(req, res, guest.roomId, guest.person);
  if (action === "bots") return addBot(req, res, guest.roomId, guest.person);
  if (action === "remove-bot") return removeBot(req, res, guest.roomId, guest.person, route![3]!);
  if (action === "bot-send") return botSend(req, res, guest.roomId, guest.person);
  if (action === "cancel") return send(res, 404, { error: "no such ask" });
  removeRoomPerson(guest.roomId, guest.person.id, req.socket);
  send(res, 200, { ok: true }, { connection: "close" });
}
