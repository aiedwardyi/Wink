import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { ProviderInstance } from "./contracts.ts";
import { MEMORY_SAVE_TOOL } from "./memory-save.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message, Store, StoreChange } from "./store.ts";
import { startTurnTrace, type UsageObserver } from "./turn-timing.ts";
import {
  ensureWorkspace,
  MEMORY_MAX_BYTES,
  MEMORY_MAX_LINES,
  MEMORY_SEED,
  memoryFileRaw,
  readMemoryFile,
  readMemoryTopic,
  saveMemoryFile,
} from "./workspace.ts";

const IDLE_MS = 3 * 60_000;
const BATCH_MESSAGES = 8;
const MAX_PASSES = 2;
const PASS_TIMEOUT_MS = 120_000;
const SAVE_DELAY_MS = 1_000;
const MAX_PENDING = 200;
const QUOTE_MAX = 120;
const FACT_MAX = 200;
const DECISION_MAX = 100;
const DECISIONS_PER_PASS = 3;
const DECISIONS_KEPT = 12;
const CONTEXT_MAX = 400;
const CONTEXT_LINE_MAX = 200;
const CONTEXT_SCAN = 50;
const SUMMARY_MAX = 120;
const STATE_FILE = "memory-pass.json";
const DECISIONS_FILE = "decisions.md";
const DECISIONS_HEADING = "## Decisions (settled, do not ask again)";
export const DECISIONS_POINTER = `- Older decisions: memory/${DECISIONS_FILE} - read it before asking the user to pick something they may have picked before.`;

const factsSchema = z.array(z.object({ kind: z.string().nullish(), fact: z.string(), quote: z.string(), replaces: z.string().nullish() })).max(20);
const droppedSchema = z.object({ dropped: z.number(), since: z.number() });
const stateSchema = z.object({
  threads: z.record(z.string(), z.array(z.string())),
  dropped: z.record(z.string(), droppedSchema).optional(),
});

export type NoteGenerator = (prompt: string, signal: AbortSignal, onUsage?: UsageObserver) => Promise<string>;
export type Fact = z.infer<typeof factsSchema>[number];
export type Note = { line: string; replaces?: string; kind?: "decision" };
/** A user line, with the end of the bot's reply before it when the line is short. */
export type UserLine = { text: string; context?: string };
export type DroppedNotes = z.infer<typeof droppedSchema>;

export interface MemoryPassDeps {
  store: Pick<Store, "onChange" | "messagesFor" | "groupByThread" | "botByThread" | "appendMessage">;
  /** The Claude one-shot call, whatever engine the bot runs; null when no Claude CLI is set up. */
  generate(botId: string): NoteGenerator | null;
  /** The bot's Auto notes switch, read live. */
  enabled(botId: string): boolean;
  busy(botId: string, threadId: string): boolean;
  dataDir: string;
  now?(): number;
}

export interface MemoryPass {
  /** Call when a 1:1 turn settles; `flush` runs the pass now, before the engine compacts. */
  onSettled(botId: string, threadId: string, flush?: boolean): void;
  /** Call after a config change: bots switched off drop pending ids and any running pass. */
  onConfigChanged(): void;
  /** Notes turned away because MEMORY.md was full, since the last save. */
  droppedNotes(botId: string): DroppedNotes | undefined;
  /** Resolves once no pass is running. */
  idle(): Promise<void>;
  dispose(): void;
}

export function noteGenerator(
  instances: readonly (Pick<ProviderInstance, "driverKind" | "enabled" | "generateText"> & { instanceId?: string })[],
  account?: { instanceId: string; available: boolean },
): NoteGenerator | null {
  if (account && !account.available) return null;
  const claude = instances.find((instance) => (!account || instance.instanceId === account.instanceId) && instance.driverKind === "claudeAgent" && instance.enabled && instance.generateText);
  return claude ? (prompt, signal, onUsage) => claude.generateText!(prompt, { signal, timeoutMs: PASS_TIMEOUT_MS, ephemeral: true, lean: true, ...(onUsage ? { onUsage } : {}) }) : null;
}

/** A user row typed on this PC into the chat, not a bot, routine, peer, draft or attachment. */
export function eligibleRow(message: Message | undefined): message is Message & { text: string } {
  return Boolean(
    message && message.role === "user" && message.kind === "text" && message.text !== undefined &&
      !message.from && !message.origin && !message.comm && !message.queued && !message.image && !message.hasImage,
  );
}

/** The user's own typing: pastes, attachments, code, quotes and long blocks cut; empty when it looks sensitive, unless the caller screens each line. */
export function userTyping(text: string, dropSensitive = true): string {
  const typed = text
    .replace(/<pasted-text\b[^>]*>[\s\S]*?<\/pasted-text>/gi, "")
    .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/gi, "")
    .replace(/<attached-(?:image|file)\b[^>]*\/>/gi, "")
    .replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|$)/g, "$1");
  // the whole message: a label and its value can sit in different paragraphs
  if (dropSensitive && secretLike(typed)) return "";
  const unwrapped = typed.replace(/"[^"\n]{81,}"|“[^”\n]{81,}”|'[^'\n]{81,}'/g, "");
  const kept = unwrapped
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.length <= 400 && paragraph.split("\n").length <= 6)
    .map((paragraph) => paragraph.split("\n").filter((line) => !line.trimStart().startsWith(">")).join("\n").trim())
    .filter(Boolean);
  return redactSecretsInText(kept.join("\n\n"));
}

const CONTEXT_TAGS = /<\/?(?:context|user_lines|notes)\b[^>]*>/gi;

/** The end of the bot's reply, as plain text that cannot close or open a prompt block. */
export function replyContext(text: string): string {
  const plain = redactSecretsInText(
    text.replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|$)/g, "$1").replace(CONTEXT_TAGS, " ").replace(/\s+/g, " ").trim(),
  );
  return plain.length > CONTEXT_MAX ? plain.slice(-CONTEXT_MAX).trimStart() : plain;
}

const sentByPerson = (message: Message) => message.role === "user" && message.kind === "text" && !message.from;

/** For each id, the bot's text reply or ask_user card just before it, if no other user line sits between. */
export function replyContexts(messages: readonly Message[], ids: string[]): Map<string, string> {
  const wanted = new Set(ids);
  const found = new Map<string, string>();
  for (let i = messages.length - 1, seen = 0; i >= 0 && seen < wanted.size; i -= 1) {
    if (!wanted.has(messages[i]!.id)) continue;
    seen += 1;
    for (let j = i - 1; j >= Math.max(0, i - CONTEXT_SCAN); j -= 1) {
      const message = messages[j]!;
      if (sentByPerson(message)) break;
      if (message.role !== "bot" || message.comm) continue;
      const text = message.kind === "text" ? message.text
        : message.kind === "options" && message.card?.askUser && !message.card.requestId ? `${message.card.subtitle}\n${message.card.options.join("\n")}`
        : undefined;
      if (!text?.trim()) continue;
      const context = replyContext(text);
      if (context) found.set(messages[i]!.id, context);
      break;
    }
  }
  return found;
}

export function notePrompt(notes: string, lines: UserLine[]): string {
  return [
    "You pick durable facts and decisions out of the user's own chat messages, for their notes file.",
    "",
    "Rules:",
    "- Use only USER LINES. Never guess, infer or add anything they did not say.",
    "- Keep facts that stay true: who they are, their age, languages, tools they use, likes and dislikes, how they want things done.",
    "- Skip one-off requests, questions, task details, and anything CURRENT NOTES already says.",
    "- A decision is a choice the user made between options, or a direction they set for how something should look or work. Keep it only if it will still matter next time that thing comes up.",
    "- CONTEXT is the end of the bot's message just before a user line. Use it only to see what a short answer like \"the second one\" or \"yes\" picked. The pick must still be in the user's own line; quote that line.",
    `- kind: "decision" or "fact". A decision names the thing and the pick, ${DECISION_MAX} characters max, for example "Picker look follows the theme". At most ${DECISIONS_PER_PASS} decisions.`,
    "- Never record passwords, PINs, codes, keys, tokens, account numbers or one-time codes.",
    "- fact: one short plain line about the user, for example \"38 years old\" or \"Can't read Korean\".",
    `- quote: the user's exact words that state the fact, copied verbatim, ${QUOTE_MAX} characters max.`,
    "- replaces: only when the fact makes a CURRENT NOTES line untrue or outdated, that whole line copied exactly. Otherwise leave it out.",
    "",
    "Reply with JSON only: [{\"kind\": \"fact\", \"fact\": \"...\", \"quote\": \"...\", \"replaces\": \"...\"}], or [] when nothing qualifies.",
    "",
    "CURRENT NOTES:",
    "<notes>",
    notes.trim() || "(empty)",
    "</notes>",
    "",
    "USER LINES:",
    "<user_lines>",
    lines.map(({ text, context }) => (context ? `<context>${context}</context>\n${text}` : text)).join("\n\n"),
    "</user_lines>",
  ].join("\n");
}

export function parseFacts(output: string): Fact[] {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const parsed = factsSchema.safeParse(JSON.parse(output.slice(start, end + 1)));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

const SECRET_WORDS =
  /\b(?:passwords?|passcodes?|passwd|pins?|otp|2fa|mfa|one[- ]time|verification codes?|security codes?|api[ _-]?keys?|secret|tokens?|private keys?|credentials?|account numbers?|card numbers?|routing numbers?|cvv|ssn|social security)\b/i;
// No \b here: it never fires between Hangul syllables.
const SECRET_WORDS_KO =
  /비밀\s*(?:번호|키)|비번|암호(?!화|학)|패스워드|패스코드|인증\s*(?:번호|코드)|보안\s*코드|일회용\s*(?:코드|번호)|(?:api|에이피아이)\s*키|토큰|개인\s*키(?!보드)|계좌\s*번호|카드\s*번호|주민\s*(?:등록\s*)?번호|핀\s*번호|시크릿/i;
const TOKEN_PATTERNS = [
  /«redacted/i,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|xox[abposr])[_-][A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/,
  /\b(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{24,}/,
];

export function secretLike(text: string): boolean {
  return redactSecretsInText(text) !== text || SECRET_WORDS.test(text) || SECRET_WORDS_KO.test(text) || TOKEN_PATTERNS.some((pattern) => pattern.test(text));
}

const STOP_WORDS = new Set(["the", "and", "but", "for", "with", "are", "was", "that", "this", "you", "your", "can", "can't", "cant", "don't", "dont", "just", "have", "has", "not", "i'm", "it's", "its", "really"]);

function quoteWords(quote: string): string[] {
  return (quote.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(
    (word) => (word.length >= 3 || /\d/.test(word)) && !STOP_WORDS.has(word),
  );
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
const sameLine = (line: string, target: string) => line.replace(/\r$/, "") === target;

/** A line only the note-taker wrote, found exactly once and claimed by one fact. */
function replaceable(target: string | null | undefined, lines: string[], claims: Map<string, number>): target is string {
  return Boolean(
    target && /\(noted \d{4}-\d{2}-\d{2}\)$/.test(target) && claims.get(target) === 1 &&
      lines.filter((line) => sameLine(line, target)).length === 1,
  );
}

const HEADING = /^#{1,6}\s/;
const LIST_LINE = /^\s*[-*+]\s/;
const STAMPED = /^\s*[-*+]\s.*\(noted (\d{4}-\d{2}-\d{2})\)\s*$/;

/** The `## Decisions` section as [heading index, end index), or null. */
function decisionSpan(lines: string[]): [number, number] | null {
  const start = lines.findIndex((line) => /^##\s+decisions\b/i.test(line));
  if (start < 0) return null;
  const next = lines.findIndex((line, index) => index > start && HEADING.test(line));
  return [start, next < 0 ? lines.length : next];
}

const contentWords = (text: string) =>
  words(text).filter((word) => (word.length >= 3 || /\d/.test(word) || /\P{ASCII}/u.test(word)) && !STOP_WORDS.has(word));
const sameStem = (a: string, b: string) => a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4));
const LITERALS = [
  /\b(?:[a-z][\w+.-]*:\/\/|www\.)\S+/gi,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  /\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\/\S*/gi,
  /\b[a-z]:[\\/]\S*|\\\\\S+|(?:^|\s)(?:~|\.{1,2})?\/[\w.-]+\/\S*/gi,
  /\b[\w.-]+(?:[\\/][\w.-]+)+\.[a-z0-9]{1,5}\b/gi,
  /`[^`]+`/g,
];

/** A decision whose words come from the quoted user line or the bot text before it, and whose URLs, paths and commands only from the user. */
function grounded(line: string, said: string, sources: UserLine[]): boolean {
  const own = sources.filter(({ text }) => squash(text).includes(squash(said)));
  const typed = squash(sources.map(({ text }) => text).join("\n"));
  if (LITERALS.some((pattern) => (line.match(pattern) ?? []).some((literal) => !typed.includes(squash(literal))))) return false;
  const known = own.flatMap(({ text, context }) => contentWords(`${text}\n${context ?? ""}`));
  const needed = contentWords(line);
  const hits = needed.filter((word) => known.some((source) => sameStem(word, source))).length;
  return hits > 0 && hits * 2 >= needed.length;
}

/** Facts that quote one non-sensitive user paragraph verbatim, carry no secret, and are not already noted. Decisions first, 3 at most; a fact on a decision's quote yields to it. */
export function acceptFacts(facts: Fact[], userText: string | UserLine[], notes: string, archived = ""): Note[] {
  const sources = Array.isArray(userText) ? userText : [{ text: userText }];
  const paragraphs = sources.map(({ text }) => text).join("\n\n").split(/\n\s*\n/).filter((paragraph) => !secretLike(paragraph)).map(squash);
  const lines = notes.split("\n");
  const span = decisionSpan(lines);
  const inSection = (target: string) => {
    const at = lines.findIndex((line) => sameLine(line, target));
    return Boolean(span && at > span[0] && at < span[1]);
  };
  const claims = new Map<string, number>();
  for (const { replaces } of facts) if (replaces) claims.set(replaces, (claims.get(replaces) ?? 0) + 1);
  const seen = new Set<string>();
  const decided = new Set<string>();
  const accept = ({ kind, fact, quote, replaces }: Fact): Note | null => {
    const decision = kind === "decision";
    const line = fact.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim();
    const said = quote.trim();
    if (!line || line.length > (decision ? DECISION_MAX : FACT_MAX) || !said || said.length > QUOTE_MAX) return null;
    if (!paragraphs.some((paragraph) => paragraph.includes(squash(said)))) return null;
    if (secretLike(line) || secretLike(said)) return null;
    if (decision ? decided.size >= DECISIONS_PER_PASS || !grounded(line, said, sources) : decided.has(squash(said))) return null;
    const target = replaceable(replaces, lines, claims) && inSection(replaces) === decision ? replaces : undefined;
    const noted = [...lines.filter((note) => !target || !sameLine(note, target)), ...archived.split("\n")].map(words);
    const quoted = quoteWords(said);
    // a short pick like "yes" says nothing on its own
    if (!decision && quoted.length && noted.some((note) => quoted.every((word) => note.includes(word)))) return null;
    const key = words(line).join(" ") || squash(line);
    if (seen.has(key) || noted.some((note) => ` ${note.join(" ")} `.includes(` ${key} `))) return null;
    seen.add(key);
    if (decision) decided.add(squash(said));
    const note: Note = { line };
    if (target) note.replaces = target;
    if (decision) note.kind = "decision";
    return note;
  };
  const picks = new Map(facts.flatMap((fact, index) => (fact.kind === "decision" ? [[index, accept(fact)] as const] : [])));
  return facts.flatMap((fact, index) => (picks.has(index) ? picks.get(index) : accept(fact)) ?? []);
}

function day(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Adds decisions at the end of `## Decisions` (made under the title and its intro), then rolls the oldest stamped lines past the cap out. */
function fileDecisions(lines: string[], decided: string[]): string[] {
  let span = decisionSpan(lines);
  if (!span) {
    const title = lines.findIndex((line) => /^#\s/.test(line));
    let at = title + 1;
    if (title >= 0) while (at < lines.length && !HEADING.test(lines[at]!) && !LIST_LINE.test(lines[at]!)) at += 1;
    while (at > title + 1 && !lines[at - 1]!.trim()) at -= 1;
    const next = lines.slice(at).find((line) => line.trim());
    // notes right below would otherwise read as decisions
    const loose = next !== undefined && !HEADING.test(next);
    const block = [...(at > 0 && lines[at - 1]!.trim() ? [""] : []), DECISIONS_HEADING, ...(loose ? ["", "## Notes"] : [])];
    if (!loose && lines[at]?.trim()) block.push("");
    lines.splice(at, 0, ...block);
    span = decisionSpan(lines)!;
  }
  let last = span[0];
  for (let index = span[0] + 1; index < span[1]; index += 1) if (LIST_LINE.test(lines[index]!)) last = index;
  lines.splice(last + 1, 0, ...decided);
  const moved: string[] = [];
  for (;;) {
    const [start, end] = decisionSpan(lines)!;
    const stamped = lines.slice(start + 1, end).flatMap((line, index) => {
      const match = STAMPED.exec(line);
      return match ? [{ at: start + 1 + index, day: match[1]! }] : [];
    });
    if (stamped.length <= DECISIONS_KEPT) break;
    const oldest = stamped.reduce((a, b) => (b.day < a.day ? b : a));
    moved.push(lines[oldest.at]!.replace(/\r$/, ""));
    lines.splice(oldest.at, 1);
  }
  const [start, end] = decisionSpan(lines)!;
  if (moved.length && !lines.slice(start + 1, end).some((line) => sameLine(line, DECISIONS_POINTER))) lines.splice(start + 1, 0, DECISIONS_POINTER);
  return moved;
}

/** MEMORY.md with replaced lines swapped in place, decisions filed under their section and the rest appended, plus the decision lines rolled out; null past the load budget. */
export function placeNotes(raw: string, notes: Note[], now: number): { text: string; moved: string[] } | null {
  const base = raw.trim() ? raw : MEMORY_SEED;
  const stamp = day(now);
  const lines = base.split("\n");
  const added: string[] = [];
  const decided: string[] = [];
  for (const { line, replaces, kind } of notes) {
    const at = replaces === undefined ? [] : lines.flatMap((current, index) => (sameLine(current, replaces) ? [index] : []));
    if (at.length === 1) lines[at[0]!] = `- ${line} (noted ${stamp})${lines[at[0]!]!.endsWith("\r") ? "\r" : ""}`;
    else (kind === "decision" ? decided : added).push(`- ${line} (noted ${stamp})`);
  }
  const moved = decided.length ? fileDecisions(lines, decided) : [];
  const swapped = lines.join("\n");
  const head = added.length && decisionSpan(lines)?.[1] === lines.length ? "\n## Notes\n" : "";
  const text = `${swapped.endsWith("\n") ? swapped : `${swapped}\n`}${head}${added.map((line) => `${line}\n`).join("")}`;
  if (text.split("\n").length > MEMORY_MAX_LINES || Buffer.byteLength(text, "utf8") > MEMORY_MAX_BYTES) return null;
  return { text, moved };
}

export function appendNotes(raw: string, notes: Note[], now: number): string | null {
  return placeNotes(raw, notes, now)?.text ?? null;
}

/** Rolled lines appended to memory/decisions.md, skipping any already there, so a retried save never doubles one. */
function fileOlderDecisions(botId: string, moved: string[]): void {
  const current = readMemoryTopic(botId, DECISIONS_FILE) ?? "";
  const have = new Set(current.split("\n").map((line) => line.replace(/\r$/, "")));
  const fresh = moved.filter((line) => !have.has(line));
  if (!fresh.length) return;
  const head = current.trim() ? (current.endsWith("\n") ? current : `${current}\n`) : "# Older decisions\n\n";
  writeFileAtomic(join(ensureWorkspace(botId), "memory", DECISIONS_FILE), `${head}${fresh.map((line) => `${line}\n`).join("")}`, { mode: 0o600 });
}

export function noteSummary(facts: string[]): string {
  const joined = facts.join(", ");
  return joined.length > SUMMARY_MAX ? `${joined.slice(0, SUMMARY_MAX - 3).trimEnd()}...` : joined;
}

/** The pending rows, scanned from the newest end until every id is found. */
export function pendingRows(messages: readonly Message[], ids: string[]): Map<string, Message> {
  const wanted = new Set(ids);
  const found = new Map<string, Message>();
  for (let i = messages.length - 1; i >= 0 && found.size < wanted.size; i -= 1) {
    const message = messages[i]!;
    if (wanted.has(message.id)) found.set(message.id, message);
  }
  return found;
}

const UNAVAILABLE = /ENOENT|not logged in|log ?in|login|sign ?in|authenticat|api key/i;

interface PassLog {
  botId: string;
  threadId: string;
  lines?: number;
  facts?: number;
  decisions?: number;
  replaced?: number;
  rolled?: number;
  ms: number;
  result: "saved" | "none" | "busy" | "too-large" | "conflict" | "error";
}

interface Batch {
  ids: string[];
  facts: Fact[];
  source: UserLine[];
}

/** Notes passing facts from new user lines into MEMORY.md once a 1:1 chat goes quiet. Never on the reply path. */
export function createMemoryPass(deps: MemoryPassDeps): MemoryPass {
  const now = deps.now ?? Date.now;
  const statePath = join(deps.dataDir, STATE_FILE);
  const pending = new Map<string, string[]>();
  const dropped = new Map<string, DroppedNotes>();
  // generated but unsaved, so a busy turn or a moved revision never pays for the same batch twice
  const held = new Map<string, Batch>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queue: Array<{ botId: string; threadId: string }> = [];
  const running = new Map<string, { botId: string; done: Promise<void>; controller: AbortController }>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let warned = false;
  let disposed = false;

  try {
    const state = stateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
    for (const [threadId, ids] of Object.entries(state.threads)) {
      if (ids.length) pending.set(threadId, ids);
    }
    for (const [botId, record] of Object.entries(state.dropped ?? {})) dropped.set(botId, record);
  } catch {
    // first run or unreadable: start empty
  }

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    try {
      const state: z.infer<typeof stateSchema> = { threads: Object.fromEntries(pending) };
      if (dropped.size) state.dropped = Object.fromEntries(dropped);
      writeFileAtomic(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`[memory-pass] state save failed (${error instanceof Error ? error.name : "error"})`);
    }
  };
  const saveSoon = () => {
    if (saveTimer || disposed) return;
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
    saveTimer.unref?.();
  };

  const arm = (botId: string, threadId: string) => {
    clearTimeout(timers.get(threadId));
    const timer = setTimeout(() => {
      timers.delete(threadId);
      enqueue(botId, threadId);
    }, IDLE_MS);
    timer.unref?.();
    timers.set(threadId, timer);
  };

  const enqueue = (botId: string, threadId: string) => {
    if (disposed || running.has(threadId) || queue.some((item) => item.threadId === threadId)) return;
    clearTimeout(timers.get(threadId));
    timers.delete(threadId);
    queue.push({ botId, threadId });
    pump();
  };

  const warnOnce = (reason: string) => {
    if (warned) return;
    warned = true;
    console.warn(`[memory-pass] skipping note passes: ${reason}`);
  };

  const log = (fields: PassLog) => console.info(`[memory-pass] ${JSON.stringify(fields)}`);

  const done = (threadId: string, ids: string[]) => {
    held.delete(threadId);
    const taken = new Set(ids);
    const rest = (pending.get(threadId) ?? []).filter((id) => !taken.has(id));
    if (rest.length) pending.set(threadId, rest);
    else pending.delete(threadId);
    save();
  };

  const land = (botId: string, threadId: string, batch: Batch, memory: { text: string; revision: string }, raw: string, ms: number) => {
    const facts = acceptFacts(batch.facts, batch.source, memory.text, readMemoryTopic(botId, DECISIONS_FILE) ?? "");
    if (!facts.length) {
      log({ botId, threadId, lines: batch.source.length, facts: 0, ms, result: "none" });
      return done(threadId, batch.ids);
    }
    // a turn may be writing MEMORY.md and its own save chip; retry after it
    if (deps.busy(botId, threadId)) {
      held.set(threadId, batch);
      log({ botId, threadId, facts: facts.length, ms, result: "busy" });
      return arm(botId, threadId);
    }
    const placed = placeNotes(raw, facts, now());
    if (!placed) {
      log({ botId, threadId, facts: facts.length, ms, result: "too-large" });
      const last = dropped.get(botId);
      dropped.set(botId, { dropped: (last?.dropped ?? 0) + facts.length, since: last?.since ?? now() });
      return done(threadId, batch.ids);
    }
    if (placed.moved.length) {
      try {
        fileOlderDecisions(botId, placed.moved);
      } catch (error) {
        held.set(threadId, batch);
        log({ botId, threadId, facts: facts.length, ms, result: "error" });
        console.warn(`[memory-pass] decisions.md write failed (${error instanceof Error ? error.name : "error"})`);
        return arm(botId, threadId);
      }
    }
    if (saveMemoryFile(botId, placed.text, memory.revision).conflict) {
      held.set(threadId, batch);
      log({ botId, threadId, facts: facts.length, ms, result: "conflict" });
      return arm(botId, threadId);
    }
    deps.store.appendMessage(threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: MEMORY_SAVE_TOOL, ok: true, spoken: noteSummary(facts.map((note) => note.line)) },
    });
    log({
      botId, threadId, lines: batch.source.length, facts: facts.length, decisions: facts.filter((note) => note.kind).length,
      replaced: facts.filter((note) => note.replaces).length, rolled: placed.moved.length, ms, result: "saved",
    });
    dropped.delete(botId);
    done(threadId, batch.ids);
  };

  const run = async (botId: string, threadId: string, signal: AbortSignal) => {
    const ids = [...(pending.get(threadId) ?? [])];
    if (!ids.length || !deps.enabled(botId)) return;
    const kept = held.get(threadId);
    if (kept) {
      land(botId, threadId, kept, readMemoryFile(botId), memoryFileRaw(botId), 0);
      if (pending.has(threadId) && !held.has(threadId)) arm(botId, threadId);
      return;
    }
    const generate = deps.generate(botId);
    if (!generate) return warnOnce("no Claude CLI instance");
    const messages = deps.store.messagesFor(threadId);
    const rows = pendingRows(messages, ids);
    const typed = ids.flatMap((id) => {
      const row = rows.get(id);
      const text = eligibleRow(row) ? userTyping(row.text) : "";
      return text ? [{ id, text }] : [];
    });
    const contexts = replyContexts(messages, typed.filter(({ text }) => text.length <= CONTEXT_LINE_MAX).map(({ id }) => id));
    const lines: UserLine[] = typed.map(({ id, text }) => (contexts.has(id) ? { text, context: contexts.get(id)! } : { text }));
    if (!lines.length) return done(threadId, ids);
    const memory = readMemoryFile(botId);
    const raw = memoryFileRaw(botId);
    const started = now();
    const trace = startTurnTrace(() => ({ engine: "claude", botId, threadId, batchId: `${threadId}:${ids.join(":")}`, sourceMessageIds: ids, sourceSendIds: ids.flatMap((id) => rows.get(id)?.sendId ? [rows.get(id)!.sendId!] : []) }));
    const endPass = trace?.span("background_pass");
    let request = 0;
    let outcome = "helper-failed";
    let output: string;
    try {
      output = await generate(notePrompt(memory.text, lines), signal, trace ? (usage, id) => {
        request++;
        trace.request(id ?? `helper:${request}`, usage);
      } : undefined);
      outcome = "helper-settled";
    } catch (error) {
      if (disposed || !deps.enabled(botId)) return;
      if (UNAVAILABLE.test(error instanceof Error ? error.message : String(error))) {
        return warnOnce("Claude CLI missing or signed out");
      }
      log({ botId, threadId, lines: lines.length, ms: now() - started, result: "error" });
      return;
    } finally {
      if (trace && !request) trace.request("helper:unknown", undefined);
      endPass?.();
      trace?.finish(signal.aborted ? "cancelled" : outcome);
    }
    // switched off mid-pass: write nothing, and the dropped ids stay dropped
    if (disposed || signal.aborted || !deps.enabled(botId)) return;
    land(botId, threadId, { ids, facts: parseFacts(output), source: lines }, memory, raw, now() - started);
  };

  const pump = () => {
    for (let i = 0; i < queue.length && running.size < MAX_PASSES; ) {
      const { botId, threadId } = queue[i]!;
      if ([...running.values()].some((pass) => pass.botId === botId)) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      if (deps.busy(botId, threadId)) {
        arm(botId, threadId);
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PASS_TIMEOUT_MS);
      timer.unref?.();
      const pass = { botId, controller, done: Promise.resolve() };
      running.set(threadId, pass);
      pass.done = run(botId, threadId, controller.signal)
        .catch((error) => console.warn(`[memory-pass] pass failed (${error instanceof Error ? error.name : "error"})`))
        .finally(() => {
          clearTimeout(timer);
          running.delete(threadId);
          pump();
        });
    }
  };

  const unsubscribe = deps.store.onChange((change: StoreChange) => {
    if (disposed) return;
    if (change.type === "bot.deleted" || (change.type === "bot" && !deps.enabled(change.botId))) return stop();
    if (change.type !== "message" || change.imported) return;
    const { message, threadId } = change;
    if (message.role !== "user" || message.kind !== "text" || deps.store.groupByThread(threadId)) return;
    const bot = deps.store.botByThread(threadId);
    if (!bot || !deps.enabled(bot.id)) return;
    const ids = pending.get(threadId) ?? [];
    if (!ids.includes(message.id)) ids.push(message.id);
    pending.set(threadId, ids.slice(-MAX_PENDING));
    clearTimeout(timers.get(threadId));
    timers.delete(threadId);
    saveSoon();
  });

  const stop = () => {
    const off = (threadId: string) => {
      const bot = deps.store.botByThread(threadId);
      return !bot || !deps.enabled(bot.id);
    };
    for (const [threadId, timer] of timers) {
      if (!off(threadId)) continue;
      clearTimeout(timer);
      timers.delete(threadId);
    }
    for (let i = queue.length - 1; i >= 0; i -= 1) if (off(queue[i]!.threadId)) queue.splice(i, 1);
    for (const [threadId, pass] of running) if (off(threadId)) pass.controller.abort();
    for (const threadId of held.keys()) if (off(threadId)) held.delete(threadId);
    const before = pending.size;
    for (const threadId of pending.keys()) if (off(threadId)) pending.delete(threadId);
    if (pending.size !== before) save();
  };

  stop();
  for (const threadId of pending.keys()) {
    const bot = deps.store.botByThread(threadId);
    if (bot) arm(bot.id, threadId);
  }

  return {
    onSettled(botId, threadId, flush) {
      const count = pending.get(threadId)?.length ?? 0;
      if (disposed || !count || !deps.enabled(botId)) return;
      if (flush || count >= BATCH_MESSAGES || held.has(threadId)) enqueue(botId, threadId);
      else arm(botId, threadId);
    },
    onConfigChanged() {
      if (!disposed) stop();
    },
    droppedNotes: (botId) => dropped.get(botId),
    async idle() {
      while (running.size) await Promise.all([...running.values()].map((pass) => pass.done));
    },
    dispose() {
      disposed = true;
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      queue.length = 0;
      for (const pass of running.values()) pass.controller.abort();
      if (saveTimer) save();
    },
  };
}
