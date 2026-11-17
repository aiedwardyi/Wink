// The user's picks, one timeline per bot in memory/decisions.md: plain markdown, oldest first.

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
const HEADER = `Current picks, newest first. Each is the user's own choice and beats any older note that disagrees; build from a pick's picture plus every tweak, never a new option. Auto Notes keeps the history in the user's words in memory/${PICKS_FILE}; read it, never edit it.`;
const ID = String.raw`\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?(?: \(\d+\))?`;
const ENTRY = new RegExp(String.raw`^## (${ID}) \| (.+?) \| (?:current|replaced by (${ID}))\s*$`);
const TWEAK = new RegExp(String.raw`^- Tweak (${ID}): "(.*)"\s*$`);
const FIELD = /^- (Picked|Picture|Over|Over pictures|Said|Files): ?(.*?)\s*$/;
const SEPARATOR = "; ";
const CAPTIONED = /^(.+?\.(?:png|jpe?g|gif|webp|svg)) \((.*)\)$/i;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg)$/i;

export type Picture = { path: string; caption?: string };
export type Tweak = { at: string; said: string };
export type PickEntry = {
  id: string;
  key: string;
  replacedBy?: string;
  picked: string;
  picture?: Picture;
  over: string[];
  overPictures: Picture[];
  said?: string;
  files: string[];
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

export function pickStamp(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
  // a tweak said with its pick lands after it
  for (const change of [...changes].sort((a, b) => a.at - b.at || Number(a.kind === "tweak") - Number(b.kind === "tweak"))) {
    const asked = clip(change.key.replace(/\|/g, "/"), KEY_MAX);
    if (!pickKey(asked)) continue;
    const current = entries.findLast((entry) => !entry.replacedBy && pickKey(entry.key) === pickKey(asked));
    const key = current?.key ?? asked;
    const said = clip(change.said, SAID_MAX);
    if (change.kind === "tweak") {
      // a retried batch or a repeated ask adds nothing
      if (!current || !said || current.tweaks.some((tweak) => same(tweak.said, said))) continue;
      current.tweaks.push({ at: pickStamp(change.at), said });
      tweaks += 1;
      continue;
    }
    const picked = clip(change.picked, PICKED_MAX);
    if (!picked || (current && same(current.picked, picked))) continue;
    const id = fresh(pickStamp(change.at));
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
    entries.push(entry);
    picks += 1;
  }
  if (!picks && !tweaks) return null;
  return { text: renderTimeline({ head: timelineHead(head), entries }), picks, tweaks, replaced };
}

export function currentPicks(text: string | null | undefined): PickEntry[] {
  return text ? parseTimeline(text).entries.filter((entry) => !entry.replacedBy) : [];
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
  const head = pickKey(entry.key) === pickKey(entry.picked) ? `${entry.picked} (${monthDay(entry.id)})` : `${entry.key} (${monthDay(entry.id)}): ${entry.picked}`;
  const tweaks = shown.length ? ` + tweaks: ${shown.join(", ")}${earlier ? ` (+${earlier} earlier in memory/${PICKS_FILE})` : ""}` : "";
  const line = `- ${head}${entry.picture ? ` (${entry.picture.path})` : ""}${tweaks}`;
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 3)}...` : line;
}

export function promptTokens(text: string): number {
  let tokens = 0;
  for (const char of text) tokens += char.charCodeAt(0) < 128 ? 1 / CHARS_PER_TOKEN : 1;
  return tokens;
}

/** The prompt's current picks, newest first, whole lines up to `max` estimated tokens; empty when there are none. */
export function picksBlock(text: string | null | undefined, max = PICKS_PROMPT_TOKENS): string {
  const live = currentPicks(text).reverse();
  if (!live.length) return "";
  const rest = (count: number) => `\n${count} older current ${count === 1 ? "pick is" : "picks are"} only in memory/${PICKS_FILE}.`;
  let out = HEADER;
  for (const [index, entry] of live.entries()) {
    const line = `\n${pickLine(entry)}`;
    const after = live.length - index - 1;
    if (promptTokens(out + line + (after ? rest(after) : "")) > max) return out + rest(live.length - index);
    out += line;
  }
  return out;
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
