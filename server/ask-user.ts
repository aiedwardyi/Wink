// The agents proxy's ask_user: a question pinned for the user that never
// pauses the bot. It lands as a bot options card marked `askUser` (so the
// client can tell it from the first-run quiz, which has no requestId either)
// and buzzes the same "has a question" alert as a provider's own ask. The
// answer arrives as a user message, so nothing here waits and the bot's
// activity is never set to waiting-on-you.
import { z } from "zod";

import { ANSWERED_IN_CHAT, askStates, scanQuestion } from "../shared/open-question.ts";
import { replyExcerpt } from "./replies.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import { addQuestionAsk, answerQuestionAsk, isOpenAsk, type TaskAsk } from "./task-asks.ts";

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
    close: z.boolean().optional().catch(undefined),
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
  activePath: Store["activePath"];
  patchMessage: Store["patchMessage"];
  cancelHeld(botId: string, threadId: string, question: string): boolean;
  /** The thread the alert opens, read when the bot asks: a routine run is over by release. */
  alertThread(bot: B, threadId: string): string;
  notifyQuestion(bot: B, target: string, question: string): void;
  /** Runs `post` now, or once the asking turn has replied. */
  whenSettled(botId: string, threadId: string, post: () => void, question: string): void;
}

export interface AskUserResult {
  status: number;
  body: { error: string } | { messageId: string } | { held: true } | { closed: boolean };
}

export function postAskUser<B extends Sender>(deps: AskUserDeps<B>, request: AskUserRequest): AskUserResult {
  const from = deps.bot(request.fromBotId);
  if (!from) return { status: 403, body: { error: "unknown sender" } };
  if (!request.fromThreadId) return { status: 400, body: { error: "no active thread" } };
  const owner = deps.conversation(from.id, request.fromThreadId);
  if (!owner) return { status: 403, body: { error: "source thread does not belong to sender" } };
  const question = request.question.trim().slice(0, ASK_USER_QUESTION_MAX);
  if (!question) return { status: 400, body: { error: "question required" } };
  if (request.close) {
    let closed = deps.cancelHeld(from.id, request.fromThreadId, question);
    for (const [message, state] of askStates(deps.activePath(request.fromThreadId))) {
      if (state.state !== "waiting" || message.card!.subtitle.trim() !== question) continue;
      if (owner.group ? message.from?.botId !== from.id : Boolean(message.from)) continue;
      closed = Boolean(deps.patchMessage(request.fromThreadId, message.id, { card: { ...message.card!, answered: ANSWERED_IN_CHAT } })) || closed;
    }
    return { status: 200, body: { closed } };
  }
  const message: Omit<Message, "id" | "at"> = {
    role: "bot",
    kind: "options",
    card: { title: ASK_USER_TITLE, subtitle: question, options: askUserChoices(request.choices), askUser: true, staysOpen: true },
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
  }, question);
  return posted ? { status: 201, body: { messageId: posted.id } } : { status: 202, body: { held: true } };
}

const isAskUserCard = (message: Message) => message.kind === "options" && Boolean(message.card?.askUser) && !message.card?.requestId;
const sentByPerson = (message: Message) => message.role === "user" && message.kind === "text" && !message.from;

/** The stored row of a question already answered, dismissed or closed: it takes no second answer, such as a tap from a screen that missed the close. */
export function settledAsk(messages: readonly Message[], messageId: string): Message | null {
  for (const [message, state] of askStates(messages)) if (message.id === messageId) return state.state === "waiting" ? null : message;
  return null;
}

/** The bot's notes on the person's message: an older ask_user card it closed unanswered, or every card still open when two or more wait. No `closerId`: a steer not yet in `messages`. */
export function closedAskNotes(messages: readonly Message[], text: string, closerId?: string, botId?: string): string[] {
  const end = closerId === undefined ? messages.length : messages.findIndex((message) => message.id === closerId);
  if (end < 0 || (closerId !== undefined && !sentByPerson(messages[end]!))) return [];
  const before = messages.slice(0, end);
  return [...closedNote(before, text, botId), ...openAsksNote(before, text, botId)];
}

function closedNote(messages: readonly Message[], text: string, botId?: string): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (sentByPerson(message)) return [];
    if (!isAskUserCard(message)) continue;
    const card = message.card!;
    // a tapped choice can arrive before its answered patch
    if (card.answered || card.dismissed || card.options.includes(text.trim())) return [];
    if ((botId && message.from?.botId !== botId) || card.staysOpen) return [];
    return [`[Your question card ("${replyExcerpt(card.subtitle, CLOSED_QUESTION_CHARS)}") closed unanswered when they typed their latest message. It is gone from their screen; if you still need it, ask again.]`];
  }
  return [];
}

// full questions, not excerpts: closing one needs its exact text
function openAsksNote(messages: readonly Message[], text: string, botId?: string): string[] {
  const typed: Message = { id: "", at: 0, role: "user", kind: "text", text };
  const states = [...askStates([...messages, typed])];
  // `by` is the row itself, so identity marks what the typed message answered
  if (states.some(([, state]) => state.state === "answered" && state.by === typed)) return [];
  const open = states.filter(([card, state]) => state.state === "waiting" && (!botId || card.from?.botId === botId)).map(([card]) => `"${card.card!.subtitle.trim()}"`);
  if (open.length < 2) return [];
  return [`[${open.length} of your question cards are still open: ${open.join("; ")}. If their latest message answers one in their own words, close that card with ask_user close:true and its exact question text.]`];
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

/** The newest waiting ask_user card when the bot asks `next`. */
export function skippedQuestion(before: readonly Message[], next: Message): Message | null {
  return isAskUserCard(next) ? scanQuestion(before) : null;
}

/** Files a question card a newer one followed unanswered on its thread's asks list, and closes it once answered. `update` saves what `change` returns; null saves nothing. */
export function watchSkippedQuestions(
  store: Pick<Store, "onChange" | "activePath" | "importingSync">,
  update: (threadId: string, change: (asks: TaskAsk[] | undefined) => TaskAsk[] | null) => void,
  now = Date.now,
): void {
  store.onChange((change) => {
    if (store.importingSync) return;
    if (change.type === "message" && !change.imported && isAskUserCard(change.message)) {
      const path = store.activePath(change.threadId);
      const card = skippedQuestion(path.at(-1)?.id === change.message.id ? path.slice(0, -1) : path, change.message)?.card;
      if (card) update(change.threadId, (asks) => addQuestionAsk(asks, card.subtitle, card.options, now()));
    } else if (change.type === "message" && !change.imported && sentByPerson(change.message)) {
      // a typed answer leaves no patch; only a thread with a filed question pays for the walk
      update(change.threadId, (asks) => {
        if (!asks?.some((ask) => ask.kind === "question" && isOpenAsk(ask))) return null;
        const path = store.activePath(change.threadId);
        for (const [card, state] of askStates(path.at(-1)?.id === change.message.id ? path : [...path, change.message])) {
          if (state.state === "answered" && state.by?.id === change.message.id) return answerQuestionAsk(asks, card.card!.subtitle, card.at, now());
        }
        return null;
      });
    } else if (change.type === "message.patch" && isAskUserCard(change.message) && change.message.card!.answered) {
      // a card-typed answer can land just after its message filed the card as skipped
      const { card, at } = change.message;
      update(change.threadId, (asks) => answerQuestionAsk(asks, card!.subtitle, at, now()));
    }
  });
}
