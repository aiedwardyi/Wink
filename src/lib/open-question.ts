// A bot's ask_user question stays open until the person replies in that chat
// (typing anything, or tapping a choice) or dismisses it. Nothing extra is
// stored: the state is derived from the transcript, so the sidebar glow, the
// pin over the composer and the inline record can never disagree.
import type { Message } from "@/state/store";
import { answersQuestion, isAskUserCard, isOpenRequest, isSentByPerson, scanQuestion } from "../../shared/open-question";

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

export type AskUserStatus =
  | { state: "waiting" }
  | { state: "answered"; reply: string }
  | { state: "dismissed" }
  | { state: "superseded" };

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}

/** How a marked card reads in the transcript. */
export function askUserStatus(messages: readonly Message[], message: Message): AskUserStatus {
  const card = message.card;
  if (card?.answered) return { state: "answered", reply: firstLine(card.answered) };
  if (card?.dismissed) return { state: "dismissed" };
  const index = messages.findIndex((entry) => entry.id === message.id);
  for (let i = index < 0 ? messages.length : index + 1; i < messages.length; i++) {
    const later = messages[i];
    if (answersQuestion(later)) return { state: "answered", reply: firstLine(later.text ?? "") };
    if (isAskUserCard(later)) return { state: "superseded" };
  }
  return { state: "waiting" };
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
