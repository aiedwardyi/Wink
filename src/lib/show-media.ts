import type { Message } from "@/state/store";
import { linkedFileSrc, mediaKey, messageRefs, showKind, type MediaRef } from "./chat-media";
import type { FileTap } from "./open-file";
import { hostRoomBase, isRoomPicture, roomFileUrl, type RoomFile } from "./team-rooms";

export interface MediaSource {
  threadId: string;
  messages: readonly Message[];
  hasMore?: boolean;
  /** a hosted room lists its files from the room */
  roomId?: string;
}

export interface MediaFile {
  key: string;
  name: string;
  /** epoch ms of the message or upload that brought it */
  at: number;
  src?: string;
  image?: boolean;
  /** sits with the pictures, opened like a file */
  video?: boolean;
  /** what a tap hands the open rule */
  tap?: FileTap;
  /** a local path the desktop opens */
  path?: string;
  size?: number;
  /** who sent it, in a room */
  sender?: string;
}

const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;

export function mediaFile(threadId: string, ref: MediaRef, at: number): MediaFile {
  const key = mediaKey(threadId, ref);
  const { kind, name, size } = ref;
  if (kind === "a" || kind === "u") return { key, name, at, src: key, image: true };
  const video = VIDEO.test(ref.ref) || undefined;
  // An attached file streams from its PC like a linked one, so a phone opens it too.
  const src = kind === "f" ? linkedFileSrc(threadId, ref.ref) : key;
  const tap = { threadId, path: ref.ref };
  return showKind(ref.ref) === "image" ? { key, name, at, src, path: ref.ref, image: true, tap } : { key, name, at, src, path: ref.ref, size, video, tap };
}

const seen = new WeakMap<Message, MediaFile[]>();

function messageMedia(threadId: string, message: Message): MediaFile[] {
  let files = seen.get(message);
  if (!files) seen.set(message, files = messageRefs(message).map((ref) => mediaFile(threadId, ref, message.at)));
  return files;
}

/** Every image and file in a chat's messages, newest first, each once. */
export function chatMedia(threadId: string, messages: readonly Message[]): MediaFile[] {
  const keys = new Set<string>();
  const files: MediaFile[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const file of messageMedia(threadId, messages[i]!)) {
      if (keys.has(file.key)) continue;
      keys.add(file.key);
      files.push(file);
    }
  }
  return files;
}

export function roomMedia(threadId: string, roomId: string, files: ReadonlyArray<RoomFile & { at: number; sender?: string }>): MediaFile[] {
  const base = hostRoomBase(roomId);
  return files.map((file) => {
    if (isRoomPicture(file)) return { key: file.id, name: file.name, at: file.at, src: roomFileUrl(base, file, true), image: true };
    const src = roomFileUrl(base, file, false);
    return { key: file.id, name: file.name, at: file.at, src, size: file.bytes, sender: file.sender, video: file.type.startsWith("video/") || undefined,
      tap: { threadId, path: file.name, src } };
  });
}
