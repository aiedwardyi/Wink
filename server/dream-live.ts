// Dreaming: the idle pass for every bot. Dry is the default: the pass writes what it would move or close to plan.json and changes
// nothing else. Only a bot D/dream-live.json sets to "live" moves lines; no file, a file that does not parse or no entry is dry.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { DREAMED_FILE, dreamedPath, fixedEntry, markPutBack, markUndone } from "./dream-archive.ts";
import type { DreamJudges } from "./dream-judge.ts";
import { applyFix, checkWrong, fixedLine, lineMarks, newestOwned, ownedIds, ownerRows, ownerTyped, savedNotes, undoFix, type FixDone, type FixItem, type JudgeLog, type OwnerRow, type SavedNotes, type StoredRow } from "./dream-wrong.ts";
import { closedAskLine, refPrs, stepLeft, withClosed, type MergedPr } from "./ask-prs.ts";
import { writeFileAtomic } from "./atomic.ts";
import { cleanerSkip, runIdOf, sha8 } from "./memory-clean.ts";
import { appendArchive, type Move } from "./memory-sleep.ts";
import type { UserMark } from "./message-db.ts";
import { pickStamp } from "./picks.ts";
import { redactRoomMemory } from "./redact.ts";
import { isOpenAsk, trimClosed, type TaskAsk } from "./task-asks.ts";
import { DROPPED_KEEP_MS } from "./task-dropped.ts";
import { normalize, serializeBounded, type TaskResumePacket } from "./task-state.ts";
import type { Message } from "./store.ts";
import { memoryFileRaw, rawRevision, readMemoryFile, saveMemoryFile } from "./workspace.ts";

const DAY = 24 * 60 * 60_000;
export const DREAM_FILE = "dream-live.json";
export const RUN_KEEP_MS = 14 * DAY;
const RUNS_DIR = join("dream-live", "runs");

const modeFileSchema = z.object({ bots: z.record(z.string(), z.unknown()) });
const prSchema = z.object({ repo: z.string().optional(), number: z.number().int(), mergedAt: z.number() });
const noteItemSchema = z.object({ op: z.literal("move"), target: z.string(), text: z.string().nullable(), by: z.string().nullable(), why: z.enum(["duplicate", "replaced", "expired"]), history: z.string() });
const askItemSchema = z.object({
  op: z.enum(["close", "ask", "fall-out"]),
  target: z.string(),
  ask: z.string(),
  prs: z.array(prSchema),
  lands: z.enum(["stays", "leaves-now", "leaves-next"]).optional(),
  closedAt: z.number().optional(),
  // the line the bot is owed once a live pass closes it; on disk so a restart cannot drop it
  notice: z.string().optional(),
  told: z.boolean().optional(),
});
const NOTES_STATES = ["checked", "unchanged", "off-here", "no-model", "stopped", "conflict", "error"] as const;
const FIX_STATES = ["checked", "off-here", "no-model", "stopped", "conflict", "error"] as const;
const fixItemSchema = z.object({
  op: z.literal("fix"),
  target: z.string(),
  text: z.string(),
  by: z.string(),
  why: z.literal("wrong"),
  listOnly: z.boolean(),
  evidence: z.object({ thread: z.string(), message: z.string(), at: z.number(), quote: z.string() }),
  done: z.object({ at: z.number(), line: z.number(), cr: z.boolean(), nth: z.number(), count: z.number(), heading: z.string(), id: z.string(), undoneAt: z.number().optional(), view: z.array(z.string()).optional(), putBack: z.object({ at: z.number(), message: z.string() }).optional(), lines: z.string().optional(), prev: z.string().optional(), retired: z.number().optional() }).optional(),
  seen: z.object({ at: z.number(), sha: z.string(), ids: z.string().optional() }).optional(),
  outdated: z.number().optional(),
});
const planSchema = z.object({
  runId: z.string(),
  botId: z.string(),
  at: z.number(),
  mode: z.literal("dry"),
  notes: z.object({ state: z.enum(NOTES_STATES), items: z.array(noteItemSchema) }),
  asks: z.object({ threads: z.number(), skipped: z.number(), unchecked: z.number(), items: z.array(askItemSchema) }),
  // through: the newest owner line checked; the next pass reads only lines after it
  fixes: z.object({ state: z.enum(FIX_STATES), through: z.number(), items: z.array(fixItemSchema) }).optional(),
  runUntil: z.number(),
  dropUntil: z.number(),
});
const manifestSchema = z.object({ runId: z.string(), botId: z.string(), at: z.number(), items: z.array(askItemSchema) });

export type DreamPlan = z.infer<typeof planSchema>;
export type AskItem = z.infer<typeof askItemSchema>;
export type NoteItem = z.infer<typeof noteItemSchema>;
export type DreamAsks = DreamPlan["asks"];
export type DryNotes = { state: (typeof NOTES_STATES)[number]; moves: Move[] };
export type DreamFixes = NonNullable<DreamPlan["fixes"]>;
export type DryFixes = DreamFixes & { pairs?: number; bytes?: number; judges?: Partial<Record<keyof DreamJudges, JudgeLog>>; reason?: string };
export type FixResult = { ok: true; revision: string } | { ok: false; error: "no-run" | "not-newest" | "no-item" | "list-only" | "done" | "undone" | "changed" | "conflict" | "outdated" | "busy" };

export interface DreamLiveDeps {
  dataDir: string;
  pc(): string;
  /** The bot's owner chats on this PC: asks live per PC. */
  threads(botId: string): string[];
  /** The packet as the next write would see it, pending buffer included. */
  packet(threadId: string): TaskResumePacket | null;
  busy(botId: string, threadId: string): boolean;
  /** Reads the repos the bot's asks and reports cite, so a bare "PR n" can be placed. */
  cite(botId: string): Promise<void>;
  merged(botId: string, threadId: string, ask: TaskAsk, start: boolean): MergedPr[] | null | undefined;
  /** The chat's user rows, any kind, and Auto Notes receipts from `since` on. */
  rows(threadId: string, since: number): Message[];
  /** Every user row of the chat, whatever its time, with its place in the store. */
  stored(threadId: string): UserMark[];
  /** The ids of every row under this one by parent links. */
  under(threadId: string, id: string): string[];
  /** Whether a send from this bot's owner was taken and still waits to reach the chat. */
  waiting(botId: string): boolean;
  /** Resolves once every gh check started so far has finished. */
  checked(): Promise<void>;
  /** After a fresh look at the thread's repo: whether a revert there undid this PR. */
  reverted(botId: string, threadId: string): Promise<(pr: number) => boolean>;
  now?(): number;
}

function readJson<T extends z.ZodType>(path: string, schema: T): z.output<T> | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
const clean = (text: string) => redactRoomMemory(text);
// a note that may hold a login or code is listed, never copied
const copy = (text: string) => cleanerSkip(text) ? null : clean(text);
const parked = (ask: TaskAsk, now: number) => ask.until !== undefined && ask.until > now;

/** Asks whose ref names PRs and no step left: building ones the pass closes, open ones it only asks about. */
function candidates(packet: TaskResumePacket | null, now: number): TaskAsk[] {
  return (packet?.asks ?? []).filter((ask) => (ask.status === "building" || ask.status === "open") && ask.kind !== "question" && !parked(ask, now) && refPrs(ask.ref).length > 0 && !stepLeft(ask.ref));
}

/** Where each closed ask would land: the save's 16 KB budget drops closed asks first, and past the 40-ask cap the bot's next update trims the oldest closed. */
export function landings(packet: TaskResumePacket, ids: readonly string[], now: number) {
  // SAFETY: serializeBounded writes a normalized packet, so its JSON parses back to one
  const savedIds = (asks: TaskAsk[] | undefined) => new Set((JSON.parse(serializeBounded(normalize({ ...packet, asks }))) as TaskResumePacket).asks?.map((ask) => ask.id));
  const asks = withClosed(packet.asks, ids, now);
  const before = savedIds(packet.asks?.map((ask) => ({ ...ask })));
  const after = savedIds(asks);
  const next = new Set(trimClosed(asks.filter((ask) => after.has(ask.id)).map((ask) => ({ ...ask }))).map((ask) => ask.id));
  return {
    lands: (id: string) => !after.has(id) ? "leaves-now" as const : next.has(id) ? "leaves-next" as const : "stays" as const,
    fallOut: (packet.asks ?? []).filter((ask) => !isOpenAsk(ask) && before.has(ask.id) && !after.has(ask.id)),
  };
}

const prsOf = (prs: readonly MergedPr[]) => prs.map(({ repo, number, mergedAt }) => {
  const pr: DreamPlan["asks"]["items"][number]["prs"][number] = { number, mergedAt: mergedAt ?? 0 };
  if (repo) pr.repo = repo;
  return pr;
});

export function createDreamLive(deps: DreamLiveDeps) {
  const now = deps.now ?? Date.now;
  const botDir = (botId: string) => join(deps.dataDir, RUNS_DIR, botId);
  const runs = (botId: string) => {
    try {
      return readdirSync(botDir(botId)).filter((name) => /^[0-9a-f]{8}$/.test(name));
    } catch {
      return [];
    }
  };
  const plans = (botId: string) => runs(botId).flatMap((runId) => {
    const plan = readJson(join(botDir(botId), runId, "plan.json"), planSchema);
    return plan?.botId === botId ? [plan] : [];
  }).sort((left, right) => right.at - left.at);

  const live = (botId: string) => readJson(join(deps.dataDir, DREAM_FILE), modeFileSchema)?.bots[botId] === "live";

  async function asks(botId: string, signal: AbortSignal): Promise<DreamAsks | null> {
    await deps.cite(botId);
    const threads = deps.threads(botId);
    const at = now();
    // every gh check first, so no thread's stretch waits on one
    for (const threadId of threads) for (const ask of candidates(deps.packet(threadId), at)) deps.merged(botId, threadId, ask, true);
    await deps.checked();
    const plan: DreamAsks = { threads: threads.length, skipped: 0, unchecked: 0, items: [] };
    for (const threadId of threads) {
      if (signal.aborted) return null;
      const undid = await deps.reverted(botId, threadId);
      if (signal.aborted) return null;
      // one synchronous stretch from here: what the busy check saw is what the packet read sees
      if (deps.busy(botId, threadId)) {
        plan.skipped += 1;
        continue;
      }
      const packet = deps.packet(threadId);
      if (!packet) continue;
      const closing: { ask: TaskAsk; prs: MergedPr[] }[] = [];
      for (const ask of candidates(packet, at)) {
        const prs = deps.merged(botId, threadId, ask, false);
        if (prs === undefined) plan.unchecked += 1;
        // merged after the ask last changed, and not reverted since
        if (!prs || prs.some((pr) => (pr.mergedAt ?? 0) <= ask.changedAt || undid(pr.number))) continue;
        if (ask.status === "building") closing.push({ ask, prs });
        else plan.items.push({ op: "ask", target: `ask:${threadId}:${ask.id}`, ask: clean(ask.ask), prs: prsOf(prs) });
      }
      if (!closing.length) continue;
      let landed: ReturnType<typeof landings>;
      try {
        landed = landings(packet, closing.map(({ ask }) => ask.id), at);
      } catch {
        // a packet past its storage limit fails its next save the same way
        plan.skipped += 1;
        continue;
      }
      for (const { ask, prs } of closing) {
        const shown = { ...ask, ask: clean(ask.ask) };
        if (ask.ref) shown.ref = clean(ask.ref);
        plan.items.push({ op: "close", target: `ask:${threadId}:${ask.id}`, ask: shown.ask, prs: prsOf(prs), lands: landed.lands(ask.id), notice: closedAskLine(shown), told: false });
      }
      for (const ask of landed.fallOut) plan.items.push({ op: "fall-out", target: `ask:${threadId}:${ask.id}`, ask: clean(ask.ask), prs: [], lands: "leaves-now", closedAt: ask.changedAt });
    }
    return plan;
  }

  async function fixes(botId: string, judges: DreamJudges | null, signal: AbortSignal): Promise<DryFixes> {
    settle(botId);
    const at = now();
    const through = plans(botId).find((each) => each.fixes?.state === "checked")?.fixes?.through ?? at - RUN_KEEP_MS;
    const raw = memoryFileRaw(botId);
    // receipts from the start of that day: a note stamped the same day as a line is ordered by when it was saved
    const since = new Date(through).setHours(0, 0, 0, 0);
    const rows: OwnerRow[] = [];
    const saved: SavedNotes[] = [];
    for (const threadId of deps.threads(botId)) {
      const messages = deps.rows(threadId, since);
      rows.push(...ownerRows(threadId, messages, through));
      saved.push(...savedNotes(messages));
    }
    if (!judges) return { state: "off-here", through, items: [] };
    rows.sort((left, right) => left.at - right.at);
    // nothing typed since the last pass: no judge reads, and the store is not walked
    const before = rows.length ? owned(botId) : undefined;
    try {
      const newest = before && !before.waiting ? newestOwned(before.rows, deps.under) : undefined;
      const checked = await checkWrong({ raw, rows, newest, ids: before?.ids ?? "", owned: before?.rows ?? [], saved, judges, today: pickStamp(at).slice(0, 10), signal, now });
      const fields: Omit<DryFixes, keyof DreamFixes> = { pairs: checked.pairs, bytes: checked.bytes, judges: checked.logs };
      if (checked.reason) fields.reason = checked.reason;
      if (memoryFileRaw(botId) !== raw) return { state: "conflict", through, items: [], ...fields };
      // a message the owner typed or sent while the judges read makes what they found stale
      const after = checked.items.length ? owned(botId) : undefined;
      const items = after && !after.waiting && after.ids === before?.ids ? checked.items : [];
      return { state: checked.state, through: checked.state === "checked" ? at : through, items, ...fields };
    } catch {
      return { state: signal.aborted ? "stopped" : "error", through, items: [] };
    }
  }

  // the owner's messages in the bot's chats as the store holds them now, whatever their time, and whether a send of theirs still waits
  function owned(botId: string) {
    const threads = deps.threads(botId);
    const rows = threads.flatMap((thread) => deps.stored(thread).map((row) => ({ ...row, thread })));
    return { threads, rows, ids: ownedIds(rows), waiting: deps.waiting(botId) };
  }

  // stale once the owner's messages are not the exact set the judges saw or one waits to send, whatever it says; a fix with no record of that is stale too
  const fresh = (item: FixItem, now: ReturnType<typeof owned>) => !!item.seen?.ids && item.seen.ids === now.ids && !now.waiting && now.threads.includes(item.evidence.thread);

  // the last plan's fixes stay listed until their line ages out, an OK'd one counted from its OK; a waiting one goes once its note changed or the owner wrote or sent anything after it was judged
  function carried(botId: string, at: number, found: DryFixes): FixItem[] {
    const raw = memoryFileRaw(botId).split("\n").map((line) => line.replace(/\r$/, ""));
    const last = plans(botId)[0]?.fixes?.items ?? [];
    const now = last.some((item) => !item.done) ? owned(botId) : undefined;
    const kept = last.filter((item) => (item.done?.at ?? item.evidence.at) > at - RUN_KEEP_MS && (item.done || (!!now && fresh(item, now) && raw.some((line) => `note:${sha8(line)}` === item.target) && !found.items.some((each) => each.target === item.target))));
    return [...kept, ...found.items.filter((item) => !kept.some((each) => each.target === item.target))];
  }

  function sweep(botId: string, keep: string) {
    for (const plan of plans(botId)) {
      if (plan.runId !== keep && now() - plan.at > RUN_KEEP_MS) rmSync(join(botDir(botId), plan.runId), { recursive: true, force: true });
    }
  }

  function plan(botId: string, at: number, notes: DryNotes, asked: DreamAsks, found?: DryFixes): DreamPlan {
    const runId = runIdOf(deps.pc(), botId, at);
    const archive = DREAMED_FILE;
    // MEMORY.md has not changed since the last checked plan, so its moves still stand; a pass that skipped notes in between saved none
    const items: NoteItem[] = notes.state === "unchanged"
      ? (plans(botId).find((each) => each.notes.state === "checked" || each.notes.state === "unchanged")?.notes.items ?? []).map((item) => ({ ...item, history: archive }))
      : notes.moves.map((move) => ({ op: "move", target: `note:${sha8(move.text)}`, text: copy(move.text), by: copy(move.by), why: move.why, history: archive }));
    const saved: DreamPlan = { runId, botId, at, mode: "dry", notes: { state: notes.state, items }, asks: asked, runUntil: at + RUN_KEEP_MS, dropUntil: at + DROPPED_KEEP_MS };
    if (found) saved.fixes = { state: found.state, through: found.through, items: carried(botId, at, found) };
    const dir = join(botDir(botId), runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, "plan.json"), `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    sweep(botId, runId);
    return saved;
  }

  // the fix's line is still the one the judges read whole, and the owner wrote or sent nothing in the bot's chats since
  function stands(botId: string, item: FixItem) {
    const { thread, message, at } = item.evidence;
    const own = ownerRows(thread, deps.rows(thread, at), at - 1).find((row) => row.id === message);
    return !!own?.whole && sha8(own.text) === item.seen?.sha && fresh(item, owned(botId));
  }

  const writePlan = (botId: string, plan: DreamPlan) => writeFileAtomic(join(botDir(botId), plan.runId, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });

  // the plan says what changed before MEMORY.md does, so a line that changed always has its Undo; a save that fails takes the plan back
  function stage(botId: string, plan: DreamPlan, changes: readonly (readonly [FixItem, FixDone])[], raw: string, text: string) {
    const before = changes.map(([item]) => item.done);
    for (const [item, next] of changes) item.done = next;
    writePlan(botId, plan);
    let saved = false;
    try {
      saved = !saveMemoryFile(botId, text, rawRevision(raw)).conflict;
    } finally {
      if (!saved) {
        changes.forEach(([item], at) => (item.done = before[at]));
        writePlan(botId, plan);
      }
    }
    return saved;
  }

  function markArchive(botId: string, mark: (text: string) => string) {
    try {
      const path = dreamedPath(botId);
      writeFileAtomic(path, mark(readFileSync(path, "utf8")), { mode: 0o600 });
    } catch {
      // the line is back either way; the heading only says so
    }
  }

  // the owner rows an OK stood on: from a day before the evidence, so a peer clock running behind still counts, up to the OK; a held send counts from when the owner acted
  const inView = (row: StoredRow, item: FixItem, at: number) => {
    const acted = row.actedAt ?? row.at;
    return ownerTyped(row) && Math.max(row.at, acted) >= item.evidence.at - DAY && Math.min(row.at, acted) <= at;
  };
  const viewKey = (row: StoredRow) => `${row.thread}\0${row.id}`;

  // the OK's own check over rows typed up to it: its evidence gone or changed, or an owner row it did not see
  function unseen(item: FixItem, rows: readonly StoredRow[]): string | undefined {
    const { thread, message, at } = item.evidence;
    const own = ownerRows(thread, deps.rows(thread, at), at - 1).find((row) => row.id === message);
    if (!own || sha8(own.text) !== item.seen?.sha) return message;
    const view = new Set(item.done!.view);
    return rows.find((row) => inView(row, item, item.done!.at) && !view.has(viewKey(row)))?.id;
  }

  /** Puts OK'd fixes' old bytes back once an owner line typed before an OK reaches this PC, as if it had landed first; true when MEMORY.md changed. */
  function settle(botId: string): boolean {
    const newest = plans(botId)[0];
    const active = newest?.fixes?.items.filter((item) => item.done?.lines !== undefined && item.done.view && item.done.undoneAt === undefined && item.done.retired === undefined) ?? [];
    if (!newest || !active.length) return false;
    const { rows } = owned(botId);
    const at = now();
    const later = new Set(active.flatMap((item) => item.done!.prev ?? []));
    let changed = false;
    let retired = false;
    for (const last of active.filter((item) => !later.has(item.done!.id))) {
      // the note's OKs oldest first: each changed the line the one before it wrote
      const chain = [last];
      for (let prev = last.done!.prev; prev !== undefined; ) {
        const item = active.find((each) => each.done!.id === prev);
        if (!item) break;
        chain.unshift(item);
        prev = item.done!.prev;
      }
      const raw = memoryFileRaw(botId);
      const line = fixedLine(raw, last);
      if (line === undefined) {
        // the owner changed that line since: MEMORY.md stays as they left it, now and later
        for (const item of chain) item.done = { ...item.done!, retired: at };
        retired = true;
        continue;
      }
      // the oldest OK a line it did not see takes back: the note goes back to what it was before that one
      const messages = chain.map((item) => unseen(item, rows));
      const first = messages.findIndex((message) => message !== undefined);
      if (first < 0) continue;
      const lines = raw.split("\n");
      lines[line] = chain[first]!.text + (chain[first]!.done!.cr ? "\r" : "");
      const back = chain.slice(first).map((item, index) => [item, { ...item.done!, undoneAt: at, putBack: { at, message: messages[first + index] ?? messages[first]! } }] as const);
      if (!stage(botId, newest, back, raw, lines.join("\n"))) continue;
      for (const [, done] of back) markArchive(botId, (text) => markPutBack(text, done.id, at));
      changed = true;
    }
    if (retired) writePlan(botId, newest);
    return changed;
  }

  /** The user's OK on one fix, or its Undo: OK swaps the note's line for the fix and archives the old line; Undo puts the old bytes back. */
  function fix(botId: string, runId: string, target: string, undo: boolean): FixResult {
    const newest = live(botId) ? undefined : plans(botId)[0];
    if (!newest) return { ok: false, error: "no-run" };
    if (newest.runId !== runId) return { ok: false, error: "not-newest" };
    const item = newest.fixes?.items.find((each) => each.target === target);
    if (!item) return { ok: false, error: "no-item" };
    const raw = memoryFileRaw(botId);
    const at = now();
    if (!undo) {
      if (item.listOnly) return { ok: false, error: "list-only" };
      // once undone an item stays undone: a late OK from another window never puts the fix back
      if (item.done) return { ok: false, error: item.done.undoneAt === undefined ? "done" : "undone" };
      if (item.outdated !== undefined) return { ok: false, error: "outdated" };
      if (!stands(botId, item)) {
        item.outdated = at;
        writePlan(botId, newest);
        return { ok: false, error: "outdated" };
      }
      const swapped = applyFix(raw, item);
      if (!swapped) return { ok: false, error: "changed" };
      const { text, ...placed } = swapped;
      const id = sha8(`${runId}\0${target}\0${at}`);
      const view = owned(botId).rows.filter((row) => inView(row, item, at)).map(viewKey);
      const done: FixDone = { at, id, ...placed, view, lines: lineMarks(text) };
      // the line an earlier OK wrote: the two settle together
      const prev = newest.fixes!.items.find((each) => each !== item && each.done?.undoneAt === undefined && each.done?.retired === undefined && fixedLine(raw, each) === placed.line)?.done!.id;
      if (prev) done.prev = prev;
      const unarchive = appendArchive(dreamedPath(botId), fixedEntry(id, item, placed.line, at));
      let saved = false;
      try {
        saved = stage(botId, newest, [[item, done]], raw, text);
      } finally {
        if (!saved) unarchive();
      }
      if (!saved) return { ok: false, error: "busy" };
    } else {
      if (!item.done || item.done.undoneAt !== undefined) return { ok: false, error: "undone" };
      const back = undoFix(raw, item);
      if ("error" in back) return { ok: false, error: back.error };
      const { id } = item.done;
      if (!stage(botId, newest, [[item, { ...item.done, undoneAt: at }]], raw, back.text)) return { ok: false, error: "busy" };
      markArchive(botId, (text) => markUndone(text, id, at));
    }
    return { ok: true, revision: readMemoryFile(botId).revision };
  }

  return {
    live,
    asks,
    fixes,
    plan,
    fix,
    settle,
    /** The newest plan on this PC as the Memory row reads it; null for a bot set to live. */
    latest(botId: string) {
      const newest = live(botId) ? undefined : plans(botId)[0];
      if (!newest) return null;
      return { runId: newest.runId, at: newest.at, files: [], beforeBytes: 0, afterBytes: 0, merged: 0, replaced: 0, moved: 0, undoneAt: null, undoable: false, dream: { mode: newest.mode, notes: newest.notes, asks: newest.asks, fixes: newest.fixes, runUntil: newest.runUntil, dropUntil: newest.dropUntil } };
    },
    /** Close lines a live pass owes this thread and has not told yet, read from its run manifests. */
    owed(botId: string, threadId: string): { runId: string; target: string; line: string }[] {
      return runs(botId).flatMap((runId) => {
        const manifest = readJson(join(botDir(botId), runId, "manifest.json"), manifestSchema);
        return (manifest?.items ?? []).flatMap((item) => item.op === "close" && item.notice && !item.told && item.target.startsWith(`ask:${threadId}:`) ? [{ runId, target: item.target, line: item.notice }] : []);
      });
    },
    /** Marks these owed lines told, on disk. */
    told(botId: string, runId: string, targets: readonly string[]): void {
      const path = join(botDir(botId), runId, "manifest.json");
      const manifest = readJson(path, manifestSchema);
      if (!manifest) return;
      const items = manifest.items.map((item) => targets.includes(item.target) ? { ...item, told: true } : item);
      writeFileAtomic(path, `${JSON.stringify({ ...manifest, items }, null, 2)}\n`, { mode: 0o600 });
    },
  };
}

export type DreamLive = ReturnType<typeof createDreamLive>;

/** Put-back off the send path: an import queues it for the loop's next turn, and a turn starting on that bot runs it before it reads its notes. starting: a turn start holds that bot's. */
export function createSettleQueue(settle: (botId: string) => void, starting: (botId: string) => boolean) {
  const pending = new Set<string>();
  let queued = false;
  const drain = () => {
    queued = false;
    for (const botId of pending) {
      if (starting(botId)) continue;
      pending.delete(botId);
      settle(botId);
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    setImmediate(drain);
  };
  return {
    queue(botId: string) {
      pending.add(botId);
      schedule();
    },
    /** Runs the bot's queued put-back now: its turn reads its notes next. */
    flush(botId: string) {
      if (pending.delete(botId)) settle(botId);
    },
    /** A turn start ended: a put-back it held runs on the loop's next turn. */
    released(botId: string) {
      if (pending.has(botId)) schedule();
    },
  };
}
