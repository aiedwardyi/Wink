// Budget filing: once MEMORY.md nears its load budget, whole old notes move word for word into a new memory/<topic>.md,
// leaving one pointer line that says when to read it. It only moves lines; scripts/dream-check.ts runs it on copies.
import { z } from "zod";

import { cleanerSkip, noteGroups, sha256 } from "./memory-clean.ts";
import { MEMORY_LINE_MAX_BYTES, MEMORY_MAX_BYTES, MEMORY_MAX_LINES } from "./workspace.ts";

/** Filing starts this full, the share of the load budget that brings the trim notice. */
const FILE_FROM_SHARE = 0.8;
export const FILE_TO_BYTES = 16_000;
export const FILE_TO_LINES = 140;
export const FILE_NIGHT_BYTES = 4_000;
export const TOPICS_MAX = 3;
const PROMPT_NOTES_MAX = 32_000;
const HEADING = /^(#{1,6})\s/;
const FENCE = /^\s*(?:```|~~~)/;
const FENCE_MARK = /^\s*(`{3,}|~{3,})(.*?)\r?$/;
const PROMPT_TAGS = /<\/?notes\b[^>]*>/gi;
// standing orders the bot needs every turn
const KEPT_SECTION = /\b(?:pin(?:ned|s)?|rules?|decisions?|goals?|lessons?|corrections?)\b/i;
// ASCII until side-file sync takes any name (#2137)
const TOPIC = /^[a-z0-9][a-z0-9-]{0,59}\.md$/;
const WHEN = /^(?:when|whenever|before|after|if|while|during)\b/i;
// a "never act on" pointer guards history or a parked copy; nothing new goes there
const OPENS = /\b(?:when|whenever|before|after|if|while|during|first|start)\b/i;

// the prompt, this schema and planFiling take one topic limit together
const filingSchema = (topics: number) => z.object({
  files: z.array(z.object({ topic: z.string(), about: z.string().nullish(), when: z.string().nullish(), notes: z.array(z.string()).max(60) })).max(2 * topics).nullish(),
});

/** at..end: the note's lines, its indented lines included; section: the heading it sits under. */
export type FileNote = { at: number; end: number; text: string; bytes: number; section: string };
/** pointer: the new line in MEMORY.md, or null when the notes join a side file MEMORY.md already says when to read. */
export type Filed = { topic: string; pointer: string | null; lines: string[]; notes: Array<{ ref: string; text: string }> };
/** A side file a loaded line already says when to read, and that line. */
export type SideFile = { name: string; line: string };
/** topics: the text each side file gains by name; bytes: what left MEMORY.md, pointers aside. */
export type Filing = { memory: string; topics: Record<string, string>; filed: Filed[]; bytes: number };

const size = (text: string) => Buffer.byteLength(text, "utf8");

/** Filing starts past FILE_FROM_SHARE of the load budget and, once `started`, goes on until MEMORY.md is down to FILE_TO_BYTES and FILE_TO_LINES. */
export function filingDue(raw: string, started = false): boolean {
  const [bytes, lines] = [size(raw), raw.split("\n").length];
  if (bytes <= FILE_TO_BYTES && lines <= FILE_TO_LINES) return false;
  return started || bytes >= MEMORY_MAX_BYTES * FILE_FROM_SHARE || lines >= MEMORY_MAX_LINES * FILE_FROM_SHARE;
}

/** Notes MEMORY.md may file: whole top-level notes outside code, under a ## or deeper heading that is not standing orders, never a label or a pointer to a side file. */
export function fileableNotes(raw: string): FileNote[] {
  const lines = raw.split("\n");
  const notes: FileNote[] = [];
  const headings: string[] = [];
  // the open fence; only the same mark, as long or longer and bare, closes it
  let fence = "";
  for (let at = 0; at < lines.length; at += 1) {
    const text = lines[at]!;
    const mark = FENCE_MARK.exec(text);
    if (mark && !fence) fence = mark[1]!;
    else if (mark && mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = "";
    const heading = HEADING.exec(text);
    if (fence || mark || heading) {
      if (heading && !fence) {
        headings.length = heading[1]!.length - 1;
        headings.push(text.trimEnd());
      }
      continue;
    }
    if (!/^\S/.test(text)) continue;
    let end = at + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end]!)) end += 1;
    const note = lines.slice(at, end).join("\n");
    // an indented line after a blank still belongs to the note above it
    const next = lines.slice(end).find((line) => line.trim());
    const under = headings.slice(1).filter(Boolean);
    const kept = !under.length || under.some((each) => KEPT_SECTION.test(each)) || /:\s*$/.test(text) || /\bmemory[\\/]/i.test(note) || note.split("\n").some((line) => FENCE.test(line));
    if (!kept && (next === undefined || !/^\s/.test(next))) notes.push({ at, end, text: note, bytes: size(note) + 1, section: under.at(-1)! });
    at = end - 1;
  }
  return notes;
}

/** The side files filing may add to: named by a loaded line that says when to read them, never a "never act on" line. */
export const openFiles = (files: readonly SideFile[]) => files.filter(({ line }) => OPENS.test(line) && !/\bnever\b/i.test(line));

export function filingPrompt(notes: readonly FileNote[], bytes: number, files: readonly SideFile[] = [], topics = TOPICS_MAX): string {
  let used = 0;
  const open = openFiles(files);
  const shown = notes.filter((note) => !cleanerSkip(note.text) && (used += note.bytes + 24) <= PROMPT_NOTES_MAX);
  return [
    "You file a bot's notes into side files so the memory it loads every session gets shorter. The bot opens a side file only when its pointer line says when.",
    "Pick notes that are reference detail needed only in some situations: a project, a tool, a person, a place, a past event, the steps for one kind of task. Prefer older notes.",
    "Never pick a note that should shape every reply: how to talk to the user, tone, length, format, honesty, safety, or who the user is.",
    `Pick close to ${bytes} bytes of notes in total (each note shows its size), in at most ${topics} topic${topics === 1 ? "" : "s"}, each one kind of situation.`,
    "A note goes into a side file only when it is about that file's subject, so that a reader of the pointer line alone would look there for it. Leave out a note no file fits.",
    ...(open.length ? ["Prefer a side file the bot already has (listed below with its pointer line); give its name as topic and leave about and when empty."] : []),
    'For a new topic give: topic, a new file name of lowercase ASCII letters, digits and dashes ending in .md; about, a few words that cover every note in it; when, starting with "when" or "before", the situations in which the bot must open the file, so a reader of that line alone knows to open it. Always give notes, the refs.',
    'Reply with JSON only: {"files": [{"topic": "video-production.md", "about": "Video and clip production", "when": "before making, cutting or judging any video or clip", "notes": ["L12", "L40"]}]}, or {"files": []} when nothing qualifies.',
    "",
    ...(open.length ? ["SIDE FILES THE BOT HAS:", ...open.map(({ name, line }) => `memory/${name}: ${line.trim()}`), ""] : []),
    "NOTES:",
    "<notes>",
    ...shown.map((note) => `L${note.at + 1} (${note.bytes} B, ${note.section.replace(/^#+\s*/, "")}): ${note.text.replace(PROMPT_TAGS, " ")}`),
    "</notes>",
  ].join("\n");
}

export function parseFiling(output: string, topics = TOPICS_MAX): z.infer<ReturnType<typeof filingSchema>> {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return {};
  try {
    const parsed = filingSchema(topics).safeParse(JSON.parse(output.slice(start, end + 1)));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** What to ask the model for: enough to reach FILE_TO_BYTES with room for the pointers, and half again for notes routing turns away. */
export const filingBytes = (raw: string) => Math.round(1.5 * Math.min(FILE_NIGHT_BYTES, Math.max(0, size(raw) - FILE_TO_BYTES) + 2 * MEMORY_LINE_MAX_BYTES));

/** skip: note refs routing turned away; nightBytes: the night's cap, raised only to route more candidates than the night files; topics: the filingPrompt limit; repoint: existing side files no line points at, which a new pointer may take. */
export type FilingOptions = { files?: readonly SideFile[]; skip?: ReadonlySet<string>; nightBytes?: number; topics?: number; repoint?: readonly string[] };

/** What the model's picks file: whole fileable notes into new side files, FILE_NIGHT_BYTES at most, stopping at FILE_TO_BYTES and FILE_TO_LINES. Each topic's pointer takes its first note's place. Null when nothing qualifies. */
export function planFiling(raw: string, reply: string, existing: readonly string[], { files = [], skip = new Set(), nightBytes = FILE_NIGHT_BYTES, topics = TOPICS_MAX, repoint = [] }: FilingOptions = {}): Filing | null {
  const lines = raw.split("\n");
  const notes = new Map<string, FileNote>(fileableNotes(raw).filter((note) => !skip.has(`L${note.at + 1}`) && !cleanerSkip(note.text)).map((note) => [`L${note.at + 1}`, note]));
  const pointless = new Set(repoint.map((name) => name.toLowerCase()));
  const taken = new Set(existing.map((name) => name.toLowerCase()).filter((name) => !pointless.has(name)));
  const open = new Map(openFiles(files).map(({ name }) => [name.toLowerCase(), name]));
  let [bytes, count, moved] = [size(raw), lines.length, 0];
  const picks: Array<{ topic: string; pointer: string | null; notes: FileNote[] }> = [];
  const capped = nightBytes === FILE_NIGHT_BYTES;
  for (const { topic, about, when, notes: refs } of parseFiling(reply, topics).files ?? []) {
    if (picks.length >= topics) break;
    const joins = open.get(topic.trim().replace(/^memory[\\/]/i, "").toLowerCase());
    const name = joins ?? topic.trim().toLowerCase();
    const [what, said] = [(about ?? "").trim().replace(/[\s:.]+$/, ""), (when ?? "").trim().replace(/[\s.]+$/, "")];
    const pointer = joins ? null : `- ${what}: read memory/${name} ${said}.`;
    if (picks.some((pick) => pick.topic === name)) continue;
    if (pointer !== null && (!TOPIC.test(name) || taken.has(name) || !what || !WHEN.test(said) || /[\r\n]/.test(pointer) || size(pointer) > MEMORY_LINE_MAX_BYTES)) continue;
    const [extra, lines1] = pointer === null ? [0, 0] : [size(pointer) + 1, 1];
    const picked: FileNote[] = [];
    for (const ref of refs) {
      const note = notes.get(ref);
      if (capped && bytes + extra <= FILE_TO_BYTES && count + lines1 <= FILE_TO_LINES) break;
      if (!note || moved + note.bytes > nightBytes) continue;
      picked.push(note);
      notes.delete(ref);
      [bytes, count, moved] = [bytes - note.bytes, count - (note.end - note.at), moved + note.bytes];
    }
    if (!picked.length) continue;
    [bytes, count] = [bytes + extra, count + lines1];
    taken.add(name);
    picks.push({ topic: name, pointer, notes: picked.sort((a, b) => a.at - b.at) });
  }
  if (!picks.length) return null;
  // a pointer keeps the line ending of the note it replaces
  const pointers = new Map(picks.flatMap(({ pointer, notes: picked }) => (pointer === null ? [] : [[picked[0]!.at, lines[picked[0]!.at]!.endsWith("\r") ? `${pointer}\r` : pointer] as const])));
  const gone = new Set(picks.flatMap(({ notes: picked }) => picked.flatMap(({ at, end }) => Array.from({ length: end - at }, (_, index) => at + index))));
  const filed = picks.map(({ topic, pointer, notes: picked }) => ({ topic, pointer, lines: picked.flatMap(({ at, end }) => lines.slice(at, end)), notes: picked.map(({ at, text }) => ({ ref: `L${at + 1}`, text })) }));
  return {
    memory: lines.flatMap((line, index) => (pointers.has(index) ? [pointers.get(index)!] : gone.has(index) ? [] : [line])).join("\n"),
    topics: Object.fromEntries(filed.map(({ topic, lines: text }) => [topic, `${text.join("\n")}\n`])),
    filed,
    bytes: moved,
  };
}

/** A fresh reader of MEMORY.md after the move names where it would look for each filed note, as the bot would. */
export function routePrompt(memory: string, filed: readonly Filed[]): string {
  const notes = filed.flatMap(({ notes: each }) => each.map(({ text }) => text));
  return [
    "You are a bot. MEMORY.md below loads into every session. Side files in memory/ do not; you read one only when a line in MEMORY.md says when to read it.",
    "For each note below, name the one file you would open when you need that note's information: a memory/<name>.md path, MEMORY.md, or none.",
    'Reply with JSON only: {"N1": "memory/example.md"}',
    "",
    "<memory>",
    memory.replace(PROMPT_TAGS, " "),
    "</memory>",
    "",
    ...notes.map((note, index) => `N${index + 1}: ${note.replace(/\s*\n\s*/g, " ")}`),
  ].join("\n");
}

/** The refs of filed notes the reader would not look for in the file they went to. */
export function misrouted(output: string, filed: readonly Filed[]): Set<string> {
  const start = output.indexOf("{");
  let routes: Record<string, string> = {};
  try {
    routes = start < 0 ? {} : z.record(z.string(), z.string()).catch({}).parse(JSON.parse(output.slice(start, output.lastIndexOf("}") + 1)));
  } catch {
    routes = {};
  }
  const path = (value: string | undefined) => (value ?? "").replace(/[`"']/g, "").replaceAll("\\", "/").replace(/^\.\//, "").trim().toLowerCase();
  const wrong = new Set<string>();
  const refs = filed.flatMap(({ topic, notes }) => notes.map(({ ref }) => [ref, `memory/${topic.toLowerCase()}`] as const));
  refs.forEach(([ref, target], index) => path(routes[`N${index + 1}`]) !== target && wrong.add(ref));
  return wrong;
}

const flat = (text: string) => text.replaceAll("\r", "");
const PLAN_TARGET = /^memory\/[a-z0-9][a-z0-9-]{0,59}\.md$/;
const count = z.number().int().nonnegative();
/** plan.json: each note by its sha256 and how often its text sits in MEMORY.md (1 to apply), never the text itself. */
export const movePlanSchema = z.object({
  copy: z.string().regex(/^[0-9a-f]{8}$/),
  notes: z.array(z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), matches: count, target: z.string().regex(PLAN_TARGET), pointer: z.string().nullable(), bytes: count }).strict()),
}).strict();
export type MovePlan = z.infer<typeof movePlanSchema>;

export function movePlan(raw: string, filing: Filing, copy: string): MovePlan {
  const text = flat(raw);
  return movePlanSchema.parse({
    copy,
    notes: filing.filed.flatMap(({ topic, pointer, notes }) =>
      notes.map((note, index) => ({ sha256: sha256(flat(note.text)), matches: text.split(flat(note.text)).length - 1, target: `memory/${topic}`, pointer: index ? null : pointer, bytes: Buffer.byteLength(flat(note.text)) })),
    ),
  });
}

export type MoveResult = { memory: string; side: Record<string, string>; moved: Array<{ sha8: string; bytes: number; target: string }>; skipped: number; bytes: number };

/** Applies a plan to MEMORY.md and its side files. A note moves only while its sha and single match hold; a note already in its side file is not appended again, so a second run or a lost tie changes nothing twice. */
export function applyMove(raw: string, side: Readonly<Record<string, string>>, plan: MovePlan): MoveResult {
  const lines = raw.split("\n");
  const text = flat(raw);
  const bySha = new Map<string, FileNote[]>();
  for (const note of fileableNotes(raw)) bySha.set(sha256(flat(note.text)), [...(bySha.get(sha256(flat(note.text))) ?? []), note]);
  const out: Record<string, string> = { ...side };
  const gone = new Set<number>();
  const pointers = new Map<number, string>();
  const moved: MoveResult["moved"] = [];
  let skipped = 0;
  for (const planned of plan.notes) {
    const hits = bySha.get(planned.sha256) ?? [];
    const note = hits[0];
    if (!note || hits.length !== 1 || planned.matches !== 1 || text.split(flat(note.text)).length - 1 !== 1) {
      skipped++;
      continue;
    }
    const name = planned.target.slice("memory/".length);
    const have = flat(out[name] ?? "");
    if (!noteGroups(have.split("\n")).some((group) => sha256(group.join("\n")) === planned.sha256)) out[name] = `${out[name] ?? ""}${have && !have.endsWith("\n") ? "\n" : ""}${flat(note.text)}\n`;
    for (let index = note.at; index < note.end; index++) gone.add(index);
    const pointed = lines.some((line, index) => !gone.has(index) && line.replaceAll("\\", "/").includes(planned.target)) || [...pointers.values()].some((line) => line.includes(planned.target));
    // a pointer keeps the line ending of the note it replaces
    if (planned.pointer && !pointed) pointers.set(note.at, lines[note.at]!.endsWith("\r") ? `${planned.pointer}\r` : planned.pointer);
    moved.push({ sha8: planned.sha256.slice(0, 8), bytes: planned.bytes, target: planned.target });
  }
  return {
    memory: lines.flatMap((line, index) => (pointers.has(index) ? [pointers.get(index)!] : gone.has(index) ? [] : [line])).join("\n"),
    side: out,
    moved,
    skipped,
    bytes: moved.reduce((sum, { bytes }) => sum + bytes, 0),
  };
}
