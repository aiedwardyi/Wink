import type { Message } from "@/state/store";
import { splitAttachedImages } from "./composer-attachments";
import { mediaList } from "./media-viewer";
import { isShownMessage } from "./shown-message";
import { linkedFileSrc, localLinks, showKind, showName, type ShowItem } from "./show-pane";
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
  /** none for a file only its own PC holds, like an attached one */
  src?: string;
  image?: boolean;
  show?: ShowItem;
  /** a local path the desktop opens */
  path?: string;
}

const seen = new WeakMap<Message, MediaFile[]>();

export function messageMedia(threadId: string, message: Message): MediaFile[] {
  const cached = seen.get(message);
  if (cached) return cached;
  const files: MediaFile[] = mediaList([message]).map((image) => ({ key: image.src, name: image.name, src: image.src, image: true }));
  if (message.kind === "text" && message.text && isShownMessage(message)) {
    if (message.role === "user") for (const file of splitAttachedImages(message.text).files) files.push({ key: file.path, name: file.name, path: file.path });
    else for (const path of localLinks(message.text)) {
      const name = showName(path);
      // No extension reads as a folder, which the folder sheet lists instead.
      if (!/\.\w+$/.test(name)) continue;
      const kind = showKind(path);
      const src = linkedFileSrc(threadId, path);
      files.push(kind === "image" ? { key: src, name, src, image: true } : { key: src, name, src, path, show: kind ? { threadId, path, kind } : undefined });
    }
  }
  seen.set(message, files);
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

export function roomMedia(threadId: string, roomId: string, files: readonly RoomFile[]): MediaFile[] {
  const base = hostRoomBase(roomId);
  return files.map((file) => {
    if (isRoomPicture(file)) return { key: file.id, name: file.name, src: roomFileUrl(base, file, true), image: true };
    const src = roomFileUrl(base, file, false);
    // A room previews only pictures; a PDF still draws from its bytes.
    return { key: file.id, name: file.name, src, show: showKind(file.name) === "pdf" ? { threadId, path: file.name, kind: "pdf", src } : undefined };
  });
}
