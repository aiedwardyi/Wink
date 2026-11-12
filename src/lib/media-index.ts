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
  ids: string[];
  /** Seconds. */
  at: number[];
  /** One MediaRef kind letter per file. */
  kind: string;
  name: string[];
  ref: string[];
}

export interface MediaMonth {
  key: string;
  label: string;
  images: MediaFile[];
  files: MediaFile[];
}

interface Held {
  v?: string;
  files: MediaFile[];
  /** A room's own `/files` answer, for its notice and Delete. */
  list?: RoomFiles;
}

// held per chat or room for the session; the least recently loaded go first
const HELD = 16;
const RETRY_MS = 1_000;
const held = new Map<string, Held>();
const loads = new Map<string, Promise<Held>>();
const tails = new WeakMap<MediaFile[], { known: Set<string>; fresh: string; files: MediaFile[] }>();

const heldKey = (threadId: string, roomId?: string) => roomId ? `room:${roomId}` : threadId;

export function decodeMedia(threadId: string, wire: MediaWire): MediaFile[] {
  // SAFETY: the server writes one MediaRef kind letter per entry.
  return wire.ref.map((ref, n) => mediaFile(threadId, { kind: wire.kind[n] as MediaRef["kind"], name: wire.name[n]!, ref }, wire.at[n]! * 1000));
}

/** What this session last loaded, drawn at once while it is asked again. */
export const heldMedia = (threadId: string, roomId?: string) => held.get(heldKey(threadId, roomId)) ?? null;

/** One request per chat or room at a time, asked once more after a failure. */
export function loadMedia(threadId: string, roomId?: string): Promise<Held> {
  const key = heldKey(threadId, roomId);
  let load = loads.get(key);
  if (!load) {
    const was = held.get(key);
    const ask = (): Promise<Held> => roomId
      ? request(`${hostRoomBase(roomId)}/files`).then((list: RoomFiles & { files: Array<RoomFile & { at: number }> }) => ({ files: roomMedia(threadId, roomId, list.files), list }))
      : request(`/api/threads/${threadId}/media${was?.v ? `?v=${encodeURIComponent(was.v)}` : ""}`)
        .then((wire: MediaWire | { v: string }) => "ids" in wire ? { v: wire.v, files: decodeMedia(threadId, wire) } : was!);
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

export function forgetMedia(): void {
  held.clear();
  loads.clear();
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

/** Newest month first, each with its pictures, then its other files. */
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
    (file.image ? month.images : month.files).push(file);
  }
  return months;
}
