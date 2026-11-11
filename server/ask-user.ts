// The agents proxy's ask_user: a question pinned for the user that never
// pauses the bot. It lands as a bot options card marked `askUser` (so the
// client can tell it from the first-run quiz, which has no requestId either)
// and buzzes the same "has a question" alert as a provider's own ask. The
// answer is simply the user's next message, so nothing here waits and the
// bot's activity is never set to waiting-on-you.
import { z } from "zod";

import { replyExcerpt } from "./replies.ts";
import type { BotRecord, Message } from "./store.ts";

export const ASK_USER_TITLE = "Your bot has a question";
export const ASK_USER_QUESTION_MAX = 2_000;
export const ASK_USER_MAX_CHOICES = 5;
const CHOICE_MAX = 200;
const CLOSED_QUESTION_CHARS = 200;

/** Anything malformed reads as empty, so the handler answers with a 4xx. */
export const askUserRequestSchema = z
  .object({
    fromBotId: z.string().catch(""),
    fromThreadId: z.string().catch(""),
    question: z.string().catch(""),
    choices: z.array(z.string().catch("")).catch([]),
  })
  .catch({ fromBotId: "", fromThreadId: "", question: "", choices: [] });
export type AskUserRequest = z.infer<typeof askUserRequestSchema>;

/** What a room may persist on a member's ask_user card. */
export const askUserCardPatchSchema = z
  .object({
    answered: z.string().optional().catch(undefined),
    dismissed: z.literal(true).optional().catch(undefined),
  })
  .catch({});

/** Trimmed, deduped, non-empty choices, at most five. */
export function askUserChoices(raw: readonly string[]): string[] {
  const choices: string[] = [];
  for (const value of raw) {
    const choice = value.trim().slice(0, CHOICE_MAX);
    if (!choice || choices.includes(choice)) continue;
    choices.push(choice);
    if (choices.length === ASK_USER_MAX_CHOICES) break;
  }
  return choices;
}

type Sender = Pick<BotRecord, "id" | "name" | "color">;

export interface AskUserDeps<B extends Sender> {
  bot(id: string): B | null | undefined;
  /** The sender's own 1:1 task or a room it belongs to; null otherwise. */
  conversation(botId: string, threadId: string): { group?: object } | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  /** The thread the alert opens, read when the bot asks: a routine run is over by release. */
  alertThread(bot: B, threadId: string): string;
  notifyQuestion(bot: B, target: string, question: string): void;
  /** Runs `post` now, or once the asking turn has replied. */
  whenSettled(botId: string, threadId: string, post: () => void): void;
}

export interface AskUserResult {
  status: number;
  body: { error: string } | { messageId: string } | { held: true };
}

export function postAskUser<B extends Sender>(deps: AskUserDeps<B>, request: AskUserRequest): AskUserResult {
  const from = deps.bot(request.fromBotId);
  if (!from) return { status: 403, body: { error: "unknown sender" } };
  if (!request.fromThreadId) return { status: 400, body: { error: "no active thread" } };
  const owner = deps.conversation(from.id, request.fromThreadId);
  if (!owner) return { status: 403, body: { error: "source thread does not belong to sender" } };
  const question = request.question.trim().slice(0, ASK_USER_QUESTION_MAX);
  if (!question) return { status: 400, body: { error: "question required" } };
  const message: Omit<Message, "id" | "at"> = {
    role: "bot",
    kind: "options",
    card: { title: ASK_USER_TITLE, subtitle: question, options: askUserChoices(request.choices), askUser: true },
  };
  // rooms attribute the question to the member who asked, like show_image
  if (owner.group) message.from = { botId: from.id, name: from.name, color: from.color };
  const threadId = request.fromThreadId;
  const target = deps.alertThread(from, threadId);
  let posted: Message | undefined;
  deps.whenSettled(from.id, threadId, () => {
    // a bot deleted or removed from the room while its card waited has nobody to ask for
    if (!deps.conversation(from.id, threadId)) return;
    posted = deps.appendMessage(threadId, message);
    deps.notifyQuestion(from, target, question);
  });
  return posted ? { status: 201, body: { messageId: posted.id } } : { status: 202, body: { held: true } };
}

const isAskUserCard = (message: Message) => message.kind === "options" && Boolean(message.card?.askUser) && !message.card?.requestId;
const sentByPerson = (message: Message) => message.role === "user" && message.kind === "text" && !message.from;

/** The bot's note when the person's message closed its open ask_user card unanswered. No `closerId`: a steer not yet in `messages`. */
export function closedAskNotes(messages: readonly Message[], text: string, closerId?: string, botId?: string): string[] {
  const end = closerId === undefined ? messages.length : messages.findIndex((message) => message.id === closerId);
  if (end < 0 || (closerId !== undefined && !sentByPerson(messages[end]!))) return [];
  for (let i = end - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (sentByPerson(message)) return [];
    if (!isAskUserCard(message)) continue;
    const card = message.card!;
    // a tapped choice can arrive before its answered patch
    if (card.answered || card.dismissed || card.options.includes(text.trim())) return [];
    if (botId && message.from?.botId !== botId) return [];
    return [`[Your question card ("${replyExcerpt(card.subtitle, CLOSED_QUESTION_CHARS)}") closed unanswered when they typed their latest message. It is gone from their screen; if you still need it, ask again.]`];
  }
  return [];
}

/** A room member's note, until it first speaks after the message that closed its card. */
export function memberClosedAskNotes(messages: readonly Message[], botId: string): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.from?.botId === botId) return [];
    if (sentByPerson(message)) return closedAskNotes(messages, message.text ?? "", message.id, botId);
  }
  return [];
}
