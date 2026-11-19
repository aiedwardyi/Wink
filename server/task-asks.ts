import { z } from "zod";

export const ASK_STATUSES = ["open", "building", "waiting-for-user", "done", "declined"] as const;
// parked is saved as open with until, so the user's screen shows it as before
export const ASK_UPDATE_STATUSES = [...ASK_STATUSES, "parked"] as const;
export const ASK_VERDICT_MS = 3 * 24 * 60 * 60 * 1000;
export const ASK_LIMITS = { ask: 80, ref: 80, kept: 40 } as const;
export const MAX_STATUS_ASKS_BYTES = 128 * 1024;
export const ASKS_LIST = "[Wink asks list";

export const TASK_ASKS_PROMPT =
  "Add each ask the user makes to update_task_state asks in the same turn, counting a yes to something you proposed; open means not started yet. Close it as done or declined as soon as it settles; never drop one. Build any summary, status or release from the asks list, not from memory. Never leave work waiting for the user's review without showing it to them. Wink lists every open ask each time and merges a repeat into the ask it matches. Park an ask with until when it waits on a date. An ask with no ref and no change in 3 days needs your verdict: build it (helper or time), park it or close it yourself, and ask the user about at most 3 at a time.";

export const taskAskSchema = z.object({
  id: z.string().regex(/^A\d{1,6}$/),
  ask: z.string().min(1).max(ASK_LIMITS.ask),
  status: z.enum(ASK_STATUSES),
  ref: z.string().min(1).max(ASK_LIMITS.ref).optional(),
  /** the bot's own ask_user card left unanswered; Wink adds these, not the bot */
  kind: z.literal("question").optional(),
  choices: z.string().min(1).max(ASK_LIMITS.ref).optional(),
  due: z.number().int().nonnegative().optional(),
  /** the wake Wink set for due, so moving or closing the ask cancels it */
  wake: z.string().min(1).max(128).optional(),
  /** parked: off the bots' list until this time, then open again */
  until: z.number().int().nonnegative().optional(),
  /** when a list past MAX_STATUS_ASKS_BYTES last showed it */
  shown: z.number().int().nonnegative().optional(),
  at: z.number().int().nonnegative(),
  changedAt: z.number().int().nonnegative(),
}).strict();

export type TaskAsk = z.output<typeof taskAskSchema>;

/** A thread's asks and the highest id it ever gave, so an id that fell off is never handed out again. */
export interface AskBook { readonly asks?: readonly TaskAsk[]; readonly lastAskId?: number }
export interface SavedAsks { asks: TaskAsk[]; lastAskId: number }

export const lastAskIdOf = (book: AskBook | undefined): number =>
  Math.max(book?.lastAskId ?? 0, ...(book?.asks ?? []).map((ask) => Number(ask.id.slice(1))));

export interface TaskAskUpdate {
  id?: string;
  ask?: string;
  status: (typeof ASK_UPDATE_STATUSES)[number];
  ref?: string;
  /** parked only: the date it comes back */
  until?: string;
}

const STATUS_TURN = /\b(summar(y|ies|i[sz]e)|recap|status|stand-?up|morning|brief(ing)?|release|progress|catch me up|where (are|were) we|what(['’]?s| is| are) (left|open|pending|next)|to-?dos?|open items)\b|요약|정리|현황|상태|상황|브리핑|아침|릴리[스즈]|남은|어디까지/i;

export const isStatusTurn = (text: string): boolean => STATUS_TURN.test(text);
export const isOpenAsk = (ask: TaskAsk): boolean => ask.status !== "done" && ask.status !== "declined";
const isQuestion = (ask: TaskAsk) => ask.kind === "question";
const isParked = (ask: TaskAsk, now: number) => isOpenAsk(ask) && ask.until !== undefined && ask.until > now;
// a skipped question waits for a natural pause, so it never nags an ordinary turn
const needsVerdict = (ask: TaskAsk, now: number) =>
  isOpenAsk(ask) && !isParked(ask, now) && !isQuestion(ask) && !ask.ref && now - Math.max(ask.changedAt, ask.until ?? 0) >= ASK_VERDICT_MS;
const words = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
const FILLER = new Set(["a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "it", "is", "be", "with", "please", "my", "our", "this", "that"]);
const terms = (text: string) => new Set(words(text).split(/[^\p{L}\p{N}]+/u).filter((term) => term && !FILLER.has(term)).map((term) => term.length > 3 ? term.replace(/([^s])s$/, "$1") : term));

/** Two phrasings of one ask: at least two words and three quarters of the longer one's words shared. */
export function sameAsk(left: string, right: string): boolean {
  const [a, b] = [terms(left), terms(right)];
  const shared = [...a].filter((term) => b.has(term)).length;
  return shared >= 2 && shared / Math.max(a.size, b.size) >= 0.75;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// a bare date is the user's local midnight, not UTC's
const untilTime = (text: string) => {
  const date = DATE.exec(text.trim());
  return date ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime() : Date.parse(text);
};

// only closed asks fall off, oldest first; an open ask is never dropped or refused
function trimClosed(asks: TaskAsk[]): void {
  for (let closed = asks.findIndex((ask) => !isOpenAsk(ask)); asks.length > ASK_LIMITS.kept && closed >= 0; closed = asks.findIndex((ask) => !isOpenAsk(ask))) {
    asks.splice(closed, 1);
  }
}

/** No id adds an ask unless an open one matches its words, an id updates it; closing keeps it, and only the oldest closed asks fall off past the cap. */
export function mergeTaskAsks(
  book: AskBook | undefined,
  updates: readonly TaskAskUpdate[],
  now: number,
): (SavedAsks & { note: string }) | { error: string } {
  const asks = (book?.asks ?? []).map((ask) => ({ ...ask }));
  const added: string[] = [];
  const merged: string[] = [];
  let last = lastAskIdOf(book);
  for (const update of updates) {
    const id = update.id?.trim().toUpperCase();
    const text = update.ask?.trim() ?? "";
    const target = id
      ? asks.find((ask) => ask.id === id)
      : text ? asks.find((ask) => isOpenAsk(ask) && words(ask.ask) === words(text)) ?? asks.find((ask) => isOpenAsk(ask) && !isQuestion(ask) && sameAsk(ask.ask, text)) : undefined;
    if (id && !target) {
      return { error: `Unknown ask id ${id}. Open asks: ${asks.filter(isOpenAsk).map((ask) => ask.id).join(", ") || "none"}.` };
    }
    const parked = update.status === "parked";
    const until = parked ? untilTime(update.until ?? "") : NaN;
    if (parked && !(until > now)) return { error: "A parked ask needs until, the future date it comes back, like 2026-12-01." };
    const status = update.status === "parked" ? "open" : update.status;
    if (target) {
      if (id && text) target.ask = text;
      target.status = status;
      if (parked) target.until = until;
      else delete target.until;
      if (update.ref) target.ref = update.ref;
      else if (update.ref !== undefined) delete target.ref;
      target.changedAt = now;
      if (!id && !merged.includes(target.id)) merged.push(target.id);
      continue;
    }
    if (!text) return { error: "A new ask needs ask, the user's words in brief; send id to update one." };
    last += 1;
    asks.push({ id: `A${last}`, ask: text, status, ...(update.ref ? { ref: update.ref } : {}), ...(parked ? { until } : {}), at: now, changedAt: now });
    added.push(`A${last}`);
  }
  trimClosed(asks);
  const saved = [added.length ? `added ${added.join(", ")}` : "", merged.length ? `merged into ${merged.join(", ")}` : ""].filter(Boolean).join("; ");
  const parkedCount = asks.filter((ask) => isParked(ask, now)).length;
  const open = asks.filter(isOpenAsk).length - parkedCount;
  return { asks, lastAskId: last, note: `Asks saved${saved ? `: ${saved}` : ""}; ${open} open${parkedCount ? `, ${parkedCount} parked` : ""}.` };
}

const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
};

/** Files a question card left unanswered as an open question; null when an open ask has its words. */
export function addQuestionAsk(book: AskBook | undefined, question: string, choices: readonly string[], now: number): SavedAsks | null {
  const ask = clip(question, ASK_LIMITS.ask);
  const asks = (book?.asks ?? []).map((item) => ({ ...item }));
  if (!ask || asks.some((item) => isOpenAsk(item) && words(item.ask) === words(ask))) return null;
  const listed = clip(choices.join(" / "), ASK_LIMITS.ref);
  const lastAskId = lastAskIdOf(book) + 1;
  asks.push({ id: `A${lastAskId}`, ask, status: "open", kind: "question", ...(listed ? { choices: listed } : {}), at: now, changedAt: now });
  trimClosed(asks);
  return { asks, lastAskId };
}

/** A card answered after its question was filed: one filed for this card goes, an older one closes done. Null when none matches. */
export function answerQuestionAsk(existing: readonly TaskAsk[] | undefined, question: string, cardAt: number, now: number): TaskAsk[] | null {
  const ask = words(clip(question, ASK_LIMITS.ask));
  const asks = (existing ?? []).map((item) => ({ ...item }));
  const index = asks.findIndex((item) => isQuestion(item) && isOpenAsk(item) && words(item.ask) === ask);
  if (index < 0) return null;
  if (asks[index]!.at >= cardAt) asks.splice(index, 1);
  else Object.assign(asks[index]!, { status: "done", changedAt: now });
  return asks;
}

function day(at: number): string {
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Open asks, needing a verdict first and then oldest, all of them; past MAX_STATUS_ASKS_BYTES the least recently shown come first and the rest wait. */
function listed(asks: readonly TaskAsk[] | undefined, now: number) {
  const open = (asks ?? []).filter((ask) => isOpenAsk(ask) && !isParked(ask, now));
  const byAge = (left: TaskAsk, right: TaskAsk) => left.at - right.at;
  const due = open.filter((ask) => needsVerdict(ask, now)).sort(byAge);
  const rest = open.filter((ask) => !needsVerdict(ask, now)).sort(byAge);
  const ordered = [...due, ...rest.filter((ask) => !isQuestion(ask)), ...rest.filter(isQuestion)];
  const line = (ask: TaskAsk) => `- ${ask.id} ${ask.status}${isQuestion(ask) ? " question" : ""}${needsVerdict(ask, now) ? " needs verdict" : ""} ${day(ask.at)}: ${ask.ask}${ask.choices ? ` (choices: ${ask.choices})` : ""}${ask.ref ? ` (${ask.ref})` : ""}`;
  const bytes = (ask: TaskAsk) => Buffer.byteLength(line(ask), "utf8") + 1;
  if (ordered.reduce((sum, ask) => sum + bytes(ask), 0) <= MAX_STATUS_ASKS_BYTES) return { ordered, due, shown: ordered, line };
  const picked = new Set<TaskAsk>();
  let used = 0;
  for (const ask of ordered.toSorted((left, right) => (left.shown ?? 0) - (right.shown ?? 0))) {
    if ((used += bytes(ask)) > MAX_STATUS_ASKS_BYTES) break;
    picked.add(ask);
  }
  return { ordered, due, shown: ordered.filter((ask) => picked.has(ask)), line };
}

/** The ids a list past MAX_STATUS_ASKS_BYTES shows, to stamp shown on; null when every open ask fits. */
export function rotatedAsks(asks: readonly TaskAsk[] | undefined, now: number): string[] | null {
  const { ordered, shown } = listed(asks, now);
  return shown.length < ordered.length ? shown.map((ask) => ask.id) : null;
}

/** Every open ask but the parked ones, which count in one line. Empty when none is open. */
export function asksBlock(asks: readonly TaskAsk[] | undefined, now: number, statusTurn = false): string {
  const parked = (asks ?? []).filter((ask) => isParked(ask, now));
  const { ordered, due, shown, line } = listed(asks, now);
  if (!ordered.length && !parked.length) return "";
  const them = due.length === 1 ? "it" : "them";
  const flagged = due.length ? `, ${due.length} need${due.length === 1 ? "s" : ""} a verdict: no ref and no change in 3+ days, so build, park or close ${them} yourself, and ask the user about at most 3 at a time` : "";
  const waiting = ordered.length - shown.length;
  const rotated = waiting ? ` ${waiting} more wait for the next turn, least recently shown first.` : "";
  const questions = shown.some(isQuestion) ? " A question is your own card still unanswered on the user's screen: never re-ask it; close moot or answered ones." : "";
  const back = Math.min(...parked.map((ask) => ask.until!));
  return [
    `${ASKS_LIST} - ${ordered.length} open${flagged}.${rotated}${statusTurn ? " Build any summary or status from this list." : ""}${questions}]`,
    ...shown.map(line),
    ...(parked.length ? [`${parked.length} parked, next back ${day(back)}`] : []),
  ].join("\n");
}

/** For a turn the record does not ride: every open ask on a status turn, otherwise only once one needs a verdict. */
export function asksNudge(asks: readonly TaskAsk[] | undefined, now: number, text: string): string {
  if (isStatusTurn(text)) return asksBlock(asks, now, true);
  return (asks ?? []).some((ask) => needsVerdict(ask, now)) ? asksBlock(asks, now) : "";
}
