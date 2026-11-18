import type { Message } from "@/state/store";
import { anyChatNeedsYou as scanChats, canAnswerCard, isAskUserCard } from "./open-question";

interface PendingAnswer {
  text: string;
  cardId?: string;
  answersCard?: string;
  sendId?: string;
  queueId?: string;
}

export function anyChatNeedsYou(
  chats: Iterable<{ id: string; threadId: string; hidden?: boolean; messages: readonly Message[] }>,
  exceptId?: string,
  accepted: Readonly<Record<string, readonly PendingAnswer[] | undefined>> = {},
  queued: Readonly<Record<string, readonly PendingAnswer[] | undefined>> = {},
): boolean {
  return scanChats([...chats].map((chat) => ({ ...chat, messages: withPendingCardAnswers(chat.messages, accepted[chat.threadId], queued[chat.threadId]) })), exceptId);
}

export function withPendingCardAnswers(
  messages: readonly Message[],
  accepted: readonly PendingAnswer[] = [],
  queued: readonly PendingAnswer[] = [],
  canonical: readonly Message[] = messages,
): readonly Message[] {
  const landed = new Set(canonical.flatMap((message) => [message.sendId, message.queueId]));
  const pending = [...accepted, ...queued].flatMap((entry): Message[] => {
    const id = entry.sendId ?? entry.queueId;
    const answersCard = entry.cardId ?? entry.answersCard;
    if (!id || !answersCard || landed.has(id)) return [];
    return [{ id: `pending-card-${id}`, at: 0, role: "user", kind: "text", text: entry.text, answersCard, queueId: entry.queueId ?? id }];
  });
  return pending.length ? [...messages, ...pending] : messages;
}

export function answerableCard(
  messages: readonly Message[],
  visible: readonly Message[],
  id: string,
  rendered: Message | undefined,
  accepted: readonly PendingAnswer[] = [],
  queued: readonly PendingAnswer[] = [],
): Message | undefined {
  const known = messages.find((message) => message.id === id);
  const shown = visible.some((message) => message.id === id);
  const question = shown ? known : rendered?.id === id && isAskUserCard(rendered) ? rendered : undefined;
  if (!question) return undefined;
  const context = shown ? visible : [...visible, question];
  return canAnswerCard(withPendingCardAnswers(context, accepted, queued, messages), id) ? question : undefined;
}
