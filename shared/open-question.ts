// What still waits on the person, read from the transcript alone. The UI and
// the server's Quick answers gate share it so a closed card reads closed in both.
import { isVoiceLine, type CallTag } from "./live-call.ts";

interface Row {
  id?: string;
  role: string;
  kind: string;
  text?: string;
  from?: { botId?: string };
  author?: { kind: string };
  call?: CallTag;
  answersCard?: string;
  card?: { subtitle?: string; options?: string[]; askUser?: true; staysOpen?: true; requestId?: string; answered?: string; dismissed?: boolean };
}

export type AskState =
  | { state: "waiting" }
  | { state: "answered"; reply: string; by?: Row }
  | { state: "dismissed" }
  | { state: "superseded" }
  | { state: "askedAgain" };

const QUOTE_CHARS = 120;
/** What a card the bot closed with ask_user close:true reads as answered with. */
export const ANSWERED_IN_CHAT = "Answered in chat";

/** A non-blocking ask_user card (never the first-run quiz, never a live ask). */
export function isAskUserCard(message: Row): boolean {
  return message.kind === "options" && Boolean(message.card?.askUser) && !message.card?.requestId;
}

/** Only what the person sent closes a question: not pane notes, peers, bots or team room people. */
export function isSentByPerson(message: Row): boolean {
  return message.role === "user" && message.kind === "text" && !message.from && (!message.author || message.author.kind === "host");
}

/** A call's transcript line is not an answer: only what went to the bot is. */
export function answersQuestion(message: Row): boolean {
  return isSentByPerson(message) && !isVoiceLine(message);
}

/** A live approval or engine-native question still waiting on the person. */
export function isOpenRequest(message: Row): boolean {
  return message.kind === "options" && Boolean(message.card?.requestId) && !message.card?.answered && !message.card?.dismissed;
}

export function answerPrefix(card: Row): string {
  const question = (card.card?.subtitle ?? "").replace(/\s+/g, " ").trim();
  return `Re: “${question.length > QUOTE_CHARS ? `${question.slice(0, QUOTE_CHARS - 1).trimEnd()}…` : question}”\n`;
}

/** What a tap on `card` sends: always naming its question, the same words a call's spoken answer sends, so the server can tell a second answer. */
export function answerText(card: Row, answer: string): string {
  return `${answerPrefix(card)}${answer}`;
}

export const quotesCard = (text: string) => text.startsWith("Re: “");

/** The ask_user card a "Re: “question”" line names, the newest that matches. */
export function quotedCard<T extends Row>(messages: readonly T[], text: string): T | undefined {
  return quotesCard(text) ? messages.findLast((message) => isAskUserCard(message) && text.startsWith(answerPrefix(message))) : undefined;
}

const sameAsker = (left: Row, right: Row) => left.from?.botId === right.from?.botId;

/** Every ask_user card's state. A staysOpen card waits until answered, dismissed or asked again word for word;
 * an older card closes as the person types past it or a newer card arrives. An answered card takes the person's
 * next line, the one that settled it, so it never answers an older card too. */
export function askStates<T extends Row>(messages: readonly T[]): Map<T, AskState> {
  const states = new Map<T, AskState>();
  const asked: T[] = [];
  let open: T[] = [];
  const answer = (card: T, text: string, by: T) => {
    if (states.get(card)?.state === "waiting") states.set(card, { state: "answered", reply: firstLine(text), by });
    open = open.filter((entry) => entry !== card);
  };
  for (const message of messages) {
    if (isAskUserCard(message)) {
      const subtitle = message.card!.subtitle?.trim();
      for (const older of open) {
        if (states.get(older)?.state !== "waiting") continue;
        if (!older.card!.staysOpen) states.set(older, { state: "superseded" });
        else if (older.card!.subtitle?.trim() === subtitle && sameAsker(older, message)) states.set(older, { state: "askedAgain" });
      }
      open = open.filter((older) => states.get(older)?.state === "waiting");
      asked.push(message);
      const card = message.card!;
      if (card.answered) {
        states.set(message, { state: "answered", reply: firstLine(card.answered) });
        open.push(message);
      } else if (card.dismissed) states.set(message, { state: "dismissed" });
      else {
        states.set(message, { state: "waiting" });
        open.push(message);
      }
      continue;
    }
    if (!answersQuestion(message)) continue;
    const text = message.text ?? "";
    const tapped = message.answersCard ? asked.find((card) => card.id === message.answersCard) : undefined;
    if (tapped) {
      if (open.includes(tapped)) answer(tapped, text.startsWith(answerPrefix(tapped)) ? text.slice(answerPrefix(tapped).length) : text, message);
      continue;
    }
    const quoted = quotedCard(asked, text);
    if (quoted) {
      if (open.includes(quoted)) answer(quoted, text.slice(answerPrefix(quoted).length), message);
      continue;
    }
    // a tapped choice can arrive before its answered patch
    const latest = asked.at(-1);
    if (latest?.card!.options?.includes(text.trim())) {
      if (open.includes(latest)) answer(latest, text, message);
      continue;
    }
    const top = open.at(-1);
    if (top && (states.get(top)?.state !== "waiting" || !top.card!.staysOpen || !top.card!.options?.length)) answer(top, text, message);
  }
  return states;
}

/** What the person's typed `text` answers `card` with, or null past its choices: that card waits for a tap, X or the bot's close. */
export function typedReply(card: Row, text: string): string | null {
  const { staysOpen, options } = card.card!;
  return !staysOpen || !options?.length || options.includes(text.trim()) ? firstLine(text) : null;
}

/** True when the person's line `text`, landing next, settles `card` by itself: the server then takes no second answer for it. */
export function lineSettles(messages: readonly Row[], card: Row, text: string): boolean {
  return askStates([...messages, { role: "user", kind: "text", text }]).get(card)?.state === "answered";
}

/** The card from before cards stayed open that the person's `text` types past, closing it unanswered; a room passes the member that asked. */
export function typedPastCard<T extends Row>(messages: readonly T[], text: string, askerId?: string): T | null {
  const line = { role: "user", kind: "text", text } as T;
  for (const [message, state] of askStates([...messages, line])) {
    // a tapped choice can arrive before its answered patch
    if (state.state !== "answered" || state.by !== line || message.card!.staysOpen || message.card!.options?.includes(text.trim())) continue;
    if (!askerId || message.from?.botId === askerId) return message;
  }
  return null;
}

/** The waiting cards ask_user close:true settles: `question` word for word, from the member that asked in a room, or with no asker in a 1:1 chat. */
export function cardsToClose<T extends Row>(messages: readonly T[], question: string, askerId?: string): T[] {
  return [...askStates(messages)].flatMap(([card, state]) =>
    state.state === "waiting" && card.card!.subtitle?.trim() === question && (askerId ? card.from?.botId === askerId : !card.from) ? [card] : []);
}

/** The chat's newest waiting ask_user card, if any. */
export function scanQuestion<T extends Row>(messages: readonly T[]): T | null {
  let newest: T | null = null;
  for (const [card, status] of askStates(messages)) if (status.state === "waiting") newest = card;
  return newest;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}
