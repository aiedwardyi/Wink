import type { VerifyIssue, VerifyReplayEnd, VerifyReplayHead, VerifyTile } from "../../shared/live-verify";

export interface VerifyReplayMark {
  ms: number;
  kind: string;
  [field: string]: unknown;
}

export type VerifyReplayChunk =
  | { kind: "head"; head: VerifyReplayHead }
  | { kind: "frame"; tile: VerifyTile; ms: number; jpeg: Uint8Array }
  | { kind: "mark"; mark: VerifyReplayMark }
  | { kind: "end"; end: VerifyReplayEnd };

const MAGIC = [0x4c, 0x56, 0x52, 0x31];
const MAX_CHUNK = 4 * 1024 * 1024;
const TILES: VerifyTile[] = ["desktop", "phone"];
const utf8 = new TextDecoder();

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown, cap: number) => typeof value === "string" ? value.slice(0, cap) : "";

function box(value: unknown): VerifyIssue["box"] {
  return Array.isArray(value) && value.length === 4 && value.every(finite) ? value as VerifyIssue["box"] : undefined;
}

function issue(value: unknown): VerifyIssue | null {
  if (!record(value) || (value.tile !== "desktop" && value.tile !== "phone")) return null;
  const row: VerifyIssue = { checker: text(value.checker, 40) as VerifyIssue["checker"], tile: value.tile, rule: text(value.rule, 120), where: text(value.where, 120), measured: text(value.measured, 160) };
  if (finite(value.scrollY)) row.scrollY = value.scrollY;
  const rect = box(value.box);
  if (rect) row.box = rect;
  return row;
}

function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(utf8.decode(bytes)); } catch { return undefined; }
}

export function parseChunk(kind: number, payload: Uint8Array): VerifyReplayChunk | null {
  if (kind === 1) {
    if (payload.length < 6 || payload[0]! > 1) return null;
    const ms = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(1, true);
    return { kind: "frame", tile: TILES[payload[0]!]!, ms, jpeg: payload.subarray(5) };
  }
  const value = json(payload);
  if (!record(value)) return null;
  if (kind === 0) {
    const tiles = record(value.tiles) ? value.tiles : {};
    const size = (tile: VerifyTile, fallback: [number, number]): [number, number] => {
      const v = tiles[tile];
      return Array.isArray(v) && v.length === 2 && v.every(finite) && v[0] > 0 && v[1] > 0 ? [v[0], v[1]] : fallback;
    };
    if (typeof value.runId !== "string") return null;
    return { kind: "head", head: { v: 1, runId: text(value.runId, 80), site: text(value.site, 1024), page: text(value.page, 1024), startedAt: finite(value.startedAt) ? value.startedAt : 0, tiles: { desktop: size("desktop", [1280, 720]), phone: size("phone", [392, 800]) } } };
  }
  if (kind === 2) return finite(value.ms) && typeof value.kind === "string" ? { kind: "mark", mark: value as VerifyReplayMark } : null;
  if (kind === 3) {
    const issues = Array.isArray(value.issues) ? value.issues.map(issue).filter((row): row is VerifyIssue => row !== null) : [];
    const notChecked = Array.isArray(value.notChecked) ? value.notChecked.filter((row): row is string => typeof row === "string").map(row => row.slice(0, 200)) : [];
    return { kind: "end", end: { status: text(value.status, 20) as VerifyReplayEnd["status"], ms: finite(value.ms) ? value.ms : 0, issues, notChecked } };
  }
  return null;
}

/** Reads a live chunk stream or a whole .lvr file ("LVR1" first). */
export async function* readReplay(source: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array): AsyncGenerator<VerifyReplayChunk> {
  let pending: Uint8Array = new Uint8Array(0);
  let start = true;
  const reader = source instanceof ReadableStream ? source.getReader() : null;
  let whole: Uint8Array | null = reader ? null : source instanceof Uint8Array ? source : new Uint8Array(source as ArrayBuffer);
  try {
    while (true) {
      let next: Uint8Array | null = whole;
      whole = null;
      if (reader) {
        const read = await reader.read();
        next = read.done ? null : read.value;
      }
      if (!next) break;
      if (next.length) pending = pending.length ? concat(pending, next) : next;
      if (start && pending.length >= 4) {
        if (MAGIC.every((byte, i) => pending[i] === byte)) pending = pending.subarray(4);
        start = false;
      }
      while (!start && pending.length >= 5) {
        const n = new DataView(pending.buffer, pending.byteOffset, 4).getUint32(0, true);
        if (n < 1 || n > MAX_CHUNK) throw new Error("bad replay chunk");
        if (pending.length < 4 + n) break;
        const chunk = parseChunk(pending[4]!, pending.slice(5, 4 + n));
        pending = pending.subarray(4 + n);
        if (chunk) yield chunk;
      }
      if (!reader) break;
    }
  } finally {
    await reader?.cancel().catch(() => {});
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Decodes off the main thread; the caller closes the bitmap. */
export function frameBitmap(jpeg: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
}
