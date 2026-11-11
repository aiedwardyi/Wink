// What still waits on the person, read from the transcript alone. The UI and
// the server's Quick answers gate share it so a closed card reads closed in both.

interface Row {
  role: string;
  kind: string;
  from?: unknown;
  author?: { kind: string };
  card?: { askUser?: true; requestId?: string; answered?: string; dismissed?: boolean };
}

/** A non-blocking ask_user card (never the first-run quiz, never a live ask). */
export function isAskUserCard(message: Row): boolean {
  return message.kind === "options" && Boolean(message.card?.askUser) && !message.card?.requestId;
}

/** Only what the person sent closes a question: not pane notes, peers, bots or team room people. */
export function isSentByPerson(message: Row): boolean {
  return message.role === "user" && message.kind === "text" && !message.from && (!message.author || message.author.kind === "host");
}

/** A live approval or engine-native question still waiting on the person. */
export function isOpenRequest(message: Row): boolean {
  return message.kind === "options" && Boolean(message.card?.requestId) && !message.card?.answered && !message.card?.dismissed;
}

/** The chat's open ask_user card, if any. */
export function scanQuestion<T extends Row>(messages: readonly T[]): T | null {
  // The open question is always after the last sent message, and only the
  // newest marked card can be open (a newer one supersedes it).
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (isSentByPerson(message)) return null;
    if (isAskUserCard(message)) return message.card!.dismissed || message.card!.answered ? null : message;
  }
  return null;
}
