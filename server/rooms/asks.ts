// Team room asks: one row per request to a room's bot, moved only by
// compare-and-set. They live in rooms.db beside the log, in a table of their own.
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "../config.ts";
import { newId, type ProviderInstance } from "../contracts.ts";
import { cancelQueuedAsk } from "../steer-queue.ts";
import type { GroupRecord, Store } from "../store.ts";
import type { RoomAlert } from "./alerts.ts";
import { appendRoomEntry, roomPeople, RoomError, type RoomGrant } from "./db.ts";
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
  /** The grant came from the host's tap. */
  allowed: boolean;
  clean: boolean;
  state: AskState;
  reason?: string;
  at: number;
}

export type HostedGroup = GroupRecord & { hosted: { roomId: string } };

export interface RoomAskDeps {
  store: Pick<Store, "group" | "groupByThread" | "bot" | "appendMessage" | "messagesFor" | "patchGroup">;
  hostName(): string;
  instance(botId: string, threadId: string): ProviderInstance | null;
  /** Queue a work ask on the room's turn queue, carrying its askId. */
  dispatch(ask: RoomAsk): void;
  /** The per-bot stop: epoch bump, interrupt, close approvals, `ended`, then release. */
  stopTurn(ask: RoomAsk, ended: () => Promise<unknown>): Promise<void>;
  endSession(ask: RoomAsk): Promise<void>;
  alert?(alert: RoomAlert): void;
}

/** Words answers plug in here; with none, a words ask fails without a call. */
export const roomAskHooks: { words?: (ask: RoomAsk, instance: ProviderInstance | null) => void } = {};

const DAY = 24 * 60 * 60 * 1000;
const LIVE: readonly AskState[] = ["queued", "running"];
const NEXT: Record<AskState, readonly AskState[]> = {
  held: ["queued", "failed", "cancelled"],
  queued: ["running", "failed", "cancelled"],
  running: ["stopping", "done", "failed"],
  stopping: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

let deps: RoomAskDeps | null = null;
/** A running ask's riders: queued asks to the same only bot that its one turn answers too. */
const riding = new Map<string, string[]>();

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

/** Terminal asks older than a day go. */
function prune(now: number): void {
  db().prepare("DELETE FROM asks WHERE state IN ('done', 'failed', 'cancelled') AND updated_at < ?").run(now - DAY);
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

const botName = (ask: RoomAsk) => need().store.bot(ask.botId)?.name ?? "The bot";

/** Why a live ask may no longer run: the room, the bot or the asker is gone. */
function askInvalid(ask: RoomAsk): { end: AskEnd; line?: string } | null {
  if (peopleOnlyRoom(ask.roomId)) return { end: "failed" };
  const group = need().store.groupByThread(ask.threadId);
  if (group?.hosted?.roomId !== ask.roomId || !group.memberIds.includes(ask.botId)) return { end: "cancelled" };
  if (ask.asker.kind === "person" && !roomPeople(ask.roomId).some((person) => person.id === ask.asker.id)) return { end: "cancelled" };
  return null;
}

/** The one gate every room turn on a hosted thread passes: the shared thread
 * only, and a teammate's request only while its ask for this room, thread and
 * bot is live. A failed check ends the ask, so nothing runs for it. */
export function hostedTurnRefused(group: GroupRecord | null | undefined, threadId: string, botId: string, authority?: string): boolean {
  if (!group?.hosted) return false;
  if (group.threadId !== threadId) return true;
  if (!authority) return false;
  const ask = askById(authority);
  if (!ask || !LIVE.includes(ask.state) || ask.roomId !== group.hosted.roomId || ask.threadId !== threadId || ask.botId !== botId) return true;
  const invalid = askInvalid(ask);
  if (invalid) void endAsk(ask.id, invalid.end, invalid.line);
  return Boolean(invalid);
}

/** The queued asks that wait behind `id` for a group's only bot, oldest first. */
export function askRiders(id: string): RoomAsk[] {
  const { store } = need();
  const ask = askById(id);
  const bots = ask ? store.groupByThread(ask.threadId)?.memberIds.filter((botId) => {
    const bot = store.bot(botId);
    return bot && !bot.hidden;
  }) : [];
  if (!ask || bots?.length !== 1) return [];
  return roomAsks(ask.roomId, ["queued"]).filter((row) => row.id !== id && row.threadId === ask.threadId && row.botId === ask.botId && row.grant === "work");
}

/** Queued > running, right before the engine is called. `riders` from askRiders start with it, off the queue. */
export function startAsk(id: string, riders: readonly RoomAsk[] = []): boolean {
  const ask = askById(id);
  if (ask?.state !== "queued") return false;
  const invalid = askInvalid(ask);
  if (invalid) {
    void endAsk(id, invalid.end, invalid.line);
    return false;
  }
  if (!moveAsk(id, "queued", "running")) return false;
  const started = riders.filter((rider) => {
    const live = askById(rider.id);
    if (live?.state !== "queued") return false;
    const gone = askInvalid(live);
    if (gone) void endAsk(rider.id, gone.end, gone.line);
    if (gone || !moveAsk(rider.id, "queued", "running")) return false;
    cancelQueuedAsk(rider.id);
    return true;
  }).map((rider) => rider.id);
  if (started.length) riding.set(id, started);
  return true;
}

/** The riders' own moves once their lead ask is over. */
function endRiders(id: string, answered: boolean): void {
  const riders = riding.get(id);
  riding.delete(id);
  for (const rider of riders ?? []) settleAsk(rider, answered);
}

/** A native step may run only inside a running ask; stopping denies. */
export function askAllowsRequest(id: string): boolean {
  const ask = askById(id);
  return ask?.state === "running" && !askInvalid(ask);
}

/** The deny for a card on a teammate's request: only the host could answer it. */
export const ASK_DENY_NOTE =
  "Wink: only the host could answer this step, and a teammate's request can't wait for them. Skip it and say so in your reply.";

const teammateAsks = (roomId: string, threadId: string, botId: string) =>
  roomAsks(roomId, ["running", "stopping"]).filter((ask) => ask.asker.kind === "person" && ask.threadId === threadId && ask.botId === botId);

/** A teammate's request is this bot's live turn on the thread. */
export function teammateAskTurn(roomId: string, threadId: string, botId: string): boolean {
  return teammateAsks(roomId, threadId, botId).length > 0;
}

/** The host, or a person the host turned "Can make bots work" on for. Keyed on who asked, never on the bot. */
const askerWorks = (ask: RoomAsk) => ask.asker.kind === "host" || roomPeople(ask.roomId).some((person) => person.id === ask.asker.id && person.works);

/** Every ask one turn answers may make the bot work; one read-only asker makes the whole turn read-only. */
export function asksWork(asks: readonly RoomAsk[]): boolean {
  return asks.every(askerWorks);
}

/** A teammate without the switch is this bot's live turn on the thread: nothing it asks for is approved. */
export function readOnlyAskTurn(roomId: string, threadId: string, botId: string): boolean {
  return teammateAsks(roomId, threadId, botId).some((ask) => !askerWorks(ask));
}

/** A deny that never reached the engine leaves a step open with no card; the request ends so the room moves on. */
export function failTeammateAskTurn(roomId: string, threadId: string, botId: string): void {
  for (const ask of teammateAsks(roomId, threadId, botId)) void endAsk(ask.id, "failed");
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

/** A running ask whose turn settled on its own: done with an answer, else failed with its line. Null once stopping took it. */
export function settleAsk(id: string, answered: boolean): RoomAsk | null {
  const ask = askById(id);
  if (!ask || !moveAsk(id, "running", answered ? "done" : "failed")) return null;
  if (!answered) writeEnd(ask, endLine(ask, "failed"));
  endRiders(id, answered);
  return ask;
}

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
  // A rider ends alone; the turn goes on for its lead ask.
  const lead = [...riding].find(([, riders]) => riders.includes(id));
  if (!lead) return "stopping";
  riding.set(lead[0], lead[1].filter((rider) => rider !== id));
  if (moveAsk(id, "stopping", end)) writeEnd(ask, line ?? endLine(ask, end));
  return "ended";
}

/** Waits for the native session to end, then makes the terminal move and writes its entry. */
export async function finishEnd(id: string): Promise<boolean> {
  const ask = askById(id);
  if (ask?.state !== "stopping") return false;
  await need().endSession(ask).catch(() => {});
  const [end, ...line] = (ask.reason ?? "failed").split(":") as [AskEnd, ...string[]];
  if (!moveAsk(id, "stopping", end)) return false;
  writeEnd(ask, line.length ? line.join(":") : endLine(ask, end));
  endRiders(id, false);
  return true;
}

/** Every ending of a live ask: Cancel, Leave, Remove, the deadline, room Stop. */
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

/** Remove or Leave: end the person's asks once they are out of the room. */
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

/** A queued ask starts: work on the room's queue, words through its hook. */
export function runAsk(ask: RoomAsk): void {
  const { dispatch, instance } = need();
  if (peopleOnlyRoom(ask.roomId)) return void endAsk(ask.id, "failed");
  if (ask.grant === "work") return dispatch(ask);
  if (roomAskHooks.words) return roomAskHooks.words(ask, instance(ask.botId, ask.threadId));
  void endAsk(ask.id, "failed");
}

/** Allow or Answer only: one held > queued move, then it runs. */
export function admitAsk(id: string, grant: RoomGrant): RoomAsk | null {
  const ask = askById(id);
  if (ask?.state !== "held") return null;
  const moved = db().prepare("UPDATE asks SET state = 'queued', grant_kind = ?, allowed = 1, updated_at = ? WHERE id = ? AND state = 'held'")
    .run(grant, Date.now(), id).changes === 1;
  if (!moved) return null;
  const admitted = { ...ask, grant, allowed: true, state: "queued" as const };
  runAsk(admitted);
  return admitted;
}
