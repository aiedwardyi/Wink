import { z } from "zod";

export const ASK_STATUSES = ["open", "building", "waiting-for-user", "done", "declined"] as const;
// parked is saved as open with until, so the user's screen shows it as before
export const ASK_UPDATE_STATUSES = [...ASK_STATUSES, "parked"] as const;
export const ASK_VERDICT_MS = 3 * 24 * 60 * 60 * 1000;
export const ASK_LIMITS = { ask: 80, ref: 80, kept: 40 } as const;
export const MAX_STATUS_ASKS_BYTES = 128 * 1024;
export const ASKS_LIST = "[Wink asks list";

export const TASK_ASKS_PROMPT =
  "Add each ask the user makes to update_task_state asks in the same turn, counting a yes to something you proposed; open means not started yet. Close it as done or declined as soon as it settles; never drop one. Keep three lists for asks and work only: the plan is the to-do for now, asks marked building are the sprint, and the asks list holds every open ask; never start a separate list file, and keep your other records. Build any summary, status or release from the asks list, not from memory. Never leave work waiting for the user's review without showing it to them. Wink lists every open ask in a fresh session and on a status question, otherwise the asks the user's words name, and merges a repeat into the ask it matches. Park an ask with until when it waits on a date. An ask with no ref and no change in 3 days needs your verdict: build it (helper or time), park it or close it yourself, and ask the user about at most 3 at a time.";

export const taskAskSchema = z.object({
  id: z.string().regex(/^A\d{1,6}$/),
  ask: z.string().min(1).max(ASK_LIMITS.ask),
  status: z.enum(ASK_STATUSES),
  ref: z.string().min(1).max(ASK_LIMITS.ref).optional(),
  /** question: the bot's own ask_user card left unanswered; promise: its own "I'll do X" a turn left undone. Wink adds these, not the bot */
  kind: z.enum(["question", "promise"]).optional(),
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
const isPromise = (ask: TaskAsk) => ask.kind === "promise";
const isRunning = (ask: TaskAsk) => isPromise(ask) && ask.status === "building";
const RUNNING_NOTE = " One building is already running: check on it, never start it again.";
const QUESTION_MARK = /[?？]$/;
const isParked = (ask: TaskAsk, now: number) => isOpenAsk(ask) && ask.until !== undefined && ask.until > now;
// a skipped question waits for a natural pause, so it never nags an ordinary turn
const needsVerdict = (ask: TaskAsk, now: number) =>
  isOpenAsk(ask) && !isParked(ask, now) && !isQuestion(ask) && !isPromise(ask) && !QUESTION_MARK.test(ask.ask) && !ask.ref && now - Math.max(ask.changedAt, ask.until ?? 0) >= ASK_VERDICT_MS;
const words = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// a bare date is the user's local midnight, not UTC's
const untilTime = (text: string) => {
  const date = DATE.exec(text.trim());
  return date ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime() : Date.parse(text);
};

// only closed asks fall off, oldest first; an open ask is never dropped or refused
export function trimClosed(asks: TaskAsk[]): TaskAsk[] {
  const trimmed: TaskAsk[] = [];
  for (let closed = asks.findIndex((ask) => !isOpenAsk(ask)); asks.length > ASK_LIMITS.kept && closed >= 0; closed = asks.findIndex((ask) => !isOpenAsk(ask))) {
    trimmed.push(...asks.splice(closed, 1));
  }
  return trimmed;
}

/** No id adds an ask unless an open one matches its words, an id updates it; closing keeps it, and only the oldest closed asks fall off past the cap, into trimmed as this update left them. */
export function mergeTaskAsks(
  book: AskBook | undefined,
  updates: readonly TaskAskUpdate[],
  now: number,
): (SavedAsks & { note: string; trimmed: TaskAsk[] }) | { error: string } {
  const asks = (book?.asks ?? []).map((ask) => ({ ...ask }));
  const added: string[] = [];
  const merged: string[] = [];
  let last = lastAskIdOf(book);
  for (const update of updates) {
    const id = update.id?.trim().toUpperCase();
    const text = update.ask?.trim() ?? "";
    const target = id
      ? asks.find((ask) => ask.id === id)
      : text ? asks.find((ask) => isOpenAsk(ask) && words(ask.ask) === words(text)) : undefined;
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
  const trimmed = trimClosed(asks);
  const saved = [added.length ? `added ${added.join(", ")}` : "", merged.length ? `merged into ${merged.join(", ")}` : ""].filter(Boolean).join("; ");
  const parkedCount = asks.filter((ask) => isParked(ask, now)).length;
  const open = asks.filter(isOpenAsk).length - parkedCount;
  return { asks, lastAskId: last, trimmed, note: `Asks saved${saved ? `: ${saved}` : ""}; ${open} open${parkedCount ? `, ${parkedCount} parked` : ""}.` };
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

const ASKED = new Set("a an the i me my you your we us our it its this that to of for on in at with from and or is are was were be do does did have has will would can could should shall may might must what why how when where which who ll s".split(" "));
// every word of any length, "the API" and "CI" too
const gist = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !ASKED.has(word)).map((word) => word.replace(/(?<=[a-z]{3})s$/, "")));
// #2073's: "PC A" and "PC B", or 4 pm and 5 pm: a number or one-letter name only one of them has keeps them apart
const marks = (text: string) => [...new Set(text.replace(/\b(\d{1,2}):00\b/g, "$1").match(/\p{N}+|(?<![\p{L}\p{N}'’])\p{Lu}(?![\p{L}\p{N}'’])/gu)?.filter((mark) => mark !== "I"))].sort().join(" ");

// #2073's: a promise's words after "I'll" are all in the other's or theirs in its, so "update the main desktop toolbar icon" is never "... layout"
const clause = (text: string) => gist(text.replace(/^.*?\bi(?:['’]ll| will)\b/i, ""));
const within = (a: string, b: string) => {
  const [p, q] = [clause(a), clause(b)];
  return [...p].every((term) => q.has(term)) || [...q].every((term) => p.has(term));
};

// a reworded repeat: most of the shorter one's words, or between a question and an ask three and half of them
function sameAsk(a: string, b: string, promises: boolean, promise: boolean): boolean {
  const [x, y] = [gist(a), gist(b)];
  const least = Math.min(x.size, y.size);
  const shared = [...x].filter((term) => y.has(term)).length;
  return words(a) === words(b) || (least > 0 && marks(a) === marks(b) && (!promise || within(a, b)) && (shared >= 0.8 * least || (!promises && shared >= 3 && shared * 2 >= least)));
}

/** Closes the settled ids or narrows them to what is left, then files what a turn left open, a promise as kind promise, building with its line when it said the work is running, and the user's question as their ask; one an ask already has, open, done or declined, stays that ask, and goes building when it is the running one. Null when nothing changes. */
export function fileLeftovers(book: AskBook | undefined, left: readonly { ask: string; promise?: true; running?: string }[], now: number, settled: readonly { id: string; ask?: string }[] = []): SavedAsks | null {
  const asks = (book?.asks ?? []).map((item) => ({ ...item }));
  let lastAskId = lastAskIdOf(book);
  let changed = false;
  for (const item of asks) {
    const done = isOpenAsk(item) ? settled.find(({ id }) => id === item.id) : undefined;
    if (!done) continue;
    // shown 0: what changed rides to the next turn, so no engine redoes the finished part
    Object.assign(item, done.ask ? { ask: clip(done.ask, ASK_LIMITS.ask), changedAt: now, shown: 0 } : { status: "done", changedAt: now });
    changed = true;
  }
  for (const item of left) {
    // a long question keeps its "?" so a later turn still reads it as one
    const mark = item.promise ? undefined : QUESTION_MARK.exec(item.ask.trim())?.[0];
    const ask = mark ? `${clip(item.ask.trim().slice(0, -1), ASK_LIMITS.ask - 1)}${mark}` : clip(item.ask, ASK_LIMITS.ask);
    const repeat = ask ? asks.find((filed) => sameAsk(filed.ask, ask, isPromise(filed) && item.promise === true, item.promise === true)) : undefined;
    if (repeat && item.running && isOpenAsk(repeat) && repeat.status !== "building") {
      Object.assign(repeat, { status: "building", ref: clip(item.running, ASK_LIMITS.ref), changedAt: now, shown: 0 });
      changed = true;
    }
    if (!ask || repeat) continue;
    lastAskId += 1;
    // shown 0: no turn showed it yet, so the next one does, resumed or not
    const filed: TaskAsk = { id: `A${lastAskId}`, ask, status: item.running ? "building" : "open", shown: 0, at: now, changedAt: now };
    if (item.promise) filed.kind = "promise";
    if (item.running) filed.ref = clip(item.running, ASK_LIMITS.ref);
    asks.push(filed);
    changed = true;
  }
  if (!changed) return null;
  trimClosed(asks);
  return { asks, lastAskId };
}

export const askTerms = (text: string): Set<string> => terms(text);

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

const askLine = (ask: TaskAsk, now: number) => isParked(ask, now)
  ? `- ${ask.id} parked back ${day(ask.until!)}: ${ask.ask}`
  : `- ${ask.id} ${ask.status}${ask.kind ? ` ${ask.kind}` : ""}${needsVerdict(ask, now) ? " needs verdict" : ""} ${day(ask.at)}: ${ask.ask}${ask.choices ? ` (choices: ${ask.choices})` : ""}${ask.ref ? ` (${ask.ref})` : ""}`;

/** Open asks, needing a verdict first and then oldest, then parked ones by return day; past MAX_STATUS_ASKS_BYTES the least recently shown come first and the rest wait. */
function listed(asks: readonly TaskAsk[] | undefined, now: number) {
  const open = (asks ?? []).filter((ask) => isOpenAsk(ask) && !isParked(ask, now));
  const parked = (asks ?? []).filter((ask) => isParked(ask, now)).sort((left, right) => left.until! - right.until!);
  const byAge = (left: TaskAsk, right: TaskAsk) => left.at - right.at;
  const due = open.filter((ask) => needsVerdict(ask, now)).sort(byAge);
  const rest = open.filter((ask) => !needsVerdict(ask, now)).sort(byAge);
  const ordered = [...due, ...rest.filter((ask) => !isQuestion(ask)), ...rest.filter(isQuestion)];
  const line = (ask: TaskAsk) => askLine(ask, now);
  const bytes = (ask: TaskAsk) => Buffer.byteLength(line(ask), "utf8") + 1;
  const all = [...ordered, ...parked];
  if (all.reduce((sum, ask) => sum + bytes(ask), 0) <= MAX_STATUS_ASKS_BYTES) return { ordered, parked, due, shown: all, line };
  const picked = new Set<TaskAsk>();
  let used = 0;
  for (const ask of all.toSorted((left, right) => (left.shown ?? 0) - (right.shown ?? 0))) {
    if ((used += bytes(ask)) > MAX_STATUS_ASKS_BYTES) break;
    picked.add(ask);
  }
  return { ordered, parked, due, shown: all.filter((ask) => picked.has(ask)), line };
}

/** The ids a list past MAX_STATUS_ASKS_BYTES shows, to stamp shown on; null when every open and parked ask fits. */
export function rotatedAsks(asks: readonly TaskAsk[] | undefined, now: number): string[] | null {
  const { ordered, parked, shown } = listed(asks, now);
  return shown.length < ordered.length + parked.length ? shown.map((ask) => ask.id) : null;
}

/** Every open ask, then each parked one with the day it comes back, or with verdictOnly just the asks needing a verdict. Empty when none is open. */
export function asksBlock(asks: readonly TaskAsk[] | undefined, now: number, statusTurn = false, verdictOnly = false): string {
  const { ordered, parked, due, shown: listShown, line } = listed(asks, now);
  if (!ordered.length && !parked.length) return "";
  const shown = verdictOnly ? listed(due, now).shown : listShown;
  const them = due.length === 1 ? "it" : "them";
  const flagged = due.length ? `, ${due.length} need${due.length === 1 ? "s" : ""} a verdict: no ref and no change in 3+ days, so build, park or close ${them} yourself, and ask the user about at most 3 at a time` : "";
  const waiting = ordered.length + parked.length - shown.length;
  const rotated = !waiting ? "" : verdictOnly ? ` ${waiting} more show on a status question.` : ` ${waiting} more wait for the next turn, least recently shown first.`;
  const questions = shown.some(isQuestion) ? " A question is your own card still unanswered on the user's screen: never re-ask it; close moot or answered ones." : "";
  const promises = shown.some(isPromise) ? ` A promise is your own "I'll" a turn left undone, maybe on another engine: check what exists first (this list, merged PRs, files) and close it done if it is; never redo it.${shown.some(isRunning) ? RUNNING_NOTE : ""}` : "";
  return [
    `${ASKS_LIST} - ${ordered.length} open${flagged}.${rotated}${statusTurn ? " Build any summary or status from this list." : ""}${questions}${promises}]`,
    ...shown.map(line),
  ].join("\n");
}

const SKIPPED_TERMS = new Set("about again also asked being change could does doing done from have into just like list make more need next please really should still that them then there they thing things this want what when where which will with would your".split(" "));
const terms = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter((word) => word.length >= (/^[a-z0-9]+$/.test(word) ? 4 : 2) && !SKIPPED_TERMS.has(word))
  .map((word) => word.replace(/(?<=[a-z]{3})s$/, "")));

const NAMED_MAX = 3;
// about 100 tokens at three bytes a token
const NAMED_BYTES = 300;

/** The user's open or parked asks sharing 2+ uncommon words with the message, or its only word, most shared first; a word more than NAMED_MAX asks hold is common. */
function named(asks: readonly TaskAsk[], text: string): TaskAsk[] {
  const said = terms(text);
  const pool = asks.filter((ask) => isOpenAsk(ask) && !isQuestion(ask)).map((ask) => ({ ask, terms: [...terms(ask.ask)] }));
  const held = new Map<string, number>();
  for (const { terms } of pool) for (const term of terms) held.set(term, (held.get(term) ?? 0) + 1);
  const need = Math.min(2, said.size);
  return pool
    .map(({ ask, terms }) => ({ ask, shared: terms.filter((term) => said.has(term) && held.get(term)! <= NAMED_MAX).length }))
    .filter(({ shared }) => need && shared >= need)
    .sort((left, right) => right.shared - left.shared)
    .map(({ ask }) => ask);
}

function leftBlock(asks: readonly TaskAsk[], now: number): string {
  if (!asks.length) return "";
  return [
    `[Wink asks the last turn left open - ${asks.length}: check what exists first, close done ones and never redo them.${asks.some(isRunning) ? RUNNING_NOTE : ""}]`,
    ...asks.map((ask) => askLine(ask, now)),
  ].join("\n");
}

// another chat's ids mean nothing here, so its asks show without them
function elsewhereBlock(asks: readonly TaskAsk[], now: number): string {
  if (!asks.length) return "";
  const shown = asks.slice(0, ASK_LIMITS.kept);
  const more = asks.length - shown.length;
  return [
    `[Wink asks from the user's other chats with you - ${asks.length}; update them in that chat.${more ? ` ${more} more not shown.` : ""}]`,
    ...shown.map((ask) => askLine(ask, now).replace(/^- A\d+ /, "- ")),
  ].join("\n");
}

/** For a turn the record does not ride: every open ask on a status turn, the asks needing a verdict on any other, and up to NAMED_MAX asks the message names in NAMED_BYTES; asks from the bot's other chats ride the same way. */
export function asksNudge(asks: readonly TaskAsk[] | undefined, now: number, text: string, elsewhere: readonly TaskAsk[] = []): string {
  const status = isStatusTurn(text);
  const own = asks ?? [];
  if (status) return [asksBlock(asks, now, true), elsewhereBlock(elsewhere.filter(isOpenAsk), now)].filter(Boolean).join("\n");
  const block = own.some((ask) => needsVerdict(ask, now)) ? asksBlock(asks, now, false, true) : "";
  const left = own.filter((ask) => isOpenAsk(ask) && ask.shown === 0 && !needsVerdict(ask, now));
  const mine = new Set(own.filter((ask) => !needsVerdict(ask, now) && !left.includes(ask)));
  const render = (picked: readonly TaskAsk[]) => {
    const hits = picked.filter((ask) => mine.has(ask));
    return [
      hits.length ? [`[Wink asks the user's message names - ${hits.length} of ${own.filter(isOpenAsk).length} open; a status question lists them all.]`, ...hits.map((ask) => askLine(ask, now))].join("\n") : "",
      elsewhereBlock(picked.filter((ask) => !mine.has(ask)), now),
    ].filter(Boolean).join("\n");
  };
  let picked: TaskAsk[] = [];
  let hits = "";
  for (const ask of named([...mine, ...elsewhere], text)) {
    if (picked.length === NAMED_MAX) break;
    const next = render([...picked, ask]);
    if (Buffer.byteLength(next, "utf8") <= NAMED_BYTES) [picked, hits] = [[...picked, ask], next];
    // the best match alone past the budget is clipped, never dropped
    else if (!picked.length) {
      hits = `${Buffer.from(next, "utf8").subarray(0, NAMED_BYTES - 3).toString("utf8").replace(/\uFFFD+$/u, "")}…`;
      break;
    }
  }
  return [block, leftBlock(left, now), hits].filter(Boolean).join("\n");
}
