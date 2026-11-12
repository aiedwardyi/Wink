// People-only team rooms: one this PC hosts (a hosted group with no bots), or one it joined elsewhere.
import type { Group, Message, RoomJoin } from "@/state/store-types";

import { fetchResponse, request, responseBody } from "./api-request";
import type { MessageKey } from "./i18n";

export type RoomFile = NonNullable<Message["roomFiles"]>[number];
export type RoomAuthor = NonNullable<Message["author"]>;

export interface RoomLine {
  id: string;
  entryId?: string;
  at: number;
  author: RoomAuthor;
  text: string;
  files: RoomFile[];
  replyToId?: string;
  message?: Message;
  color?: string;
}

export type TeamRoom = Group & { hosted: { roomId: string } };

/** A bot room always keeps a bot, so a hosted room with none is people-only. */
export const isTeamRoom = (group: Group | undefined): group is TeamRoom => Boolean(group?.hosted && group.memberIds.length === 0);

export const roomPeople = (group: Group) => (group.room && "people" in group.room ? group.room.people : []);

const NO_JOINS: RoomJoin[] = [];

// One empty list, so a memoized transcript keeps its props.
export const roomJoins = (group: Group) => (group.room && "joins" in group.room ? group.room.joins : NO_JOINS);

export const hostLines = (messages: readonly Message[]): RoomLine[] =>
  messages.flatMap((message) => (message.author && message.roomEntryId
    ? [{ id: message.id, entryId: message.roomEntryId, at: message.at, author: message.author, text: message.text ?? "", files: message.roomFiles ?? [], replyToId: message.replyToId, message }]
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
  state: { roomName: string; host: string; people: JoinedPerson[]; picture?: string; bots?: JoinedBot[] } | null;
  unread?: number;
  lastEntry?: JoinedEntry;
}

export interface JoinedBot {
  id: string;
  name: string;
  color: string;
}

export interface JoinedEntry {
  seq: number;
  id: string;
  at: number;
  author: RoomAuthor;
  text: string;
  files?: RoomFile[];
  replyToId?: string;
}

export type JoinedPhase = "connecting" | "live" | "offline" | "removed" | "left";

export const joinedPhase = (view: JoinedView): JoinedPhase =>
  view.status !== "joined" ? view.status : view.link === "live" ? "live" : view.link === "offline" ? "offline" : "connecting";

export const joinedLines = (entries: readonly JoinedEntry[], bots: readonly JoinedBot[] = []): RoomLine[] =>
  entries.map((entry) => {
    const color = entry.author.kind === "bot" ? bots.find((bot) => bot.id === entry.author.id)?.color : undefined;
    return { id: entry.id, at: entry.at, author: entry.author, text: entry.text, files: entry.files ?? [], replyToId: entry.replyToId, ...(color ? { color } : {}) };
  });

export const roomMessage = (line: RoomLine): Message => line.message ?? ({
  id: line.id, at: line.at, role: "user", kind: "text", text: line.text,
  author: line.author, roomEntryId: line.id, roomFiles: line.files, replyToId: line.replyToId,
});

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

export const ROOM_IMAGE_MAX_BYTES = 100 * 1024 ** 2;
export const ROOM_DOCUMENT_MAX_BYTES = 1024 ** 3;
export const MAX_ROOM_FILES = 50;

export function createTeamRoom(name: string): Promise<{ group: Group }> {
  return request("/api/groups", { method: "POST", body: JSON.stringify({ name, hosted: true, peopleOnly: true, memberIds: [] }) });
}

type Refused = { status: number; error: string };

const refused = (status: number, body: any): Refused => ({ status, error: typeof body?.error === "string" ? body.error : "" });

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

/** Invite in a group: the first press shares it, later ones hand back the same code. */
export async function shareGroup(groupId: string): Promise<{ code: string; group: Group } | Refused> {
  try {
    const res = await fetchResponse(`/api/groups/${groupId}/share`, { method: "POST" });
    const body = await responseBody(res);
    return res.ok && typeof body?.code === "string" && body.group ? { code: body.code, group: body.group } : refused(res.status, body);
  } catch {
    return { status: 0, error: "" };
  }
}

export const shareErrorKey = ({ status, error }: Refused): MessageKey =>
  error === "phone access is off" ? "teamRoom.phoneOff" : status === 409 ? "teamRoom.shareBusy" : "errors.request";

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

export async function rejoinRoom(roomId: string, code?: string): Promise<{ room: JoinedView } | Refused> {
  try {
    const res = await fetchResponse(`${joinedRoomBase(roomId)}/rejoin`, { method: "POST", ...(code === undefined ? {} : { body: JSON.stringify({ code: code.trim() }) }) });
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
  const big = files.find((file) => file.size > (PICTURE_TYPES.has(file.type) ? ROOM_IMAGE_MAX_BYTES : ROOM_DOCUMENT_MAX_BYTES));
  return big ? { key: "teamRoom.tooBig", vars: { name: big.name } } : null;
}

function uploadProblem(status: number, name: string, error?: string): RoomProblem {
  if (status === 413) return { key: "teamRoom.tooBig", vars: { name } };
  if (status === 415) return { key: "teamRoom.fileType" };
  if (status === 507) return { key: "teamRoom.outOfSpace" };
  if (status === 503 && error === "room files folder is unavailable") return { key: "teamRoom.folderError" };
  return { key: "teamRoom.sendFailed" };
}

/** Uploads each file, then sends one message. A retry reuses `sendId`, so it never posts twice. */
export async function sendToRoom(base: string, text: string, files: readonly File[], sendId: string, replyToId?: string): Promise<RoomProblem | null> {
  const ahead = filesProblem(files);
  if (ahead) return ahead;
  try {
    const fileIds: string[] = [];
    for (const file of files) {
      const query = new URLSearchParams({ name: file.name, uploadId: crypto.randomUUID() });
      const res = await fetchResponse(`${base}/files?${query}`, { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } });
      const body = await responseBody(res);
      if (!res.ok || typeof body?.file?.id !== "string") return uploadProblem(res.status, file.name, body?.error);
      fileIds.push(body.file.id);
    }
    const res = await fetchResponse(`${base}/send`, { method: "POST", body: JSON.stringify({ text, sendId, ...(replyToId !== undefined ? { replyToId } : {}), ...(fileIds.length ? { fileIds } : {}) }) });
    return res.ok ? null : { key: "teamRoom.sendFailed" };
  } catch {
    return { key: "teamRoom.sendFailed" };
  }
}

export function roomPictureUrl(base: string, picture?: string | null): string | undefined {
  if (!picture) return undefined;
  return base.startsWith("/api/joined/") ? `${base}/picture?id=${encodeURIComponent(picture)}` : `${base}/files/${encodeURIComponent(picture)}/preview`;
}
