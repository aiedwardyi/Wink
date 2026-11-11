// Team room asks: one row per request to a room's bot, moved only by
// compare-and-set, plus the durable day and hour quotas. Both live in rooms.db
// beside the log, in tables of their own.
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "../config.ts";
import { newId, type ProviderInstance } from "../contracts.ts";
import { cancelQueuedAsk } from "../steer-queue.ts";
import type { GroupRecord, Store } from "../store.ts";
import { appendRoomEntry, roomPeople, RoomError, type RoomGrant, type RoomLevel } from "./db.ts";
import { roomEngineAllowed } from "./guards.ts";
import { writeRoomEntry } from "./mirror.ts";
import { PEOPLE_ONLY_LINE, peopleOnlyRoom } from "./people-only.ts";

export type AskState = "held" | "queued" | "running" | "stopping" | "done" | "failed" | "cancelled";
export type AskEnd = "failed" | "cancelled";

export interface RoomAsker {
  kind: "host" | "person";
  id: string;
}

export interface RoomAsk {
  id: string;
  roomId: string;
  threadId: string;
  botId: string;
  asker: RoomAsker;
  entryId: string;
  quoteId?: string;
  /** Unset while held; Allow or Answer only picks it. */
  grant?: RoomGrant;
  /** The grant came from the host's tap, not the asker's level. */
  allowed: boolean;
  clean: boolean;
  state: AskState;
  reason?: string;
  at: number;
}

export type HostedGroup = GroupRecord & { hosted: { roomId: string } };

export interface RoomAskDeps {
  store: Pick<Store, "group" | "groupByThread" | "bot" | "appendMessage" | "messagesFor" | "patchGroup">;
  teamRooms(): boolean;
  hostName(): string;
  driverKind(botId: string): string | undefined;
  instance(botId: string, threadId: string): ProviderInstance | null;
  /** Queue a work ask on the room's turn queue, carrying its askId. */
  dispatch(ask: RoomAsk): void;
  /** The per-bot stop: epoch bump, interrupt, close approvals, `ended`, then release. */
  stopTurn(ask: RoomAsk, ended: () => Promise<unknown>): Promise<void>;
  endSession(ask: RoomAsk): Promise<void>;
}

/** Words answers plug in here; with none, a words ask fails without a call. */
export const roomAskHooks: { words?: (ask: RoomAsk, instance: ProviderInstance | null) => void } = {};

export const ROOM_LIMITS = {
  messagesPerPersonDay: 1_000,
  messagesPerRoomDay: 5_000,
  asksPerPersonHour: 30,
  asksPerRoomHour: 120,
  openWorkPerPerson: 1,
  heldPerPerson: 3,
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LIVE: readonly AskState[] = ["queued", "running"];
const NEXT: Record<AskState, readonly AskState[]> = {
  held: ["queued", "failed", "cancelled"],
  queued: ["running", "failed", "cancelled"],
  running: ["stopping"],
  stopping: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

let deps: RoomAskDeps | null = null;

export function configureRoomAsks(next: RoomAskDeps | null): void {
  deps = next;
}

function need(): RoomAskDeps {
  if (!deps) throw new Error("team room asks are not configured");
  return deps;
}

export const roomAskDeps = need;

const DB_FILE = () => join(DATA_DIR, "rooms.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

function open(): DatabaseSync {
  const file = DB_FILE();
  closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {}
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS asks (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      asker_kind TEXT NOT NULL,
      asker_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      quote_id TEXT,
      grant_kind TEXT,
      allowed INTEGER NOT NULL,
      clean INTEGER NOT NULL,
      state TEXT NOT NULL,
      reason TEXT,
      at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS asks_by_room ON asks (room_id, state);
    CREATE TABLE IF NOT EXISTS room_spend (
      room_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS room_spend_by_room ON room_spend (room_id, kind, at);
  `);
  return db;
}

function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  handle = open();
  handlePath = DB_FILE();
  return handle;
}

export function closeAsksDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}

type AskRow = {
  id: string; room_id: string; thread_id: string; bot_id: string; asker_kind: RoomAsker["kind"]; asker_id: string;
  entry_id: string; quote_id: string | null; grant_kind: RoomGrant | null; allowed: number; clean: number;
  state: AskState; reason: string | null; at: number;
};

const ASK_COLUMNS = "id, room_id, thread_id, bot_id, asker_kind, asker_id, entry_id, quote_id, grant_kind, allowed, clean, state, reason, at";

const rowToAsk = (row: AskRow): RoomAsk => ({
  id: row.id,
  roomId: row.room_id,
  threadId: row.thread_id,
  botId: row.bot_id,
  asker: { kind: row.asker_kind, id: row.asker_id },
  entryId: row.entry_id,
  ...(row.quote_id ? { quoteId: row.quote_id } : {}),
  ...(row.grant_kind ? { grant: row.grant_kind } : {}),
  allowed: row.allowed === 1,
  clean: row.clean === 1,
  state: row.state,
  ...(row.reason ? { reason: row.reason } : {}),
  at: row.at,
});

export function askById(id: string): RoomAsk | null {
  const row = db().prepare(`SELECT ${ASK_COLUMNS} FROM asks WHERE id = ?`).get(id) as AskRow | undefined;
  return row ? rowToAsk(row) : null;
}

export function roomAsks(roomId: string, states: readonly AskState[]): RoomAsk[] {
  const rows = db().prepare(`SELECT ${ASK_COLUMNS} FROM asks WHERE room_id = ? AND state IN (${states.map(() => "?").join(", ")}) ORDER BY at, rowid`)
    .all(roomId, ...states) as AskRow[];
  return rows.map(rowToAsk);
}

/** Terminal asks and spend older than a day go. */
function prune(now: number): void {
  db().prepare("DELETE FROM asks WHERE state IN ('done', 'failed', 'cancelled') AND updated_at < ?").run(now - DAY);
  db().prepare("DELETE FROM room_spend WHERE at < ?").run(now - DAY);
}

export function createAsk(draft: Omit<RoomAsk, "id" | "at" | "state" | "reason" | "allowed">): RoomAsk {
  if (peopleOnlyRoom(draft.roomId)) throw new RoomError(409, PEOPLE_ONLY_LINE);
  const now = Date.now();
  prune(now);
  const ask: RoomAsk = { ...draft, id: newId(), allowed: false, state: draft.grant ? "queued" : "held", at: now };
  db().prepare(`INSERT INTO asks (${ASK_COLUMNS}, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ask.id, ask.roomId, ask.threadId, ask.botId, ask.asker.kind, ask.asker.id, ask.entryId, ask.quoteId ?? null,
    ask.grant ?? null, 0, Number(ask.clean), ask.state, null, now, now,
  );
  return ask;
}

/** One compare-and-set: true only for the caller whose move landed. */
export function moveAsk(id: string, from: AskState, to: AskState, reason?: string): boolean {
  if (!NEXT[from].includes(to)) throw new Error(`an ask can't move from ${from} to ${to}`);
  return db().prepare("UPDATE asks SET state = ?, reason = ?, updated_at = ? WHERE id = ? AND state = ?")
    .run(to, reason ?? null, Date.now(), id, from).changes === 1;
}

const levelAllows = (level: RoomLevel, ask: RoomAsk) =>
  ask.grant === "words" || level === "trusted" || (level === "ask" && ask.allowed);

export const engineLine = (name: string) => `${name} can only answer in team rooms on Claude or Codex`;
const botName = (ask: RoomAsk) => need().store.bot(ask.botId)?.name ?? "The bot";

/** Why a live ask may no longer run: the room, the bot, the asker's level or the engine changed. */
function askInvalid(ask: RoomAsk): { end: AskEnd; line?: string } | null {
  if (peopleOnlyRoom(ask.roomId)) return { end: "failed" };
  const { store, driverKind } = need();
  const group = store.groupByThread(ask.threadId);
  if (group?.hosted?.roomId !== ask.roomId || !group.memberIds.includes(ask.botId)) return { end: "cancelled" };
  if (ask.asker.kind === "person") {
    const person = roomPeople(ask.roomId).find((candidate) => candidate.id === ask.asker.id);
    if (!person || !levelAllows(person.level, ask)) return { end: "cancelled" };
  }
  if (!roomEngineAllowed(driverKind(ask.botId))) return { end: "failed", line: engineLine(botName(ask)) };
  return null;
}

/** The one gate every room turn on a hosted thread passes: only a live ask for
 * this exact room, thread and bot whose asker still holds its grant. A failed
 * check ends the ask, so nothing runs for it. */
export function hostedTurnRefused(group: GroupRecord | null | undefined, threadId: string, botId: string, authority?: string): boolean {
  if (!group?.hosted) return false;
  if (!authority || group.threadId !== threadId) return true;
  const ask = askById(authority);
  if (!ask || !LIVE.includes(ask.state) || ask.roomId !== group.hosted.roomId || ask.threadId !== threadId || ask.botId !== botId) return true;
  const invalid = askInvalid(ask);
  if (invalid) void endAsk(ask.id, invalid.end, invalid.line);
  return Boolean(invalid);
}

/** Queued > running, right before the engine is called. */
export function startAsk(id: string): boolean {
  const ask = askById(id);
  if (ask?.state !== "queued") return false;
  const invalid = askInvalid(ask);
  if (invalid) {
    void endAsk(id, invalid.end, invalid.line);
    return false;
  }
  return moveAsk(id, "queued", "running");
}

/** A native step may run only inside a running ask; stopping denies. */
export function askAllowsRequest(id: string): boolean {
  const ask = askById(id);
  return ask?.state === "running" && !askInvalid(ask);
}

function writeEnd(ask: RoomAsk, text: string): void {
  if (peopleOnlyRoom(ask.roomId)) return;
  const { store } = need();
  const group = store.groupByThread(ask.threadId);
  const draft = {
    author: { kind: "bot" as const, id: ask.botId, name: botName(ask) },
    text,
    replyToId: ask.entryId,
    askId: ask.id,
    ...(ask.grant ? { grant: ask.grant } : {}),
    clean: ask.clean,
  };
  try {
    if (group?.hosted?.roomId === ask.roomId) writeRoomEntry(store, group as HostedGroup, draft);
    else appendRoomEntry(ask.roomId, draft);
  } catch {
    // The room or its asked entry is gone with a deleted room: no one is left to read the line.
  }
}

const endLine = (ask: RoomAsk, end: AskEnd) => (end === "cancelled" ? "Cancelled." : `${botName(ask)} couldn't finish this.`);

/** The synchronous half of ending: held and queued end now, running takes stopping. */
export function beginEnd(id: string, end: AskEnd, line?: string): "ended" | "stopping" | null {
  const ask = askById(id);
  if (!ask) return null;
  if (ask.state === "held" || ask.state === "queued") {
    if (!moveAsk(id, ask.state, end, line)) return null;
    if (ask.state === "queued") cancelQueuedAsk(id);
    writeEnd(ask, line ?? endLine(ask, end));
    return "ended";
  }
  if (ask.state !== "running" || !moveAsk(id, "running", "stopping", line ? `${end}:${line}` : end)) return null;
  return "stopping";
}

/** Waits for the native session to end, then makes the terminal move and writes its entry. */
export async function finishEnd(id: string): Promise<boolean> {
  const ask = askById(id);
  if (ask?.state !== "stopping") return false;
  await need().endSession(ask).catch(() => {});
  const [end, ...line] = (ask.reason ?? "failed").split(":") as [AskEnd, ...string[]];
  if (!moveAsk(id, "stopping", end)) return false;
  writeEnd(ask, line.length ? line.join(":") : endLine(ask, end));
  return true;
}

/** Every ending of a live ask: Cancel, Leave, Remove, a level drop, the deadline, room Stop. */
export async function endAsk(id: string, end: AskEnd, line?: string): Promise<boolean> {
  const first = beginEnd(id, end, line);
  if (first !== "stopping") return first === "ended";
  let ended: Promise<boolean> | undefined;
  await need().stopTurn(askById(id)!, () => (ended = finishEnd(id))).catch(() => {});
  return ended ?? finishEnd(id);
}

/** Room Stop: queued asks end now; running ones take stopping before the interrupt. */
export function stopRoomAsks(roomId: string): string[] {
  return roomAsks(roomId, ["queued", "running"]).filter((ask) => beginEnd(ask.id, "cancelled") === "stopping").map((ask) => ask.id);
}

/** Remove, Leave or a level change: end what the person's level no longer covers. */
export function revalidatePersonAsks(roomId: string, personId: string): Promise<boolean[]> {
  const asks = roomAsks(roomId, ["held", "queued", "running"]).filter((ask) => ask.asker.kind === "person" && ask.asker.id === personId);
  return Promise.all(asks.map((ask) => {
    const invalid = ask.state === "held"
      ? roomPeople(roomId).some((person) => person.id === personId) ? null : { end: "cancelled" as const }
      : askInvalid(ask);
    return invalid ? endAsk(ask.id, invalid.end, invalid.line) : false;
  }));
}

/** Boot: queued and running work died with the last run; held asks wait on. */
export function failInterruptedAsks(): number {
  if (!existsSync(DB_FILE())) return 0;
  const rows = db().prepare(`SELECT ${ASK_COLUMNS} FROM asks WHERE state IN ('queued', 'running', 'stopping')`).all() as AskRow[];
  let failed = 0;
  for (const ask of rows.map(rowToAsk)) {
    const moved = db().prepare("UPDATE asks SET state = 'failed', reason = 'restart', updated_at = ? WHERE id = ? AND state = ?")
      .run(Date.now(), ask.id, ask.state).changes === 1;
    if (!moved) continue;
    failed += 1;
    writeEnd(ask, `Stopped: ${need().hostName()}'s PC restarted. Ask again.`);
  }
  return failed;
}

function spent(roomId: string, kind: "message" | "ask", since: number, personId?: string): number {
  const row = (personId === undefined
    ? db().prepare("SELECT COUNT(*) AS n FROM room_spend WHERE room_id = ? AND kind = ? AND at > ?").get(roomId, kind, since)
    : db().prepare("SELECT COUNT(*) AS n FROM room_spend WHERE room_id = ? AND kind = ? AND at > ? AND person_id = ?").get(roomId, kind, since, personId)) as { n: number };
  return row.n;
}

export function spend(roomId: string, personId: string, kind: "message" | "ask"): void {
  db().prepare("INSERT INTO room_spend (room_id, person_id, kind, at) VALUES (?, ?, ?, ?)").run(roomId, personId, kind, Date.now());
}

/** Why this person can't send now, if they can't. The host has no quota. */
export function sendRefusal(roomId: string, personId: string, ask: RoomGrant | "held" | null): string | null {
  const now = Date.now();
  if (spent(roomId, "message", now - DAY, personId) >= ROOM_LIMITS.messagesPerPersonDay) return "you've sent today's limit of messages in this room";
  if (spent(roomId, "message", now - DAY) >= ROOM_LIMITS.messagesPerRoomDay) return "this room has reached today's message limit";
  if (!ask) return null;
  const mine = roomAsks(roomId, ["held", "queued", "running", "stopping"]).filter((row) => row.asker.kind === "person" && row.asker.id === personId);
  if (ask === "held") return mine.filter((row) => row.state === "held").length >= ROOM_LIMITS.heldPerPerson ? "you already have 3 requests waiting" : null;
  return askRefusal(roomId, personId, ask, mine);
}
function askRefusal(roomId: string, personId: string, ask: RoomGrant, mine: RoomAsk[]): string | null {
  const now = Date.now();
  if (ask === "work" && mine.filter((row) => row.grant === "work" && row.state !== "held").length >= ROOM_LIMITS.openWorkPerPerson) return "wait for your last request to finish";
  if (spent(roomId, "ask", now - HOUR, personId) >= ROOM_LIMITS.asksPerPersonHour) return "you've asked the bot the most it takes in an hour";
  if (spent(roomId, "ask", now - HOUR) >= ROOM_LIMITS.asksPerRoomHour) return "this room has asked the bot the most it takes in an hour";
  return null;
}

/** A queued ask starts: work on the room's queue, words through its hook. */
export function runAsk(ask: RoomAsk): void {
  const { dispatch, instance } = need();
  if (peopleOnlyRoom(ask.roomId)) return void endAsk(ask.id, "failed");
  if (ask.asker.kind === "person") spend(ask.roomId, ask.asker.id, "ask");
  if (ask.grant === "work") return dispatch(ask);
  if (roomAskHooks.words) return roomAskHooks.words(ask, instance(ask.botId, ask.threadId));
  void endAsk(ask.id, "failed");
}

/** Allow or Answer only: one held > queued move, then it runs. */
export function admitAsk(id: string, grant: RoomGrant): RoomAsk | null {
  const ask = askById(id);
  if (ask?.state !== "held") return null;
  if (ask.asker.kind === "person") {
    const mine = roomAsks(ask.roomId, ["queued", "running", "stopping"]).filter((row) => row.asker.kind === "person" && row.asker.id === ask.asker.id);
    const refusal = askRefusal(ask.roomId, ask.asker.id, grant, mine);
    if (refusal) throw Object.assign(new Error(refusal), { status: 429 });
  }
  const moved = db().prepare("UPDATE asks SET state = 'queued', grant_kind = ?, allowed = 1, updated_at = ? WHERE id = ? AND state = 'held'")
    .run(grant, Date.now(), id).changes === 1;
  if (!moved) return null;
  const admitted = { ...ask, grant, allowed: true, state: "queued" as const };
  runAsk(admitted);
  return admitted;
}
