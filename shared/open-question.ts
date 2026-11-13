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

function answerPrefix(card: Row): string {
  const question = (card.card?.subtitle ?? "").replace(/\s+/g, " ").trim();
  return `Re: “${question.length > QUOTE_CHARS ? `${question.slice(0, QUOTE_CHARS - 1).trimEnd()}…` : question}”\n`;
}

/** What an answer to `card` sends: a card some newer question follows names its question, so the bot knows which one it answers. */
export function answerText(messages: readonly Row[], card: Row, answer: string): string {
  const index = messages.indexOf(card);
  return index >= 0 && messages.slice(index + 1).some(isAskUserCard) ? `${answerPrefix(card)}${answer}` : answer;
}

const sameAsker = (left: Row, right: Row) => left.from?.botId === right.from?.botId;

/** Every ask_user card's state. A staysOpen card waits until answered, dismissed or asked again word for word;
 * an older card closes as the person types past it or a newer card arrives. */
export function askStates<T extends Row>(messages: readonly T[]): Map<T, AskState> {
  const states = new Map<T, AskState>();
  const asked: T[] = [];
  let open: T[] = [];
  const answer = (card: T, text: string, by: T) => {
    states.set(card, { state: "answered", reply: firstLine(text), by });
    open = open.filter((entry) => entry !== card);
  };
  for (const message of messages) {
    if (isAskUserCard(message)) {
      const subtitle = message.card!.subtitle?.trim();
      for (const older of open) {
        if (!older.card!.staysOpen) states.set(older, { state: "superseded" });
        else if (older.card!.subtitle?.trim() === subtitle && sameAsker(older, message)) states.set(older, { state: "askedAgain" });
      }
      open = open.filter((older) => states.get(older)?.state === "waiting");
      asked.push(message);
      const card = message.card!;
      if (card.answered) states.set(message, { state: "answered", reply: firstLine(card.answered) });
      else if (card.dismissed) states.set(message, { state: "dismissed" });
      else {
        states.set(message, { state: "waiting" });
        open.push(message);
      }
      continue;
    }
    if (!answersQuestion(message)) continue;
    const text = message.text ?? "";
    const quoted = text.startsWith("Re: “") ? asked.findLast((card) => text.startsWith(answerPrefix(card))) : undefined;
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
    if (top && (!top.card!.staysOpen || !top.card!.options?.length)) answer(top, text, message);
  }
  return states;
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
