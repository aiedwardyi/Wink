import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { ProviderInstance } from "./contracts.ts";
import { AGY_TEXT_MODEL, exhaustedWindow, usageLimitFromError } from "./drivers/rate-limits.ts";
import { isSignOut } from "./drivers/signout.ts";
import { MEMORY_SAVE_TOOL } from "./memory-save.ts";
import { labeledOptions, offersOption, QUOTE_LABEL, replyTurns, validatePickBinding, type PickBinding, type ReplyPictures } from "./pick-sources.ts";
import { applyPicks, currentPicks, KEY_MAX, LABELED, parseTimeline, PICKS_FILE, pickKey, pickKeysList, sameOption, type PickChange, type PickEntry, type Picture } from "./picks.ts";
import { loadProfileSyncSettings } from "./profile-sync.ts";
import type { RateLimitsMap } from "./rate-limits-store.ts";
import { redactRoomMemory, redactSecretsInText } from "./redact.ts";
import type { Message, Store, StoreChange } from "./store.ts";
import { chatSyncBotId } from "./thread-sync.ts";
import { startTurnTrace, type UsageObserver } from "./turn-timing.ts";
import {
  appendLines,
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
const CONTEXT_MAX = 400;
const OPTIONS_MAX = 6;
const SHORT_ANSWER = 6;
const SUMMARY_MAX = 120;
const STATE_FILE = "memory-pass.json";
// A helper limit that named no reset holds notes for the shortest subscription
// window: a spent window is back by then, and a throttle long over.
const BARE_LIMIT_MS = 5 * 60 * 60_000;
export const OVERFLOW_FILE = "auto-notes-overflow.md";
const OVERFLOW_HEAD = "# Auto notes overflow\n\nAuto Notes saved here while MEMORY.md was full.\n\n";
const OVERFLOW_POINTER = `memory/${OVERFLOW_FILE}: Auto Notes saved while this file was full; read it when a fact seems missing`;

const listSchema = z.union([z.array(z.string()), z.string()]).nullish();
const factsSchema = z
  .array(z.object({
    kind: z.string().nullish(), fact: z.string(), quote: z.string(), replaces: z.string().nullish(),
    key: z.string().nullish(), over: listSchema, picture: z.string().nullish(), over_pictures: listSchema,
    message_id: z.string().nullish(), question_id: z.string().nullish(),
  }));
const droppedSchema = z.object({ dropped: z.number(), since: z.number() });
// a row by its words and the day it was noted, so rows coming or going around it never move it; one written here also keeps the rows in its words above it
const landedSchema = z.object({ line: z.string(), date: z.string(), copy: z.number().optional() });
const stateSchema = z.object({
  host: z.string().optional(),
  threads: z.record(z.string(), z.array(z.string())),
  // notes a full MEMORY.md turned away before the overflow file; they are gone, never reported as moved
  dropped: z.record(z.string(), droppedSchema).optional(),
  overflow: z.record(z.string(), droppedSchema).optional(),
  // a held batch as accepted and where its overflow rows are, so a restart lands it as it was and never adds them again
  held: z.record(z.string(), z.object({
    ids: z.array(z.string()),
    notes: z.array(z.object({ line: z.string(), replaces: z.string().optional(), kind: z.enum(["decision", "tweak"]).optional(), quote: z.string().optional() })),
    picked: z.boolean().optional(),
    wrote: z.array(landedSchema).optional(),
    seen: z.array(landedSchema).optional(),
  })).optional().catch(undefined),
  // restored from another PC: left to it once this copy syncs the bot's chats
  foreign: z.record(z.string(), z.array(z.string())).optional(),
  // cards the bot closed as answered in chat after their reply's pass, still to be filed
  owed: z.record(z.string(), z.array(z.string())).optional(),
});

export type NoteGenerator = ((prompt: string, signal: AbortSignal, onUsage?: UsageObserver) => Promise<string>) & { engine?: string };
export type Fact = z.infer<typeof factsSchema>[number];
export type Note = { line: string; replaces?: string; kind?: "decision" | "tweak"; pick?: PickChange };
/** A user line, with the end of the bot's reply before it when the line is short, the pictures the bot showed before it, and the user's own attached images; typedAnswer: a card answer in the user's typed words, not a press of one of its own options; cardOnly: filed under its card in code, never sent to the note-taker. */
export type UserLine = Partial<ReplyPictures> & { text: string; id?: string; files?: string[]; at?: number; tap?: boolean; typedAnswer?: boolean; cardOnly?: boolean; thread?: string };
type DroppedCount = z.infer<typeof droppedSchema>;
type Landed = z.infer<typeof landedSchema>;
// the user's words it came from, so a restart checks it against MEMORY.md as a retry does
type HeldNote = Note & { quote?: string };
/** Notes sent to the overflow file, and apart from them notes an older version turned away and lost. */
export type DroppedNotes = DroppedCount & { lost?: DroppedCount };

export interface MemoryPassDeps {
  store: Pick<Store, "onChange" | "messagesFor" | "groupByThread" | "botByThread" | "appendMessage"> & Partial<Pick<Store, "bot" | "importingSync">>;
  /** The selected account's one-shot call, if it can run. */
  generate(botId: string): NoteGenerator | null;
  /** The bot's Auto notes switch, read live. */
  enabled(botId: string): boolean;
  busy(botId: string, threadId: string): boolean;
  dataDir: string;
  /** This PC; pending ids restored from another PC stay that PC's work while this copy syncs chats with it. */
  host?: string;
  now?(): number;
}

export interface MemoryPass {
  /** Call when a 1:1 turn settles; `flush` runs the pass now, before the engine compacts. */
  onSettled(botId: string, threadId: string, flush?: boolean): void;
  onTurn(botId: string): void;
  /** Call after a config change: bots switched off drop pending ids and any running pass. */
  onConfigChanged(): void;
  /** Notes sent to the overflow file because MEMORY.md was full, since the last save. */
  droppedNotes(botId: string): DroppedNotes | undefined;
  /** Resolves once no pass is running. */
  idle(): Promise<void>;
  dispose(): void;
}

type NoteInstance = Pick<ProviderInstance, "driverKind" | "enabled" | "generateText" | "textModel"> & { instanceId?: string };
export type NoteLimits = { limits: RateLimitsMap; save(): void; signedOut?: Set<string> };

export function noteGenerator(
  instances: readonly NoteInstance[],
  account?: { instanceId: string; available: boolean },
  own?: NoteInstance | null,
  usage?: NoteLimits,
): NoteGenerator | null {
  const helper = own !== undefined ? own : account && !account.available ? null
    : instances.find((instance) => (!account || instance.instanceId === account.instanceId) && instance.driverKind === "claudeAgent" && instance.enabled && instance.generateText);
  if (!helper?.enabled || !helper.generateText) return null;
  const id = helper.instanceId;
  const report = id && usage ? usage.limits.get(id) : undefined;
  const now = Date.now();
  // a window spent in one pool while the helper's own pool still has room: the helper's own rejection decides
  if (exhaustedWindow(report?.windows?.filter((w) => !w.otherPoolLeft || (helper.textModel ?? AGY_TEXT_MODEL) !== AGY_TEXT_MODEL), now) || (report?.noteLimit?.resetsAt ?? 0) > now) return null;
  if (id && usage?.signedOut?.has(id)) return null;
  const generate: NoteGenerator = async (prompt, signal, onUsage) => {
    try {
      return await helper.generateText!(prompt, { signal, timeoutMs: PASS_TIMEOUT_MS, ephemeral: true, lean: true, ...(onUsage ? { onUsage } : {}) });
    } catch (error) {
      const limit = !signal.aborted && error instanceof Error && usageLimitFromError(error, true);
      if (limit && id && usage) {
        const previous = usage.limits.get(id);
        usage.limits.set(id, { windows: [], observedAt: new Date().toISOString(), ...previous, noteLimit: { resetsAt: limit.resetsAt ?? Date.now() + BARE_LIMIT_MS } });
        usage.save();
      } else if (id && !signal.aborted && error instanceof Error && (isSignOut(error.message) || UNAVAILABLE.test(error.message))) usage?.signedOut?.add(id);
      throw error;
    }
  };
  return Object.assign(generate, { engine: helper.driverKind.replace(/Agent$/, "") });
}

/** A user row typed on this PC into the chat, not a bot, routine, peer, draft or attachment. */
export function eligibleRow(message: Message | undefined): message is Message & { text: string } {
  return Boolean(
    message && message.role === "user" && message.kind === "text" && message.text !== undefined &&
      !message.from && !message.origin && !message.comm && !message.queued && !message.image && !message.hasImage,
  );
}

/** The user's own typing: pastes, attachments, code, quotes and long blocks cut; empty when it looks sensitive, unless the caller screens each line. */
/** The message without pasted blocks and fenced code: what the user did not type. */
export function withoutBlocks(text: string): string {
  return text
    .replace(/<pasted-text\b[^>]*>[\s\S]*?<\/pasted-text>/gi, "")
    .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/gi, "")
    .replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|$)/g, "$1");
}

/** whole: a card answer, never cut for length: a card's own option keeps its quotes and blockquotes, a typed answer loses only pastes and code. */
export function userTyping(text: string, dropSensitive = true, keepImages = false, whole?: "option" | "answer"): string {
  const attached = text.replace(/<attached-(image|file)\b[^>]*\/>/gi, (tag, kind) => keepImages && kind.toLowerCase() === "image" ? tag : "");
  const typed = whole === "option" ? attached : withoutBlocks(attached);
  // a quote of earlier chat is screened apart from the user's own words, so a secret it carries costs only the quote
  const own = whole === "answer" ? typed.replace(QUOTE_LABEL, "") : typed;
  // the whole message: a label and its value can sit in different paragraphs
  if (dropSensitive && secretValue(own)) return "";
  if (whole === "option") return redactSecretsInText(typed.trim());
  if (whole === "answer") return redactSecretsInText(typed.replace(QUOTE_LABEL, (quote) => dropSensitive && secretValue(`${own}\n${quote}`) ? "" : quote).trim());
  const unwrapped = typed.replace(/(?<!=)"[^"\n]{81,}"|“[^”\n]{81,}”|'[^'\n]{81,}'/g, "");
  const kept = unwrapped
    .split(/\n\s*\n/)
    .filter((paragraph) => paragraph.length <= 400 && paragraph.split("\n").length <= 6)
    .map((paragraph) => paragraph.split("\n").filter((line) => !line.trimStart().startsWith(">")).join("\n").trim())
    .filter(Boolean);
  return redactSecretsInText(kept.join("\n\n"));
}

const CONTEXT_TAGS = /<\/?(?:context|user_lines|notes|picks|pictures|source|prior)\b[^>]*>/gi;

/** The end of the bot's reply, as plain text that cannot close or open a prompt block. */
export function replyContext(text: string): string {
  const plain = redactSecretsInText(
    text.replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|$)/g, "$1").replace(CONTEXT_TAGS, " ").replace(/\s+/g, " ").trim(),
  );
  return plain.length > CONTEXT_MAX ? plain.slice(-CONTEXT_MAX).trimStart() : plain;
}

const ATTACHED = /<attached-image\s+path="([^"]*)"\s*\/?>/g;

/** The images the user attached to a row. */
export function attachedImages(text: string): string[] {
  const typed = userTyping(text, false, true);
  return [...new Set([...typed.matchAll(ATTACHED)].map((match) => match[1]!.replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).filter(Boolean))];
}

const promptPictures = (pictures: Picture[]) => pictures.map(({ path, caption }) =>
  (caption ? `${path} (${caption})` : path).replace(CONTEXT_TAGS, " ")).join("\n");

const promptLine = ({ id, questionId, text, context, pictures, prior }: UserLine) =>
  [
    ...(id ? [`<source message_id="${id}" question_id="${questionId ?? id}" />`] : []),
    ...(prior ? [`<prior question_id="${prior.questionId}">\n${[prior.context, promptPictures(prior.pictures)].filter(Boolean).join("\n")}\n</prior>`] : []),
    ...(context ? [`<context>${context}</context>`] : []),
    ...(pictures?.length ? [`<pictures>\n${promptPictures(pictures)}\n</pictures>`] : []),
    text,
  ].join("\n");

export function notePrompt(notes: string, lines: UserLine[], picks = ""): string {
  return [
    "You pick durable facts and decisions out of the user's own chat messages, for their notes file.",
    "",
    "Rules:",
    "- Use only USER LINES. Never guess, infer or add anything they did not say.",
    "- Keep facts that stay true: who they are, their age, languages, tools they use, likes and dislikes, how they want things done.",
    "- Skip one-off requests that are not tweaks, questions, task details, and anything CURRENT NOTES already says.",
    "- A decision is a choice the user made between options, or a direction they set for how something should look or work. Keep it only if it will still matter next time that thing comes up.",
    "- goal: something the user wants built or reached, with its spec, like \"Glasses v1: person brief, top 3 competitors, 1 news line\". Never task details.",
    "- CONTEXT and PICTURES clarify short answers. Quote the user's choice, never the bot's suggestion.",
    `- kind: "decision", "tweak", "goal" or "fact". One decision per thing.`,
    `- decision: key is the thing decided, never the option, in 2-6 chat words, copied exactly if CURRENT PICKS has it. fact is the pick, ${DECISION_MAX} characters max, with its letter or number, like "C - Reddit cards"; over: the options it beat; picture, over_pictures: copy paths from PICTURES, a continued <prior> or CURRENT PICKS.`,
    "- \"actually c\" moving a CURRENT PICKS pick to an option it beat is a new decision, same key, even with tweaks after it.",
    "- tweak: a change the user asked for on a pick, like \"make the header smaller\"; key: that pick's key. Never a new pick.",
    "- Never record passwords, PINs, codes, keys, tokens, account numbers or one-time codes.",
    "- fact: one short plain line about the user, for example \"38 years old\" or \"Can't read Korean\".",
    `- quote: the user's exact words that state the fact, copied verbatim from a user line, never from CONTEXT, ${QUOTE_MAX} characters max.`,
    "- Copy the decision's message_id from <source>. Use <prior> and its question_id only for a continued question.",
    "- replaces: only when the fact makes a CURRENT NOTES line untrue or outdated, that whole line copied exactly. Otherwise leave it out.",
    "",
    "Reply with a JSON array of facts, decisions and tweaks, or [] when nothing qualifies.",
    "",
    "CURRENT NOTES:",
    "<notes>",
    notes.trim() || "(empty)",
    "</notes>",
    "",
    "CURRENT PICKS:",
    "<picks>",
    picks.trim() || "(none)",
    "</picks>",
    "",
    "USER LINES:",
    "<user_lines>",
    lines.map(promptLine).join("\n\n"),
    "</user_lines>",
  ].join("\n");
}

export function parseFacts(output: string): Fact[] | null {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  // a list inside an object is not the reply's fact list
  if (start < 0 || end < start || output.slice(0, start).includes("{")) return null;
  try {
    const parsed = factsSchema.safeParse(JSON.parse(output.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const SECRET_WORDS =
  /\b(?:passwords?|passcodes?|passwd|pins?|otp|2fa|mfa|one[- ]time|verification codes?|security codes?|api[ _-]?keys?|secret|tokens?|private keys?|credentials?|account numbers?|card numbers?|routing numbers?|cvv|ssn|social security)\b/i;
// No \b here: it never fires between Hangul syllables.
const SECRET_WORDS_KO =
  /비밀\s*(?:번호|키)|비번|암호(?!화|학)|패스워드|패스코드|인증\s*(?:번호|코드)|보안\s*코드|일회용\s*(?:코드|번호)|(?:api|에이피아이)\s*키|토큰|개인\s*키(?!보드)|계좌\s*번호|카드\s*번호|주민\s*(?:등록\s*)?번호|핀\s*번호|시크릿/i;
const VALUE_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|xox[abposr])[_-][A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/,
  /\b(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{24,}/,
];
const TOKEN_PATTERNS = [/«redacted/i, ...VALUE_PATTERNS];
// The last VALUE_PATTERN also matches paths, links, model ids, uuids and shas: words of one case or digits, not a key.
// The part alternatives must not overlap ([A-Z][a-z]+, not [A-Z]?[a-z]+): overlap backtracks exponentially on a long run.
const PLAIN_RUN = /^[/_-]*(?:[a-z0-9]+|[A-Z][a-z]+|[A-Z]+)(?:[/_-]+(?:[a-z0-9]+|[A-Z][a-z]+|[A-Z]+))*[/_-]*$/;
const KEY_WORD_BEFORE = /(?:\b(?:keys?|tokens?|secrets?|passwords?|passcodes?|credentials?)|키|토큰|비밀\s*번호|비번|암호)\W{0,3}$/i;

// A sha or uuid is plain; the same lowercase shape is a key after a key word, behind a short prefix (key-, dop_v1_), when not hex, or alone.
function plainValue(value: string, before: string, all: string): boolean {
  if (!PLAIN_RUN.test(value) || KEY_WORD_BEFORE.test(before)) return false;
  const parts = value.split(/[/_-]+/).filter(Boolean);
  const last = parts.at(-1) ?? "";
  if (!/^(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{20,}$/.test(last)) return true;
  const prefixed = parts.length > 1 && parts.length <= 3 && parts.slice(0, -1).every((part) => part.length <= 6);
  return /^[0-9a-f]+$/.test(last) && !prefixed && all.trim() !== value;
}

export function secretLike(text: string): boolean {
  return redactSecretsInText(text) !== text || SECRET_WORDS.test(text) || SECRET_WORDS_KO.test(text) || TOKEN_PATTERNS.some((pattern) => pattern.test(text));
}

/** The key values secretLike flags, masked in place; words like "password" or "tokens" and plain names stay, so a goal keeps its sense. */
export function maskSecretValues(text: string): string {
  return VALUE_PATTERNS.reduce((out, pattern, i) => out.replace(new RegExp(pattern.source, "g"), (value: string, at: number, all: string) =>
    i === VALUE_PATTERNS.length - 1 && plainValue(value, all.slice(Math.max(0, at - 40), at), all) ? value : `«redacted ${value.length} chars»`), redactRoomMemory(text));
}

const valueWord = (word: string) => word.length >= 6 && /\p{L}/u.test(word) &&
  (/\d/.test(word) || /\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+){2,}/u.test(word) || (/\p{L}[!@#$%^&*=~|<>{}]+\p{L}/u.test(word) && !/:\/\/|^\W*[\w.+-]+@[\w-]+\.[\w.-]+\W*$/.test(word)));
// Tr0ub4dor&3xQ, Tr@ub!dor&xQ, Blue-Horse-Staple, card or account digits, or a value spelled out letter by letter
export const holdsValue = (paragraph: string) => paragraph.split(/\s+/).some(valueWord) || /\d(?:[ -]?\d){9,}/.test(paragraph) || /(?<!\S)(?:\S[ \t]+){5,}\S(?!\S)/u.test(paragraph);
// LLM token talk, only after a plain word or sentence punctuation: "the hf token" and "(github) token" name a credential
const TOKEN_TALK = [
  /(?<=(?:^|\n|\(|[,;.!?][ \t]|\b(?:the|my|our|your|their|its|this|that|these|those|a|an|of|per|in|on|at|for|and|or|but|so|to|with|by|from|about|watch|check|track|cut|lower|reduce|total|daily|weekly|monthly|high|higher|low|big|huge|llm|model|prompt|output|input|claude|gpt|opus|sonnet|haiku|ai|is|was|are|were)\b)[ \t]*)\btokens?\s+(?:costs?|usage|counts?(?!\s+down)|budgets?|limits?|spend(?:ing)?|bills?|totals?|intensive|heavy)\b/gi,
  /(?<![\d.,])\b\d[\d.,]*[ \t]?(?:[kmb]|million|billion|thousand)\s+tokens?\b/gi,
];
// login, lock and key-name words; the nightly cleaner (memory-clean.ts) skips a note holding one
export const LABEL_WORDS = /\b(?:pw|pwd|pass|passphrase|passkey|p\/w|log[- ]?in|sign[- ]?in|user ?name|admin|wi-?fi|router|modem|nas|door|gate|lock|unlock|safe|vault|alarm|garage|locker|combo|ssh|ftp|sftp)\b|\b(?:license|product|encryption|recovery|backup|secret|access|security|auth)\s+(?:keys?|codes?|phrase|answer|word)\b|\b[A-Z][A-Z0-9]*_(?:PASS|PWD|KEY|SECRET|TOKEN)\w*|로그인|아이디|와이파이|공유기|도어락|현관|금고|비밀/i;
// token talk clears a message base drops only when no login word, value handed over on its line or bare code sits in it
const VALUE_HINT = new RegExp(`${LABEL_WORDS.source}|\\b(?:below|next line|last line|coming|incoming|here(?:'s| is| are))\\b|:[ \\t]*\\S|(?<![\\w#$.,:/-])(?<!\\bPR )\\d{4,9}(?![\\w%.,:/-])`, "i");

export function secretValue(text: string): boolean {
  const plain = text
    .replace(/\b(?:(?:under|fewer than|up to|at most)\s+\d+|fewer|more|\d+)\s+tokens?\b/gi, "")
    .replace(/\bpin\s+(?:it|this|that|the\s+\w+)\s+(?:to|at|on)\b/gi, "")
    .replace(/\bsecret\s+(?:menu|theme|level|door|room)\b/gi, "");
  if (!secretLike(plain)) return false;
  const rest = TOKEN_TALK.reduce((left, talk) => left.replace(talk, ""), plain);
  return rest === plain || secretLike(rest) || VALUE_HINT.test(text) || holdsValue(text);
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
const factLine = (fact: string) => fact.replace(/^[-*]\s+/, "").replace(/\s+/g, " ").trim();

/** A line only the note-taker wrote, found exactly once and claimed by one fact. */
function replaceable(target: string | null | undefined, lines: string[], claims: Map<string, number>): target is string {
  return Boolean(
    target && /\(noted \d{4}-\d{2}-\d{2}\)$/.test(target) && claims.get(target) === 1 &&
      lines.filter((line) => sameLine(line, target)).length === 1,
  );
}

const HEADING = /^#{1,6}\s/;
const NOTED = /^\s*[-*+]\s+(.*?)\s*\(noted (\d{4}-\d{2}-\d{2})\)\s*$/;
function liveRows(text: string): { rows: string[]; dates: string[]; close: string } {
  const rows: string[] = [];
  const dates: string[] = [];
  let block: { close: string; end: RegExp } | undefined;
  for (const row of text.split("\n")) {
    if (block) {
      if (block.end.test(row)) block = undefined;
      continue;
    }
    // an info string with a backtick is inline code, not a fence
    const marks = /^ {0,3}(`{3,}(?!.*`)|~{3,})/.exec(row)?.[1];
    if (marks) {
      block = { close: marks, end: new RegExp(`^ {0,3}${marks[0]}{${marks.length},}\\s*$`) };
      continue;
    }
    const opener = /^ {0,3}(?:<!--|<(pre|details)\b[^>]*>)/i.exec(row);
    if (opener) {
      const close = opener[1] ? `</${opener[1]}>` : "-->";
      const end = new RegExp(close, "i");
      if (!end.test(row.slice(opener[0].length))) block = { close, end };
      continue;
    }
    const bullet = /^ {0,3}[-*+][ \t]+([^\r\n]+)/.exec(row)?.[1];
    if (!bullet) continue;
    const noted = NOTED.exec(row);
    rows.push(noted?.[1] ?? bullet.trim());
    dates.push(noted?.[2] ?? "");
  }
  return { rows, dates, close: block ? `${block.close}\n` : "" };
}

/** Match an explicit key anywhere; unstructured prose needs an Auto Notes stamp. */
function legacyLine(key: string, lines: string[], taken: Set<string>): string | undefined {
  const asked = pickKey(key);
  if (!asked) return undefined;
  const noted = lines.map((line) => line.replace(/\r$/, "")).filter((line) => /^\s*[-*+]\s+/.test(line) && !taken.has(line));
  const subject = (line: string) => NOTED.exec(line)?.[1] ?? line.replace(/^\s*[-*+]\s+/, "");
  for (const opens of [(line: string) => /^[^:]+:/.test(subject(line)) && pickKey(subject(line).slice(0, subject(line).indexOf(":"))) === asked, (line: string) => NOTED.test(line) && `${pickKey(subject(line))} `.startsWith(`${asked} `)]) {
    const found = noted.filter(opens);
    if (found.length) return found.length === 1 && lines.filter((line) => sameLine(line, found[0]!)).length === 1 ? found[0] : undefined;
  }
  return undefined;
}

/** The `## Decisions` section as [heading index, end index), or null. */
export function decisionSpan(lines: string[]): [number, number] | null {
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
  /\b[a-z]:[\\/]\S*|\\\\\S+|(?:^|\s)(?:~|\.{1,2})?\/[\w.-]+(?:\/\S*)?/gi,
  /\b[\w.-]+(?:[\\/][\w.-]+)+\.[a-z0-9]{1,5}\b/gi,
  /`[^`]+`/g,
];

/** A decision whose words come from the user's lines or the bot text and pictures before the quoted one, and whose URLs, paths and commands only from the user. */
function grounded(line: string, said: string, sources: UserLine[], picked = line): boolean {
  const own = sources.filter(({ text }) => squash(text).includes(squash(said)));
  const label = LABELED.exec(picked.trim())?.[1]?.toLowerCase();
  // a switch by letter ("actually c") is grounded in any bot list in these lines that names that letter
  const lists = label ? sources.filter(({ context, pictures }) => new RegExp(`(?:^|\\s)${label}\\s*[-.):]\\s`, "i").test(context ?? "") || pictures?.some(({ caption }) => caption !== undefined && sameOption(caption, picked))) : [];
  const typed = squash(sources.map(({ text }) => text).join("\n"));
  if (LITERALS.some((pattern) => (line.match(pattern) ?? []).some((literal) => !typed.includes(squash(literal))))) return false;
  // the user may name the options in one line and pick in the next; other bot text grounds only the line it precedes
  const known = contentWords([...sources.map(({ text }) => text), ...[...own, ...lists].flatMap(({ context, pictures }) => [context ?? "", ...(pictures ?? []).map(({ caption }) => caption ?? "")])].join("\n"));
  const needed = contentWords(line);
  const hits = needed.filter((word) => known.some((source) => sameStem(word, source))).length;
  return hits > 0 && hits * 2 >= needed.length;
}

const ASKED = /\?|(?:^|\s)(?:[1-9]|[a-h])[.):]\s|\boption\s+[a-h1-9]\b/i;
const LABEL = /^(?:option\s+)?([a-z]|\d{1,2})\b/i;
const CLAUSE = /[,;.!?]+|\s(?:and|but|or)\s|\s-\s/g;
const NEGATED = /(?:^|\s)(?:not|no|nope|nah|don't|dont|never|without|hate|dislike|except|skip|instead of|rather than|other than)(?:\s|$)/;
const ASKING = /^(?:what|which|how|why|should|shall|would|could|can|is|are|does|did|will|maybe)$/;
const CHOOSING = /(?:^|\s)(?:yes|yeah|yep|yup|sure|definitely|absolutely|agreed|perfect|sounds good|do it|go ahead|go with it|that one|this one|first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|네|넵|응|좋아|좋아요|그래|그래요)(?:\s|$)/;

/** The quote is in the text, a short one as whole words, so "c" never matches inside "cards". */
export function quotes(text: string, said: string): boolean {
  const target = squash(said);
  if (target.length >= 4) return squash(text).includes(target);
  const spoken = words(target).join(" ");
  return Boolean(spoken) && ` ${words(text).join(" ")} `.includes(` ${spoken} `);
}

/** The quote with the rest of its clause around it, the marks between clauses kept, so "not" or "?" next to a quoted "tiles" still counts. */
function clauseOf(text: string, said: string): string {
  const line = squash(text);
  const target = squash(said);
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...line.matchAll(new RegExp(`(?<![\\p{L}\\p{N}'])${escaped}(?![\\p{L}\\p{N}'])`, "gu"))];
  const at = matches.at(-1)?.index ?? -1;
  if (at < 0) return target;
  const marks = [...line.matchAll(CLAUSE)];
  const start = marks.filter((mark) => mark.index! + mark[0].length <= at).at(-1)?.index ?? 0;
  const end = marks.find((mark) => mark.index! >= at + target.length);
  return line.slice(start, end ? end.index! + end[0].length : line.length);
}

/** Its clauses in order, each asked when it ends on "?", sits beside "or" or opens like a question. */
function clauses(text: string): Array<{ words: string[]; asked: boolean }> {
  const parts = text.split(new RegExp(`(${CLAUSE.source})`));
  const out: Array<{ words: string[]; asked: boolean }> = [];
  for (let i = 0; i < parts.length; i += 2) {
    const said = words(parts[i]!);
    const [before = "", after = ""] = [parts[i - 1], parts[i + 1]];
    if (said.length) out.push({ words: said, asked: after.includes("?") || /^\s*or\s*$/.test(before) || /^\s*or\s*$/.test(after) || ASKING.test(said[0]!) });
  }
  return out;
}

/** The user's words name the pick or its label in a clause that neither asks nor turns it down, or say yes or "the second one" to a question the bot asked; "ok thanks", "no thanks" or "not b" never pick. */
function userChose(picked: string, said: string, own: UserLine[]): boolean {
  const label = LABEL.exec(picked.trim())?.[1]?.toLowerCase();
  const stems = contentWords(picked);
  return (own.length ? own : [{ text: said }]).some(({ text, context, options: card }) => {
    const spoken = clauseOf(text, said);
    const long = words(spoken).length > SHORT_ANSWER;
    const parts = clauses(spoken);
    const ordinal = /\b(?:the\s+)?(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)(?:\s+(?:one|option|choice))?\b/.exec(spoken)?.[1];
    const explicit = parts.some(({ words: clause }) => Boolean(label && clause.includes(label)) || stems.length > 0 && stems.every((stem) => clause.some((word) => sameStem(stem, word))));
    if (ordinal && !explicit) {
      if (parts.some(({ words: clause, asked }) => asked || NEGATED.test(clause.join(" ")))) return false;
      const options = labeledOptions(context);
      // the context runs a card's unlettered options together
      if (!options.length && card?.length) options.push(...card);
      if (!options.length && context?.includes(" or ")) options.push(...context.split(/[.!?]/).filter(Boolean).at(-1)!.split(/,?\s+or\s+/));
      const index = ordinal === "last" ? options.length - 1 : ["first", "second", "third", "fourth", "fifth"].indexOf(ordinal) >= 0 ? ["first", "second", "third", "fourth", "fifth"].indexOf(ordinal) : Number(ordinal[0]) - 1;
      const option = options[index];
      if (!option) return false;
      if (LABELED.test(option)) return sameOption(picked, option);
      const chosen = contentWords(option);
      const other = options.filter((_, at) => at !== index).flatMap(contentWords);
      const distinctive = stems.filter((stem) => chosen.some((word) => sameStem(stem, word)) && !other.some((word) => sameStem(stem, word)));
      return distinctive.length > 0 && !stems.some((stem) => other.some((word) => sameStem(stem, word)) && !chosen.some((word) => sameStem(stem, word)));
    }
    const named = parts.flatMap(({ words: clause, asked }, index) => {
      let at = clause.findIndex((word) => contentWords(word).length > 0 && stems.some((stem) => sameStem(stem, word)));
      // a label counts in a short answer, or in a short opening clause of a longer line: "a" or "i" only as its last word
      const opening = parts.slice(0, index).every(({ words: prior, asked: question }) => !question && !NEGATED.test(prior.join(" ")) && !prior.some((word) => /^[a-h]$/.test(word)));
      const explicit = /\b(?:choose|pick|use|prefer|want|with)\s+(?:option\s+)?[a-h1-9]\b/.test(clause.join(" "));
      if (at < 0 && label && (!long || explicit || (opening && clause.length <= SHORT_ANSWER))) at = long && !explicit && (label === "a" || label === "i") ? (clause.at(-1) === label ? clause.length - 1 : -1) : clause.indexOf(label);
      return at < 0 ? [] : [!asked && !NEGATED.test(clause.slice(0, at).join(" "))];
    });
    // The last mention can withdraw an earlier choice in the same line.
    if (named.length) return named.at(-1)!;
    const plain = parts.every(({ words: clause, asked }) => !asked && !NEGATED.test(clause.join(" ")));
    return !long && plain && CHOOSING.test(words(spoken).join(" ")) && Boolean(context && ASKED.test(context));
  });
}

/** An option the pick beat, grounded like a decision; a bare label like "B" only from the text around the pick. */
function optionNamed(option: string, said: string, sources: UserLine[], own: UserLine[]): boolean {
  if (contentWords(option).length) return grounded(option, said, sources);
  const label = words(option).join(" ");
  return Boolean(label) && own.some(({ text, context }) => ` ${words(`${context ?? ""} ${text}`).join(" ")} `.includes(` ${label} `));
}

const listOf = (value: string | string[] | null | undefined) =>
  (Array.isArray(value) ? value : value ? [value] : []).map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);

/** The user's short answer a bot line restates, like "actually c" before "C it is": it ends on the letter of the option it switches to, and names no other. */
function confirmed(sources: UserLine[], said: string, picked: string, before: PickEntry): string | undefined {
  const at = sources.findIndex(({ context }) => context !== undefined && quotes(context, said));
  const answer = at > 0 ? sources[at - 1]!.text.trim() : "";
  const typed = words(answer);
  const label = (option: string) => LABELED.exec(option.trim())?.[1]?.toLowerCase();
  const labels = new Set([before.picked, ...before.over].map(label));
  const option = before.over.find((other) => label(other) === typed.at(-1));
  if (!option || answer.endsWith("?") || typed.length > SHORT_ANSWER || typed.filter((word) => labels.has(word)).length !== 1) return undefined;
  return sameOption(option, picked) ? answer : undefined;
}

/** Facts that quote one non-sensitive user paragraph verbatim, carry no secret, and are not already noted. Decisions first, each picked in the user's own words; a tweak only on a current pick. A fact on a decision's quote yields to it. */
export function acceptFacts(facts: Fact[], userText: string | UserLine[], notes: string, archived = ""): Note[] {
  return acceptQuoted(facts, userText, notes, archived).map(({ quote: _quote, ...note }) => note);
}

// a fact keeps the quote it passed on, so a held batch rechecks that one and never a turned-away twin
function acceptQuoted(facts: Fact[], userText: string | UserLine[], notes: string, archived = ""): HeldNote[] {
  const sources = Array.isArray(userText) ? userText : [{ text: userText }];
  const paragraphs = sources.filter(({ cardOnly }) => !cardOnly).map(({ text }) => text).join("\n\n").split(/\n\s*\n/).filter((paragraph) => !secretValue(paragraph));
  const lines = notes.split("\n");
  const span = decisionSpan(lines);
  const inSection = (target: string) => {
    const at = lines.findIndex((line) => sameLine(line, target));
    return Boolean(span && at > span[0] && at < span[1]);
  };
  const claims = new Map<string, number>();
  for (const { replaces } of facts) if (replaces) claims.set(replaces, (claims.get(replaces) ?? 0) + 1);
  const current = new Map(currentPicks(archived).map((entry) => [pickKey(entry.key), entry] as const));
  const live = new Set(current.keys());
  const seen = new Set<string>();
  const decided = new Set<string>();
  const taken = new Set<string>();
  const cardNotes = new Map<string, CardNote>();
  const accept = (fact: Fact): HeldNote | null => {
    const { kind, quote, replaces } = fact;
    const decision = kind === "decision";
    const tweak = kind === "tweak";
    const goal = kind === "goal";
    const stated = factLine(fact.fact);
    const line = goal && stated ? `Goal: ${stated}` : stated;
    const key = fact.key?.replace(/\s+/g, " ").trim() ?? "";
    // switching to an option the current pick beat is grounded in that pick's record
    const before = decision ? current.get(pickKey(key || line)) : undefined;
    let said = quote.trim();
    // the note-taker may quote the bot's "C it is" for the user's "actually c"
    if (before && !paragraphs.some((paragraph) => quotes(paragraph, said))) said = confirmed(sources, said, line, before) ?? said;
    if (!line || line.length > (decision || tweak ? DECISION_MAX : FACT_MAX) || !said || said.length > QUOTE_MAX) return null;
    if (!paragraphs.some((paragraph) => quotes(paragraph, said))) return null;
    const sensitive = decision || tweak || goal ? secretValue : secretLike;
    // the "Goal:" label's colon reads as a value handed over
    if (sensitive(stated) || sensitive(said)) return null;
    // the note-taker never saw a card-only line
    const quoting = sources.filter(({ text, cardOnly }) => !cardOnly && quotes(text, said));
    const identified = decision && fact.message_id != null ? quoting.filter(({ id }) => id === fact.message_id) : quoting;
    const own = identified.length ? identified : quoting;
    const at = own.at(-1)?.at ?? 0;
    if (tweak) {
      const id = `tweak ${pickKey(key)} ${squash(said)}`;
      // the change is in the user's own words, on a pick that is still current
      if (!pickKey(key) || !live.has(pickKey(key)) || seen.has(id) || !grounded(line, said, [{ text: said }])) return null;
      seen.add(id);
      return { line: `${key}: ${line}`, kind: "tweak", pick: { kind: "tweak", at, key, said } };
    }
    if (decision) {
      const source = quoting.find(({ questionId }) => fact.question_id != null && questionId === fact.question_id) ?? own[0];
      if (!source) return null;
      const thing = key || line;
      const named = pickKey(thing) === pickKey(line) ? line : `${thing}: ${line}`;
      const options = source.options ?? labeledOptions(source.context);
      const label = LABELED.exec(line)?.[1]?.toLowerCase();
      const namedOption = label && options.find((option) => LABELED.exec(option)?.[1]?.toLowerCase() === label);
      if (namedOption && !sameOption(namedOption, line)) return null;
      const continued = fact.question_id === source.prior?.questionId ? source.prior : undefined;
      const context = [source.context, continued?.context].filter(Boolean).join(" ");
      const known = sources.map((other) => other === source ? { ...source, context, pictures: [...(source.pictures ?? []), ...(continued?.pictures ?? [])] } : { text: other.text });
      if (before) known.push({ text: [before.key, before.picked, ...before.over].join("\n") });
      // a second pick on one question in the same lines is a change of mind: both land, in the order said
      const id = `pick ${pickKey(thing)} ${source.id ?? squash(said)}`;
      if (seen.has(id) || !grounded(named, said, known, line) || !userChose(line, said, [{ ...source, context }])) return null;
      // an older Auto Notes line on this question leaves MEMORY.md for the timeline, named by the note-taker or not
      const listed = replaceable(replaces, lines, claims) && (inSection(replaces) || legacyLine(thing, [replaces], taken) === replaces) && !taken.has(replaces) ? replaces : undefined;
      const target = listed ?? legacyLine(thing, lines, taken);
      const over = listOf(fact.over)
        .filter((option) => option.length <= DECISION_MAX && !secretLike(option) && pickKey(option) !== pickKey(line) && optionNamed(option, said, known, own))
        .slice(0, OPTIONS_MAX);
      const bound = identified.length === 1 ? identified[0] : undefined;
      const binding = validatePickBinding({
        key: thing, picked: line, over, messageId: fact.message_id, questionId: fact.question_id, picture: fact.picture,
        overPictures: fact.over_pictures == null ? undefined : listOf(fact.over_pictures),
      }, bound, before, sources.filter((other) => other !== bound && (quoting.includes(other) || offersOption(other, line))));
      // a card answer is filed in code from the user's own words: a note bound to its card only names its key, the options it beat and the line it replaces
      if (source.tap && source.id) {
        if (binding?.messageId === source.id && binding.questionId === source.questionId && !cardNotes.has(cardLine(source))) {
          if (target) taken.add(target);
          decided.add(squash(said));
          cardNotes.set(cardLine(source), { key: thing, over, binding, replaces: target });
        }
        return null;
      }
      if (target) taken.add(target);
      seen.add(id);
      live.add(pickKey(thing));
      decided.add(squash(said));
      const pick: Extract<PickChange, { kind: "pick" }> = { kind: "pick", at: binding?.at ?? source.at ?? 0, key: thing, picked: line, said };
      if (source.id) pick.binding = binding ?? "unbound";
      if (over.length) pick.over = over;
      if (target) pick.legacy = legacyPick(target, pick.at);
      const note: Note = { line: named, kind: "decision", pick };
      if (target) note.replaces = target;
      return note;
    }
    if (decided.has(squash(said))) return null;
    const target = replaceable(replaces, lines, claims) && !inSection(replaces) ? replaces : undefined;
    const noted = (target ? lines.filter((note) => !sameLine(note, target)) : [...lines, ...archived.split("\n")]).map(words);
    const quoted = quoteWords(said);
    if (quoted.length && noted.some((note) => quoted.every((word) => note.includes(word)))) return null;
    const known = words(line).join(" ") || squash(line);
    if (seen.has(known) || noted.some((note) => ` ${note.join(" ")} `.includes(` ${known} `))) return null;
    seen.add(known);
    const note: HeldNote = { line, quote: said };
    if (target) note.replaces = target;
    return note;
  };
  // decisions first, then tweaks, so a tweak can land on a pick made in the same lines
  const rank = (fact: Fact) => (fact.kind === "decision" ? 0 : fact.kind === "tweak" ? 1 : 2);
  const order = facts.map((fact, index) => ({ fact, index })).sort((a, b) => rank(a.fact) - rank(b.fact));
  const kept = new Map(order.filter(({ fact }) => fact.kind === "decision").map(({ fact, index }) => [index, accept(fact)] as const));
  // a card answer filed in code is current before the tweaks, which may qualify it
  const cards = cardAnswers(sources, cardNotes, archived);
  for (const { pick } of cards) for (const key of [pick?.key, pick?.kind === "pick" ? pick.noted : undefined]) if (key) live.add(pickKey(key));
  for (const { fact, index } of order) if (fact.kind !== "decision") kept.set(index, accept(fact));
  const picked = (decision: boolean) => facts.flatMap((fact, index) => (fact.kind === "decision") === decision ? kept.get(index) ?? [] : []);
  return [...picked(true), ...cards, ...picked(false)];
}

// a long card question is cut in the middle: two questions that open alike differ at the end, a topic set first stays; a cut another card holds is a different question, cut at the end
function questionKey(question: string, held: (key: string) => boolean): string {
  const chars = [...question];
  if (chars.length <= KEY_MAX) return question;
  const middle = `${chars.slice(0, 27).join("").trimEnd()}...${chars.slice(-30).join("").trimStart()}`;
  return held(middle) ? `${chars.slice(0, KEY_MAX - 3).join("").trimEnd()}...` : middle;
}

type CardNote = { key: string; over: string[]; binding: PickBinding; replaces?: string };
// one message can answer two cards
const cardLine = (source: UserLine) => `${source.id}\n${source.questionId}`;

const legacyPick = (target: string, at: number) => {
  const old = NOTED.exec(target);
  return { day: old?.[2] ?? day(at), line: old?.[1] ?? target.replace(/^\s*[-*+]\s+/, "") };
};

/** Every card answer, each a pick in the user's own words under its card; the note-taker's note on it adds only a key no other question holds, the options it beat and the line it replaces. */
function cardAnswers(sources: UserLine[], noted: Map<string, CardNote>, archived: string): HeldNote[] {
  const entries = parseTimeline(archived).entries;
  const keys = new Map<string, string>();
  return sources.flatMap((source) => {
    const question = source.question?.replace(/\s+/g, " ").trim();
    const said = source.text.trim();
    // the option replyTurns read off the card itself, else the user's words as typed
    const picked = source.choice ?? said;
    // screened on the value filed too: a letter's option was not in the typed text
    if (!source.tap || !source.id || !question || !said || secretValue(question) || secretValue(said) || secretValue(picked)) return [];
    const note = noted.get(cardLine(source));
    // bound by the card's own question and options: bot words before a card with no buttons never decide it
    const binding = note?.binding ?? validatePickBinding({ key: question, picked, over: [] }, { ...source, context: [question, ...(source.options ?? [])].join("\n") });
    if (!binding) return [];
    const held = (key: string) => [...keys].some(([id, other]) => id !== binding.questionId && pickKey(other) === pickKey(key))
      || entries.some((entry) => !entry.replacedBy && !entry.kind && entry.questionId !== binding.questionId && pickKey(entry.key) === pickKey(key));
    // a card keeps the key it is filed under, so a revised answer replaces the older one
    const key = keys.get(binding.questionId) ?? entries.findLast((entry) => !entry.kind && entry.questionId === binding.questionId)?.key
      ?? (note && !held(note.key) ? note.key : questionKey(question, held));
    keys.set(binding.questionId, key);
    const pick: Extract<PickChange, { kind: "pick" }> = { kind: "pick", at: binding.at, key, picked, said, binding, tapped: true };
    if (note?.over.length) pick.over = note.over;
    if (note && pickKey(note.key) !== pickKey(key)) pick.noted = note.key;
    if (source.typedAnswer) pick.typed = true;
    if (note?.replaces) pick.legacy = legacyPick(note.replaces, pick.at);
    const filed: HeldNote = { line: `${key}: ${picked}`, kind: "decision", pick };
    if (note?.replaces) filed.replaces = note.replaces;
    return [filed];
  });
}

function day(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** MEMORY.md with replaced lines swapped in place, a replaced decision line taken out (the timeline keeps it) and the rest appended; null past the load budget. */
export function appendNotes(raw: string, notes: Note[], now: number): string | null {
  const base = raw.trim() ? raw : MEMORY_SEED;
  const stamp = day(now);
  const lines = base.split("\n");
  const added: string[] = [];
  for (const { line, replaces, kind } of notes) {
    const at = replaces === undefined ? [] : lines.flatMap((current, index) => (sameLine(current, replaces) ? [index] : []));
    if (kind) {
      if (kind === "decision" && at.length === 1) lines.splice(at[0]!, 1);
      continue;
    }
    if (at.length === 1) lines[at[0]!] = `- ${line} (noted ${stamp})${lines[at[0]!]!.endsWith("\r") ? "\r" : ""}`;
    else added.push(`- ${line} (noted ${stamp})`);
  }
  const swapped = lines.join("\n");
  const head = added.length && decisionSpan(lines)?.[1] === lines.length ? "\n## Notes\n" : "";
  const text = `${swapped.endsWith("\n") ? swapped : `${swapped}\n`}${head}${added.map((line) => `${line}\n`).join("")}`;
  if (text.split("\n").length > MEMORY_MAX_LINES || Buffer.byteLength(text, "utf8") > MEMORY_MAX_BYTES) return null;
  return text;
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
  tweaks?: number;
  ms: number;
  result: "saved" | "none" | "busy" | "too-large" | "conflict" | "error";
}

interface Batch {
  ids: string[];
  // owed cards it files
  owes?: string[];
  facts: Fact[];
  source: UserLine[];
  // accepted before a restart, since asking the note-taker again can word them another way
  notes?: HeldNote[];
  // its picks are in the timeline, held only for MEMORY.md
  picked?: boolean;
  // its lines an earlier try put in the overflow file, written again only once gone from there
  wrote?: Landed[];
  // its lines an earlier try left out as already the newest row, so a row landing after them never makes a retry add them
  seen?: Landed[];
}

/** Notes passing facts from new user lines into MEMORY.md once a 1:1 chat goes quiet. Never on the reply path. */
export function createMemoryPass(deps: MemoryPassDeps): MemoryPass {
  const now = deps.now ?? Date.now;
  const statePath = join(deps.dataDir, STATE_FILE);
  const pending = new Map<string, string[]>();
  // notes sent to the overflow file, and apart from them notes an older version turned away and lost
  const overflowed = new Map<string, DroppedCount>();
  const lost = new Map<string, DroppedCount>();
  const foreign = new Map<string, string[]>();
  const owedCards = new Map<string, string[]>();
  // generated but unsaved, so a busy turn or a moved revision never pays for the same batch twice
  const held = new Map<string, Batch>();
  const replays = new Map<string, Pick<Batch, "ids" | "picked" | "wrote" | "seen"> & { notes: HeldNote[] }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queue: Array<{ botId: string; threadId: string }> = [];
  const running = new Map<string, { botId: string; done: Promise<void>; controller: AbortController }>();
  // a pass asked for while one runs: the running one read its rows first
  const again = new Set<string>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let warned = false;
  let disposed = false;
  const roomKey = (botId: string, threadId: string) => JSON.stringify([botId, threadId]);
  const roomSource = (key: string): [string, string] | undefined => {
    try {
      const value: unknown = JSON.parse(key);
      return Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string") ? value as [string, string] : undefined;
    } catch {
      return undefined;
    }
  };
  const sourceThread = (key: string) => roomSource(key)?.[1] ?? key;
  const sourceBot = (key: string) => {
    const room = roomSource(key);
    return room ? deps.store.groupByThread(room[1])?.memberIds?.includes(room[0]) ? deps.store.bot?.(room[0]) : undefined : deps.store.botByThread(key);
  };
  const busy = (botId: string, key: string) => deps.busy(botId, sourceThread(key));

  let claim = false;
  try {
    const state = stateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
    const restored = Boolean(state.host && deps.host && state.host !== deps.host);
    for (const [threadId, ids] of Object.entries(state.threads)) {
      if (!ids.length) continue;
      pending.set(threadId, ids);
      const theirs = restored ? ids : state.foreign?.[threadId];
      if (theirs?.length) foreign.set(threadId, [...theirs]);
    }
    for (const [threadId, cards] of Object.entries(state.owed ?? {})) if (cards.length) owedCards.set(threadId, cards);
    for (const [botId, record] of Object.entries(state.dropped ?? {})) lost.set(botId, record);
    for (const [botId, record] of Object.entries(state.overflow ?? {})) overflowed.set(botId, record);
    for (const [threadId, batch] of Object.entries(state.held ?? {})) {
      replays.set(threadId, batch);
      held.set(threadId, { ...batch, facts: [], source: [] });
    }
    claim = Boolean(deps.host && state.host !== deps.host);
  } catch {
    // first run or unreadable: start empty
  }

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    try {
      const state: z.infer<typeof stateSchema> = { host: deps.host, threads: Object.fromEntries(pending) };
      if (lost.size) state.dropped = Object.fromEntries(lost);
      if (overflowed.size) state.overflow = Object.fromEntries(overflowed);
      if (replays.size) state.held = Object.fromEntries(replays);
      if (foreign.size) state.foreign = Object.fromEntries(foreign);
      if (owedCards.size) state.owed = Object.fromEntries(owedCards);
      writeFileAtomic(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`[memory-pass] state save failed (${error instanceof Error ? error.name : "error"})`);
    }
  };
  // stamp a legacy or copied file at once, so a copy taken before the next save cannot run these rows again
  if (claim) save();
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
    const active = running.get(threadId);
    if (disposed || queue.some((item) => item.threadId === threadId)) return;
    if (active && !active.controller.signal.aborted) {
      again.add(threadId);
      return;
    }
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

  const drop = (threadId: string, ids: string[]) => {
    const taken = new Set(ids);
    const rest = (pending.get(threadId) ?? []).filter((id) => !taken.has(id));
    if (rest.length) pending.set(threadId, rest);
    else pending.delete(threadId);
    const theirs = foreign.get(threadId)?.filter((id) => !taken.has(id));
    if (theirs?.length) foreign.set(threadId, theirs);
    else foreign.delete(threadId);
    save();
  };

  const done = (threadId: string, ids: string[], owes: string[] = []) => {
    held.delete(threadId);
    replays.delete(threadId);
    const rest = (owedCards.get(threadId) ?? []).filter((id) => !owes.includes(id));
    if (rest.length) owedCards.set(threadId, rest);
    else owedCards.delete(threadId);
    drop(threadId, ids);
  };

  const hold = (threadId: string, batch: Batch, notes: HeldNote[]) => {
    held.set(threadId, batch);
    if (!batch.wrote?.length && !batch.seen?.length) return;
    replays.set(threadId, { ids: batch.ids, notes: notes.map((note) => ({ line: note.line, replaces: note.replaces, kind: note.kind, quote: note.quote })), picked: batch.picked, wrote: batch.wrote, seen: batch.seen });
    save();
  };

  const land = (botId: string, threadId: string, batch: Batch, memory: { text: string; revision: string }, raw: string, ms: number) => {
    let timeline: string;
    try {
      timeline = readMemoryTopic(botId, PICKS_FILE) ?? "";
    } catch (error) {
      held.set(threadId, batch);
      log({ botId, threadId, lines: batch.source.length, ms, result: "error" });
      console.warn(`[memory-pass] ${PICKS_FILE} read failed (${error instanceof Error ? error.name : "error"})`);
      return arm(botId, threadId);
    }
    const checked = batch.notes?.map((note) => note.kind || note.quote === undefined ? [note] :
      acceptQuoted([{ fact: note.line, quote: note.quote, replaces: note.replaces }], note.quote, memory.text, timeline));
    const accepted = checked?.flat() ?? acceptQuoted(batch.facts, batch.source, memory.text, timeline);
    // MEMORY.md may have taken a note in before the restart; the overflow row this batch wrote for it still earns its receipt
    const owed = batch.notes?.filter((note, index) => !checked?.[index]?.length && batch.wrote?.some(({ line }) => line === note.line)) ?? [];
    if (!accepted.length && !owed.length) {
      log({ botId, threadId, lines: batch.source.length, facts: 0, ms, result: "none" });
      return done(threadId, batch.ids, batch.owes);
    }
    // a turn may be writing MEMORY.md and its own save chip; retry after it
    if (busy(botId, threadId)) {
      held.set(threadId, batch);
      log({ botId, threadId, facts: accepted.length, ms, result: "busy" });
      return arm(botId, threadId);
    }
    const facts = accepted.filter((note) => !note.kind);
    const moved = accepted.filter((note) => note.kind === "decision" && note.replaces);
    const text = facts.length || moved.length ? appendNotes(raw, [...facts, ...moved], now()) : null;
    const full = text === null && (facts.length > 0 || moved.length > 0);
    // a full MEMORY.md sends facts to the overflow file; a pick still lands in the timeline, its old line left in place
    const changes = accepted.flatMap(({ pick }) => {
      if (!pick) return [];
      const change = { ...pick, at: pick.kind === "pick" && pick.binding && pick.binding !== "unbound" ? pick.binding.at : pick.at || now() };
      if (full && change.kind === "pick") delete change.legacy;
      return [change];
    });
    if (full && !changes.length && !facts.length) {
      log({ botId, threadId, facts: facts.length, ms, result: "too-large" });
      return done(threadId, batch.ids, batch.owes);
    }
    // before MEMORY.md drops a replaced decision line, so a failed write never loses it; a retry lands each pick once
    const landed = changes.length ? applyPicks(timeline, changes) : null;
    if (landed) {
      try {
        writeFileAtomic(join(ensureWorkspace(botId), "memory", PICKS_FILE), landed.text, { mode: 0o600 });
      } catch (error) {
        held.set(threadId, batch);
        log({ botId, threadId, facts: accepted.length, ms, result: "error" });
        console.warn(`[memory-pass] ${PICKS_FILE} write failed (${error instanceof Error ? error.name : "error"})`);
        return arm(botId, threadId);
      }
    }
    const picked = Boolean(landed) || Boolean(batch.picked);
    // at the limit a correction still swaps in place, or else its old line comes out, so MEMORY.md never asserts the old value
    const rows = raw.split("\n");
    const stamp = day(now());
    const swaps = full
      ? facts.filter(({ replaces }) => replaces !== undefined && rows.filter((row) => sameLine(row, replaces)).length === 1 && facts.filter((other) => other.replaces === replaces).length === 1)
      : [];
    const swapFor = new Map(swaps.map(({ replaces, line }) => [replaces, line]));
    // in place, so the line count never grows and only the byte budget can refuse it
    const edited = rows.map((row) => {
      const line = swapFor.get(row.replace(/\r$/, ""));
      return line === undefined ? row : `- ${line} (noted ${stamp})${row.endsWith("\r") ? "\r" : ""}`;
    }).join("\n");
    const swapped = swaps.length && Buffer.byteLength(edited, "utf8") <= MEMORY_MAX_BYTES ? edited : null;
    const corrected = swapped ?? (swaps.length ? rows.filter((row) => !swapFor.has(row.replace(/\r$/, ""))).join("\n") : null);
    const overflow = full ? facts.filter((note) => swapped === null || !swaps.includes(note)) : [];
    const noted = text !== null ? facts : swapped !== null ? swaps : [];
    const base = text ?? corrected ?? raw;
    // with no spare line the pointer goes last with no line break, and only where the prompt still reads it
    const ending = `${base}- ${OVERFLOW_POINTER} (noted ${stamp})`;
    const pointer = overflow.length && !base.includes(OVERFLOW_FILE)
      ? appendNotes(base, [{ line: OVERFLOW_POINTER }], now()) ??
        (base.endsWith("\n") && ending.split("\n").length <= MEMORY_MAX_LINES && Buffer.byteLength(ending, "utf8") <= MEMORY_MAX_BYTES ? ending : null)
      : null;
    const saved = pointer ?? text ?? corrected;
    // before MEMORY.md drops a corrected line, so a failed write never loses the new value; a retry finds it written
    let wrote = batch.wrote ?? [];
    let seen = batch.seen ?? [];
    if (overflow.length) {
      const path = join(ensureWorkspace(botId), "memory", OVERFLOW_FILE);
      try {
        // a locked file must hold the batch, never be rewritten from the header
        const current = existsSync(path) ? readFileSync(path, "utf8") : "";
        const { rows, dates, close } = liveRows(current);
        // a row in its words noted before its day is an older copy when every row below is older too, or, if it went under an older copy, a row below falls between the two days, so a hand-edited date alone never hides it
        const older = (index: number, date: string, copy?: number) => {
          const noted = dates[index]!;
          const below = dates.slice(index + 1).filter(Boolean);
          return Boolean(noted) && noted < date && (below.every((day) => day < date) || (copy !== 0 && below.some((day) => day > noted && day < date)));
        };
        // recall keeps a label's newest-dated rows, so a row it hides is there only when a copy as new as its write was outdated by a later row
        const modified = current ? day(statSync(path).mtimeMs) : stamp;
        const label = (row: string) => (/^([^:]{2,60}):\s/.exec(row)?.[1] ?? row).toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ");
        const shown = ({ line, date }: Landed) => {
          const own = rows.reduce((max, row, index) => (row === line && (dates[index] || modified) > max ? dates[index] || modified : max), "");
          return own >= date || rows.every((row, index) => (dates[index] || modified) <= own || label(row) !== label(line));
        };
        const stays = (landed: Landed) => shown(landed) && rows.some((row, index) => row === landed.line && !older(index, landed.date, landed.copy));
        wrote = wrote.filter(stays);
        seen = seen.filter(stays);
        // from its first row gone on, so a later line of the batch still lands after an earlier one written again
        const gone = overflow.findIndex(({ line }) => ![...wrote, ...seen].some((row) => row.line === line));
        const due = gone < 0 ? [] : overflow.slice(gone);
        // written again on the day it was first noted, so it never outranks a row said after it
        const first = (line: string) => batch.wrote?.find((row) => row.line === line)?.date ?? stamp;
        // a row in its words counts as there only when it is as new as the note or no later-dated row of its label outdates it
        const present = (line: string | undefined) => line !== undefined && shown({ line, date: first(line) });
        // a restart can replay a batch whose notes already landed in order
        let ends = due.length;
        while (ends && due.slice(0, ends).some(({ line }, index) => rows.at(index - ends) !== line || !present(line))) ends -= 1;
        // a line said again lands unless it is already the newest row, so the newest row is what was said last
        let newest = present(rows.at(-1)) ? rows.at(-1) : undefined;
        const fresh = due.slice(ends).filter(({ line }) => {
          if (line === newest) return false;
          newest = line;
          return true;
        });
        seen = [...seen, ...due.filter((note) => !fresh.includes(note)).map(({ line }) => ({ line, date: dates[rows.lastIndexOf(line)] ?? "" }))];
        if (fresh.length) {
          const added = fresh.map(({ line }) => `- ${line} (noted ${first(line)})\n`).join("");
          appendLines(path, `${current ? close : OVERFLOW_HEAD}${added}`);
          const prior = overflowed.get(botId);
          overflowed.set(botId, { dropped: (prior?.dropped ?? 0) + fresh.filter(({ line }) => !batch.wrote?.some((row) => row.line === line)).length, since: prior?.since ?? now() });
          const placed = fresh.map(({ line }) => ({ line, date: first(line), copy: rows.filter((row) => row === line).length }));
          wrote = [...wrote.filter(({ line }) => !fresh.some((note) => note.line === line)), ...placed];
        }
      } catch (error) {
        hold(threadId, { ...batch, picked, wrote, seen }, accepted);
        log({ botId, threadId, facts: accepted.length, ms, result: "error" });
        console.warn(`[memory-pass] ${OVERFLOW_FILE} write failed (${error instanceof Error ? error.name : "error"})`);
        return arm(botId, threadId);
      }
    }
    // a pointer alone is appended, so a line another writer lands after the revision check stays
    const tail = pointer !== null && base === raw ? pointer.slice(raw.length) : null;
    let conflict: boolean;
    try {
      conflict = tail !== null ? readMemoryFile(botId).revision !== memory.revision : saved !== null && saveMemoryFile(botId, saved, memory.revision).conflict;
      if (tail !== null && !conflict) appendLines(join(ensureWorkspace(botId), "MEMORY.md"), tail);
    } catch (error) {
      // the overflow notes are on disk; a retry finds them there, then finishes MEMORY.md and the receipt
      hold(threadId, { ...batch, picked, wrote, seen }, accepted);
      log({ botId, threadId, facts: accepted.length, ms, result: "error" });
      console.warn(`[memory-pass] MEMORY.md write failed (${error instanceof Error ? error.name : "error"})`);
      return arm(botId, threadId);
    }
    if (conflict) {
      hold(threadId, { ...batch, picked, wrote, seen }, accepted);
      log({ botId, threadId, facts: accepted.length, ms, result: "conflict" });
      return arm(botId, threadId);
    }
    // a repeat left out of the overflow file was not written, so it gets no receipt; one an earlier try wrote does
    const kept = [...accepted.filter((note) => (note.kind ? picked : !overflow.includes(note) || [...wrote, ...batch.wrote ?? []].some(({ line }) => line === note.line))), ...owed];
    if (!kept.length) {
      log({ botId, threadId, lines: batch.source.length, facts: 0, ms, result: "none" });
      return done(threadId, batch.ids, batch.owes);
    }
    deps.store.appendMessage(sourceThread(threadId), {
      role: "bot",
      kind: "activity",
      tool: { name: MEMORY_SAVE_TOOL, ok: true, spoken: `${noteSummary(kept.map((note) => note.line))}${kept.some((note) => overflow.includes(note)) ? ` (MEMORY.md is full, saved in memory/${OVERFLOW_FILE})` : ""}`, memoryBotId: botId },
    });
    log({
      botId, threadId, lines: batch.source.length, facts: noted.length, decisions: landed?.picks ?? 0, tweaks: landed?.tweaks ?? 0,
      replaced: (landed?.replaced ?? 0) + noted.filter((note) => note.replaces).length, ms, result: full ? "too-large" : "saved",
    });
    if (!full) {
      overflowed.delete(botId);
      lost.delete(botId);
    }
    done(threadId, batch.ids, batch.owes);
  };

  const run = async (botId: string, threadId: string, signal: AbortSignal) => {
    if (signal.aborted || !deps.enabled(botId)) return;
    const theirs = foreign.get(threadId);
    const source = theirs && sourceBot(threadId);
    // read now, not at startup: the bot's sync mapping can land after a restore
    if (source && chatSyncBotId(loadProfileSyncSettings(deps.dataDir), source.id)) drop(threadId, theirs);
    const ids = [...(pending.get(threadId) ?? [])];
    const owes = [...(owedCards.get(threadId) ?? [])];
    if (!ids.length && !owes.length) return;
    if (busy(botId, threadId)) return arm(botId, threadId);
    const kept = held.get(threadId);
    if (kept) {
      land(botId, threadId, kept, readMemoryFile(botId), memoryFileRaw(botId), 0);
      if ((pending.has(threadId) || owedCards.has(threadId)) && !held.has(threadId)) arm(botId, threadId);
      return;
    }
    const generate = deps.generate(botId);
    if (!generate) return;
    const messages = deps.store.messagesFor(sourceThread(threadId));
    const rows = pendingRows(messages, ids);
    // a reply whose pass ran before the bot closed its card: filed under the card now, its notes already taken
    const closed = new Set([...pendingRows(messages, owes).values()].flatMap(({ card }) => card?.answeredBy && !ids.includes(card.answeredBy) ? [card.answeredBy] : []));
    for (const [id, row] of pendingRows(messages, [...closed])) rows.set(id, row);
    const eligible = [...ids, ...closed].filter((id) => eligibleRow(rows.get(id)));
    const replies = replyTurns(messages, eligible, join(deps.dataDir, "attachments"));
    const typed = eligible.flatMap((id) => {
      const row = rows.get(id)!;
      const first = replies.get(id);
      // one line per card the reply answers; the note-taker reads it once
      return [first, ...(first?.also ?? [])].flatMap((reply, n) => {
        const cardOnly = n > 0 || closed.has(id);
        if (cardOnly && !reply?.cardId) return [];
        // a pasted tag cannot open or close a prompt block
        // a card answer is the user's own words after the question it quotes, whole
        const text = userTyping(reply?.answer ?? row.text!, true, false, reply?.answer === undefined ? undefined : reply.choice === reply.answer ? "option" : "answer").replace(CONTEXT_TAGS, " ").trim();
        const pressed = Boolean(row.answersCard) && reply?.choice !== undefined && reply.choice === reply.answer;
        return text ? [{ id, reply, text, at: Math.max(row.actedAt ?? row.at, (reply?.edits ?? -Infinity) + 1), tap: Boolean(row.answersCard || reply?.cardId), pressed, cardOnly, files: attachedImages(row.text ?? "") }] : [];
      });
    });
    const lines = typed.sort((a, b) => a.at - b.at).map(({ id, reply, text, at, tap, pressed, cardOnly, files }) => {
      const line: UserLine = { id, text, at, thread: sourceThread(threadId) };
      if (tap) line.tap = true;
      if (tap && !pressed) line.typedAnswer = true;
      if (cardOnly) line.cardOnly = true;
      if (reply) {
        line.questionId = reply.questionId;
        line.context = reply.context ? replyContext(reply.context) : undefined;
        line.options = reply.options;
        line.pictures = reply.pictures;
        line.previousAnswerId = reply.previousAnswerId;
        line.invalidCard = reply.invalidCard;
        line.question = reply.question;
        line.choice = reply.choice;
        if (reply.prior) line.prior = { ...reply.prior, context: reply.prior.context ? replyContext(reply.prior.context) : undefined };
      }
      if (files.length) line.files = files;
      return line;
    });
    if (!lines.length) return done(threadId, ids, owes);
    const memory = readMemoryFile(botId);
    const raw = memoryFileRaw(botId);
    const asked = lines.filter(({ cardOnly }) => !cardOnly);
    if (!asked.length) return land(botId, threadId, { ids, owes, facts: [], source: lines }, memory, raw, 0);
    const started = now();
    const trace = startTurnTrace(() => ({ engine: generate.engine, botId, threadId, batchId: `${threadId}:${ids.join(":")}`, sourceMessageIds: ids, sourceSendIds: ids.flatMap((id) => rows.get(id)?.sendId ? [rows.get(id)!.sendId!] : []) }));
    const endPass = trace?.span("background_pass");
    let request = 0;
    let outcome = "helper-failed";
    let output: string;
    try {
      output = await generate(notePrompt(memory.text, asked, pickKeysList(readMemoryTopic(botId, PICKS_FILE))), signal, trace ? (usage, id) => {
        request++;
        trace.request(id ?? `helper:${request}`, usage);
      } : undefined);
      outcome = "helper-settled";
    } catch (error) {
      if (disposed || signal.aborted || !deps.enabled(botId)) return;
      if (UNAVAILABLE.test(error instanceof Error ? error.message : String(error))) {
        return warnOnce("engine CLI missing or signed out");
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
    const facts = parseFacts(output);
    if (facts === null) return;
    land(botId, threadId, { ids, owes, facts, source: lines }, memory, raw, now() - started);
  };

  const pump = () => {
    for (let i = 0; i < queue.length && running.size < MAX_PASSES; ) {
      const { botId, threadId } = queue[i]!;
      if ([...running.values()].some((pass) => pass.botId === botId)) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      if (busy(botId, threadId)) {
        arm(botId, threadId);
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PASS_TIMEOUT_MS);
      timer.unref?.();
      const pass = { botId, controller, done: Promise.resolve() };
      running.set(threadId, pass);
      // started off the caller's stack, so a settling turn never waits on a pass
      pass.done = Promise.resolve().then(() => run(botId, threadId, controller.signal))
        .catch((error) => console.warn(`[memory-pass] pass failed (${error instanceof Error ? error.name : "error"})`))
        .finally(() => {
          clearTimeout(timer);
          running.delete(threadId);
          if (again.delete(threadId)) enqueue(botId, threadId);
          pump();
        });
    }
  };

  const unsubscribe = deps.store.onChange((change: StoreChange) => {
    if (disposed) return;
    if (change.type === "bot.deleted" || (change.type === "bot" && !deps.enabled(change.botId))) return stop();
    const targetsOf = (threadId: string) => {
      const group = deps.store.groupByThread(threadId);
      const bot = group ? undefined : deps.store.botByThread(threadId);
      const targets = group ? (group.memberIds ?? []).map((id) => deps.store.bot?.(id)).filter((bot) => bot !== undefined && bot !== null) : bot ? [bot] : [];
      return targets.filter((target) => deps.enabled(target.id)).map((target) => ({ botId: target.id, key: group ? roomKey(target.id, threadId) : threadId }));
    };
    // a card the bot closed as answered in chat: its reply's pass may be over, so the next one files it under the card
    if (change.type === "message.patch" && change.message.card?.askUser && change.message.card.answeredBy && !deps.store.importingSync) {
      for (const { botId, key } of targetsOf(change.threadId)) {
        const cards = owedCards.get(key) ?? [];
        if (!cards.includes(change.message.id)) owedCards.set(key, [...cards, change.message.id].slice(-MAX_PENDING));
        if (!pending.has(key)) arm(botId, key);
      }
      return saveSoon();
    }
    if (change.type !== "message" || change.imported) return;
    const { message, threadId } = change;
    if (message.role !== "user" || message.kind !== "text") return;
    const group = deps.store.groupByThread(threadId);
    if (group && (!eligibleRow(message) || message.author?.kind === "person" || message.author?.kind === "bot")) return;
    let queued = false;
    for (const { key } of targetsOf(threadId)) {
      const ids = pending.get(key) ?? [];
      if (!ids.includes(message.id)) pending.set(key, [...ids, message.id].slice(-MAX_PENDING));
      clearTimeout(timers.get(key));
      timers.delete(key);
      queued = true;
    }
    if (queued) saveSoon();
  });

  const stop = () => {
    const off = (threadId: string) => {
      const bot = sourceBot(threadId);
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
    for (const threadId of replays.keys()) if (off(threadId)) replays.delete(threadId);
    const before = pending.size;
    for (const threadId of pending.keys()) if (off(threadId)) pending.delete(threadId);
    for (const threadId of foreign.keys()) if (!pending.has(threadId)) foreign.delete(threadId);
    const owing = owedCards.size;
    for (const threadId of owedCards.keys()) if (off(threadId)) owedCards.delete(threadId);
    if (pending.size !== before || owedCards.size !== owing) save();
  };

  stop();
  for (const threadId of new Set([...pending.keys(), ...owedCards.keys()])) {
    const bot = sourceBot(threadId);
    if (bot) arm(bot.id, threadId);
  }

  return {
    onSettled(botId, threadId, flush) {
      const group = deps.store.groupByThread(threadId);
      const targets = group ? (group.memberIds ?? []).map((id) => ({ botId: id, key: roomKey(id, threadId) })) : [{ botId, key: threadId }];
      for (const { botId, key } of targets) {
        const count = (pending.get(key)?.length ?? 0) + (owedCards.get(key)?.length ?? 0);
        if (disposed || !count || !deps.enabled(botId)) continue;
        if (flush || count >= BATCH_MESSAGES || held.has(key)) enqueue(botId, key);
        else arm(botId, key);
      }
    },
    onTurn(botId) {
      for (const pass of running.values()) if (pass.botId === botId) pass.controller.abort();
    },
    onConfigChanged() {
      if (!disposed) stop();
    },
    droppedNotes: (botId) => {
      const sent = overflowed.get(botId);
      const gone = lost.get(botId);
      if (!gone) return sent;
      const notes: DroppedNotes = { ...(sent ?? { dropped: 0, since: gone.since }) };
      notes.lost = gone;
      return notes;
    },
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
