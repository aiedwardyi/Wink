import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { redactSecretsInText } from "./redact.ts";
import { asksBlock, type TaskAsk } from "./task-asks.ts";
import { readContextCompaction } from "../shared/context-compaction.ts";

export interface ReplayMessage {
  role: "user" | "assistant";
  text: string;
  engine?: string;
  speaker?: { botId: string; name: string };
}

// Voice-call provenance is not a chat engine switch.
const REPLAY_ENGINE_NAMES = new Map([
  ["claudeAgent", "Claude"],
  ["codex", "Codex"],
  ["antigravityAgent", "Gemini"],
  ["grokAgent", "Grok"],
  ["museAgent", "Muse"],
]);

export function replayEngineTag(engine?: string, driverKind?: string, model?: string): string {
  const name = engine && REPLAY_ENGINE_NAMES.get(engine);
  // Box selects its engine by model; its driver kind only names the runner.
  const currentEngine = driverKind === "boxAgent" ? (model?.startsWith("gpt") ? "codex" : "claudeAgent") : driverKind;
  return name && currentEngine && engine !== currentEngine ? ` (on ${name})` : "";
}

export function replayMessageText(message: ReplayMessage, driverKind: string, botId?: string, model?: string): string {
  if (message.role !== "assistant" || (botId && message.speaker?.botId !== botId)) return message.text;
  const tag = replayEngineTag(message.engine, driverKind, model);
  if (!tag) return message.text;
  const speaker = message.speaker?.name;
  const prefix = speaker ? `${speaker}: ` : "";
  return speaker && message.text.startsWith(prefix)
    ? `${speaker}${tag}: ${message.text.slice(prefix.length)}`
    : `${tag.trimStart()} ${message.text}`;
}

function replayLine(message: ReplayMessage, driverKind?: string, model?: string): string {
  return `${message.role === "user" ? "User" : `Assistant${replayEngineTag(message.engine, driverKind, model)}`}: ${message.text}`;
}

// Building the text a driver actually receives. Three situations force an
// inline replay of the active branch: a rewind (the visible branch
// changed), a fresh engine (this instance has no session here — the user
// switched the bot's model mid-thread), and a recycled session (Orbit
// compacted the thread, or a pre-compact soak fattened the native CLI
// session with tool payloads). They coincide today but are distinct
// markers on purpose: rewound also invalidates OTHER instances' cursors;
// recycle drops this task's cursors so the next turn injects summary+tail
// (or the still-uncompacted Orbit transcript).
export interface TurnContextInput {
  /** the user's new message */
  text: string;
  /** settled text turns on the active branch, oldest first, capped upstream */
  transcript: ReplayMessage[];
  driverKind?: string;
  model?: string;
  /** the visible branch changed (edit / version switch) */
  rewound: boolean;
  /** this driver instance has no session cursor for this thread */
  fresh: boolean;
  /**
   * The native provider session must not be resumed: Orbit compacted the
   * thread, or a pre-compact soak fattened the CLI session with tool
   * payloads. CLI `--resume` would re-send that fat history.
   */
  recycled?: boolean;
  /**
   * Why the provider session is being recycled. Compaction keeps the PR 70
   * preamble; a pre-first-compact fat soak uses a distinct session-bound
   * marker so the model is not told a summary exists when it does not.
   * `system`: the system text changed too much for a reminder.
   */
  recycleReason?: "compaction" | "session-fat" | "system";
  /** transcript-replay drivers get history via SendTurnInput.transcript instead */
  replaysNatively: boolean;
  /** durable harness state, included only at a recovery boundary */
  taskRecord?: TaskRecordContext;
  /** Pre-sized durable state for the selected model window. */
  taskRecordText?: string;
  /** the session has not held the latest summary: built this turn, or landed since its seed */
  contextCapped?: boolean;
  /** the prior process or user stop ended the running turn */
  recovering?: boolean;
  /** the request this turn must answer; the transcript excludes it on a plain send */
  currentRequestText?: string;
  /** the asks list for a turn the record does not ride */
  asksText?: string;
  /** memoryBlock text; rides every turn once the chat has had a fresh session */
  memoryText?: string;
}

export interface TaskRecordContext {
  goal: string;
  plan: Array<{ step: string; status: "pending" | "active" | "done" | "skipped" }>;
  completed: Array<{ note: string }>;
  evidence?: Array<{ kind: string; ref: string; note?: string }>;
  artifacts?: Array<{ ref: string; label: string }>;
  blockers: Array<{ note: string }>;
  nextAction: string;
  asks?: TaskAsk[];
}

/** Does this engine need the thread replayed to it? True when a DIFFERENT
 * instance ran the last turn here — a cursor of our own is not enough,
 * because it only proves we once had a session covering some prefix of the
 * thread; every turn another engine took since is missing from it. Tasks
 * from before `lastInstanceId` existed fall back to the cursor map: a lone
 * cursor that is ours means a single-engine thread we can keep resuming;
 * anything else is ambiguous, and replaying is the safe side of ambiguous.
 * Gated on a prior USER turn: a new bot's thread may only have an
 * onboarding card, and that alone is nothing to join. */
export function engineIsFresh(input: {
  instanceId: string;
  model: string;
  lastInstanceId: string | undefined;
  lastModel: string | undefined;
  sessionModelSwitch: "in-session" | "unsupported";
  resumeCursors: Record<string, unknown>;
  resumeCursor?: boolean;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  hasPriorUserTurn?: boolean;
}): boolean {
  const { instanceId, model, lastInstanceId, lastModel, sessionModelSwitch, resumeCursors, transcript } = input;
  if (!(input.hasPriorUserTurn ?? transcript.some((message) => message.role === "user"))) return false;
  if (input.resumeCursor === false) return true;
  if (lastInstanceId !== undefined) {
    if (lastInstanceId !== instanceId || resumeCursors[instanceId] === undefined) return true;
    return sessionModelSwitch === "unsupported" && lastModel !== undefined && lastModel !== model;
  }
  const cursorIds = Object.keys(resumeCursors);
  return !(cursorIds.length === 1 && cursorIds[0] === instanceId);
}

/**
 * Forever-chat history belongs to Orbit's prepared context once a durable
 * summary exists. Resume-cursor engines (Claude `--resume`, Codex
 * thread/resume, Antigravity `--conversation`, ACP
 * session/load) would otherwise keep growing a provider-side session that
 * ignores that projection.
 *
 * Before the first compact, a long agentic soak can still fatten the
 * native session with full tool payloads while Orbit's own transcript
 * stays cheap (collapsed chips). Recycle on the next user send when the
 * session's own latest prompt passed its budget, for engines that report
 * one. Otherwise when the last turn was tool-heavy, settled tools since the
 * last compact exceed the session budget, or the provider reported native
 * input over half the model window, the same share compaction uses.
 *
 * Stop / crash Continuity still `--resume`s when there is no compaction
 * yet, even if the session is already fat. A rewind already drops resume
 * on its own path.
 */
export const PRE_COMPACT_TOOL_ROUND_LIMIT = 24;
export const PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT = 48;
const NATIVE_SESSION_BUDGET_SHARE = 0.5;
// Well above a fresh session's own first prompt: ~45k of tools and startup
// text plus a replay of up to ~92k.
export const NATIVE_PROMPT_BUDGET_CAP = 250_000;
const NATIVE_PROMPT_GROWTH = 100_000;
// Past this share a reseed costs about what the fat session does.
const RESEED_PROMPT_SHARE = 0.5;

export function nativeSessionTokenBudget(contextWindow: number): number {
  return Number.isSafeInteger(contextWindow) && contextWindow > 0
    ? Math.max(1, Math.floor(contextWindow * NATIVE_SESSION_BUDGET_SHARE))
    : 0;
}

/** Half the window, capped: on a 1M window every call would re-read 500k first. */
export function nativePromptBudget(contextWindow: number): number {
  return Math.min(NATIVE_PROMPT_BUDGET_CAP, nativeSessionTokenBudget(contextWindow));
}

/** Prompt sizes an engine reported for one native session. */
export interface NativePrompt {
  /** the resume cursor of that session */
  cursor: unknown;
  /** its first reported call: tools, startup text and any replay */
  first: number;
  /** its latest call */
  last: number;
  /** the latest call's rise over the one before; older records have none */
  growth?: number;
  /** the window the engine reported, and the model it was reported for */
  window?: { model: string; tokens: number };
}

export interface SessionPrompt {
  first: number;
  last: number;
  contextWindow: number;
}

/** The figures for the session this send would resume, if any describe it. */
export function sessionPromptFor(input: {
  report: NativePrompt | undefined;
  cursor: unknown;
  model: string;
  catalogWindow: number | null;
}): SessionPrompt | undefined {
  const { report } = input;
  if (!report || input.cursor === undefined || report.cursor !== input.cursor) return undefined;
  const contextWindow = (report.window?.model === input.model ? report.window.tokens : null) ?? input.catalogWindow;
  return contextWindow ? { first: report.first, last: report.last, contextWindow } : undefined;
}

/** The window the engine last reported for `model`. */
export function reportedWindow(task: { nativePrompt?: NativePrompt }, model: string): number | null {
  return task.nativePrompt?.window?.model === model ? task.nativePrompt.window.tokens : null;
}

// A session must also outgrow its own first prompt, or a replay that alone
// passes a small window's budget would recycle every send.
function sessionPromptOverBudget({ first, last, contextWindow }: SessionPrompt, reseedTokens?: number): boolean {
  const budget = nativePromptBudget(contextWindow);
  return budget > 0 && last > budget && last - first >= Math.min(NATIVE_PROMPT_GROWTH, Math.floor(budget / 2)) &&
    (reseedTokens === undefined || reseedTokens <= last * RESEED_PROMPT_SHARE);
}

export interface SessionFatMessage {
  id?: string;
  kind?: string;
  role?: string;
  tool?: { ok?: boolean };
  compaction?: unknown;
}

function coveredThroughId(message: SessionFatMessage): string | undefined {
  const read = readContextCompaction({ value: message.compaction });
  return read.status === "valid" ? read.value.coveredThroughId : undefined;
}

function isSettledTool(message: SessionFatMessage): boolean {
  return message.kind === "activity" && message.tool?.ok !== undefined;
}

/** Settled tool chips after the previous user line (the last completed soak)
 *  or the recycle watermark, whichever is later. Pane wakes add no user line. */
export function countLastTurnToolRounds(
  messages: readonly SessionFatMessage[],
  excludeIds?: ReadonlySet<string>,
  boundMessageId?: string,
): number {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.id && excludeIds?.has(message.id)) continue;
    if (message.kind === "text" && message.role === "user") break;
    if (boundMessageId && message.id === boundMessageId) break;
    if (isSettledTool(message)) count++;
  }
  return count;
}

/** Settled tool chips after the latest compaction marker or recycle
 *  watermark (`boundMessageId`). Without the watermark a front-loaded
 *  soak would keep recycling every later send until Orbit compacted. */
export function countSessionToolRounds(
  messages: readonly SessionFatMessage[],
  excludeIds?: ReadonlySet<string>,
  boundMessageId?: string,
): number {
  let start = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.kind !== "compaction") continue;
    // A repair re-covers an earlier row's span; the session it would restart never saw it.
    const covered = coveredThroughId(message);
    if (covered !== undefined && messages.slice(0, index).some((earlier) => earlier.kind === "compaction" && coveredThroughId(earlier) === covered)) {
      continue;
    }
    start = index + 1;
    break;
  }
  if (boundMessageId) {
    const boundIndex = messages.findIndex((message) => message.id === boundMessageId);
    if (boundIndex >= 0) start = Math.max(start, boundIndex + 1);
  }
  let count = 0;
  for (let index = start; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.id && excludeIds?.has(message.id)) continue;
    if (isSettledTool(message)) count++;
  }
  return count;
}

export function shouldRecycleProviderSession(input: {
  compacted: boolean;
  rewound?: boolean;
  recovering?: boolean;
  lastTurnToolRounds?: number;
  sessionToolRounds?: number;
  lastTurnInputTokens?: number;
  nativeTokenBudget?: number;
  /** the session's own prompt sizes; they replace the tool-count rules */
  sessionPrompt?: SessionPrompt;
  /** the engine compacts its own session, so a Wink summary leaves it running */
  native?: boolean;
  /** what a reseed would replay */
  reseedTokens?: number;
}): boolean {
  if (input.rewound) return false;
  // Compaction always forces a recycle regardless of recovery state: a
  // recovered session that was then compacted must start fresh.
  if (input.compacted && !input.native) return true;
  if (input.recovering) return false;
  if (input.sessionPrompt) return sessionPromptOverBudget(input.sessionPrompt, input.reseedTokens);
  if ((input.lastTurnToolRounds ?? 0) >= PRE_COMPACT_TOOL_ROUND_LIMIT) return true;
  if ((input.sessionToolRounds ?? 0) >= PRE_COMPACT_SESSION_TOOL_ROUND_LIMIT) return true;
  const budget = input.nativeTokenBudget ?? 0;
  return budget > 0 && (input.lastTurnInputTokens ?? 0) > budget;
}

/** The session a turn certified: the summary id (null: none) the provider
 * accepted into `cursor` on `instanceId`. */
export interface ResumeSeed {
  instanceId: string;
  cursor: unknown;
  compactionId: string | null;
}

/** A cursor is resumable only once the provider accepted a prompt carrying the
 * thread's current summary into that very session. A session that failed
 * before its prompt, another instance's certification, or a seed that
 * predates the newest summary would otherwise resume without Orbit's context.
 * A grown window replaces the summary with the original history, so the
 * session must have been seeded with that (no summary) instead. Absent seed
 * (tasks from before seeds existed included): replay once. */
export function resumeSessionUnseeded(input: {
  instanceId: string;
  cursor: unknown;
  seed: ResumeSeed | undefined;
  latestCompactionId: string | null;
  expanded?: boolean;
  /** rows the latest one repaired; a session seeded on one already holds that span */
  supersededIds?: ReadonlySet<string>;
  /** the session holds the history any later summary covers */
  native?: boolean;
}): boolean {
  if (input.cursor === undefined) return false;
  const { seed } = input;
  if (!seed || seed.instanceId !== input.instanceId || seed.cursor !== input.cursor) return true;
  if (input.native && !(input.expanded && seed.compactionId !== null)) return false;
  const expected = input.expanded ? null : input.latestCompactionId;
  if (seed.compactionId === expected) return false;
  return !(expected !== null && seed.compactionId !== null && input.supersededIds?.has(seed.compactionId));
}

/** A resumed session still holds the summary it was seeded with, so a repair of
 * that summary is certified only by a turn whose prompt replayed it. */
export function turnSeedCompactionId(input: {
  replayed: boolean;
  instanceId: string;
  cursor: unknown;
  seed: ResumeSeed | undefined;
  sessionCompactionId: string | null;
  supersededIds: ReadonlySet<string>;
}): string | null {
  const { seed } = input;
  if (input.replayed || !seed || seed.instanceId !== input.instanceId || seed.cursor !== input.cursor) {
    return input.sessionCompactionId;
  }
  return seed.compactionId !== null && input.supersededIds.has(seed.compactionId) ? seed.compactionId : input.sessionCompactionId;
}

/** A turn certifies only the session it ran on: the cursor it resumed, or the
 * one its own session.started set, on its own instance. A late session.started
 * from a stopped turn can move the task's cursor underneath a live one. */
export function turnSeedsSession(input: {
  ok: boolean;
  interrupted: boolean;
  promptAccepted?: boolean;
  seed: { instanceId: string; cursor: unknown };
  eventInstanceId?: string;
  currentCursor: unknown;
}): boolean {
  if (!input.promptAccepted && !(input.ok && !input.interrupted)) return false;
  if (input.eventInstanceId !== undefined && input.eventInstanceId !== input.seed.instanceId) return false;
  return input.seed.cursor !== undefined && input.seed.cursor === input.currentCursor;
}

export type TurnSeed<T = ResumeSeed> = T & {
  /** the adapter's id for the dispatch, once sendTurn returned it */
  turnId?: string;
};

/** Thread -> what its running 1:1 turn certifies on completion. Each entry
 * belongs to the dispatch that set it: a stopped dispatch's cleanup or late
 * completion must not drop or consume its replacement's entry. */
export class TurnSeeds<T extends { instanceId: string; cursor: unknown } = ResumeSeed> {
  private readonly byThread = new Map<string, TurnSeed<T>>();

  set(threadId: string, seed: T): TurnSeed<T> {
    const entry: TurnSeed<T> = { ...seed };
    this.byThread.set(threadId, entry);
    return entry;
  }

  get(threadId: string): TurnSeed<T> | undefined {
    return this.byThread.get(threadId);
  }

  /** Drop `entry` only while it is still the thread's current seed. */
  release(threadId: string, entry: TurnSeed<T>): void {
    if (this.byThread.get(threadId) === entry) this.byThread.delete(threadId);
  }

  /** Consume the seed of the turn that completed; another dispatch's stays. */
  take(threadId: string, turnId: string | undefined): TurnSeed<T> | undefined {
    const entry = this.byThread.get(threadId);
    if (!entry || turnId === undefined || entry.turnId !== turnId) return undefined;
    this.byThread.delete(threadId);
    return entry;
  }
}

/** Cap on the changed lines' characters; past it the session recycles instead. */
export const SYSTEM_REMINDER_MAX_CHARS = 12_000;
// Most of Wink's guidance is one long line; split such lines at sentence
// ends so one changed rule does not resend the rest.
const SYSTEM_LINE_SPLIT_CHARS = 2_000;
const SYSTEM_REMINDER_HEADER =
  "[Wink instructions update - your system prompt changed after this session started. Removed lines no longer apply; added lines are current and win over anything older.]";

function systemLines(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trimEnd();
      return trimmed.length > SYSTEM_LINE_SPLIT_CHARS ? trimmed.split(/(?<=[.!?])\s+/) : [trimmed];
    })
    .filter((line) => line.trim());
}

function retainedLinesReordered(before: string[], after: string[]): boolean {
  const oldLines = new Set(before);
  const newLines = new Set(after);
  const retainedBefore = before.filter((line) => newLines.has(line));
  const retainedAfter = after.filter((line) => oldLines.has(line));
  return retainedBefore.length !== retainedAfter.length
    || retainedBefore.some((line, index) => line !== retainedAfter[index]);
}

export function systemLinesReordered(delivered: string, system: string): boolean {
  return retainedLinesReordered(systemLines(delivered), systemLines(system));
}

/** Lines of `from` that `other` does not also hold, in `from`'s order. */
function linesOnlyIn(from: string[], other: string[]): string[] {
  const left = new Map<string, number>();
  for (const line of other) left.set(line, (left.get(line) ?? 0) + 1);
  return from.filter((line) => {
    const count = left.get(line) ?? 0;
    left.set(line, count - 1);
    return count <= 0;
  });
}

/** A resumed session keeps the system text it started with. Prepends what
 * changed since `delivered` to this turn's text; null when the change is
 * too big for that and the session should recycle instead. */
export function withSystemChanges(
  text: string,
  delivered: string | undefined,
  system: string,
  maxChars = SYSTEM_REMINDER_MAX_CHARS,
): string | null {
  if (delivered === undefined || delivered === system) return text;
  const before = systemLines(delivered);
  const after = systemLines(system);
  const reordered = retainedLinesReordered(before, after);
  const removed = reordered ? before : linesOnlyIn(before, after);
  const added = reordered ? after : linesOnlyIn(after, before);
  if (!removed.length && !added.length) return text;
  if ([...removed, ...added].reduce((sum, line) => sum + line.length, 0) > maxChars) return null;
  // Untagged, Haiku kept the stale system prompt in about half of real-CLI
  // trials; the CLI's own prompt treats tags in a user message as system info.
  return [
    "<system-reminder>",
    SYSTEM_REMINDER_HEADER,
    ...(removed.length ? ["[Removed:]", ...removed] : []),
    ...(added.length ? ["[Added:]", ...added] : []),
    "</system-reminder>",
    "",
    text,
  ].join("\n");
}

export function systemTurnInput(text: string, updated: string, driverKind: string) {
  return driverKind === "codex"
    ? { text, systemUpdate: updated.slice(0, updated.length - text.length) }
    : { text: updated, systemUpdate: "" };
}

const REWOUND_PREAMBLE =
  "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]";
const FRESH_PREAMBLE =
  "[You are joining this conversation mid-thread (the user switched this bot over to you). The conversation so far:]";
const RECYCLED_PREAMBLE =
  "[Wink compacted this conversation to keep the provider session bounded. Session-start reads already ran in this chat; reread a file only when the task needs it. The conversation so far:]";
const SESSION_FAT_PREAMBLE =
  "[Wink started a fresh provider session to keep tool history bounded. Session-start reads already ran in this chat; reread a file only when the task needs it. The conversation so far:]";
const SYSTEM_CHANGED_PREAMBLE =
  "[Wink started a fresh provider session because your instructions changed. The conversation so far:]";

function replayPreamble(input: TurnContextInput): string {
  if (input.rewound) return REWOUND_PREAMBLE;
  if (input.recycled) {
    return input.recycleReason === "compaction"
      ? RECYCLED_PREAMBLE
      : input.recycleReason === "system" ? SYSTEM_CHANGED_PREAMBLE : SESSION_FAT_PREAMBLE;
  }
  return FRESH_PREAMBLE;
}

const MEMORY_FOLDERS = 4;
const MEMORY_NAMES = 2;
export const MAX_MEMORY_PLAN_BYTES = 4096;
const MEMORY_PLAN_PREFIX = "Read first, your plan: ";
// only an ASCII word char extends the extension: Korean and Japanese particles attach to the filename
const DOC_PATH = /(?:[A-Za-z]:)?[\p{L}\p{M}\p{N}\p{Pc}.~\\/-]*\.(?:md|txt|docx?|pdf)(?!\w)/giu;
// a quoted path may hold spaces, so it is read whole before DOC_PATH
const QUOTED_DOC_PATH = /(["'`])([^"'`\n]+\.(?:md|txt|docx?|pdf))\1/gi;
// CJK prose runs into names with no space, so every name the text or the files on disk support is pinned; DOC_PATH guesses the rest
const NAME_RUN = /[\p{L}\p{M}\p{N}\p{Pc}\p{S}.:\\/-]+/gu;
const DOC_EXT = /\.(?:md|txt|docx?|pdf)(?!\w)/gi;
// Windows finds review.txt for "review.txt.", so a name ends only after an extension
const NAME_END = /\.[A-Za-z\d]+(?!\.*[\w~\\/-])/g;
// in CJK prose a name may start where Latin letters follow another script
const LATIN_START = /(?<=^|(?!\p{Script=Latin})\p{L})\p{Script=Latin}/gu;
const BUILT_PATH = /(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\n"'`<>|*?]*?built\.md/gi;

function localPath(ref: string, cwd: string | undefined): string | null {
  const path = ref.trim();
  if (!path || /^\w{2,}:\/\//.test(path)) return null;
  if (/^~[\\/]/.test(path)) return join(homedir(), path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return cwd ? resolve(cwd, path) : null;
}

function runFiles(run: string, cwd: string | undefined, listed: (dir: string) => Set<string>): string[] {
  const ends = [...run.matchAll(NAME_END)].map((match) => match.index + match[0].length).reverse();
  const refs: [number, string][] = [];
  let rest = run;
  let from = 0;
  const starts = [0];
  const latin = [...run.matchAll(LATIN_START)].map((match) => match.index);
  const named = [...latin, ...[...run.matchAll(/[\\/]/g)].map((match) => match.index)];
  const real: number[] = [];
  for (const hit of run.matchAll(DOC_EXT)) {
    if (hit.index < from) continue;
    const after = hit.index + hit[0].length;
    const tails = ends.filter((end) => end >= after && !/[\\/]/.test(run.slice(after, end)));
    let best: [number, number] | undefined;
    for (let start = from; start <= hit.index && tails.length > 0 && (!best || tails[0]! - start > best[1] - best[0]); start++) {
      // a name starts after a character no ASCII name holds, so release-plan.md never pins plan.md
      if (start && start !== starts.at(-1) && /[\w.~:\\/-]/.test(run[start - 1]!) || /[\uDC00-\uDFFF]/.test(run[start]!)) continue;
      const head = localPath(run.slice(start, after), cwd);
      if (!head || !listed(dirname(head)).has(fileKey(basename(head)))) continue;
      for (const end of tails) {
        if (best && end - start <= best[1] - best[0]) break;
        const path = localPath(run.slice(start, end), cwd)!;
        if (listed(dirname(path)).has(fileKey(basename(path))) && existsSync(path)) {
          best = [start, end];
          break;
        }
      }
    }
    if (best) real.push(best[1]);
    const spans = best ? [best] : [];
    if (ends.includes(after)) {
      // 请先读plan.md is prose then a name, 新draft.md and 計画.md改訂.md one name each, and no rule tells them apart, so the token and each start since the name before this one are pinned up to this end; only a file on disk ending at a name end or starting a later name (a Latin start, a folder) shows plan.md和review.txt is two names, so only then does no reading run past that end
      const token = [...run.slice(0, after).matchAll(DOC_PATH)].at(-1)!;
      const next = Math.max(best?.[0] ?? 0, ...named.filter((at) => at < hit.index));
      const cut = ends.find((end) => end <= next && (real.includes(end) || best && best[0] >= end)) ?? 0;
      const lead = Math.max(token.index, cut);
      const near = Math.max(lead, starts.at(-2) ?? 0);
      for (const start of new Set([lead, ...[...starts, ...latin].filter((start) => start >= near)])) {
        if (start < hit.index) spans.push([start, after]);
      }
    }
    if (!spans.length) {
      // a folder like notes.md/ ends no name, so the next name may still start before it
      if (tails.length) from = after;
      continue;
    }
    from = Math.max(...spans.map(([, end]) => end));
    starts.push(from);
    for (const [start, end] of spans) refs.push([start, run.slice(start, end)]);
    const blank = Math.min(...spans.map(([start]) => start));
    rest = rest.slice(0, blank) + " ".repeat(from - blank) + rest.slice(from);
  }
  for (const match of rest.matchAll(DOC_PATH)) refs.push([match.index, match[0]]);
  return refs.sort(([a], [b]) => a - b).map(([, ref]) => ref);
}

function fileKey(name: string): string {
  return name.normalize("NFC").toUpperCase();
}

// a CJK plan tries a name start per character, so folders are listed once and walked down from cwd or the drive root, never a stat per guess
function listedFiles(cwd: string | undefined): (dir: string) => Set<string> {
  const base = cwd ? resolve(cwd) : undefined;
  const listed = new Map<string, Set<string>>();
  const none = new Set<string>();
  const read = (dir: string) => {
    let names = listed.get(dir);
    if (!names) {
      names = new Set();
      listed.set(dir, names);
      try {
        for (const name of readdirSync(dir)) {
          const key = fileKey(name);
          names.add(key);
          // a name start goes on only when a file name begins with it up to its extension
          for (const match of key.matchAll(DOC_EXT)) names.add(key.slice(0, match.index + match[0].length));
        }
      } catch {}
    }
    return names;
  };
  return (dir) => {
    let at = base && (dir === base || dir.startsWith(base + sep)) ? base : parse(dir).root;
    for (const part of dir.slice(at.length).split(sep)) {
      if (!part) continue;
      if (!read(at).has(fileKey(part))) return none;
      at = join(at, part);
    }
    return read(at);
  };
}

/** Files the record names as its plan: artifacts labeled or named plan, and any document path the goal or plan steps cite. */
export function planFiles(record: Pick<TaskRecordContext, "goal" | "plan" | "artifacts">, cwd?: string): string[] {
  const refs = (record.artifacts ?? []).filter((item) => /plan/i.test(item.label) || /plan/i.test(basename(item.ref))).map((item) => item.ref);
  const cited = [record.goal, ...record.plan.map((item) => item.step)].join("\n").replace(/\w{2,}:\/\/\S+/g, "");
  for (const match of cited.matchAll(QUOTED_DOC_PATH)) refs.push(match[2]!);
  const listed = listedFiles(cwd);
  for (const run of cited.replace(QUOTED_DOC_PATH, " ").match(NAME_RUN) ?? []) refs.push(...runFiles(run, cwd, listed));
  return [...new Set(refs.map((ref) => localPath(ref, cwd)).filter((path): path is string => path !== null))];
}

/** The first path in the bot's notes that ends in built.md and exists. */
export function builtListPath(notes: string, exists: (path: string) => boolean = existsSync): string | null {
  for (const match of notes.matchAll(BUILT_PATH)) {
    const path = match[0].startsWith("~") ? join(homedir(), match[0].slice(2)) : match[0];
    if (exists(path)) return path;
  }
  return null;
}

export interface MemoryBlockInput {
  /** saved or recorded file paths, oldest first */
  files: readonly string[];
  cwd?: string;
  plans?: readonly string[];
  savePlanSidecar?: (paths: readonly string[]) => string;
  builtList?: string | null;
  /** the open-work line unlanded.ts built */
  work?: string;
  home?: string;
}

function memoryPlanLines(paths: readonly string[], savePlanSidecar: MemoryBlockInput["savePlanSidecar"]): string[] {
  const shown: string[] = [];
  let bytes = Buffer.byteLength(MEMORY_PLAN_PREFIX);
  for (const path of paths) {
    bytes += Buffer.byteLength(path) + (shown.length ? 2 : 0);
    if (bytes > MAX_MEMORY_PLAN_BYTES) break;
    shown.push(path);
  }
  const lines = shown.length ? [MEMORY_PLAN_PREFIX + shown.join("; ")] : [];
  const more = paths.length - shown.length;
  if (more) {
    if (!savePlanSidecar) throw new Error("plan memory overflow needs a sidecar");
    lines.push(`+${more} more paths in ${savePlanSidecar(paths)}`);
  }
  return lines;
}

/** Paths only: plan refs, the built list, the newest MEMORY_FOLDERS folders, then a count of the rest. */
export function memoryBlock(input: MemoryBlockInput): string {
  const newest = new Map<string, true>();
  for (const ref of input.files) {
    const path = localPath(ref, input.cwd);
    if (!path) continue;
    newest.delete(path);
    newest.set(path, true);
  }
  const folders = new Map<string, { count: number; names: string[] }>();
  for (const path of [...newest.keys()].reverse()) {
    const dir = dirname(path);
    const folder = folders.get(dir) ?? { count: 0, names: [] };
    folder.count++;
    if (folder.names.length < MEMORY_NAMES) folder.names.push(basename(path));
    folders.set(dir, folder);
  }
  const shown = [...folders].slice(0, MEMORY_FOLDERS).map(([dir, { count, names }]) => {
    const label = input.cwd && resolve(input.cwd) === dir ? "task folder" : [input.cwd, input.home ?? homedir()].map((root) => root ? relative(root, dir) : "")
      .map((inside, index) => inside && !inside.startsWith("..") && !isAbsolute(inside) ? (index ? join("~", inside) : inside) : "")
      .find(Boolean) ?? dir;
    return `${label} ${count} (${names.join(", ")})`;
  });
  const rest = [...folders.values()].slice(MEMORY_FOLDERS);
  if (rest.length) shown.push(`+${rest.length} older folders (${rest.reduce((total, folder) => total + folder.count, 0)} files)`);
  const lines = [
    ...memoryPlanLines(input.plans ?? [], input.savePlanSidecar),
    ...(input.builtList ? [`Built list: ${input.builtList}`] : []),
    ...(shown.length ? [`Files, newest ${MEMORY_FOLDERS} folders: ${shown.join("; ")}`] : []),
    ...(input.work ? [input.work] : []),
  ];
  if (!lines.length) return "";
  return redactSecretsInText(["[Wink memory - open these before answering about the plan or what is built or merged, or starting new work:]", ...lines].join("\n"));
}

type RecordedFile = { ref: string; label: string };

export interface ChatMemoryInput {
  record: Pick<TaskRecordContext, "goal" | "plan" | "artifacts"> | null;
  /** artifacts the record moved to its sidecar, oldest first */
  overflow: readonly RecordedFile[];
  messages: readonly { recorded?: RecordedFile[]; tool?: { writes?: string[]; made?: string[] } }[];
  cwd?: string;
  savePlanSidecar?: MemoryBlockInput["savePlanSidecar"];
  builtList?: string | null;
  work?: string;
}

/** memoryBlock for a chat: the record and its sidecar on this PC, plus what synced rows recorded or wrote. */
export function chatMemory(input: ChatMemoryInput): string {
  const rows = input.messages.flatMap((message) => message.recorded ?? []);
  const recorded = [...input.overflow, ...input.record?.artifacts ?? [], ...rows];
  return memoryBlock({
    files: [...input.overflow, ...input.record?.artifacts ?? []].map((item) => item.ref)
      .concat(input.messages.flatMap((message) => [...(message.recorded ?? []).map((item) => item.ref), ...message.tool?.writes ?? [], ...message.tool?.made ?? []])),
    cwd: input.cwd,
    plans: planFiles({ goal: input.record?.goal ?? "", plan: input.record?.plan ?? [], artifacts: recorded }, input.cwd),
    savePlanSidecar: input.savePlanSidecar,
    builtList: input.builtList,
    work: input.work,
  });
}

export const TASK_RESUME_PROMPT =
  "The previous turn was interrupted. Continue from the conversation.";

/** Marks where replayed history ends and the message a driver must actually
 * answer begins. Drivers that re-attach native content (e.g. images) from
 * `<attached-image>` tags in replayed text scope that to tags after this
 * marker, so old history isn't mistaken for something the user just sent. */
export const REPLY_MARKER = "[Now reply to the user's latest message:]";

export interface TaskRecordBlockOptions {
  /** Stop / crash Resume — do not present a drifted Goal/Plan/Next as current work. */
  recovering?: boolean;
  /** Latest real user turn; only the recovery shape shows it. */
  latestUserText?: string;
  /** A request no completion settled; it takes the recovery shape too. */
  unsettledRequest?: string;
  /** Clock parked asks and verdicts are judged by. */
  now?: number;
  /** A status turn: the asks list says to build any summary from it. */
  allAsks?: boolean;
}

function compactValue(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  const marker = " [more saved]";
  return characters.slice(0, Math.max(1, maxCharacters - marker.length)).join("").trimEnd() + marker;
}

function latestUserTextFromTranscript(
  transcript: Array<{ role: "user" | "assistant"; text: string }>,
): string {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const message = transcript[i]!;
    if (message.role === "user" && message.text.trim()) return message.text;
  }
  return "";
}

function formatTaskRecordFields(
  header: string,
  fields: ReadonlyArray<readonly [string, string]>,
  maxCharacters: number,
): string {
  const limit = Math.max(512, maxCharacters);
  const valueBudget = Math.max(24, Math.floor((limit - header.length - fields.length) / Math.max(1, fields.length)) - 16);
  return redactSecretsInText([
    header,
    ...fields.map(([label, value]) => `${label}: ${compactValue(value, valueBudget)}`),
  ].join("\n"));
}

function taskRecordProgressFields(record: TaskRecordContext): Array<readonly [string, string]> {
  const recent = record.completed.slice(-3).map((item) => item.note).join(" | ") || "none recorded";
  const evidenceItems = record.evidence ?? [];
  const evidence = evidenceItems.slice(-3)
    .map((item) => `${item.kind}: ${item.ref}${item.note ? ` (${item.note})` : ""}`).join(" | ") || "none";
  const artifactItems = record.artifacts ?? [];
  const artifacts = artifactItems.slice(-3).map((item) => `${item.label}: ${item.ref}`).join(" | ") || "none";
  const blockers = record.blockers.slice(-3).map((item) => item.note).join(" | ") || "none";
  return [
    ["Done recently", `${record.completed.length} total; ${recent}`],
    ["Evidence", `${evidenceItems.length} total; ${evidence}`],
    ["Artifacts", `${artifactItems.length} total; ${artifacts}`],
    ["Blockers", `${record.blockers.length} total; ${blockers}`],
  ];
}

export function taskRecordBlock(
  record: TaskRecordContext,
  maxCharacters = 6_000,
  options?: TaskRecordBlockOptions,
): string {
  const fields = taskRecordFields(record, maxCharacters, options);
  const asks = asksBlock(record.asks, options?.now ?? Date.now(), options?.allAsks);
  return asks ? `${fields}\n${asks}` : fields;
}

function taskRecordFields(
  record: TaskRecordContext,
  maxCharacters: number,
  options?: TaskRecordBlockOptions,
): string {
  const unsettled = (options?.unsettledRequest ?? "").trim();
  if (options?.recovering || unsettled) {
    const current = (options?.latestUserText ?? "").trim();
    return formatTaskRecordFields(
      "[Wink task record - local notes. The previous turn was interrupted. Continue from the conversation.]",
      [
        ...(unsettled ? [["Unfinished request", unsettled] as const] : []),
        ...(current ? [["Current request", current] as const] : []),
        ...taskRecordProgressFields(record),
      ],
      maxCharacters,
    );
  }
  const done = record.plan.filter((item) => item.status === "done").length;
  const active = record.plan.find((item) => item.status === "active")?.step;
  const pending = record.plan.find((item) => item.status === "pending")?.step;
  const plan = record.plan.map((item, index) => `${index + 1}. ${item.status}: ${item.step}`).join(" | ") || "none";
  return formatTaskRecordFields(
    "[Wink task record - saved locally. The conversation is authoritative; verify against it.]",
    [
      ["Goal", record.goal],
      ["Plan", `${done}/${record.plan.length} done${active ? `; active: ${active}` : ""}${pending ? `; next pending: ${pending}` : ""}; steps: ${plan}`],
      ["Next action", record.nextAction],
      ...taskRecordProgressFields(record),
    ],
    maxCharacters,
  );
}

const RESUME_FALLBACK_PREAMBLE =
  "[The provider session could not be resumed. Continue from this durable Wink context:]";

export function buildResumeFallback(input: {
  text: string;
  transcript: ReplayMessage[];
  driverKind?: string;
  model?: string;
  taskRecord?: TaskRecordContext;
  taskRecordText?: string;
}): string {
  const record = input.taskRecordText ?? (input.taskRecord ? taskRecordBlock(input.taskRecord) : "");
  return [
    record || null,
    record ? "" : null,
    RESUME_FALLBACK_PREAMBLE,
    "",
    ...input.transcript.map((message) => replayLine(message, input.driverKind, input.model)),
    "",
    REPLY_MARKER,
    "",
    input.text,
  ].filter((line) => line !== null).join("\n");
}

/** A summary that lands after the turn text was built still owes a resumed session the record. */
export function withTaskRecord(text: string, record: string): string {
  return text.includes(record) ? text : `${record}\n\n${text}`;
}

export function buildTurnContext(input: TurnContextInput): {
  turnText: string;
  /** false when the native session must not be resumed */
  resume: boolean;
} {
  const { text, transcript, rewound, fresh, recycled = false, replaysNatively, taskRecord, taskRecordText, contextCapped = false, recovering = false, currentRequestText, asksText = "", memoryText = "" } = input;
  const resume = !rewound && !fresh && !recycled;
  const replay = !resume && !replaysNatively && transcript.length > 0;
  // The caller already sized its block for the model window and knows this
  // send's request; re-deriving from the transcript would drop both, and the
  // transcript excludes the message this turn is answering.
  const durableRecord = taskRecordText ?? (
    taskRecord
      ? taskRecordBlock(taskRecord, 6_000, recovering
        ? {
          recovering: true,
          latestUserText: currentRequestText ?? latestUserTextFromTranscript(transcript),
        }
        : undefined)
      : ""
  );
  const record = [durableRecord && (rewound || fresh || recycled || contextCapped || recovering)
    ? durableRecord
    : asksText, memoryText].filter(Boolean).join("\n");
  if (!replay && !record) return { turnText: text, resume };
  if (!replay) return { turnText: `${record}\n\n${text}`, resume };
  return {
    turnText: [
      record,
      record ? "" : null,
      replayPreamble(input),
      "",
      ...transcript.map((message) => replayLine(message, input.driverKind, input.model)),
      "",
      REPLY_MARKER,
      "",
      text,
    ].filter((line) => line !== null).join("\n"),
    resume,
  };
}
