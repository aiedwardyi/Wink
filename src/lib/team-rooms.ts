// People-only team rooms: one this PC hosts (a hosted group with no bots), or one it joined elsewhere.
import type { Group, Message } from "@/state/store-types";

import { fetchResponse, request, responseBody } from "./api-request";
import { DOCUMENT_MAX_BYTES, IMAGE_MAX_BYTES } from "./composer-attachments";
import type { MessageKey } from "./i18n";

export type RoomFile = NonNullable<Message["roomFiles"]>[number];
export type RoomAuthor = NonNullable<Message["author"]>;

export interface RoomLine {
  id: string;
  at: number;
  author: RoomAuthor;
  text: string;
  files: RoomFile[];
}

export type TeamRoom = Group & { hosted: { roomId: string } };

/** A bot room always keeps a bot, so a hosted room with none is people-only. */
export const isTeamRoom = (group: Group | undefined): group is TeamRoom => Boolean(group?.hosted && group.memberIds.length === 0);

export const roomPeople = (group: Group) => (group.room && "people" in group.room ? group.room.people : []);

export const hostLines = (messages: readonly Message[]): RoomLine[] =>
  messages.flatMap((message) => (message.author && message.roomEntryId
    ? [{ id: message.id, at: message.at, author: message.author, text: message.text ?? "", files: message.roomFiles ?? [] }]
    : []));

export type JoinedLink = "connecting" | "live" | "offline";

export interface JoinedPerson {
  id: string;
  name: string;
}

export interface JoinedView {
  roomId: string;
  status: "joined" | "removed" | "left";
  link: JoinedLink | null;
  me: JoinedPerson;
  state: { roomName: string; host: string; people: JoinedPerson[] } | null;
  unread?: number;
  lastEntry?: JoinedEntry;
}

export interface JoinedEntry {
  seq: number;
  id: string;
  at: number;
  author: { kind: "host" | "person"; id: string; name: string };
  text: string;
  files?: RoomFile[];
}

export type JoinedPhase = "connecting" | "live" | "offline" | "removed" | "left";

export const joinedPhase = (view: JoinedView): JoinedPhase =>
  view.status !== "joined" ? view.status : view.link === "live" ? "live" : view.link === "offline" ? "offline" : "connecting";

export const joinedLines = (entries: readonly JoinedEntry[]): RoomLine[] =>
  entries.map((entry) => ({ id: entry.id, at: entry.at, author: entry.author, text: entry.text, files: entry.files ?? [] }));

const JOINED = "joined:";

/** The sidebar selection for a joined room. It never matches a bot or group id. */
export const joinedSelection = (roomId: string) => `${JOINED}${roomId}`;

export const joinedRoomIdOf = (selectedId: string): string | null => (selectedId.startsWith(JOINED) ? selectedId.slice(JOINED.length) : null);

const CODE = /^wkr1:[a-z0-9.-]{1,253}:[\w-]{1,64}\.wki_[A-Za-z0-9_-]{43}$/;

export const looksLikeRoomCode = (text: string) => CODE.test(text.trim());

export function joinErrorKey(status: number, error: string): MessageKey {
  if (error === "room-full") return "teamRoom.full";
  if (status === 429) return "teamRoom.busy";
  if (status === 503) return "teamRoom.unreachable";
  return "teamRoom.badCode";
}

export const hostRoomBase = (roomId: string) => `/api/rooms/${roomId}`;
export const joinedRoomBase = (roomId: string) => `/api/joined/rooms/${roomId}`;

export const roomFileUrl = (base: string, file: RoomFile, preview: boolean) => `${base}/files/${file.id}${preview ? "/preview" : ""}`;

const PICTURE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const isRoomPicture = (file: Pick<RoomFile, "type">) => PICTURE_TYPES.has(file.type);

export const MAX_ROOM_FILES = 10;

export function createTeamRoom(name: string): Promise<{ group: Group }> {
  return request("/api/groups", { method: "POST", body: JSON.stringify({ name, hosted: true, peopleOnly: true, memberIds: [] }) });
}

type Refused = { status: number; error: string };

const refused = (status: number, body: any): Refused => ({ status, error: typeof body?.error === "string" ? body.error : "" });

/** The room's one code; the same every time it's asked for. */
export async function inviteToRoom(roomId: string): Promise<{ code: string } | Refused> {
  try {
    const res = await fetchResponse(`${hostRoomBase(roomId)}/invites`, { method: "POST" });
    const body = await responseBody(res);
    return res.ok && typeof body?.code === "string" ? { code: body.code } : refused(res.status, body);
  } catch {
    return { status: 0, error: "" };
  }
}

export const inviteErrorKey = (status: number): MessageKey => (status === 409 ? "teamRoom.phoneOff" : "errors.request");

export function removeFromRoom(roomId: string, personId: string): Promise<{ ok: true }> {
  return request(`${hostRoomBase(roomId)}/people/${personId}`, { method: "DELETE" });
}

export async function joinRoom(code: string): Promise<{ room: JoinedView } | Refused> {
  try {
    const res = await fetchResponse("/api/joined/join", { method: "POST", body: JSON.stringify({ code: code.trim() }) });
    const body = await responseBody(res);
    return res.ok && body?.room ? { room: body.room } : refused(res.status, body);
  } catch {
    return { status: 503, error: "" };
  }
}

export type RoomProblem = { key: MessageKey; vars?: Record<string, string> };

/** Size and count checks before any byte leaves this PC; the server checks again. */
export function filesProblem(files: readonly Pick<File, "name" | "size" | "type">[]): RoomProblem | null {
  if (files.length > MAX_ROOM_FILES) return { key: "teamRoom.tooMany" };
  const big = files.find((file) => file.size > (PICTURE_TYPES.has(file.type) ? IMAGE_MAX_BYTES : DOCUMENT_MAX_BYTES));
  return big ? { key: "teamRoom.tooBig", vars: { name: big.name } } : null;
}

function uploadProblem(status: number, name: string): RoomProblem {
  if (status === 413) return { key: "teamRoom.tooBig", vars: { name } };
  if (status === 415) return { key: "teamRoom.fileType" };
  return { key: "teamRoom.sendFailed" };
}

/** Uploads each file, then sends one message. A retry reuses `sendId`, so it never posts twice. */
export async function sendToRoom(base: string, text: string, files: readonly File[], sendId: string): Promise<RoomProblem | null> {
  const ahead = filesProblem(files);
  if (ahead) return ahead;
  try {
    const fileIds: string[] = [];
    for (const file of files) {
      const query = new URLSearchParams({ name: file.name, uploadId: crypto.randomUUID() });
      const res = await fetchResponse(`${base}/files?${query}`, { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } });
      const body = await responseBody(res);
      if (!res.ok || typeof body?.file?.id !== "string") return uploadProblem(res.status, file.name);
      fileIds.push(body.file.id);
    }
    const res = await fetchResponse(`${base}/send`, { method: "POST", body: JSON.stringify({ text, sendId, ...(fileIds.length ? { fileIds } : {}) }) });
    return res.ok ? null : { key: "teamRoom.sendFailed" };
  } catch {
    return { key: "teamRoom.sendFailed" };
  }
}
