// The user's picks, one timeline per bot in memory/decisions.md: plain markdown, oldest first.
import { createHash } from "node:crypto";

export const PICKS_FILE = "decisions.md";
/** Estimated tokens of the current-picks block in the prompt, header included. */
export const PICKS_PROMPT_TOKENS = 300;
// Claude's tokenizer measured 2.6 chars per token on path-heavy English; other scripts run near one token per char
const CHARS_PER_TOKEN = 2.6;
const KEY_MAX = 60;
const PICKED_MAX = 100;
const SAID_MAX = 120;
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
const ID = String.raw`\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2}\.\d{3})?)?(?: \(\d+\))?`;
const ENTRY = new RegExp(String.raw`^## (${ID}) \| (.+?) \| (?:current|replaced by (${ID}))\s*$`);
const TWEAK = new RegExp(String.raw`^- Tweak (${ID}): "(.*)"\s*$`);
const FIELD = /^- (Picked|Picture|Over|Over pictures|Said|Files|Source|At|Tapped|Thread|Message|Question): ?(.*?)\s*$/;
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
      tapped?: boolean;
      legacy?: { day: string; line: string };
    }
  | { kind: "tweak"; at: number; key: string; said: string };

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => {
  const one = flat(text);
  // a cut between an emoji's two halves leaves a broken character
  return one.length > max ? `${one.slice(0, max - 3).replace(/[\uD800-\uDBFF]$/, "").trimEnd()}...` : one;
};
const same = (a: string, b: string) => flat(a).toLowerCase() === flat(b).toLowerCase();
const list = (value: string) => value.split(SEPARATOR).map((part) => part.trim()).filter(Boolean);
const pad = (value: number) => String(value).padStart(2, "0");
const monthDay = (id: string) => id.slice(5, 10);
const pictureOf = (value: string): Picture => {
  const captioned = CAPTIONED.exec(value);
  return captioned ? { path: captioned[1]!, caption: captioned[2]! } : { path: value };
};
// a caption reads back only after an image file name, and never splits a list
const pictureText = ({ path, caption }: Picture) => (caption && IMAGE_FILE.test(path) ? `${path} (${clip(caption, CAPTION_MAX).replace(/;/g, ",")})` : path);

/** One question, however it is cased or spaced. */
export const pickKey = (key: string) => key.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

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

export function pickStamp(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const identity = (entry: PickEntry) => entry.source ?? createHash("sha256").update(JSON.stringify(entry.messageId
  ? [pickKey(entry.key), entry.thread, entry.messageId]
  : [pickKey(entry.key), entry.id, entry.picked, entry.said, entry.at])).digest("hex");

export const entryTime = (entry: PickEntry) => {
  const stamp = entry.id.replace(/ \(\d+\)$/, "");
  return entry.at ?? new Date(stamp.includes(" ") ? stamp.replace(" ", "T") : `${stamp}T00:00`).getTime();
};

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
    const current = entries.findLast((entry) => !entry.replacedBy && pickKey(entry.key) === pickKey(asked));
    const key = current?.key ?? asked;
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
      tweaks += 1;
      continue;
    }
    const picked = clip(change.picked, PICKED_MAX);
    if (!picked) continue;
    if (change.messageId && entries.some((entry) => entry.messageId === change.messageId && entry.thread === change.thread && pickKey(entry.key) === pickKey(key))) continue;
    if (current && sameOption(current.picked, picked)) {
      if (overTap) {
        // pinned first: the identity hashes the time, and a merge must still find the tap
        current.source = identity(current);
        delete current.tapped;
        current.at = change.at;
        if (change.messageId) {
          current.thread = change.thread;
          current.messageId = change.messageId;
          current.questionId = change.questionId;
          current.said = said;
          current.files = change.files ?? [];
          current.picture = change.picture;
          current.overPictures = change.overPictures ?? [];
        }
        retyped = true;
      }
      continue;
    }
    const id = fresh(stamp);
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
      overPictures: change.overPictures ?? [],
      said,
      files: change.files ?? [],
      tweaks: [],
      extra: [],
    };
    if (change.picture) entry.picture = change.picture;
    if (tapped) entry.tapped = true;
    if (change.thread) entry.thread = change.thread;
    if (change.messageId) entry.messageId = change.messageId;
    if (change.questionId) entry.questionId = change.questionId;
    if (change.messageId || change.at % 60_000) entry.at = change.at;
    entries.push(entry);
    picks += 1;
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

export function currentPicks(text: string | null | undefined): PickEntry[] {
  return text ? parseTimeline(text).entries.filter((entry) => !entry.replacedBy) : [];
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
  for (const { entries } of timelines) {
    const sources = new Map(entries.map((entry) => [entry.id, identity(entry)]));
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const entry of entries) {
      const key = identity(entry);
      const next = entry.replacedBy ? sources.get(entry.replacedBy) : undefined;
      // typed beats tapped whatever the order, so a link between them orders nothing
      const ordered = Boolean(entry.tapped) === Boolean(entry.replacedBy && byId.get(entry.replacedBy)?.tapped);
      if (next && next !== key && ordered) parents.set(next, new Set([...(parents.get(next) ?? []), key]));
      const before = merged.get(key);
      if (!before) {
        merged.set(key, { ...entry, source: key, replacedBy: undefined });
        continue;
      }
      const typed = Boolean(before.tapped) !== Boolean(entry.tapped) ? (before.tapped ? entry : before) : undefined;
      const bound = typed ?? (before.messageId ? before : entry);
      if (bound.messageId) {
        merged.set(key, { ...bound, source: key, replacedBy: undefined, tweaks: said(before.tweaks, entry.tweaks), extra: union(before.extra, entry.extra) });
        continue;
      }
      const both: PickEntry = {
        ...before,
        picture: before.picture ?? entry.picture,
        over: union(before.over, entry.over), overPictures: union(before.overPictures, entry.overPictures),
        files: union(before.files, entry.files), tweaks: said(before.tweaks, entry.tweaks), extra: union(before.extra, entry.extra),
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
    const before = current.get(pickKey(entry.key));
    if (before && entry.tapped && !before.tapped) {
      entry.replacedBy = before.id;
      continue;
    }
    if (before) before.replacedBy = id;
    current.set(pickKey(entry.key), entry);
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
function keyIndex(entries: PickEntry[], room = Infinity): string {
  if (!entries.length) return "";
  const more = (count: number) => (count ? `${count === entries.length ? "" : " "}(+${count} more)` : "");
  let out = "\nAlso current, on file: ";
  for (const [index, entry] of entries.entries()) {
    const next = `${out}${index ? "; " : ""}${entry.key}`;
    if (promptTokens(next + more(entries.length - index - 1)) > room) return index || promptTokens(out + more(entries.length)) <= room ? out + more(entries.length - index) : "";
    out = next;
  }
  return out;
}

export function promptTokens(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += char.charCodeAt(0) < 128 ? 1 / CHARS_PER_TOKEN : 1;
  return tokens;
}

/** The prompt's current picks, newest first, within `max` estimated tokens: whole lines while every other key still fits, then the pick alone, then its key. Empty when there are none. */
export function picksBlock(text: string | null | undefined, max = PICKS_PROMPT_TOKENS): string {
  const live = currentPicks(text).reverse();
  if (!live.length) return "";
  let out = HEADER;
  const listed: PickEntry[] = [];
  for (const [index, entry] of live.entries()) {
    const rest = keyIndex([...listed, ...live.slice(index + 1)]);
    const line = [pickLine(entry), shortLine(entry)].find((option) => promptTokens(`${out}\n${option}${rest}`) <= max);
    // the newest pick always shows, its words if not its picture and tweaks
    if (line || !index) out += `\n${line ?? shortLine(entry)}`;
    else listed.push(entry);
  }
  return out + keyIndex(listed, max - promptTokens(out));
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
