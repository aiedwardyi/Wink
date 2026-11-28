// The one picture a host's message follows rides on that turn as an <attached-image> tag; the saved row never holds it.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { localLinks } from "../src/lib/chat-media.ts";
import { ATTACHMENTS_DIR, IMAGE_MAX_BYTES, importLocalImage, sharableLocalFile, sniffImageMime } from "./attachments.ts";
import { lineWords, typedByHost } from "./replies.ts";
import type { Message } from "./store.ts";

/** Claude's standard-tier long edge: a bigger picture goes as its path, never as pixels. */
export const RIDE_MAX_EDGE = 1568;

const LABEL = "[The picture this message follows";
const TAG = /<attached-image\s+path="([^"]*)"\s*\/?>/g;
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|wmv)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const NETWORK = /^[\\/]{2}/;

type Found = { path: string; name: string; linked?: true } | { video: string };
/** The line a turn carries, and the store copy of its pixels for engines that take a local image beside the text. */
export type Ride = { text: string; image?: string };
const NONE: Ride = { text: "" };

const attribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
const unattribute = (value: string) =>
  value.replace(/&(amp|quot|lt|gt|#13|#10);/g, (_m, e: string) => ({ amp: "&", quot: '"', lt: "<", gt: ">", "#13": "\r", "#10": "\n" })[e]!);

function inStore(path: string): boolean {
  if (NETWORK.test(path)) return false;
  try {
    return dirname(realpathSync(path)) === realpathSync(ATTACHMENTS_DIR);
  } catch {
    return false;
  }
}

/** Pixel size from the header, or null when it can't be read. */
export function imageSize(bytes: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === "image/png") return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (mime === "image/gif") return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    if (mime === "image/webp") {
      const chunk = bytes.toString("latin1", 12, 16);
      if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
      if (chunk === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
      }
      if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      return null;
    }
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  } catch {
    // a truncated header reads as unknown
  }
  return null;
}

/** The newest picture or video in one row. Tags count only in rows the host or this bot wrote. */
function findIn(row: Message, trusted: boolean, own: boolean): Found | null {
  const tag = trusted && [...(row.text ?? "").matchAll(TAG)].at(-1)?.[1];
  if (tag) return { path: unattribute(tag), name: basename(unattribute(tag)) };
  if (row.kind === "screen" && row.shown && row.image) return { path: join(ATTACHMENTS_DIR, row.image), name: row.image };
  if (!own || row.kind !== "text") return null;
  const link = localLinks(row.text ?? "").filter((path) => IMAGE.test(path) || VIDEO.test(path)).at(-1);
  if (!link) return null;
  return VIDEO.test(link) ? { video: basename(link) } : { path: link, name: basename(link), linked: true };
}

function render(hit: Found, row: Message, roots: readonly string[]): Ride {
  const words = (text: string) => lineWords(row, text);
  if ("video" in hit) return { text: `[${words(hit.video)} is a video: the user can see it and you can't. Ask what they see if it matters.]` };
  let path = hit.path;
  try {
    if (hit.linked) path = sharableLocalFile(path, roots).path;
    else if (!inStore(path)) return NONE;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0 || stat.size > IMAGE_MAX_BYTES) return NONE;
    const bytes = readFileSync(path);
    const mime = sniffImageMime(bytes);
    if (!mime) return NONE;
    const caption = row.kind === "screen" && row.text?.trim() ? ` - ${words(row.text.trim())}` : "";
    const name = words(hit.name);
    if (mime === "image/gif") return { text: `[${name} is a GIF: the user can see it move and you can't. Ask what they see if it matters.]` };
    const size = imageSize(bytes, mime);
    if (!size || Math.max(size.width, size.height) > RIDE_MAX_EDGE) {
      return { text: `${LABEL}: ${name}${caption}, ${size ? `${size.width}x${size.height} px, ` : ""}too big to attach. Open ${path} to look.]` };
    }
    if (!inStore(path)) path = importLocalImage(path, roots).path;
    return { text: `${LABEL}: ${name}${caption}]\n<attached-image path="${attribute(path)}" />`, image: path };
  } catch {
    return NONE;
  }
}

/** At most one picture for a message the host typed: a reply's own, else the newest this bot showed or linked since the host last spoke. */
export async function imageRide(input: {
  rows: readonly Message[];
  current: Message;
  replyTo?: Message;
  botId: string;
  roots: readonly string[];
  readOnly?: boolean;
}): Promise<Ride> {
  const { rows, current, replyTo, botId, roots } = input;
  if (input.readOnly || current.kind !== "text" || !typedByHost(current) || /<attached-image\s/.test(current.text ?? "")) return NONE;
  const own = (row: Message) => row.role === "bot" && (!row.from || row.from.botId === botId);
  const hit = (row: Message) => {
    const found = findIn(row, (row.role === "user" && typedByHost(row)) || own(row), own(row));
    return found && render(found, row, roots);
  };
  // the first picture found is the one meant: unreadable, the turn goes text-only rather than to an older one
  if (replyTo) return hit(replyTo) ?? NONE;
  const end = rows.findIndex((row) => row.id === current.id);
  for (let i = (end === -1 ? rows.length : end) - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.role === "user" && row.kind === "text" && typedByHost(row)) break;
    if (!own(row)) continue;
    const ride = hit(row);
    if (ride) return ride;
  }
  return NONE;
}