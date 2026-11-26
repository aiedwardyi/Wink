// The user's picks, one timeline per bot in memory/decisions.md: plain markdown, oldest first.
import { createHash } from "node:crypto";
import { entryTime, pickStamp } from "../shared/timeline-time.ts";
import { holdSources, sharedSources, type PickBinding } from "./pick-sources.ts";

export const PICKS_FILE = "decisions.md";
/** Estimated tokens of the current-picks block in a voice call's brief, header included; the chat prompt shows every pick. */
export const PICKS_PROMPT_TOKENS = 300;
/** The open goals' own budget, so a goal never falls into the picks' "+N more". */
export const GOALS_PROMPT_TOKENS = 400;
/** Longest goal pin_goal takes; a longer spec belongs in a memory/ side file. */
export const GOAL_MAX = 4_000;
// Claude's tokenizer measured 2.6 chars per token on path-heavy English; other scripts run near one token per char
const CHARS_PER_TOKEN = 2.6;
export const KEY_MAX = 60;
// the card API's longest choice, so a tapped answer lands whole
const PICKED_MAX = 200;
// a goal shown in words gets at least this much; past that many goals, the oldest are listed by name
const GOAL_TOKENS_MIN = 16;
const SAID_MAX = 200;
const LINE_MAX = 420;
const TWEAKS_SHOWN = 3;
const TWEAK_SHOWN_MAX = 80;
const KEYS_LISTED = 40;
const KEYS_DETAILED = 10;
const CAPTION_MAX = 80;

const TITLE = "# Decision timeline";
const INTRO =
  "The user's picks in their own words, oldest first. Auto Notes writes this file from the chat; bots read it and never edit it. A newer pick on the same question replaces the old one, which stays here struck out with a pointer to the newer pick. A tweak adds to the pick it changes. Only current picks load into the bot's prompt.";
const LEGACY = "## Older picks, before the timeline (no words kept)";
const HEADER = `Current picks, newest first: the user's own, each beating older notes unless they changed it since. Build from a pick's picture plus its tweaks, never a new option. History: memory/${PICKS_FILE} (Auto Notes writes it; never edit).`;
const GOALS_HEADER = "Open goals the user set, in their words: build toward each until they finish or drop it, then call pin_goal with done.";
const GOALS_CUT = `A goal ending in "..." is cut here; its whole text is in memory/${PICKS_FILE}.`;
const DONE = "Done";
const ID = String.raw`\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2}\.\d{3})?)?(?: \(\d+\))?`;
const ENTRY = new RegExp(String.raw`^## (${ID}) \| (.+?) \| (?:current|replaced by (${ID}))\s*$`);
const TWEAK = new RegExp(String.raw`^- Tweak (${ID}): "(.*)"\s*$`);
const FIELD = /^- (Picked|Kind|Done|Retired|Picture|Over|Over pictures|Said|Files|Source|At|Tapped|Thread|Message|Question|Binding): ?(.*?)\s*$/;
const SEPARATOR = "; ";
/** An option's letter or number before its words, like "C - Reddit cards". */
export const LABELED = /^(?:option\s+)?([a-z]|\d{1,2})\s*[-.):]\s+/i;
const CAPTIONED = /^(.+?\.(?:png|jpe?g|gif|webp|svg)) \((.*)\)$/i;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg)$/i;

export type Picture = { path: string; caption?: string };
export type Tweak = { at: string; said: string };
export type PickEntry = {
  id: string;
  source?: string;
  at?: number;
  key: string;
  replacedBy?: string;
  picked: string;
  /** A standing goal or spec: shown in every prompt in words until a done entry replaces it. */
  kind?: "goal";
  done?: boolean;
  /** Day a finished one-off left the prompt; it stays on file, so lookup still finds it. */
  retired?: string;
  picture?: Picture;
  over: string[];
  overPictures: Picture[];
  said?: string;
  /** Picked by tapping a card; a typed pick on the question always beats it. */
  tapped?: boolean;
  files: string[];
  /** The task or room that holds the source messages and links its files. */
  thread?: string;
  messageId?: string;
  questionId?: string;
  binding?: "verified" | "unbound";
  tweaks: Tweak[];
  extra: string[];
};
export type Timeline = { head: string; entries: PickEntry[] };
/** A pick or tweak to land, at the user's message time; `legacy` is an older MEMORY.md decision line it replaces. */
export type PickChange =
  | {
      kind: "pick";
      at: number;
      key: string;
      picked: string;
      said: string;
      over?: string[];
      picture?: Picture;
      overPictures?: Picture[];
      files?: string[];
      thread?: string;
      messageId?: string;
      questionId?: string;
      binding?: PickBinding | "unbound";
      tapped?: boolean;
      legacy?: { day: string; line: string };
    }
  | { kind: "tweak"; at: number; key: string; said: string }
  | { kind: "goal"; at: number; key: string; goal?: string; done?: boolean };
export type PinnedGoal = { name: string; goal: string };

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => {
  const one = flat(text);
  // a cut between an emoji's two halves leaves a broken character
  return one.length > max ? `${one.slice(0, max - 3).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}...` : one;
};
const same = (a: string, b: string) => flat(a).toLowerCase() === flat(b).toLowerCase();
const list = (value: string) => value.split(SEPARATOR).map((part) => part.trim()).filter(Boolean);
const monthDay = (id: string) => id.slice(5, 10);
const pictureOf = (value: string): Picture => {
  const captioned = CAPTIONED.exec(value);
  return captioned ? { path: captioned[1]!, caption: captioned[2]! } : { path: value };
};
// a caption reads back only after an image file name, and never splits a list
const pictureText = ({ path, caption }: Picture) => (caption && IMAGE_FILE.test(path) ? `${path} (${clip(caption, CAPTION_MAX).replace(/;/g, ",")})` : path);

/** One question, however it is cased or spaced. */
export const pickKey = (key: string) => key.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// goals and picks never replace each other, whatever their keys
const slotOf = (entry: { kind?: string; key: string }) => `${entry.kind === "goal" ? "goal" : "pick"}\0${pickKey(entry.key)}`;

const stems = (text: string) => new Set(pickKey(text).split(" ").filter((word) => word.length >= 3).map((word) => word.slice(0, 4)));

/** Two names of one option: the same letter or number with one name's words all in the other, else the same words. */
export function sameOption(a: string, b: string): boolean {
  const [x, y] = [LABELED.exec(a.trim())?.[1]?.toLowerCase(), LABELED.exec(b.trim())?.[1]?.toLowerCase()];
  const [p, q] = [a.trim().replace(LABELED, ""), b.trim().replace(LABELED, "")];
  if (!x || !y) return pickKey(p) === pickKey(q);
  const [s, t] = [stems(p), stems(q)];
  const within = (inner: Set<string>, outer: Set<string>) => [...inner].every((stem) => outer.has(stem));
  return x === y && (within(s, t) || within(t, s));
}

const identity = (entry: PickEntry) => entry.source ?? createHash("sha256").update(JSON.stringify(entry.messageId
  ? [pickKey(entry.key), entry.thread, entry.messageId]
  : [pickKey(entry.key), entry.id, entry.picked, entry.said, entry.at])).digest("hex");

export { entryTime, pickStamp } from "../shared/timeline-time.ts";

/** Entries and the text above them; lines it does not know stay with their entry. */
export function parseTimeline(text: string): Timeline {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => ENTRY.test(line));
  const head = (first < 0 ? lines : lines.slice(0, first)).join("\n").trimEnd();
  const entries: PickEntry[] = [];
  for (const line of first < 0 ? [] : lines.slice(first)) {
    const heading = ENTRY.exec(line);
    if (heading) {
      const entry: PickEntry = { id: heading[1]!, key: heading[2]!, picked: "", over: [], overPictures: [], files: [], tweaks: [], extra: [] };
      if (heading[3]) entry.replacedBy = heading[3];
      entries.push(entry);
      continue;
    }
    const entry = entries.at(-1)!;
    const tweak = TWEAK.exec(line);
    const [, field, value = ""] = (!tweak && FIELD.exec(line)) || [];
    if (tweak) entry.tweaks.push({ at: tweak[1]!, said: tweak[2]! });
    else if (field === "Picked") entry.picked = value.replace(/^~~(.*)~~$/, "$1");
    else if (field === "Kind" && value === "goal") entry.kind = "goal";
    else if (field === "Done" && value === "yes") entry.done = true;
    else if (field === "Retired" && /^\d{4}-\d{2}-\d{2}$/.test(value)) entry.retired = value;
    else if (field === "Picture") entry.picture = value ? pictureOf(value) : undefined;
    else if (field === "Over") entry.over = list(value);
    else if (field === "Over pictures") entry.overPictures = list(value).map(pictureOf);
    else if (field === "Said") entry.said = value.replace(/^"(.*)"$/, "$1");
    else if (field === "Files") entry.files = list(value);
    else if (field === "Source" && /^[a-f0-9]{64}$/.test(value)) entry.source = value;
    else if (field === "Tapped" && value === "yes") entry.tapped = true;
    else if (field === "Thread" && /^[\w-]+$/.test(value)) entry.thread = value;
    else if (field === "Message" && /^[\w-]+$/.test(value)) entry.messageId = value;
    else if (field === "Question" && /^[\w-]+$/.test(value)) entry.questionId = value;
    else if (field === "Binding" && (value === "verified" || value === "unbound")) entry.binding = value;
    else if (field === "At" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) entry.at = Number(value);
    else entry.extra.push(line);
  }
  for (const entry of entries) while (entry.extra.length && !entry.extra.at(-1)!.trim()) entry.extra.pop();
  return { head, entries };
}

export function renderTimeline({ head, entries }: Timeline): string {
  const blocks = entries.map((entry) =>
    [
      `## ${entry.id} | ${entry.key} | ${entry.replacedBy ? `replaced by ${entry.replacedBy}` : "current"}`,
      `- Picked: ${entry.replacedBy ? `~~${entry.picked}~~` : entry.picked}`,
      ...(entry.kind ? [`- Kind: ${entry.kind}`] : []),
      ...(entry.done ? ["- Done: yes"] : []),
      ...(entry.retired ? [`- Retired: ${entry.retired}`] : []),
      ...(entry.picture ? [`- Picture: ${pictureText(entry.picture)}`] : []),
      ...(entry.over.length ? [`- Over: ${entry.over.join(SEPARATOR)}`] : []),
      ...(entry.overPictures.length ? [`- Over pictures: ${entry.overPictures.map(pictureText).join(SEPARATOR)}`] : []),
      ...(entry.said === undefined ? [] : [`- Said: "${entry.said}"`]),
      ...(entry.files.length ? [`- Files: ${entry.files.join(SEPARATOR)}`] : []),
      ...(entry.source ? [`- Source: ${entry.source}`] : []),
      ...(entry.at === undefined ? [] : [`- At: ${entry.at}`]),
      ...(entry.tapped ? ["- Tapped: yes"] : []),
      ...(entry.thread ? [`- Thread: ${entry.thread}`] : []),
      ...(entry.messageId ? [`- Message: ${entry.messageId}`] : []),
      ...(entry.questionId ? [`- Question: ${entry.questionId}`] : []),
      ...(entry.binding ? [`- Binding: ${entry.binding}`] : []),
      ...entry.tweaks.map(({ at, said }) => `- Tweak ${at}: "${said}"`),
      ...entry.extra,
    ].join("\n"),
  );
  return `${[head || `${TITLE}\n\n${INTRO}`, ...blocks].join("\n\n")}\n`;
}

/** The old "# Older decisions" roll file becomes the first section, its lines kept word for word. */
function timelineHead(head: string): string {
  if (!head.trim()) return `${TITLE}\n\n${INTRO}`;
  if (head.trimStart().startsWith(TITLE)) return head;
  const lines = head.split("\n");
  const body = /^#\s+older decisions\s*$/i.test(lines[0]!.trim()) ? lines.slice(1) : lines;
  return [TITLE, "", INTRO, "", LEGACY, ...(body[0]?.trim() ? [""] : []), ...body].join("\n");
}

/** Lands changes in the order the user said them, in one text: a pick on a question with a current pick replaces it, a tweak appends to the current pick. Null when nothing changed. */
export function applyPicks(text: string, changes: readonly PickChange[]): { text: string; picks: number; tweaks: number; replaced: number } | null {
  const { head, entries } = parseTimeline(text);
  const ids = new Set(entries.map((entry) => entry.id));
  const fresh = (base: string) => {
    let id = base;
    for (let n = 2; ids.has(id); n += 1) id = `${base} (${n})`;
    ids.add(id);
    return id;
  };
  let picks = 0;
  let tweaks = 0;
  let replaced = 0;
  let retyped = false;
  // a tweak said with its pick lands after it
  for (const change of [...changes].sort((a, b) => a.at - b.at || Number(a.kind === "tweak") - Number(b.kind === "tweak"))) {
    const asked = clip(change.key.replace(/\|/g, "/"), KEY_MAX);
    if (!pickKey(asked)) continue;
    const slot = slotOf({ kind: change.kind, key: asked });
    const card = change.kind === "pick" && change.binding && change.binding !== "unbound" && change.binding.questionId !== change.binding.messageId ? change.binding : undefined;
    // a later answer to the same card is that card's pick, whatever key the note-taker gave it
    const answers = card ? entries.filter((entry) => !entry.replacedBy && !entry.kind && entry.questionId === card.questionId && entry.thread === card.thread && entry.messageId !== card.messageId) : [];
    const current = (answers.length === 1 ? answers[0] : undefined) ?? entries.findLast((entry) => !entry.replacedBy && slotOf(entry) === slot);
    const key = current?.key ?? asked;
    if (change.kind === "goal") {
      // a replayed batch from before the current entry never lands on it
      if (current && change.at < entryTime(current)) continue;
      const open = current?.kind === "goal" && !current.done ? current : undefined;
      const goal = change.done ? open && DONE : flat(change.goal ?? "");
      if (!goal || (open && !change.done && same(open.picked, goal))) continue;
      const id = fresh(pickStamp(change.at));
      if (current) {
        current.replacedBy = id;
        replaced += 1;
      }
      entries.push({ id, key, picked: goal, kind: "goal", ...(change.done ? { done: true } : {}), over: [], overPictures: [], files: [], tweaks: [], extra: [] });
      picks += 1;
      continue;
    }
    const said = clip(change.said, SAID_MAX);
    const stamp = pickStamp(change.at);
    const tapped = change.kind === "pick" && Boolean(change.tapped);
    // a typed pick beats a tapped one whenever either was said, so it skips the replay guard below
    const overTap = change.kind === "pick" && !tapped && current?.tapped;
    // a replayed batch from before the current pick never lands on it
    if (current && change.at < entryTime(current) && !overTap) continue;
    if (tapped && current && !current.tapped) continue;
    if (change.kind === "tweak") {
      const last = current?.tweaks.at(-1);
      // a retried batch or an ask said twice in a row adds nothing; asking again after a reversal does
      if (!current || !said || (last && same(last.said, said)) || current.tweaks.some((tweak) => tweak.at === stamp && same(tweak.said, said))) continue;
      current.tweaks.push({ at: stamp, said });
      // the user spoke to it again, so it is live until its newest words are done
      delete current.retired;
      tweaks += 1;
      continue;
    }
    const picked = clip(change.picked, PICKED_MAX);
    if (!picked) continue;
    const binding = change.binding === "unbound" ? "unbound" : change.binding && "verified";
    const evidence: Partial<PickBinding> = change.binding === "unbound" ? {} : change.binding ?? change;
    if (evidence.messageId && entries.some((entry) => entry.messageId === evidence.messageId && entry.thread === evidence.thread && pickKey(entry.key) === pickKey(key))) continue;
    // a new card asking the same question again is a new answer, dated today
    const reasked = tapped && current?.tapped && card && current.questionId !== card.questionId;
    if (current && sameOption(current.picked, picked) && !reasked) {
      // a re-pick whose question never names the pick keeps the verified picture and time
      const proven = binding !== "verified" || current.binding !== "verified" || evidence.named;
      if (proven && (overTap || (binding === "verified" && (current.binding === "unbound" || (current.binding === "verified" && !tapped && !current.tapped))))) {
        // pinned first: the identity hashes the time, and a merge must still find the tap
        current.source = identity(current);
        delete current.tapped;
        current.at = binding === "unbound" ? undefined : change.at;
        current.binding = binding;
        if (evidence.messageId || binding === "unbound") {
          current.thread = evidence.thread;
          current.messageId = evidence.messageId;
          current.questionId = evidence.questionId;
          current.said = said;
          current.files = evidence.files ?? [];
          current.picture = evidence.picture;
          current.overPictures = evidence.overPictures ?? [];
        }
        retyped = true;
      }
      continue;
    }
    const id = fresh(binding === "unbound" ? stamp.slice(0, 10) : stamp);
    if (change.legacy) {
      entries.push({ id: fresh(change.legacy.day), key, replacedBy: id, picked: clip(change.legacy.line, PICKED_MAX), over: [], overPictures: [], files: [], tweaks: [], extra: [] });
      replaced += 1;
    }
    if (current) {
      current.replacedBy = id;
      replaced += 1;
    }
    const entry: PickEntry = {
      id, key, picked,
      over: (change.over ?? []).map((option) => clip(option, PICKED_MAX).replace(/;/g, ",")).filter(Boolean),
      overPictures: evidence.overPictures ?? [],
      said,
      files: evidence.files ?? [],
      tweaks: [],
      extra: [],
    };
    if (evidence.picture) entry.picture = evidence.picture;
    if (tapped) entry.tapped = true;
    if (evidence.thread) entry.thread = evidence.thread;
    if (evidence.messageId) entry.messageId = evidence.messageId;
    if (evidence.questionId) entry.questionId = evidence.questionId;
    if (binding) entry.binding = binding;
    if (binding !== "unbound" && (evidence.messageId || change.at % 60_000)) entry.at = change.at;
    entries.push(entry);
    picks += 1;
  }
  for (const entry of sharedSources(entries)) {
    entry.source = identity(entry);
    holdSources(entry);
  }
  if (!picks && !tweaks && !retyped) return null;
  return { text: renderTimeline({ head: timelineHead(head), entries }), picks, tweaks, replaced };
}

/** The timeline already holds every pick, tweak and older line of a set-aside copy, so the copy has nothing left to recover. */
export function timelineHolds(text: string | null, copy: string): boolean {
  const main = parseTimeline(text ?? "");
  const held = new Map(main.entries.map((entry) => [identity(entry), entry]));
  const lines = new Set(main.head.split("\n").map((line) => line.trim()));
  const { head, entries } = parseTimeline(copy);
  const boilerplate = (line: string) => !line || line.startsWith("<!--") || line === TITLE || line === INTRO || line === LEGACY || /^#\s+older decisions$/i.test(line);
  return head.split("\n").every((line) => boilerplate(line.trim()) || lines.has(line.trim())) && entries.every((entry) => {
    const kept = held.get(identity(entry));
    return kept !== undefined && entry.tweaks.every(({ at, said }) => kept.tweaks.some((tweak) => tweak.at === at && tweak.said === said));
  });
}

/** Current picks, goals left out: they have their own slot and block. */
export function currentPicks(text: string | null | undefined): PickEntry[] {
  return text ? parseTimeline(text).entries.filter((entry) => !entry.replacedBy && !entry.kind) : [];
}

function openGoals(text: string | null | undefined): PickEntry[] {
  return text ? parseTimeline(text).entries.filter((entry) => !entry.replacedBy && entry.kind === "goal" && !entry.done) : [];
}

/** The Timeline's entries without finished goals: a goal is not a pick, so once done it leaves the page. */
export function timelineEntries(entries: PickEntry[]): PickEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const finished = (entry: PickEntry) => {
    const seen = new Set<string>();
    for (let each: PickEntry | undefined = entry; each && !seen.has(each.id); each = each.replacedBy ? byId.get(each.replacedBy) : undefined) {
      if (each.done) return true;
      seen.add(each.id);
    }
    return false;
  };
  return entries.filter((entry) => entry.kind !== "goal" || !finished(entry));
}

/** Concurrent PCs can reuse a minute id; content breaks ties and gives each pick a stable slot. */
export function mergeTimelines(a: string, b: string): string | null {
  const timelines = [a, b].sort().map(parseTimeline);
  if (timelines.every(({ entries }) => !entries.length)) return null;
  const merged = new Map<string, PickEntry>();
  const parents = new Map<string, Set<string>>();
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const unique = <T>(x: T[], y: T[]) => [...new Map([...x, ...y].map((item) => [JSON.stringify(item), item])).values()];
  const union = <T>(x: T[], y: T[]) => unique(x, y).sort((x, y) => compare(JSON.stringify(x), JSON.stringify(y)));
  // same-minute tweaks keep the order they were said in; the sort is stable
  const said = (x: Tweak[], y: Tweak[]) => unique(x, y).sort((x, y) => compare(x.at, y.at));
  // a retyped tap keeps the tap's identity, so another PC's copy of the typed message alone joins it by that message
  const pinned = new Map(timelines.flatMap(({ entries }) => entries.flatMap((entry) => entry.source && entry.messageId ? [[identity({ ...entry, source: undefined }), entry.source] as const] : [])));
  const slot = (entry: PickEntry) => pinned.get(identity(entry)) ?? identity(entry);
  for (const { entries } of timelines) {
    const sources = new Map(entries.map((entry) => [entry.id, slot(entry)]));
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      const key = slot(entry);
      const next = entry.replacedBy ? sources.get(entry.replacedBy) : undefined;
      // typed beats tapped whatever the order, so a link between them orders nothing
      const ordered = Boolean(entry.tapped) === Boolean(entry.replacedBy && byId.get(entry.replacedBy)?.tapped);
      if (next && next !== key && ordered) parents.set(next, new Set([...(parents.get(next) ?? []), key]));
      const before = merged.get(key);
      if (!before) {
        merged.set(key, { ...entry, source: key, replacedBy: undefined });
        continue;
      }
      const tweaks = said(before.tweaks, entry.tweaks);
      // a retirement judged the words it saw; a tweak it never saw brings the pick back
      const retired = [before, entry].find((side) => side.retired && tweaks.every((tweak) => side.tweaks.some((seen) => seen.at === tweak.at && seen.said === tweak.said)))?.retired;
      const typed = Boolean(before.tapped) !== Boolean(entry.tapped) ? (before.tapped ? entry : before) : undefined;
      const bound = typed ?? (before.binding === "verified" ? before : entry.binding === "verified" ? entry : before.messageId ? before : entry);
      if (bound.messageId || bound.binding === "unbound") {
        merged.set(key, { ...bound, source: key, replacedBy: undefined, retired, tweaks, extra: union(before.extra, entry.extra) });
        continue;
      }
      const both: PickEntry = {
        ...before,
        picture: before.picture ?? entry.picture,
        retired,
        over: union(before.over, entry.over), overPictures: union(before.overPictures, entry.overPictures),
        files: union(before.files, entry.files), tweaks, extra: union(before.extra, entry.extra),
      };
      // one PC saw the tap retyped
      if (before.tapped && !entry.tapped) {
        delete both.tapped;
        both.at = entry.at;
      }
      merged.set(key, both);
    }
  }
  const pending = [...merged.entries()].sort(([a, x], [b, y]) => entryTime(x) - entryTime(y) || compare(a, b));
  const left = new Set(merged.keys());
  const entries: PickEntry[] = [];
  while (pending.length) {
    const ready = pending.findIndex(([key]) => ![...(parents.get(key) ?? [])].some((parent) => left.has(parent)));
    const [key, entry] = pending.splice(Math.max(0, ready), 1)[0]!;
    entries.push(entry);
    left.delete(key);
  }
  const ids = new Set<string>();
  const current = new Map<string, PickEntry>();
  for (const entry of entries) {
    const base = entry.id.replace(/ \(\d+\)$/, "");
    let id = base;
    for (let n = 2; ids.has(id); n += 1) id = `${base} (${n})`;
    ids.add(id);
    entry.id = id;
    entry.replacedBy = undefined;
    const before = current.get(slotOf(entry));
    if (before && entry.tapped && !before.tapped) {
      entry.replacedBy = before.id;
      continue;
    }
    if (before) before.replacedBy = id;
    current.set(slotOf(entry), entry);
  }
  const head = [...new Set(timelines.flatMap(({ head }) => timelineHead(head).split("\n")))].join("\n");
  return renderTimeline({ head, entries });
}

/** Current picks for the note-taker, newest last, the newest with what they beat, so a change of mind reuses the key and can name an option it beat. */
export function pickKeysList(text: string | null | undefined): string {
  const live = currentPicks(text).slice(-KEYS_LISTED);
  return live
    .map((entry, index) => {
      const lines = [`- ${entry.key}: ${entry.picked}${entry.tweaks.length ? ` (${entry.tweaks.length === 1 ? "1 tweak" : `${entry.tweaks.length} tweaks`})` : ""}`];
      if (index < live.length - KEYS_DETAILED) return lines[0];
      if (entry.picture) lines.push(`  picture: ${pictureText(entry.picture)}`);
      if (entry.over.length) lines.push(`  over: ${entry.over.join(SEPARATOR)}`);
      if (entry.overPictures.length) lines.push(`  over pictures: ${entry.overPictures.map(pictureText).join(SEPARATOR)}`);
      return lines.join("\n");
    })
    .join("\n");
}

function pickLine(entry: PickEntry): string {
  const shown = entry.tweaks.slice(-TWEAKS_SHOWN).map(({ at, said }) => `"${clip(said, TWEAK_SHOWN_MAX)}" (${monthDay(at)})`);
  const earlier = entry.tweaks.length - shown.length;
  const tweaks = shown.length ? ` + tweaks: ${shown.join(", ")}${earlier ? ` (+${earlier} earlier in memory/${PICKS_FILE})` : ""}` : "";
  const line = `- ${pickHead(entry)}${entry.picture ? ` (${entry.picture.path})` : ""}${tweaks}`;
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 3)}...` : line;
}

const pickHead = (entry: PickEntry) => (pickKey(entry.key) === pickKey(entry.picked) ? `${entry.picked} (${monthDay(entry.id)})` : `${entry.key} (${monthDay(entry.id)}): ${entry.picked}`);

/** The pick alone, its picture and tweaks left to the file. */
function shortLine(entry: PickEntry): string {
  const count = entry.tweaks.length;
  const left = [...(entry.picture ? ["picture"] : []), ...(count ? [count === 1 ? "1 tweak" : `${count} tweaks`] : [])];
  return `- ${pickHead(entry)}${left.length ? ` (+${left.join(", ")} on file)` : ""}`;
}

/** The other current picks by key, as many as fit in `room` tokens. */
function keyIndex(entries: PickEntry[], room = Infinity, lead = "\nAlso current, on file: "): string {
  if (!entries.length) return "";
  const more = (count: number) => (count ? `${count === entries.length ? "" : " "}(+${count} more)` : "");
  let out = lead;
  for (const [index, entry] of entries.entries()) {
    const next = `${out}${index ? "; " : ""}${entry.key}`;
    if (promptTokens(next + more(entries.length - index - 1)) > room) return index || promptTokens(out + more(entries.length)) <= room ? out + more(entries.length - index) : "";
    out = next;
  }
  return out;
}

const charTokens = (char: string) => (char.charCodeAt(0) < 128 ? 1 / CHARS_PER_TOKEN : 1);

export function promptTokens(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += charTokens(char);
  return tokens;
}

/** `text` cut to `max` estimated tokens, "..." included, so Korean is cut by its own cost. */
function clipTokens(text: string, max: number): string {
  if (promptTokens(text) <= max) return text;
  let out = "";
  let used = promptTokens("...");
  for (const char of text) {
    used += charTokens(char);
    if (used > max) break;
    out += char;
  }
  return `${out.trimEnd()}...`;
}

/** Goal lines within `max` estimated tokens, newest first: short ones whole, long ones sharing what is left; past GOAL_TOKENS_MIN each, the oldest by name only. */
export function goalLines(goals: readonly PinnedGoal[], max: number): string[] {
  const lines = goals.map(({ name, goal }) => `- ${name}: ${goal}`);
  const cost = (line: string) => promptTokens(`${line}\n`);
  if (lines.reduce((sum, line) => sum + cost(line), 0) <= max) return lines;
  const room = max - cost(GOALS_CUT);
  const keysRoom = goals.length * GOAL_TOKENS_MIN > room ? Math.floor(room / 4) : 0;
  const words = Math.max(1, Math.min(goals.length, Math.floor((room - keysRoom) / GOAL_TOKENS_MIN)));
  const named = goals.slice(words).map(({ name }) => ({ key: name }) as PickEntry);
  const keys = keyIndex(named, keysRoom, `\nAlso open, whole text in memory/${PICKS_FILE}: `).trimStart();
  let left = room - (keys ? cost(keys) : 0);
  const shown = lines.slice(0, words);
  const order = [...shown.keys()].sort((a, b) => cost(shown[a]!) - cost(shown[b]!));
  for (const [done, index] of order.entries()) {
    const share = left / (order.length - done);
    // a long name gets at most half its line, so the goal's own words still show
    if (cost(shown[index]!) > share) shown[index] = clipTokens(`${clipTokens(`- ${goals[index]!.name}`, Math.floor(share / 2))}: ${goals[index]!.goal}`, share - cost(""));
    left -= cost(shown[index]!);
  }
  return [...shown, ...(keys ? [keys] : []), GOALS_CUT];
}

export function pinnedGoals(text: string | null | undefined): PinnedGoal[] {
  return openGoals(text).map((entry) => ({ name: entry.key, goal: entry.picked }));
}

/** Every open goal in words, newest first, within `max`: never folded into the picks' "+N more". */
function goalsBlock(text: string | null | undefined, max = GOALS_PROMPT_TOKENS): string {
  const goals = openGoals(text).reverse();
  if (!goals.length) return "";
  return [GOALS_HEADER, ...goalLines(goals.map((entry) => ({ name: `${entry.key} (${monthDay(entry.id)})`, goal: entry.picked })), max - promptTokens(`${GOALS_HEADER}\n`))].join("\n");
}

/** The prompt's open goals, then its current picks, newest first, within `max` estimated tokens (every pick in full by default): whole lines while every other key still fits, then the pick alone, then its key. Empty when there are none. */
export function picksBlock(text: string | null | undefined, max = Infinity): string {
  const goals = goalsBlock(text);
  const live = currentPicks(text).filter((entry) => !entry.retired).reverse();
  if (!live.length) return goals;
  let out = HEADER;
  const listed: PickEntry[] = [];
  for (const [index, entry] of live.entries()) {
    const rest = max === Infinity ? "" : keyIndex([...listed, ...live.slice(index + 1)]);
    const line = [pickLine(entry), shortLine(entry)].find((option) => promptTokens(`${out}\n${option}${rest}`) <= max);
    // the newest pick always shows, its words if not its picture and tweaks
    if (line || !index) out += `\n${line ?? shortLine(entry)}`;
    else listed.push(entry);
  }
  return `${goals ? `${goals}\n\n` : ""}${out}${keyIndex(listed, max - promptTokens(out))}`;
}

/** The file with replaced entries blanked, so recall never finds an old pick and line numbers still match. */
export function currentOnly(text: string): string {
  let replaced = false;
  return text
    .split("\n")
    .map((line) => {
      const heading = ENTRY.exec(line.replace(/\r$/, ""));
      if (heading) replaced = Boolean(heading[3]);
      else if (/^#{1,2}\s/.test(line)) replaced = false;
      return replaced ? "" : line;
    })
    .join("\n");
}

// a word that dates the action to the day it was said; "for now" and "from now on" do not
const DATED = /(?<![\w.@])(?:tonight|today|right now|after \d{1,2}:\d{2})\b|(?<![\w.@]|\b(?:for|from) )now\b(?! on\b)/i;
// a tweak is the user's raw words, so it dates the pick only by these
const DATED_SAID = /(?<![\w.@])(?:tonight|expires? today|right now|after \d{1,2}:\d{2})\b/i;
// "every day after 13:30" is a standing rule, whatever time it names
const RECURRING = /\b(?:every|each|daily|nightly|weekly|monthly|always|whenever|from now on|(?:mon|tues|wednes|thurs|fri|satur|sun)days)\b/i;

/** Marks current picks that are finished one-offs as retired today: their newest words date the action to a day now past, or done() says the PRs they name merged since. Null when none. */
export function retirePicks(text: string, now: number, done: (entry: PickEntry) => boolean = () => false): string | null {
  const timeline = parseTimeline(text);
  const today = pickStamp(now).slice(0, 10);
  let retired = 0;
  for (const entry of timeline.entries) {
    if (entry.replacedBy || entry.kind || entry.retired) continue;
    const tweak = entry.tweaks.at(-1);
    // a card question can say what holds "right now" before or after what it asks
    const asked = entry.key.match(/[^.?!]*\?/g)?.join(" ") ?? entry.key;
    const day = tweak ? DATED_SAID.test(tweak.said) && tweak.at.slice(0, 10) : DATED.test(`${asked}\n${entry.picked}`) && pickStamp(entryTime(entry)).slice(0, 10);
    const dated = day && day < today && !RECURRING.test([asked, entry.picked, ...entry.tweaks.map(({ said }) => said)].join("\n"));
    if (!dated && !done(entry)) continue;
    entry.retired = today;
    retired += 1;
  }
  return retired ? renderTimeline(timeline) : null;
}

/** What starts each retired pick's prompt line in any version of it, and the block header they may have taken with them, so a resumed session that still holds them is not told they no longer apply. */
export function retiredLines(text: string | null | undefined): string[] {
  const heads = currentPicks(text).filter((entry) => entry.retired).map((entry) => `- ${pickHead(entry)}`);
  return heads.length ? [HEADER, ...heads] : [];
}
