// The Media tab's whole timeline for each chat or room: fetched when the tab opens,
// kept for the session, and asked again with its version so an unchanged chat costs a few bytes.
import type { RoomFiles } from "@/components/RoomMedia";
import { request } from "./api-request";
import type { MediaRef } from "./chat-media";
import { localeTag, type LocaleId } from "./i18n";
import { mediaFile, roomMedia, type MediaFile } from "./show-media";
import { hostRoomBase, type RoomFile } from "./team-rooms";

export interface MediaWire {
  v: string;
  head?: string;
  next?: number;
  ids: string[];
  /** Seconds. */
  at: number[];
  /** One MediaRef kind letter per file. */
  kind: string;
  name: string[];
  ref: string[];
  size: Array<number | null>;
}

export type MediaKind = "photos" | "files";

export interface MediaMonth {
  key: string;
  label: string;
  images: MediaFile[];
  files: MediaFile[];
}

interface Held {
  v?: string;
  head?: string;
  next?: number;
  files: MediaFile[];
  /** A room's own `/files` answer, for its notice and Delete. */
  list?: RoomFiles;
}

// held per chat or room for the session; the least recently loaded go first
const HELD = 16;
const RETRY_MS = 1_000;
const held = new Map<string, Held>();
const loads = new Map<string, Promise<Held>>();
const older = new WeakMap<Held, Promise<Held>>();
const tails = new WeakMap<MediaFile[], { known: Set<string>; fresh: string; files: MediaFile[] }>();
const kinds = new Map<string, MediaKind>();

const heldKey = (threadId: string, roomId?: string) => roomId ? `room:${roomId}` : threadId;

export function decodeMedia(threadId: string, wire: MediaWire, page = 0): MediaFile[] {
  const versioned = `/api/threads/${threadId}/media?v=${encodeURIComponent(wire.v)}${page ? `&page=${page}` : ""}`;
  // SAFETY: the server writes one MediaRef kind letter per entry.
  return wire.ref.map((ref, n) => {
    const kind = wire.kind[n] as MediaRef["kind"];
    const file = mediaFile(threadId, { kind, name: wire.name[n]!, ref, size: wire.size[n] ?? undefined }, wire.at[n]! * 1000);
    if (kind === "l" && !file.image && !file.video && file.size === undefined) {
      file.readSize = () => request(`${versioned}&size=${n}`).then((result: { size: number | null }) => result.size, () => null);
    }
    return file;
  });
}

/** What this session last loaded, drawn at once while it is asked again. */
export const heldMedia = (threadId: string, roomId?: string) => held.get(heldKey(threadId, roomId)) ?? null;

/** The Photos or Files pick each chat last made this session. */
export const pickedKind = (threadId: string, roomId?: string) => kinds.get(heldKey(threadId, roomId));
export const pickKind = (threadId: string, roomId: string | undefined, kind: MediaKind) => void kinds.set(heldKey(threadId, roomId), kind);

/** One request per chat or room at a time, asked once more after a failure. */
export function loadMedia(threadId: string, roomId?: string): Promise<Held> {
  const key = heldKey(threadId, roomId);
  let load = loads.get(key);
  if (!load) {
    const was = held.get(key);
    const ask = (): Promise<Held> => roomId
      ? request(`${hostRoomBase(roomId)}/files`).then((list: RoomFiles & { files: Array<RoomFile & { at: number; sender?: string }> }) => ({ files: roomMedia(threadId, roomId, list.files), list }))
      : request(`/api/threads/${threadId}/media${was?.v ? `?v=${encodeURIComponent(was.v)}` : ""}`)
        .then((wire: MediaWire | { v: string }) => {
          if ("ids" in wire) return { v: wire.v, head: wire.head, next: wire.next, files: decodeMedia(threadId, wire) };
          const current = held.get(key);
          return current?.v === wire.v ? current : was!;
        });
    const next = ask().catch(() => new Promise((wait) => setTimeout(wait, RETRY_MS)).then(ask));
    load = next.then((got) => {
      held.delete(key);
      held.set(key, got);
      if (held.size > HELD) held.delete(held.keys().next().value!);
      return got;
    }).finally(() => loads.delete(key));
    loads.set(key, load);
  }
  return load;
}

export function loadOlderMedia(threadId: string, was: Held): Promise<Held> {
  let load = older.get(was);
  if (!load) {
    const page = was.next!;
    load = request(`/api/threads/${threadId}/media?v=${encodeURIComponent(was.v!)}&page=${page}`).then((wire: MediaWire | null) => {
      const files = wire?.ids.length ? [...was.files, ...decodeMedia(threadId, wire, page)] : was.files;
      const got = { ...was, next: wire?.next, files };
      if (held.get(threadId) === was) held.set(threadId, got);
      return got;
    }).finally(() => older.delete(was));
    older.set(was, load);
  }
  return load;
}

export function forgetMedia(): void {
  held.clear();
  loads.clear();
  kinds.clear();
}

/** The index with what the open chat gained since it loaded on top; the same array while that stays the same. */
export function withLive(index: MediaFile[], live: readonly MediaFile[]): MediaFile[] {
  const tail = tails.get(index) ?? { known: new Set(index.map((file) => file.key)), fresh: "", files: index };
  tails.set(index, tail);
  const fresh = live.filter((file) => !tail.known.has(file.key));
  const keys = fresh.map((file) => file.key).join("\n");
  if (keys !== tail.fresh) {
    tail.fresh = keys;
    tail.files = fresh.length ? [...fresh, ...index] : index;
  }
  return tail.files;
}

/** Newest month first, each with its pictures and videos, then its other files. */
export function mediaMonths(files: readonly MediaFile[], locale: LocaleId): MediaMonth[] {
  const format = new Intl.DateTimeFormat(localeTag(locale), { year: "numeric", month: "long" });
  const months: MediaMonth[] = [];
  const keys = new Set<string>();
  let month: MediaMonth | undefined;
  let stamp = NaN;
  for (const file of files) {
    const date = new Date(file.at);
    const next = date.getFullYear() * 12 + date.getMonth();
    if (!month || next !== stamp) {
      stamp = next;
      let key = String(next);
      while (keys.has(key)) key += "+";
      keys.add(key);
      months.push(month = { key, label: format.format(date), images: [], files: [] });
    }
    (file.image || file.video ? month.images : month.files).push(file);
  }
  return months;
}
