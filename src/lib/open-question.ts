// A bot's ask_user question stays open until the person answers it (a tapped
// choice, or typing to a pinned question without choices) or dismisses it.
// Nothing extra is stored: the state is derived from the transcript, so the
// sidebar glow, the pin over the composer and the inline record can never disagree.
import type { Message } from "@/state/store";
import { askStates, isAskUserCard, isOpenRequest, isSentByPerson, scanQuestion, type AskState } from "../../shared/open-question";

export { ANSWERED_IN_CHAT } from "../../shared/open-question";
export { isAskUserCard, isSentByPerson };

export interface NeedsYou {
  /** The chat's open ask_user card, if any. */
  question: Message | null;
  /** An approval or engine question card is still open. */
  request: boolean;
}

const NONE: NeedsYou = { question: null, request: false };
const cache = new WeakMap<readonly Message[], NeedsYou>();

/** What in this chat is waiting on the person, memoized per message array. */
export function needsYou(messages: readonly Message[]): NeedsYou {
  if (!messages.length) return NONE;
  const cached = cache.get(messages);
  if (cached) return cached;
  const question = scanQuestion(messages);
  const request = messages.some(isOpenRequest);
  const result = question || request ? { question, request } : NONE;
  cache.set(messages, result);
  return result;
}

export function openQuestion(messages: readonly Message[]): Message | null {
  return needsYou(messages).question;
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
