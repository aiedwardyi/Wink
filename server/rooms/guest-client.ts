// The teammate's side of a team room: joins a host's room through the relay
// with a pasted code, keeps joined.db in step with the door's stream, sends
// and leaves. Speaks the frozen door protocol only; no outbox.
import { randomBytes } from "node:crypto";
import type { ClientRequest } from "node:http";
import { request } from "node:https";
import { z } from "zod";

import { labelFromHost } from "../../shared/relay-protocol.ts";
import { HttpsError, httpsRequest, type HttpsDeps } from "../phone-relay/https.ts";
import {
  addJoinedEntries,
  endJoined,
  joinedCursor,
  joinedEntries,
  joinedKey,
  joinedRoom,
  joinedRooms,
  resetJoined,
  saveJoined,
  setJoinedState,
  type JoinedEntry,
  type JoinedRoom,
  type JoinedState,
} from "./joined.ts";

const CODE = /^wkr1:([a-z0-9.-]{1,253}):([\w-]{1,64})\.(wki_[A-Za-z0-9_-]{43})$/;
const SEND_ID = /^[A-Za-z0-9_-]{16,80}$/;
const REQUEST_MS = 15_000;
const REPLY_BYTES = 4 * 1024 * 1024;
const FRAME_BYTES = 256 * 1024;
const SEND_TRIES = 2;
const VIEW_ENTRIES = 200;

const id = z.string().regex(/^[\w-]{1,64}$/);
const name = z.string().max(200);
const personSchema = z.object({ id, name });
const entrySchema = z.object({
  seq: z.number().int().positive(),
  id,
  at: z.number(),
  author: z.object({ kind: z.enum(["host", "person"]), id, name }),
  text: z.string().max(20_000),
  replyToId: id.optional(),
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
}

export type GuestResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

export interface GuestClientDeps {
  /** Relay bases a code's host may sit under: the enrolled one and the baked team one. */
  bases(): ReadonlyArray<string | null>;
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
  leaving: boolean;
  stopped: boolean;
}

export class GuestClient {
  private readonly syncs = new Map<string, Sync>();
  private readonly sending = new Map<string, Promise<unknown>>();
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

  /** The whole join: the pasted code in, a synced room out. */
  async join(code: string): Promise<GuestResult<JoinedView>> {
    const pasted = code.trim();
    const relayHost = roomCodeHost(pasted, this.deps.bases());
    if (!relayHost) return failed(400, "bad-code");
    const reply = await this.call(relayHost, "POST", "/room/v1/join", null, JSON.stringify({ code: pasted }));
    if (!reply.ok) return reply;
    const joined = joinSchema.safeParse(reply.value);
    if (!joined.success) return unavailable();
    const { roomId, person, key } = joined.data;
    this.unfollow(roomId);
    saveJoined(roomId, relayHost, person, key);
    this.follow(roomId);
    this.changed(roomId);
    return { ok: true, value: this.view(joinedRoom(roomId)!) };
  }

  /** One at a time per room. A caller retrying a failed send passes the same sendId back. */
  send(roomId: string, text: unknown, replyToId?: unknown, sendId?: unknown): Promise<GuestResult<JoinedEntry> & { sendId?: string }> {
    const next = (this.sending.get(roomId) ?? Promise.resolve()).then(() => this.sendNow(roomId, text, replyToId, sendId));
    const tail = next.catch(() => {});
    this.sending.set(roomId, tail);
    void tail.then(() => {
      if (this.sending.get(roomId) === tail) this.sending.delete(roomId);
    });
    return next;
  }

  async leave(roomId: string): Promise<GuestResult<JoinedView>> {
    const room = joinedRoom(roomId);
    if (!room) return failed(404, "not found");
    const creds = joinedKey(roomId);
    if (!creds) return { ok: true, value: this.view(room) };
    const sync = this.syncs.get(roomId);
    if (sync) sync.leaving = true;
    const reply = await this.call(creds.relayHost, "POST", `/room/v1/rooms/${roomId}/leave`, creds.key, "{}");
    if (!reply.ok && reply.status !== 401) {
      if (sync) sync.leaving = false;
      return reply;
    }
    this.end(roomId, "left");
    return { ok: true, value: this.view(joinedRoom(roomId)!) };
  }

  private async sendNow(roomId: string, text: unknown, replyToId: unknown, sendId: unknown): Promise<GuestResult<JoinedEntry> & { sendId?: string }> {
    if (!joinedRoom(roomId)) return failed(404, "not found");
    const creds = joinedKey(roomId);
    if (!creds) return failed(409, "this room is read-only");
    if (typeof text !== "string" || (replyToId !== undefined && typeof replyToId !== "string")) return failed(400, "bad request");
    if (sendId !== undefined && (typeof sendId !== "string" || !SEND_ID.test(sendId))) return failed(400, "bad sendId");
    const chosen = (sendId as string | undefined) ?? randomBytes(18).toString("base64url");
    const body = JSON.stringify({ text, ...(replyToId === undefined ? {} : { replyToId }), sendId: chosen });
    let reply: GuestResult<unknown> = unavailable();
    for (let tries = 0; tries < SEND_TRIES && !reply.ok && reply.status === 503; tries++) {
      reply = await this.call(creds.relayHost, "POST", `/room/v1/rooms/${roomId}/send`, creds.key, body);
    }
    if (!reply.ok) {
      if (reply.status === 401) this.end(roomId, "removed");
      return { ...reply, sendId: chosen };
    }
    const entry = z.object({ entry: entrySchema }).safeParse(reply.value);
    if (!entry.success) return { ...unavailable(), sendId: chosen };
    if (addJoinedEntries(roomId, [entry.data.entry])) this.changed(roomId);
    return { ok: true, value: entry.data.entry, sendId: chosen };
  }

  /** A transport failure or a non-JSON reply reads as 503 `unavailable`. */
  private async call(relayHost: string, method: "GET" | "POST", path: string, key: string | null, body?: string): Promise<GuestResult<unknown>> {
    const headers: Record<string, string> = { host: relayHost, ...(method === "POST" ? { origin: `https://${relayHost}` } : {}) };
    if (key) headers.authorization = `Bearer ${key}`;
    try {
      const res = await httpsRequest({ method, url: `https://${relayHost}${path}`, body, headers, timeoutMs: REQUEST_MS, maxBytes: REPLY_BYTES }, this.deps.https);
      if (res.status !== 200) return doorError(res.status, res.body);
      return { ok: true, value: JSON.parse(res.body.toString("utf8")) };
    } catch (error) {
      if (error instanceof HttpsError || error instanceof SyntaxError) return unavailable();
      throw error;
    }
  }

  private view(room: JoinedRoom): JoinedView {
    const link = room.status === "joined" ? (this.syncs.get(room.roomId)?.link ?? "offline") : null;
    return { roomId: room.roomId, status: room.status, link, me: room.me, state: room.state };
  }

  private changed(roomId: string): void {
    this.deps.onChange?.(roomId);
  }

  private follow(roomId: string): void {
    const sync: Sync = { link: "connecting", req: null, timer: null, tries: 0, leaving: false, stopped: false };
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

  private end(roomId: string, status: "removed" | "left"): void {
    this.unfollow(roomId);
    if (endJoined(roomId, status)) this.changed(roomId);
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

  /** False when the room ended or the snapshot could not be had. */
  private async snapshot(roomId: string, sync: Sync): Promise<boolean> {
    const creds = joinedKey(roomId);
    if (!creds || sync.stopped) return false;
    const reply = await this.call(creds.relayHost, "GET", `/room/v1/rooms/${roomId}/snapshot`, creds.key);
    if (sync.stopped) return false;
    if (!reply.ok && reply.status === 401) this.end(roomId, "removed");
    const snapshot = reply.ok ? snapshotSchema.safeParse(reply.value) : null;
    if (!snapshot?.success) return false;
    addJoinedEntries(roomId, snapshot.data.entries, snapshot.data.head);
    setJoinedState(roomId, snapshot.data.state);
    this.changed(roomId);
    return true;
  }

  /** A snapshot first when nothing is held yet, then the stream from the newest seq held. */
  private async connect(roomId: string, sync: Sync): Promise<void> {
    if (sync.stopped) return;
    if (!joinedRoom(roomId)?.state && !(await this.snapshot(roomId, sync))) return this.retry(roomId, sync);
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
      headers: { host: creds.relayHost, accept: "text/event-stream", authorization: `Bearer ${creds.key}` },
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
        if (res.statusCode === 401) this.end(roomId, "removed");
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
          if (block.startsWith("data: ")) void this.frame(roomId, sync, block.slice(6));
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

  private async frame(roomId: string, sync: Sync, json: string): Promise<void> {
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
      if (addJoinedEntries(roomId, [parsed.entry], parsed.entry.seq)) this.changed(roomId);
    } else if (parsed.kind === "state") {
      if (setJoinedState(roomId, parsed.state)) this.changed(roomId);
    } else if (parsed.kind === "ended") {
      this.end(roomId, sync.leaving ? "left" : "removed");
    } else {
      // Live entries keep arriving on this stream while the snapshot loads; both are deduped by seq.
      resetJoined(roomId);
      if (!(await this.snapshot(roomId, sync))) sync.req?.destroy();
    }
  }
}
