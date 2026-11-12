// The door's open streams and sockets per room and person: live frames, the
// 15 s heartbeat, and the cut that Remove, Leave and revoke make.
import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { RoomNotice } from "../store.ts";
import type { RoomAuthor, RoomEntry, RoomFile } from "./db.ts";

/** The relay cuts a socket idle for 10 minutes. */
export const HEARTBEAT_MS = 15_000;
export const MAX_BACKLOG_BYTES = 1024 * 1024;
/** A reader that stops reading can hold the `ended` flush open forever. */
export const ENDED_FLUSH_MS = 5_000;

export interface DoorEntry {
  seq: number;
  id: string;
  at: number;
  author: RoomAuthor;
  text: string;
  replyToId?: string;
  files?: RoomFile[];
}

export interface DoorState {
  version: number;
  picture?: string;
  notice?: RoomNotice;
  roomName: string;
  instructions: string;
  host: string;
  me: { id: string; name: string };
  people: Array<{ id: string; name: string }>;
  bots: Array<{ id: string; name: string; color: string }>;
  myAsks: never[];
}

/** `by` is "host", "person:<id>" or "bot:<id>". */
export interface LineReactions {
  id: string;
  marks: Array<{ emoji: string; by: string }>;
}

/** Older guests drop an unknown kind, so this never breaks their stream. A `reset` frame starts a full set. */
export type DoorFrame =
  | { kind: "entry"; entry: DoorEntry }
  | { kind: "state"; state: DoorState }
  | { kind: "reactions"; reset?: true; lines: LineReactions[] }
  | { kind: "reset" }
  | { kind: "ended" };

export interface DoorStream {
  roomId: string;
  personId: string;
  res: ServerResponse;
  /** Asked with `with=bots`; anyone else reads a bot as a person by its name. */
  bots: boolean;
  largeFiles?: boolean;
  /** Live frames held until replay is done; null once live. */
  buffer: DoorFrame[] | null;
}

const streams = new Set<DoorStream>();
const sockets = new Map<string, Set<Duplex>>();
const personKey = (roomId: string, personId: string) => `${roomId}\n${personId}`;

/** Builds before bots in rooms parse only host and person authors. */
const wireAuthor = (author: RoomAuthor, bots: boolean): RoomAuthor =>
  bots || author.kind !== "bot" ? author : { kind: "person", id: `bot-${author.id}`, name: author.name };

export const doorEntry = (entry: RoomEntry, bots = true): DoorEntry => ({
  seq: entry.seq,
  id: entry.id,
  at: entry.at,
  author: wireAuthor(entry.author, bots),
  text: entry.text,
  ...(entry.replyToId ? { replyToId: entry.replyToId } : {}),
  ...(entry.files ? { files: entry.files } : {}),
});

export function compatibleDoorEntry(entry: DoorEntry, largeFiles: boolean): DoorEntry {
  if (largeFiles || !entry.files?.length) return entry;
  const files = entry.files.filter((file) => !file.deleted && file.bytes <= 25 * 1024 ** 2).slice(0, 10);
  const omitted = entry.files.filter((file) => !file.deleted && !files.includes(file));
  return { ...entry, files, text: [entry.text, ...omitted.map((file) => file.name)].filter(Boolean).join("\n").slice(0, 20_000) };
}

/** Remembers which sockets a person used, so Remove can cut keep-alive ones too. */
export function trackDoorSocket(roomId: string, personId: string, socket: Duplex): void {
  const key = personKey(roomId, personId);
  let open = sockets.get(key);
  if (!open) sockets.set(key, (open = new Set()));
  if (open.has(socket)) return;
  const set = open;
  set.add(socket);
  socket.once("close", () => {
    set.delete(socket);
    if (!set.size && sockets.get(key) === set) sockets.delete(key);
  });
}

function write(stream: DoorStream, chunk: string): void {
  if (stream.res.writableEnded || stream.res.destroyed) return;
  stream.res.write(chunk);
  // A reader this far behind gets cut; it reconnects with `after` and catches up.
  if (stream.res.writableLength > MAX_BACKLOG_BYTES) stream.res.destroy();
}

export function writeFrame(stream: DoorStream, frame: DoorFrame): void {
  const sent = frame.kind === "entry" ? { kind: "entry", entry: compatibleDoorEntry({ ...frame.entry, author: wireAuthor(frame.entry.author, stream.bots) }, stream.largeFiles !== false) } : frame;
  write(stream, `data: ${JSON.stringify(sent)}\n\n`);
}

/** Registered and buffering: live frames wait until goLive. */
export function openDoorStream(roomId: string, personId: string, res: ServerResponse, bots = false, largeFiles = true): DoorStream {
  const stream: DoorStream = { roomId, personId, res, bots, buffer: [], largeFiles };
  streams.add(stream);
  const heartbeat = setInterval(() => write(stream, ": ping\n\n"), HEARTBEAT_MS);
  res.once("close", () => {
    clearInterval(heartbeat);
    streams.delete(stream);
  });
  return stream;
}

/** Flushes what arrived during replay, minus entries replay already sent. */
export function goLive(stream: DoorStream, sentThrough: number): void {
  const held = stream.buffer ?? [];
  stream.buffer = null;
  for (const frame of held) {
    if (frame.kind !== "entry" || frame.entry.seq > sentThrough) writeFrame(stream, frame);
  }
}

function deliver(stream: DoorStream, frame: DoorFrame): void {
  if (stream.buffer) stream.buffer.push(frame);
  else writeFrame(stream, frame);
}

const roomStreams = (roomId: string) => [...streams].filter((stream) => stream.roomId === roomId);

export function resetDoorRoom(roomId: string): void {
  for (const stream of roomStreams(roomId)) deliver(stream, { kind: "reset" });
}

export function broadcastDoorEntry(roomId: string, entry: RoomEntry): void {
  if (!streams.size) return;
  const frame: DoorFrame = { kind: "entry", entry: doorEntry(entry) };
  for (const stream of roomStreams(roomId)) deliver(stream, frame);
}

export function broadcastDoorReactions(roomId: string, lines: LineReactions[]): void {
  for (const stream of roomStreams(roomId)) deliver(stream, { kind: "reactions", lines });
}

export function sendDoorState(roomId: string, stateFor: (personId: string) => DoorState | null): void {
  for (const stream of roomStreams(roomId)) {
    const state = stateFor(stream.personId);
    if (state) deliver(stream, { kind: "state", state });
  }
}

export const doorStreamCount = (roomId: string, personId: string) =>
  roomStreams(roomId).filter((stream) => stream.personId === personId).length;

export const anyDoorStreams = () => streams.size > 0;

/** Sends `ended`, closes the person's streams and cuts every other socket of theirs but `keep`. */
export function endDoorPerson(roomId: string, personId: string, keep?: Duplex): void {
  const ending = new Set<Duplex>();
  for (const stream of roomStreams(roomId)) {
    if (stream.personId !== personId) continue;
    streams.delete(stream);
    const socket = stream.res.socket;
    if (socket) ending.add(socket);
    stream.res.end(`data: ${JSON.stringify({ kind: "ended" } satisfies DoorFrame)}\n\n`, () => socket?.destroy());
    setTimeout(() => socket?.destroy(), ENDED_FLUSH_MS).unref();
  }
  const key = personKey(roomId, personId);
  for (const socket of sockets.get(key) ?? []) {
    if (socket !== keep && !ending.has(socket)) socket.destroy();
  }
  sockets.delete(key);
}

export function endDoorRoom(roomId: string): void {
  const people = new Set([...roomStreams(roomId).map((stream) => stream.personId)]);
  for (const key of sockets.keys()) if (key.startsWith(`${roomId}\n`)) people.add(key.slice(roomId.length + 1));
  for (const personId of people) endDoorPerson(roomId, personId);
}
