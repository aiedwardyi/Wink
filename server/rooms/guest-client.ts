// The teammate's side of a team room: joins a host's room through the relay
// with a pasted code, keeps joined.db in step with the door's stream, sends
// and leaves. Speaks the frozen door protocol only; no outbox.
import { randomBytes } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import type { Readable } from "node:stream";
import { z } from "zod";

import { labelFromHost } from "../../shared/relay-protocol.ts";
import { DOCUMENT_MAX_BYTES } from "../attachments.ts";
import { HttpsError, httpsRequest, type HttpsDeps } from "../phone-relay/https.ts";
import {
  addJoinedEntries,
  endJoined,
  joinedCode,
  joinedCursor,
  joinedEntries,
  joinedFile,
  joinedKey,
  joinedRoom,
  joinedRooms,
  joinedSummary,
  readJoined,
  resetJoined,
  removeJoined,
  saveJoined,
  setJoinedState,
  type JoinedEntry,
  type JoinedFile,
  type JoinedRoom,
  type JoinedState,
} from "./joined.ts";
import { cachedJoinedFile, keepJoinedFile, removeJoinedFiles } from "./joined-files.ts";
import { NAME_MAX } from "./names.ts";

const CODE = /^wkr1:([a-z0-9.-]{1,253}):([\w-]{1,64})\.(wki_[A-Za-z0-9_-]{43})$/;
const SEND_ID = /^[A-Za-z0-9_-]{16,80}$/;
const REQUEST_MS = 15_000;
const REPLY_BYTES = 4 * 1024 * 1024;
const FRAME_BYTES = 256 * 1024;
const SEND_TRIES = 2;
const MAX_PENDING_SENDS = 20;
const VIEW_ENTRIES = 200;
const UPLOAD_MS = 10 * 60_000;
const MAX_FILES = 10;

const id = z.string().regex(/^[\w-]{1,64}$/);
const name = z.string().max(200);
const personSchema = z.object({ id, name });
const fileSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{24}$/),
  name: z.string().max(200),
  type: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "application/zip", "application/x-ole-storage", "text/plain"]),
  bytes: z.number().int().positive().max(DOCUMENT_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const entrySchema = z.object({
  seq: z.number().int().positive(),
  id,
  at: z.number(),
  author: z.object({ kind: z.enum(["host", "person"]), id, name }),
  text: z.string().max(20_000),
  replyToId: id.optional(),
  files: z.array(fileSchema).max(MAX_FILES).optional(),
});
const stateSchema = z.object({
  version: z.number().int().nonnegative(),
  roomName: z.string().max(200),
  instructions: z.string().max(20_000),
  host: name,
  me: personSchema,
  people: z.array(personSchema).max(100),
});
const joinSchema = z.object({ roomId: id, person: personSchema, key: z.string().regex(/^wkg_[A-Za-z0-9_-]{43}$/) });
const snapshotSchema = z.object({ head: z.number().int().nonnegative(), entries: z.array(entrySchema).max(1_000), state: stateSchema });
const frameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entry"), entry: entrySchema }),
  z.object({ kind: z.literal("state"), state: stateSchema }),
  z.object({ kind: z.literal("reset") }),
  z.object({ kind: z.literal("ended") }),
]);

/** `offline` covers a host that is off, unreachable or answering with errors. */
export type JoinedLink = "connecting" | "live" | "offline";

export interface JoinedView {
  roomId: string;
  status: JoinedRoom["status"];
  link: JoinedLink | null;
  me: { id: string; name: string };
  state: JoinedState | null;
  unread: number;
  lastEntry?: JoinedEntry;
}

export type GuestResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export interface GuestClientDeps {
  /** Relay bases a code's host may sit under: the enrolled one and the baked team one. */
  bases(): ReadonlyArray<string | null>;
  /** This PC as the host sees it: its own name and a steady id a Remove can bar. */
  joiner(): { name: string; device: string };
  onChange?(roomId: string): void;
  https?: HttpsDeps;
  /** Silence before a stream counts as dropped, and the reconnect backoff. */
  timing?: { silenceMs?: number; retryMs?: number; maxRetryMs?: number };
}

/** The relay host of a strictly well-formed code under one of `bases`, else null. */
export function roomCodeHost(code: string, bases: ReadonlyArray<string | null>): string | null {
  const host = CODE.exec(code)?.[1];
  return host && bases.some((base) => base && labelFromHost(host, base) !== null) ? host : null;
}

const failed = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const unavailable = () => failed(503, "unavailable");

function doorError(status: number, body: Buffer): { ok: false; status: number; error: string } {
  try {
    const error = (JSON.parse(body.toString("utf8")) as { error?: unknown }).error;
    if (typeof error === "string" && error.length <= 200) return failed(status, error);
  } catch {}
  return failed(status, "unavailable");
}

interface Sync {
  link: JoinedLink;
  req: ClientRequest | null;
  timer: NodeJS.Timeout | null;
  tries: number;
  /** Set by reset; only a snapshot that lands clears it. */
  needsSnapshot: boolean;
  snapshotting: Promise<boolean> | null;
  stopped: boolean;
}

export class GuestClient {
  private readonly syncs = new Map<string, Sync>();
  private readonly sending = new Map<string, Promise<unknown>>();
  private readonly pending = new Map<string, number>();
  /** Keys whose leave is in flight. */
  private readonly leaving = new Set<string>();
  private readonly changing = new Set<string>();
  private joining = 0;
  private readonly fetching = new Map<string, Promise<GuestResult<{ file: JoinedFile; path: string }>>>();
  private started = false;
  private readonly deps: GuestClientDeps;

  constructor(deps: GuestClientDeps) {
    this.deps = deps;
  }

  /** Resumes every joined room's stream. Safe to call again. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const room of joinedRooms()) if (room.status === "joined") this.follow(room.roomId);
  }

  stop(): void {
    this.started = false;
    for (const roomId of [...this.syncs.keys()]) this.unfollow(roomId);
  }

  rooms(): JoinedView[] {
    return joinedRooms().map((room) => this.view(room));
  }

  room(roomId: string): (JoinedView & { entries: JoinedEntry[] }) | null {
    const room = joinedRoom(roomId);
    return room ? { ...this.view(room), entries: joinedEntries(roomId, VIEW_ENTRIES) } : null;
  }

  read(roomId: string, seq: unknown): GuestResult<JoinedView> {
    const room = joinedRoom(roomId);
    if (!room) return failed(404, "not found");
    const last = joinedEntries(roomId, 1)[0]?.seq ?? 0;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || seq > last) return failed(400, "bad-read");
    const readSeq = Math.min(seq, joinedCursor(roomId));
    if (readSeq > 0 && readJoined(roomId, readSeq)) this.changed(roomId);
    return { ok: true, value: this.view(room) };
  }

  /** The whole join: the pasted code in, a synced room out. */
  async join(code: string): Promise<GuestResult<JoinedView>> {
    if (this.changing.size) return failed(409, "room is busy");
    this.joining++;
    try {
      return await this.joinNow(code);
    } finally {
      this.joining--;
    }
  }

  private async joinNow(code: string, expectedRoomId?: string): Promise<GuestResult<JoinedView>> {
    const pasted = code.trim();
    const relayHost = roomCodeHost(pasted, this.deps.bases());
    if (!relayHost) return failed(400, "bad-code");
    const { name, device } = this.deps.joiner();
    // The door refuses join bodies over 1 KB, and a profile name has no cap.
    const reply = await this.call(relayHost, "POST", "/room/v1/join", null, JSON.stringify({ code: pasted, name: [...name].slice(0, NAME_MAX).join(""), device, ...(expectedRoomId ? { roomId: expectedRoomId } : {}) }));
    if (!reply.ok) return reply;
    const joined = joinSchema.safeParse(reply.value);
    if (!joined.success) return unavailable();
    const { roomId, person, key } = joined.data;
    if (expectedRoomId && roomId !== expectedRoomId) return failed(400, "bad-code");
    this.unfollow(roomId);
    saveJoined(roomId, relayHost, person, key, pasted);
    this.follow(roomId);
    this.changed(roomId);
    return { ok: true, value: this.view(joinedRoom(roomId)!) };
  }

  /** One at a time per room. A caller retrying a failed send passes the same sendId back. */
  send(roomId: string, text: unknown, replyToId?: unknown, sendId?: unknown, fileIds?: unknown): Promise<GuestResult<JoinedEntry> & { sendId?: string }> {
    const waiting = this.pending.get(roomId) ?? 0;
    if (waiting >= MAX_PENDING_SENDS) return Promise.resolve(failed(429, "too many messages waiting to send"));
    this.pending.set(roomId, waiting + 1);
    const next = (this.sending.get(roomId) ?? Promise.resolve()).then(() => this.sendNow(roomId, text, replyToId, sendId, fileIds));
    const tail = next.catch(() => {}).then(() => {
      const left = (this.pending.get(roomId) ?? 1) - 1;
      if (left) return void this.pending.set(roomId, left);
      this.pending.delete(roomId);
      this.sending.delete(roomId);
    });
    this.sending.set(roomId, tail);
    return next;
  }

  async leave(roomId: string): Promise<GuestResult<JoinedView>> {
    const room = joinedRoom(roomId);
    if (!room) return failed(404, "not found");
    const creds = joinedKey(roomId);
    if (!creds) return { ok: true, value: this.view(room) };
    this.leaving.add(creds.key);
    const reply = await this.call(creds.relayHost, "POST", `/room/v1/rooms/${roomId}/leave`, creds.key, "{}");
    if (reply.ok || reply.status === 401) this.end(roomId, creds.key, "left");
    this.leaving.delete(creds.key);
    if (!reply.ok && reply.status !== 401) return reply;
    return { ok: true, value: this.view(joinedRoom(roomId)!) };
  }

  async rejoin(roomId: string, suppliedCode?: unknown): Promise<GuestResult<JoinedView>> {
    const room = joinedRoom(roomId);
    if (!room) return failed(404, "not found");
    if (room.status === "removed") return failed(403, "removed");
    if (room.status !== "left" || this.changing.has(roomId) || this.joining) return failed(409, "room is busy");
    if (suppliedCode !== undefined && typeof suppliedCode !== "string") return failed(400, "bad-code");
    const code = typeof suppliedCode === "string" ? suppliedCode : joinedCode(roomId);
    if (!code) return failed(409, "no-saved-code");
    if (roomCodeHost(code.trim(), this.deps.bases()) !== room.relayHost) return failed(400, "bad-code");
    this.changing.add(roomId);
    try {
      return await this.joinNow(code, roomId);
    } finally {
      this.changing.delete(roomId);
    }
  }

  async remove(roomId: string): Promise<GuestResult<boolean>> {
    const room = joinedRoom(roomId);
    if (!room) return failed(404, "not found");
    if (room.status === "joined" || this.changing.has(roomId) || this.joining) return failed(409, "room is busy");
    this.changing.add(roomId);
    try {
      await removeJoinedFiles(roomId);
      this.unfollow(roomId);
      const removed = removeJoined(roomId);
      if (removed) this.changed(roomId);
      return { ok: true, value: removed };
    } finally {
      this.changing.delete(roomId);
    }
  }

  /** Streams `body` to the door, which sniffs and caps it. The caller owns uploadId and resends it on retry; no retry here, the body is spent. */
  async upload(roomId: string, body: Buffer | Readable, name: string, uploadId: string, length?: string): Promise<GuestResult<JoinedFile> & { uploadId?: string }> {
    if (!joinedRoom(roomId)) return failed(404, "not found");
    const creds = joinedKey(roomId);
    if (!creds) return failed(409, "this room is read-only");
    if (!SEND_ID.test(uploadId)) return failed(400, "bad uploadId");
    const query = new URLSearchParams({ uploadId, name: name.slice(0, 200) });
    const reply = await this.call(creds.relayHost, "POST", `/room/v1/rooms/${roomId}/files?${query}`, creds.key, body, length, UPLOAD_MS);
    if (!reply.ok) {
      if (reply.status === 401) this.end(roomId, creds.key);
      return { ...reply, uploadId };
    }
    const file = z.object({ file: fileSchema }).safeParse(reply.value);
    return file.success ? { ok: true, value: file.data.file, uploadId } : { ...unavailable(), uploadId };
  }

  /** A file a held entry carries: the local copy, else fetched through the door with this room's key. */
  file(roomId: string, fileId: string): Promise<GuestResult<{ file: JoinedFile; path: string }>> {
    const file = joinedFile(roomId, fileId);
    if (!file) return Promise.resolve(failed(404, "not found"));
    const path = cachedJoinedFile(roomId, file);
    if (path) return Promise.resolve({ ok: true, value: { file, path } });
    const key = `${roomId}\n${fileId}`;
    let fetching = this.fetching.get(key);
    if (!fetching) {
      fetching = this.fetchFile(roomId, file).finally(() => this.fetching.delete(key));
      this.fetching.set(key, fetching);
    }
    return fetching;
  }

  private async fetchFile(roomId: string, file: JoinedFile): Promise<GuestResult<{ file: JoinedFile; path: string }>> {
    const creds = joinedKey(roomId);
    if (!creds) return failed(409, "this room is read-only");
    const https = this.deps.https ?? {};
    const res = await new Promise<IncomingMessage | null>((resolve) => {
      const req = request({
        method: "GET",
        protocol: "https:",
        hostname: creds.relayHost,
        servername: creds.relayHost,
        port: https.port ?? 443,
        path: `/room/v1/rooms/${roomId}/files/${file.id}`,
        headers: { host: creds.relayHost, authorization: `Bearer ${creds.key}` },
        ca: https.ca,
        lookup: https.lookup,
        agent: false,
        timeout: REQUEST_MS,
      }, resolve);
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
      req.end();
    });
    if (!res) return unavailable();
    if (res.statusCode !== 200) {
      res.resume();
      if (res.statusCode === 401) this.end(roomId, creds.key);
      return res.statusCode === 404 ? failed(404, "not found") : unavailable();
    }
    if (!(await keepJoinedFile(roomId, file, res))) return unavailable();
    return { ok: true, value: { file, path: cachedJoinedFile(roomId, file)! } };
  }

  private async sendNow(roomId: string, text: unknown, replyToId: unknown, sendId: unknown, fileIds: unknown): Promise<GuestResult<JoinedEntry> & { sendId?: string }> {
    if (!joinedRoom(roomId)) return failed(404, "not found");
    const creds = joinedKey(roomId);
    if (!creds) return failed(409, "this room is read-only");
    if (typeof text !== "string" || (replyToId !== undefined && typeof replyToId !== "string")) return failed(400, "bad request");
    if (sendId !== undefined && (typeof sendId !== "string" || !SEND_ID.test(sendId))) return failed(400, "bad sendId");
    if (fileIds !== undefined && !(Array.isArray(fileIds) && fileIds.length <= MAX_FILES && fileIds.every((fileId) => typeof fileId === "string"))) return failed(400, "bad request");
    const chosen = (sendId as string | undefined) ?? randomBytes(18).toString("base64url");
    const body = JSON.stringify({ text, ...(replyToId === undefined ? {} : { replyToId }), sendId: chosen, ...(fileIds?.length ? { fileIds } : {}) });
    let reply: GuestResult<unknown> = unavailable();
    for (let tries = 0; tries < SEND_TRIES && !reply.ok && reply.status === 503; tries++) {
      reply = await this.call(creds.relayHost, "POST", `/room/v1/rooms/${roomId}/send`, creds.key, body);
    }
    if (!reply.ok) {
      if (reply.status === 401) this.end(roomId, creds.key);
      return { ...reply, sendId: chosen };
    }
    const entry = z.object({ entry: entrySchema }).safeParse(reply.value);
    if (!entry.success) return { ...unavailable(), sendId: chosen };
    if (addJoinedEntries(roomId, [entry.data.entry])) this.changed(roomId);
    return { ok: true, value: entry.data.entry, sendId: chosen };
  }

  /** A transport failure or a non-JSON reply reads as 503 `unavailable`. */
  private async call(
    relayHost: string, method: "GET" | "POST", path: string, key: string | null, body?: string | Buffer | Readable, length?: string, timeoutMs = REQUEST_MS,
  ): Promise<GuestResult<unknown>> {
    const headers: Record<string, string> = { host: relayHost, ...(method === "POST" ? { origin: `https://${relayHost}` } : {}) };
    if (key) {
      headers.authorization = `Bearer ${key}`;
      headers["x-wink-device"] = this.deps.joiner().device;
    }
    if (length) headers["content-length"] = length;
    const contentType = typeof body === "string" ? undefined : "application/octet-stream";
    try {
      const res = await httpsRequest({ method, url: `https://${relayHost}${path}`, body, contentType, headers, timeoutMs, maxBytes: REPLY_BYTES }, this.deps.https);
      if (res.status !== 200) return doorError(res.status, res.body);
      return { ok: true, value: JSON.parse(res.body.toString("utf8")) };
    } catch (error) {
      if (error instanceof HttpsError || error instanceof SyntaxError) return unavailable();
      throw error;
    }
  }

  private view(room: JoinedRoom): JoinedView {
    const link = room.status === "joined" ? (this.syncs.get(room.roomId)?.link ?? "offline") : null;
    return { roomId: room.roomId, status: room.status, link, me: room.me, state: room.state, ...joinedSummary(room) };
  }

  private changed(roomId: string): void {
    this.deps.onChange?.(roomId);
  }

  private follow(roomId: string): void {
    const sync: Sync = { link: "connecting", req: null, timer: null, tries: 0, needsSnapshot: false, snapshotting: null, stopped: false };
    this.syncs.set(roomId, sync);
    void this.connect(roomId, sync);
  }

  private unfollow(roomId: string): void {
    const sync = this.syncs.get(roomId);
    if (!sync) return;
    sync.stopped = true;
    if (sync.timer) clearTimeout(sync.timer);
    sync.req?.destroy();
    this.syncs.delete(roomId);
  }

  /** Only while `key` is still the room's key: a late reply from before a rejoin changes nothing. */
  private end(roomId: string, key: string, status?: "removed" | "left"): void {
    if (joinedKey(roomId)?.key !== key) return;
    this.unfollow(roomId);
    if (endJoined(roomId, status ?? (this.leaving.has(key) ? "left" : "removed"))) this.changed(roomId);
  }

  private setLink(roomId: string, sync: Sync, link: JoinedLink): void {
    if (sync.stopped || sync.link === link) return;
    sync.link = link;
    this.changed(roomId);
  }

  private retry(roomId: string, sync: Sync): void {
    sync.req = null;
    if (sync.stopped || sync.timer) return;
    this.setLink(roomId, sync, "offline");
    const { retryMs = 1_000, maxRetryMs = 60_000 } = this.deps.timing ?? {};
    const wait = Math.min(maxRetryMs, retryMs * 2 ** Math.min(sync.tries++, 16));
    sync.timer = setTimeout(() => {
      sync.timer = null;
      void this.connect(roomId, sync);
    }, wait);
    sync.timer.unref();
  }

  /** One request at a time per room. False when the room ended or the snapshot could not be had. */
  private snapshot(roomId: string, sync: Sync): Promise<boolean> {
    sync.snapshotting ??= this.loadSnapshot(roomId, sync).finally(() => {
      sync.snapshotting = null;
    });
    return sync.snapshotting;
  }

  private async loadSnapshot(roomId: string, sync: Sync): Promise<boolean> {
    const creds = joinedKey(roomId);
    if (!creds || sync.stopped) return false;
    const reply = await this.call(creds.relayHost, "GET", `/room/v1/rooms/${roomId}/snapshot`, creds.key);
    if (sync.stopped) return false;
    if (!reply.ok && reply.status === 401) this.end(roomId, creds.key);
    const snapshot = reply.ok ? snapshotSchema.safeParse(reply.value) : null;
    if (!snapshot?.success) return false;
    addJoinedEntries(roomId, snapshot.data.entries, snapshot.data.head);
    setJoinedState(roomId, snapshot.data.state);
    sync.needsSnapshot = false;
    this.changed(roomId);
    return true;
  }

  /** A snapshot first when nothing is held yet, then the stream from the newest seq held. */
  private async connect(roomId: string, sync: Sync): Promise<void> {
    if (sync.stopped) return;
    if ((sync.needsSnapshot || !joinedRoom(roomId)?.state) && !(await this.snapshot(roomId, sync))) return this.retry(roomId, sync);
    const creds = joinedKey(roomId);
    if (!creds || sync.stopped) return;
    const head = joinedCursor(roomId);
    const { silenceMs = 45_000 } = this.deps.timing ?? {};
    const https = this.deps.https ?? {};
    const req = request({
      method: "GET",
      protocol: "https:",
      hostname: creds.relayHost,
      servername: creds.relayHost,
      port: https.port ?? 443,
      path: `/room/v1/rooms/${roomId}/stream?after=${head}`,
      headers: { host: creds.relayHost, accept: "text/event-stream", authorization: `Bearer ${creds.key}`, "x-wink-device": this.deps.joiner().device },
      ca: https.ca,
      lookup: https.lookup,
      agent: false,
    });
    sync.req = req;
    let silence: NodeJS.Timeout | null = null;
    const quiet = () => {
      if (silence) clearTimeout(silence);
      silence = setTimeout(() => req.destroy(), silenceMs);
      silence.unref();
    };
    quiet();
    req.on("response", (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        if (res.statusCode === 401) this.end(roomId, creds.key);
        else req.destroy();
        return;
      }
      sync.tries = 0;
      this.setLink(roomId, sync, "live");
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        quiet();
        text += chunk;
        let cut: number;
        while ((cut = text.indexOf("\n\n")) >= 0) {
          const block = text.slice(0, cut);
          text = text.slice(cut + 2);
          if (block.startsWith("data: ")) void this.frame(roomId, sync, creds.key, block.slice(6));
        }
        if (text.length > FRAME_BYTES) req.destroy();
      });
      res.on("error", () => {});
    });
    req.on("error", () => {});
    req.on("close", () => {
      if (silence) clearTimeout(silence);
      if (sync.req === req) this.retry(roomId, sync);
    });
    req.end();
  }

  private async frame(roomId: string, sync: Sync, key: string, json: string): Promise<void> {
    if (sync.stopped) return;
    let parsed: z.infer<typeof frameSchema>;
    try {
      const result = frameSchema.safeParse(JSON.parse(json));
      if (!result.success) return;
      parsed = result.data;
    } catch {
      return;
    }
    if (parsed.kind === "entry") {
      // The cursor holds until a reset's snapshot lands, so a restart meanwhile replays from the start.
      if (addJoinedEntries(roomId, [parsed.entry], sync.needsSnapshot ? undefined : parsed.entry.seq)) this.changed(roomId);
    } else if (parsed.kind === "state") {
      if (setJoinedState(roomId, parsed.state)) this.changed(roomId);
    } else if (parsed.kind === "ended") {
      this.end(roomId, key);
    } else if (!sync.snapshotting) {
      // Live entries keep arriving on this stream while the snapshot loads; both are deduped by seq.
      sync.needsSnapshot = true;
      resetJoined(roomId);
      if (!(await this.snapshot(roomId, sync))) sync.req?.destroy();
    }
  }
}
