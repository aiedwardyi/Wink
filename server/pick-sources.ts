import { basename, join } from "node:path";

import { answerPrefix, askStates } from "../shared/open-question.ts";

import { LABELED, pickKey, type PickEntry, type Picture } from "./picks.ts";
import type { Message } from "./store.ts";

const PICTURE_SCAN = 200;
const PICTURES_MAX = 8;
const CAPTION_MAX = 80;
const SHOW_IMAGE = /(?:^|[_.])show_image$/;
const PREVIEW_REQUEST = /^(?:please\s+|(?:can|could) you\s+)?(?:show\b|let me see\b)[^\n.!?]*[.!?]?$/i;
const CORRECTION = /^(?:actually\b|(?:no[,\s]+)?wait\b|i changed my mind\b)/i;
const CONFIRMATION = /^(?:option\s+)?[a-z1-9]\s+it is\b[^?]*$/i;

export type ShownPicture = Picture & { original?: string };
type PictureTurn = { questionId: string; context?: string; options?: string[]; pictures: ShownPicture[] };
export type ReplyPictures = PictureTurn & {
  prior?: PictureTurn & { kind: "preview" | "correction" }; previousAnswerId?: string; invalidCard?: boolean; question?: string;
  /** the card the reply answers, by its id or as the chat reads the reply */
  cardId?: string;
  /** the reply's own words, without the question it quotes */
  answer?: string;
  /** the card's own option the reply picks, word for word */
  choice?: string;
  /** an edit's newest replaced row time: the edit is newer, whatever that row's clock said */
  edits?: number;
};
type PickSource = Partial<ReplyPictures> & { id?: string; at?: number; thread?: string; files?: string[] };
type PickClaim = {
  key: string; picked: string; over: string[]; messageId?: string | null; questionId?: string | null; at?: number; thread?: string;
  picture?: string | null; overPictures?: string[]; files?: string[];
};
const verifiedBinding = Symbol("verified pick");
export type PickBinding = {
  readonly [verifiedBinding]: true;
  at: number; messageId: string; questionId: string; thread: string;
  picture?: Picture; overPictures: Picture[]; files: string[];
  /** the question's own asking sentences name the whole key */
  named: boolean;
};

const sentByPerson = (message: Message) => message.role === "user" && message.kind === "text" && !message.from;

function botTurn(messages: readonly Message[], start: number, parent: (index: number) => number) {
  const turn: Message[] = [];
  for (let i = start, scanned = 0; i >= 0 && scanned < PICTURE_SCAN; i = parent(i), scanned++) {
    const row = messages[i]!;
    if (sentByPerson(row)) return { turn: turn.reverse(), previous: i };
    if (row.role === "bot" && !row.comm) turn.push(row);
  }
  return { turn: turn.reverse(), previous: -1 };
}

const OPTION = /(?:^|\s)[*_(]*(?:[a-h]|\d{1,2})[*_]*\s*[-.):]\s+\S/gi;
const isQuestionCard = (row: Message) => row.kind === "options" && row.role === "bot" && row.card?.askUser && !row.card.requestId;
const asks = (row: Message) => isQuestionCard(row) || (row.kind === "text" && (/[?？]/.test(row.text ?? "") || (row.text?.match(OPTION)?.length ?? 0) > 1));

function picturesIn(turn: Message[], attachments: string, answered?: Message): PictureTurn | undefined {
  const tools = new Map(turn.filter((row) => row.kind === "activity" && row.tool?.ok !== false && SHOW_IMAGE.test(row.tool?.name ?? "")).map((row) => [row.id, row.tool?.summary]));
  const pictures: ShownPicture[] = [];
  let lastScreen: string | undefined;
  // with two questions in one turn, a screen shown before the last one may be either's
  const asked = turn.filter(asks);
  for (const row of asked.length > 1 ? turn.slice(turn.indexOf(asked.at(-1)!) + 1) : turn) {
    if (row.kind !== "screen" || !row.image || basename(row.image) !== row.image) continue;
    const path = join(attachments, row.image);
    const caption = row.text?.replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX);
    const original = row.parentId ? tools.get(row.parentId) : undefined;
    pictures.push({ path, caption, original });
    lastScreen = row.id;
  }
  const reply = turn.findLast((row) => row.kind === "text" && row.text?.trim());
  const question = answered ?? turn.findLast((row) => row === reply || isQuestionCard(row));
  const questionId = question?.id ?? lastScreen;
  if (!questionId) return undefined;
  const card = question?.card;
  // a question with no buttons can lean on the bot's words before it, as an unanswered one does
  const context = [answered && card?.options?.length ? card.subtitle : reply?.text ?? card?.subtitle, ...(card?.options ?? [])].filter(Boolean).join("\n");
  return { questionId, context, options: card?.options, pictures: pictures.slice(-PICTURES_MAX) };
}

export const labeledOptions = (context = "") => [...context.matchAll(/(?:^|\s)([a-h]|\d{1,2})\s*[-.):]\s+(.+?)(?=\s+(?:or\s+)?(?:[a-h]|\d{1,2})\s*[-.):]\s+|$)/gi)]
  .map((match) => `${match[1]} - ${match[2]!.replace(/[?,;]+$/, "").trim()}`);

const PLACES = ["first", "second", "third", "fourth", "fifth"];
const POINTER = /^(?:option\s+)?([a-z]|\d{1,2})[.)]?$/i;
const PLACE = /^(?:the\s+)?(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)(?:\s+(?:one|option|choice))?(?:,?\s+please)?[.!]?$/i;

/** The card's own option an answer names: its whole text as written, else its letter, number or place on this card. Never a near name: "C++" is not "C#". */
export function cardChoice(answer: string, options: readonly string[]): string | undefined {
  const said = answer.trim();
  const own = options.map((option) => option.trim()).filter(Boolean);
  if (own.includes(said)) return said;
  const label = POINTER.exec(said)?.[1]?.toLowerCase();
  if (label) {
    const labeled = own.filter((option) => LABELED.exec(option)?.[1]?.toLowerCase() === label);
    // a card that letters or numbers its options is read by those labels, not by place
    if (own.some((option) => LABELED.test(option))) return labeled.length === 1 ? labeled[0] : undefined;
    return own[/\d/.test(label) ? Number(label) - 1 : label.charCodeAt(0) - 97];
  }
  const place = PLACE.exec(said)?.[1]?.toLowerCase();
  if (!place) return undefined;
  return own[place === "last" ? own.length - 1 : (PLACES.indexOf(place) + 1 || Number(place[0])) - 1];
}

const QUOTED = /^\s*>/;
const QUOTE_MARKS = /^\s*(?:>\s?)+/;
const plain = (text: string) => text.replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** A reply without the blockquotes it pasted from the chat before it; a blockquote the user wrote, such as a callout, is their own words. */
function ownWords(said: string, before: () => readonly Message[]): string {
  let shown: string | undefined;
  const quotesChat = (words: string) => (shown ??= plain(before().flatMap((row) => [row.text ?? "", row.card?.subtitle ?? "", ...(row.card?.options ?? [])]).join("\n"))).includes(words);
  const lines = said.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length;) {
    let end = i;
    while (end < lines.length && QUOTED.test(lines[end]!)) end += 1;
    if (end === i) {
      kept.push(lines[i++]!);
      continue;
    }
    const block = lines.slice(i, end);
    const words = plain(block.map((line) => line.replace(QUOTE_MARKS, "")).join(" "));
    if (!words || !quotesChat(words)) kept.push(...block);
    i = end;
  }
  return kept.join("\n").trim();
}

export function replyTurns(messages: readonly Message[], ids: string[], attachments: string): Map<string, ReplyPictures> {
  const wanted = new Set(ids);
  const found = new Map<string, ReplyPictures>();
  const byId = new Map(messages.map(({ id }, i) => [id, i]));
  const parent = (i: number) => {
    const id = messages[i]!.parentId;
    const index = id === undefined ? i - 1 : id ? byId.get(id) ?? -1 : -1;
    return index < i ? index : -1;
  };
  // the chat as the reply's own branch shows it, root first: a card on another branch is never its question
  const pathTo = (i: number) => {
    const path: Message[] = [];
    for (let at = i; at >= 0; at = parent(at)) path.push(messages[at]!);
    return path.reverse();
  };
  // a reply with no card id answers the newest card on its branch it quotes, answered before or not, else a question with no buttons its branch closes with it
  const chatCard = (answer: Message, path: readonly Message[]) => {
    if (answer.answersCard) return undefined;
    const text = answer.text ?? "";
    const quoted = text.startsWith("Re: “") ? path.findLast((row) => row !== answer && isQuestionCard(row) && text.startsWith(answerPrefix(row))) : undefined;
    if (quoted) return quoted.id;
    for (const [card, state] of askStates(path)) if (state.state === "answered" && state.by === answer && !card.card?.options?.length) return card.id;
    return undefined;
  };
  for (let i = messages.length - 1; i >= 0 && wanted.size; i -= 1) {
    const answer = messages[i]!;
    if (!wanted.delete(answer.id)) continue;
    let path: Message[] | undefined;
    const branch = () => (path ??= pathTo(i));
    const cardId = answer.answersCard ?? chatCard(answer, branch());
    const card = cardId ? byId.get(cardId) : undefined;
    const answered = card !== undefined && card < i && isQuestionCard(messages[card]!) ? messages[card] : undefined;
    const { turn, previous } = botTurn(messages, answered ? card! : parent(i), parent);
    const current = picturesIn(turn, attachments, answered) ?? { questionId: answer.id, pictures: [] };
    const previousAnswer = messages[previous];
    const preview = current.pictures.length > 0 && PREVIEW_REQUEST.test(previousAnswer?.text?.trim() ?? "");
    const correction = !current.pictures.length && !current.options?.length && (!current.context || CONFIRMATION.test(current.context)) && CORRECTION.test(answer.text?.trim() ?? "");
    const prior = previousAnswer && !answered && (preview || correction) ? picturesIn(botTurn(messages, parent(previous), parent).turn, attachments) : undefined;
    const reply: ReplyPictures = { ...current, prior: prior && { ...prior, kind: preview ? "preview" : "correction" }, previousAnswerId: previousAnswer?.id, invalidCard: Boolean(answer.answersCard && !answered), question: answered?.card?.subtitle };
    if (answered) {
      reply.cardId = answered.id;
      const text = answer.text ?? "";
      const said = (text.startsWith(answerPrefix(answered)) ? text.slice(answerPrefix(answered).length) : text).trim();
      const choice = cardChoice(said, answered.card?.options?.length ? answered.card.options : labeledOptions(answered.card?.subtitle));
      if (choice !== undefined) reply.choice = choice;
      reply.answer = choice === said ? said : ownWords(said, () => branch().slice(0, -1));
    }
    // an edit sits on the parent of the user's rows it replaces
    const replaced = messages.slice(0, i).filter((row, j) => sentByPerson(row) && parent(j) === parent(i));
    if (replaced.length) reply.edits = Math.max(...replaced.map((row) => row.actedAt ?? row.at));
    found.set(answer.id, reply);
  }
  return found;
}

function shownPicture(value: string | null | undefined, shown: ShownPicture[]): Picture | undefined {
  const pathKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  const asked = value && pathKey(value.trim());
  if (!asked) return undefined;
  const is = (path: string, caption?: string) => asked === pathKey(path) || (caption !== undefined && asked === pathKey(`${path} (${caption})`));
  const matches = shown.filter(({ path, caption, original }) => is(path, caption) || (original && is(original, caption)));
  const match = matches[0];
  if (!match || matches.some(({ path }) => pathKey(path) !== pathKey(match.path))) return undefined;
  return shown.some(({ path, caption }) => pathKey(path) === pathKey(match.path) && caption !== match.caption) ? undefined : { path: match.path, caption: match.caption };
}

const SENTENCE_END = /(?<=[.!?？。！][*_)"'”’\]]*)\s+|\n\s*\n/;
const optionCount = (text: string) => text.match(OPTION)?.length ?? 0;

/** A question's asking sentences, without the statements before them such as a restated earlier pick. */
function asking(context = ""): string {
  const units = context.split(SENTENCE_END).filter((unit) => unit.trim());
  const kept: string[] = [];
  for (let i = units.length - 1, lean = false; i >= 0; i -= 1) {
    const unit = units[i]!;
    const question = /[?？]/.test(unit) || optionCount(unit) > 1;
    if (question || (lean && optionCount(unit) !== 1)) kept.unshift(unit);
    // a bare "Which one?" or an option list with no label leans on the sentence before it, unless that one states a single option
    lean = question && !(optionCount(unit) > 1 && /\p{L}/u.test(unit.slice(0, unit.search(OPTION))));
  }
  return kept.length ? kept.join(" ") : context;
}

/** A question that names its own topic before the options, as in "Settings: A - red or B - blue?", with no word of the key. */
function namesOtherTopic(context: string | undefined, key: string): boolean {
  const text = asking(context);
  const head = text.slice(0, Math.max(0, text.search(OPTION))).replace(/[\s*_]+$/, "");
  if (!head.endsWith(":")) return false;
  const words = pickKey(head).split(" ");
  // a prefix match lets "look" meet "looks" and a Korean noun meet its particle
  return !pickKey(key).split(" ").some((word) => words.some((each) => each.startsWith(word) || word.startsWith(each)));
}

/** How well a reply's question names a pick: the whole key as one phrase first, then how many of its words. */
function topicScore(source: PickSource, key: string): [number, number] {
  const text = ` ${pickKey([asking(source.context), asking(source.prior?.context)].filter(Boolean).join(" "))} `;
  const words = pickKey(key).split(" ");
  return [text.includes(` ${words.join(" ")} `) ? 1 : 0, words.filter((word) => text.includes(` ${word} `)).length];
}

function captionMatches(caption: string, option: string): boolean {
  const [a, b] = [caption.trim(), option.trim()];
  const [left, right] = [LABELED.exec(a)?.[1]?.toLowerCase(), LABELED.exec(b)?.[1]?.toLowerCase()];
  return (!left || !right || left === right) && pickKey(a.replace(LABELED, "")) === pickKey(b.replace(LABELED, ""));
}

export const offersOption = (source: PickSource, option: string) => ` ${pickKey(source.context ?? "")} `.includes(` ${pickKey(option)} `);

/** Rivals are the batch's other replies that could carry this pick: the bound reply's question must name the pick better than each. */
export function validatePickBinding(claim: PickClaim, source: PickSource | undefined, before?: PickEntry, rivals: readonly PickSource[] = []): PickBinding | undefined {
  if (!source?.id || !source.thread || source.at === undefined || !Number.isFinite(new Date(source.at).getTime()) || source.invalidCard) return undefined;
  if ((claim.messageId != null && claim.messageId !== source.id) || (claim.thread !== undefined && claim.thread !== source.thread) || (claim.at !== undefined && claim.at !== source.at)) return undefined;
  const topic = (context = "") => ` ${pickKey(context)} `.includes(` ${pickKey(claim.key)} `);
  const prior = source.prior && claim.questionId === source.prior.questionId && (source.prior.kind === "correction" || (topic(source.context) && topic(source.prior.context))) ? source.prior : undefined;
  const recorded = source.prior?.kind === "correction" && before?.binding === "verified" && before.thread === source.thread && before.messageId === source.previousAnswerId && before.questionId === source.prior.questionId && (!claim.questionId || claim.questionId === before.questionId)
    ? [before.picture, ...before.overPictures].filter((picture): picture is Picture => Boolean(picture)) : [];
  const questionId = prior?.questionId ?? (recorded.length ? before?.questionId : undefined) ?? source.questionId ?? source.id;
  if (claim.questionId != null && claim.questionId !== questionId) return undefined;
  if (namesOtherTopic(prior ? prior.context : source.context, claim.key)) return undefined;
  const [phrase, words] = topicScore(source, claim.key);
  if (rivals.some((other) => {
    if (other.questionId === questionId || other.prior?.questionId === questionId) return false;
    const [otherPhrase, otherWords] = topicScore(other, claim.key);
    return otherPhrase > phrase || (otherPhrase === phrase && otherWords >= words);
  })) return undefined;

  const shown = [...(source.pictures ?? []), ...(prior?.pictures ?? []), ...recorded];
  const options = [claim.picked, ...claim.over];
  const forOption = (picture: Picture | undefined) => {
    if (!picture?.caption) return -1;
    const matches = options.flatMap((option, i) => captionMatches(picture.caption!, option) ? [i] : []);
    return matches.length === 1 ? matches[0]! : -1;
  };
  const winner = claim.picture ? shownPicture(claim.picture, shown) : recorded.find((picture) => forOption(picture) === 0);
  const picture = forOption(winner) === 0 ? winner : undefined;
  const rejected = claim.overPictures ?? (picture && recorded.some(({ path }) => path === picture.path) ? recorded.map(({ path }) => path) : []);
  const overPictures = new Map<number, Picture | null>();
  for (const path of rejected) {
    const found = shownPicture(path, shown);
    const option = forOption(found);
    if (!found || option <= 0 || found.path === picture?.path) continue;
    const other = overPictures.get(option);
    if (other?.path !== found.path) overPictures.set(option, overPictures.has(option) ? null : found);
  }
  const paths = new Set(source.files ?? []);
  const files = (claim.files ?? source.files ?? []).filter((path) => paths.has(path));
  return {
    [verifiedBinding]: true,
    at: source.at, messageId: source.id, questionId, thread: source.thread, picture,
    overPictures: [...overPictures.values()].filter((value): value is Picture => value !== null), files, named: phrase === 1,
  };
}

const sourcesOf = (entry: PickEntry) => new Set([
  ...(entry.messageId ? [JSON.stringify([entry.thread, entry.messageId, entry.questionId])] : []),
  ...[entry.picture, ...entry.overPictures].flatMap((picture) => picture ? [picture.path] : []),
  ...entry.files,
]);

/** Picks on different questions that claim one answer or screenshot, less the one pick bound to it by its own message id and action time, when only one is. */
export function sharedSources(entries: readonly PickEntry[]): Set<PickEntry> {
  const claims = new Map<string, PickEntry[]>();
  for (const entry of entries) {
    if (entry.binding === "unbound") continue;
    for (const source of sourcesOf(entry)) claims.set(source, [...(claims.get(source) ?? []), entry]);
  }
  const shared = new Set<PickEntry>();
  for (const claimants of claims.values()) {
    if (new Set(claimants.map(({ key }) => pickKey(key))).size < 2) continue;
    const exact = claimants.filter((entry) => entry.binding === "verified" && entry.messageId && entry.at !== undefined);
    for (const entry of claimants) if (exact.length !== 1 || entry !== exact[0]) shared.add(entry);
  }
  return shared;
}

export function holdSources(entry: PickEntry): void {
  delete entry.picture;
  entry.overPictures = [];
  entry.files = [];
  delete entry.at;
  entry.binding = "unbound";
}
