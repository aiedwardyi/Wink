import type { Message } from "@/state/store";
import { mediaKey, messageRefs, showKind, type MediaRef } from "./chat-media";
import type { ShowItem } from "./show-pane";
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
  /** none for a file only its own PC holds, like an attached one */
  src?: string;
  image?: boolean;
  show?: ShowItem;
  /** a local path the desktop opens */
  path?: string;
}

export function mediaFile(threadId: string, ref: MediaRef, at: number): MediaFile {
  const key = mediaKey(threadId, ref);
  const { kind, name } = ref;
  if (kind === "a" || kind === "u") return { key, name, at, src: key, image: true };
  if (kind === "f") return { key, name, at, path: ref.ref };
  const show = showKind(ref.ref);
  return show === "image" ? { key, name, at, src: key, image: true } : { key, name, at, src: key, path: ref.ref, show: show ? { threadId, path: ref.ref, kind: show } : undefined };
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

export function roomMedia(threadId: string, roomId: string, files: ReadonlyArray<RoomFile & { at: number }>): MediaFile[] {
  const base = hostRoomBase(roomId);
  return files.map((file) => {
    if (isRoomPicture(file)) return { key: file.id, name: file.name, at: file.at, src: roomFileUrl(base, file, true), image: true };
    const src = roomFileUrl(base, file, false);
    // A room previews only pictures; a PDF still draws from its bytes.
    return { key: file.id, name: file.name, at: file.at, src, show: showKind(file.name) === "pdf" ? { threadId, path: file.name, kind: "pdf", src } : undefined };
  });
}
