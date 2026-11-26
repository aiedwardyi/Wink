// Dreaming: the idle pass for every bot. Dry is the default: the pass writes what it would move or close to plan.json and changes
// nothing else. Only a bot D/dream-live.json sets to "live" moves lines; no file, a file that does not parse or no entry is dry.
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { DREAMED_FILE } from "./dream-archive.ts";
import { closedAskLine, refPrs, stepLeft, withClosed, type MergedPr } from "./ask-prs.ts";
import { writeFileAtomic } from "./atomic.ts";
import { cleanerSkip, runIdOf, sha8 } from "./memory-clean.ts";
import type { Move } from "./memory-sleep.ts";
import { redactRoomMemory } from "./redact.ts";
import { isOpenAsk, trimClosed, type TaskAsk } from "./task-asks.ts";
import { DROPPED_KEEP_MS } from "./task-dropped.ts";
import { normalize, serializeBounded, type TaskResumePacket } from "./task-state.ts";

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
const planSchema = z.object({
  runId: z.string(),
  botId: z.string(),
  at: z.number(),
  mode: z.literal("dry"),
  notes: z.object({ state: z.enum(NOTES_STATES), items: z.array(noteItemSchema) }),
  asks: z.object({ threads: z.number(), skipped: z.number(), unchecked: z.number(), items: z.array(askItemSchema) }),
  runUntil: z.number(),
  dropUntil: z.number(),
});
const manifestSchema = z.object({ runId: z.string(), botId: z.string(), at: z.number(), items: z.array(askItemSchema) });

export type DreamPlan = z.infer<typeof planSchema>;
export type AskItem = z.infer<typeof askItemSchema>;
export type NoteItem = z.infer<typeof noteItemSchema>;
export type DreamAsks = DreamPlan["asks"];
export type DryNotes = { state: (typeof NOTES_STATES)[number]; moves: Move[] };

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

  function sweep(botId: string, keep: string) {
    for (const plan of plans(botId)) {
      if (plan.runId !== keep && now() - plan.at > RUN_KEEP_MS) rmSync(join(botDir(botId), plan.runId), { recursive: true, force: true });
    }
  }

  function plan(botId: string, at: number, notes: DryNotes, asked: DreamAsks): DreamPlan {
    const runId = runIdOf(deps.pc(), botId, at);
    const archive = DREAMED_FILE;
    // MEMORY.md has not changed since the last checked plan, so its moves still stand; a pass that skipped notes in between saved none
    const items: NoteItem[] = notes.state === "unchanged"
      ? (plans(botId).find((each) => each.notes.state === "checked" || each.notes.state === "unchanged")?.notes.items ?? []).map((item) => ({ ...item, history: archive }))
      : notes.moves.map((move) => ({ op: "move", target: `note:${sha8(move.text)}`, text: copy(move.text), by: copy(move.by), why: move.why, history: archive }));
    const saved: DreamPlan = { runId, botId, at, mode: "dry", notes: { state: notes.state, items }, asks: asked, runUntil: at + RUN_KEEP_MS, dropUntil: at + DROPPED_KEEP_MS };
    const dir = join(botDir(botId), runId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, "plan.json"), `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    sweep(botId, runId);
    return saved;
  }

  return {
    live,
    asks,
    plan,
    /** The newest plan on this PC as the Memory row reads it; null for a bot set to live. */
    latest(botId: string) {
      const newest = live(botId) ? undefined : plans(botId)[0];
      if (!newest) return null;
      return { runId: newest.runId, at: newest.at, files: [], beforeBytes: 0, afterBytes: 0, merged: 0, replaced: 0, moved: 0, undoneAt: null, undoable: false, dream: { mode: newest.mode, notes: newest.notes, asks: newest.asks, runUntil: newest.runUntil, dropUntil: newest.dropUntil } };
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
