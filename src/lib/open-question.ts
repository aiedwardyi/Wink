// A bot's ask_user question stays open until the person answers it (a tapped
// choice, or typing to a pinned question without choices) or dismisses it.
// Nothing extra is stored: the state is derived from the transcript, so the
// sidebar glow, the pin over the composer and the inline record can never disagree.
// What this screen shows of a question (its fold, the one shrink, the arrival
// glow, an arrow's pick) is this device's alone and lives here too, so no
// component keeps a copy that can drift from it.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Message, OptionCardData } from "@/state/store";
import { reducedMotion } from "./phone-swipe";
import { isShownMessage } from "./shown-message";
import { askStates, isAskUserCard, isOpenRequest, isSentByPerson, lineSettles, typedReply, type AskState } from "../../shared/open-question";

export { ANSWERED_IN_CHAT } from "../../shared/open-question";
export { isAskUserCard, isSentByPerson };

export interface NeedsYou {
  /** The chat's newest open ask_user card, if any. */
  question: Message | null;
  /** Every ask_user card still waiting, oldest first. */
  questions: readonly Message[];
  /** An approval or engine question card is still open. */
  request: boolean;
}

const NONE: NeedsYou = { question: null, questions: [], request: false };
const cache = new WeakMap<readonly Message[], NeedsYou>();

/** What in this chat is waiting on the person, memoized per message array. */
export function needsYou(messages: readonly Message[]): NeedsYou {
  if (!messages.length) return NONE;
  const cached = cache.get(messages);
  if (cached) return cached;
  const questions = [...askStates(messages)].flatMap(([card, status]) => (status.state === "waiting" ? [card] : []));
  const question = questions.at(-1) ?? null;
  const request = messages.some(isOpenRequest);
  const result = question || request ? { question, questions, request } : NONE;
  cache.set(messages, result);
  return result;
}

export function openQuestion(messages: readonly Message[]): Message | null {
  return needsYou(messages).question;
}

export function openQuestions(messages: readonly Message[]): readonly Message[] {
  return needsYou(messages).questions;
}

/** The open question a typed `text` settles at once, what with, and whether the line alone settles it once it lands. */
export function typedAnswer(messages: readonly Message[], text: string): { question: Message; answered: string; byLine: boolean } | null {
  const question = openQuestion(messages);
  if (!question) return null;
  const answered = typedReply(question, text);
  return answered === null ? null : { question, answered, byLine: lineSettles(messages, question, text) };
}

/** An open permission ask: it takes the composer over, so it hides the pin. */
function isOpenApproval(message: Message): boolean {
  return isOpenRequest(message) && Boolean(message.card?.tool);
}

/** The question pinned above the composer. `visible` is the shown branch,
 * where an approval waits; the question comes from the whole chat. */
export function pinnedQuestion(messages: readonly Message[], visible: readonly Message[] = messages): Message | null {
  return visible.some(isOpenApproval) ? null : openQuestion(messages);
}

/** The chat moved on from `question`: the person sent a message after it (a queued line landing by itself is not one), or its asker replied. */
export function chatMovedOn(messages: readonly Message[], question: Message): boolean {
  const at = messages.indexOf(question);
  const asker = question.from?.botId;
  return at >= 0 && messages.slice(at + 1).some((message) =>
    message.role === "bot"
      ? message.kind === "text" && message.from?.botId === asker && isShownMessage(message)
      : isSentByPerson(message) && !message.queueId);
}

/** True when a sidebar row for this chat should glow. */
export function chatNeedsYou(messages: readonly Message[]): boolean {
  const state = needsYou(messages);
  return Boolean(state.question) || state.request;
}

export type AskUserStatus = Exclude<AskState, { state: "answered" }> | { state: "answered"; reply: string };

const statuses = new WeakMap<readonly Message[], Map<string, AskState>>();

/** How a marked card reads in the transcript. */
export function askUserStatus(messages: readonly Message[], message: Message): AskUserStatus {
  let states = statuses.get(messages);
  if (!states) statuses.set(messages, (states = new Map([...askStates(messages)].map(([card, state]) => [card.id, state]))));
  const status = states.get(message.id) ?? askStates([message]).get(message)!;
  return status.state === "answered" ? { state: "answered", reply: status.reply } : status;
}

/** How a question's transcript record reads: gone while the composer shows it, its choices live while it waits. */
export function askRecord(transcript: readonly Message[], message: Message, shown: boolean): { status: AskUserStatus; hidden: boolean; live: boolean } {
  const status = askUserStatus(transcript, message);
  const live = status.state === "waiting";
  return { status, hidden: live && shown, live };
}

/** What a tap persists on its card: an ask_user card or a live ask reads answered, the first-run quiz also drops out. */
export function answerPatch(card: Pick<OptionCardData, "requestId" | "askUser"> | undefined, answer: string): Partial<OptionCardData> {
  return card?.requestId || card?.askUser ? { answered: answer } : { answered: answer, dismissed: true };
}

/** True while `cardId` still holds the answer one send gave it, so undoing that send may reopen it. */
export function settledBy(messages: readonly Message[], settles: { cardId: string; answered: string }): boolean {
  return messages.some((message) => message.id === settles.cardId && message.card?.answered === settles.answered);
}

/** The message box asks to type the answer: the shown question takes any typed line. */
export function asksForTyping(question: Message | null): boolean {
  return Boolean(question?.card && !question.card.options.length);
}

/** False only for an ask_user card that already settled, so a stale tap cannot answer it again. */
export function canAnswerCard(messages: readonly Message[], messageId: string): boolean {
  const message = messages.find((candidate) => candidate.id === messageId);
  return !message || !isAskUserCard(message) || askUserStatus(messages, message).state === "waiting";
}

/** For the control hiding the rows (drawer button, collapsed sidebar or
 * section): does any chat other than the open one need the person? */
export function anyChatNeedsYou(
  chats: Iterable<{ id: string; hidden?: boolean; messages: readonly Message[] }>,
  exceptId?: string,
): boolean {
  for (const chat of chats) {
    if (chat.id !== exceptId && !chat.hidden && chatNeedsYou(chat.messages)) return true;
  }
  return false;
}

const folds = new Set<string>();
const shrunk = new Set<string>();
const glowed = new Set<string>();
// newest waiting id -> the older one the composer's arrows show instead
const picks = new Map<string, string>();
const watchers = new Set<() => void>();
function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}
const changed = () => { for (const notify of watchers) notify(); };

/** Shows a question as its row from now on; it never shrinks by itself after that. */
export function foldQuestion(id: string) {
  shrunk.add(id);
  folds.add(id);
  changed();
}

/** Opens a question's full card; the person's own open keeps it open while they type. */
export function unfoldQuestion(id: string) {
  folds.delete(id);
  changed();
}

/** What the message box holds and whether the chat moved on: the inputs that fold a question once. */
export interface QuestionInput {
  typed: string;
  attached: number;
  replying: boolean;
  movedOn: boolean;
}

/** The fold rule for one question: it folds once, the first time the person types, attaches or starts a reply,
 * or the chat moves on, and arrives folded when that already happened; after that only the person folds or opens it. */
export function questionFolded(id: string, input: QuestionInput): boolean {
  return folds.has(id) || (!shrunk.has(id) && (drafting(input) || input.movedOn));
}

const drafting = (input: QuestionInput) => Boolean(input.typed.trim()) || input.attached > 0 || input.replying;

/** A shown question's fold and arrival glow, which plays once per question and never after it folds. */
export function useQuestionView(id: string, input: QuestionInput) {
  useSyncExternalStore(subscribe, () => folds.has(id), () => false);
  // read in render so a question arriving over a draft or past the chat's last turn never paints as the card first
  const folded = questionFolded(id, input);
  const [glowing, setGlowing] = useState(() => !glowed.has(id) && !reducedMotion());
  useEffect(() => { glowed.add(id); }, [id]);
  const was = useRef(input);
  const { typed, attached, replying, movedOn } = input;
  useEffect(() => {
    const before = was.current;
    was.current = { typed, attached, replying, movedOn };
    if (shrunk.has(id) || !(drafting(was.current) || movedOn || typed !== before.typed || attached > before.attached)) return;
    setGlowing(false);
    foldQuestion(id);
  }, [id, typed, attached, replying, movedOn]);
  const fold = (value: boolean) => {
    setGlowing(false);
    if (value) foldQuestion(id);
    else unfoldQuestion(id);
  };
  return { folded, glowing, fold, endGlow: () => setGlowing(false) };
}

/** The question the composer shows: the newest waiting one, or an older one its arrows picked until a newer one arrives.
 * `visible` is the shown branch, where an approval waits. */
export function useShownQuestion(messages: readonly Message[], visible: readonly Message[] = messages) {
  const pinned = pinnedQuestion(messages, visible);
  const questions = pinned ? openQuestions(messages) : [];
  const [pick, setPick] = useState<{ id: string; newest: string } | null>(null);
  const question = (pick?.newest === pinned?.id && questions.find((open) => open.id === pick?.id)) || pinned;
  const index = question ? questions.indexOf(question) : -1;
  const newest = pinned?.id;
  const shown = question?.id;
  // the transcript reads the pick before paint, so a record never shows next to its own pin
  useLayoutEffect(() => {
    if (!newest || !shown || shown === newest) return;
    picks.set(newest, shown);
    changed();
    return () => {
      picks.delete(newest);
      changed();
    };
  }, [newest, shown]);
  const step = (by: number) => {
    const next = questions[index + by];
    if (!next || !pinned) return;
    foldQuestion(next.id);
    setPick({ id: next.id, newest: pinned.id });
  };
  return { question, count: questions.length, index, step };
}

/** The id of the question the composer shows, for the transcript record it replaces. */
export function useShownQuestionId(messages: readonly Message[], visible: readonly Message[] = messages): string | undefined {
  const pinned = pinnedQuestion(messages, visible);
  const picked = useSyncExternalStore(subscribe, () => (pinned ? picks.get(pinned.id) : undefined), () => undefined);
  return picked && openQuestions(messages).some((open) => open.id === picked) ? picked : pinned?.id;
}
