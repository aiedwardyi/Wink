// The door's open streams and sockets per room and person: live frames, the
// 15 s heartbeat, and the cut that Remove, Leave and revoke make.
import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { RoomAuthor, RoomEntry } from "./db.ts";

/** The relay cuts a socket idle for 10 minutes. */
export const HEARTBEAT_MS = 15_000;
export const MAX_BACKLOG_BYTES = 1024 * 1024;

export interface DoorEntry {
  seq: number;
  id: string;
  at: number;
  author: RoomAuthor;
  text: string;
  replyToId?: string;
}

export interface DoorState {
  version: number;
  roomName: string;
  instructions: string;
  host: string;
  me: { id: string; name: string };
  people: Array<{ id: string; name: string }>;
  bots: never[];
  myAsks: never[];
}

export type DoorFrame = { kind: "entry"; entry: DoorEntry } | { kind: "state"; state: DoorState } | { kind: "reset" } | { kind: "ended" };

export interface DoorStream {
  roomId: string;
  personId: string;
  res: ServerResponse;
  /** Live frames held until replay is done; null once live. */
  buffer: DoorFrame[] | null;
}

const streams = new Set<DoorStream>();
const sockets = new Map<string, Set<Duplex>>();
const personKey = (roomId: string, personId: string) => `${roomId}\n${personId}`;

export const doorEntry = (entry: RoomEntry): DoorEntry => ({
  seq: entry.seq,
  id: entry.id,
  at: entry.at,
  author: entry.author,
  text: entry.text,
  ...(entry.replyToId ? { replyToId: entry.replyToId } : {}),
});

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
  write(stream, `data: ${JSON.stringify(frame)}\n\n`);
}

/** Registered and buffering: live frames wait until goLive. */
export function openDoorStream(roomId: string, personId: string, res: ServerResponse): DoorStream {
  const stream: DoorStream = { roomId, personId, res, buffer: [] };
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

export function broadcastDoorEntry(roomId: string, entry: RoomEntry): void {
  if (!streams.size) return;
  const frame: DoorFrame = { kind: "entry", entry: doorEntry(entry) };
  for (const stream of roomStreams(roomId)) deliver(stream, frame);
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
