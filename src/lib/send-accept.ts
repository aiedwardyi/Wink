// Same-tick chrome after composer accepts a send. Thinking / busy / Sends-next
// must not wait for POST or the SSE busy patch: startTurn still runs
// prepareModelContext on the request path before the server flips busy.
import { showWorkingDots } from "./turn-tail";
import type { Message } from "@/state/store";

export { sendClock } from "../../shared/send-clock";

export type AcceptedSendKind = "thinking" | "sends-next";

export type AcceptedSend = {
  sendId: string;
  kind: AcceptedSendKind;
  text: string;
  at?: number;
  sendSeq?: number;
  /** Sent "after this turn": waits even on an engine that could steer it. */
  after?: boolean;
  replyToId?: string;
  /** The POST has not answered: an idle snapshot cannot say whether the server has this send yet. */
  posting?: true;
};

export type AcceptedSends = Record<string, AcceptedSend[]>;

export function withAcceptedMessages(
  messages: Message[],
  accepted: readonly AcceptedSend[] = [],
  pending: readonly { queueId: string; text: string; at?: number; sendId?: string; replyToId?: string; sendSeq?: number }[] = [],
): Message[] {
  if (!accepted.length && !pending.length) return messages;
  const seen = new Set(messages.flatMap((message) => [message.id, message.sendId, message.queueId]));
  const waiting = [
    ...pending.filter((entry) => !entry.sendId || !seen.has(entry.sendId)).map((entry) => ({ sendId: entry.queueId, text: entry.text, at: entry.at, replyToId: entry.replyToId, sendSeq: entry.sendSeq })),
    ...accepted.filter((entry) => !pending.some((held) => held.sendId === entry.sendId)),
  ];
  const added: Message[] = [];
  for (const entry of waiting) {
    if (seen.has(entry.sendId)) continue;
    seen.add(entry.sendId);
    added.push({
      id: entry.sendId,
      sendId: entry.sendId,
      role: "user",
      kind: "text",
      text: entry.text,
      at: entry.at ?? 0,
      replyToId: entry.replyToId,
      sendSeq: entry.sendSeq,
      placeholder: true,
    });
  }
  return added.length ? [...messages, ...added] : messages;
}

/** A person's line keeps the place it was sent from: rows that landed after it draw below it, live and on reload. */
export function inSendOrder(messages: Message[], queued?: ReadonlySet<string>): Message[] {
  let ordered: Message[] | undefined;
  for (let i = 1; i < messages.length; i++) {
    const message = messages[i]!;
    // a held send draws below the turn; moving it here would only push it out of the mounted window
    const sent = queued?.has(message.id) ? undefined : sentAt(message);
    if (sent === undefined) continue;
    const list = ordered ?? messages;
    let to = i;
    while (to > 0 && landedAfter(list[to - 1]!, sent, message.sendSeq)) to--;
    if (to === i) continue;
    ordered ??= messages.slice();
    ordered.splice(i, 1);
    ordered.splice(to, 0, message);
  }
  return ordered ?? messages;
}

// sendClock stamps a send past every row it saw, so a row in its millisecond landed after it; two sends stamped alike keep the order sent
function landedAfter(row: Message, sent: number, sendSeq = 0): boolean {
  const at = sentAt(row);
  return at === undefined ? row.at >= sent : at > sent || (at === sent && (row.sendSeq ?? 0) > sendSeq);
}

function sentAt(message: Message): number | undefined {
  if (message.role !== "user" || !message.sendId || message.waited) return undefined;
  return (message.placeholder ? message.at : message.actedAt) || undefined;
}

/** One past every send this window knows: the server can stamp two lines alike, and this keeps them in the order sent. */
export function nextSendSeq(...sends: readonly (readonly { sendSeq?: number }[] | undefined)[]): number {
  let seq = 0;
  for (const list of sends) for (const send of list ?? []) seq = Math.max(seq, send.sendSeq ?? 0);
  return seq + 1;
}

/** Sends that run after the reply render below the turn; a steering engine reads an accepted send mid-turn. */
export function queuedSendIds(
  accepted: readonly AcceptedSend[] = [],
  pending: readonly { queueId: string; waited?: boolean; reason?: "sync" }[] = [],
  canSteer = false,
): Set<string> {
  return new Set([
    // a plain send the engine could not take that instant stays where it was sent
    ...pending.filter((entry) => !canSteer || entry.waited || entry.reason === "sync").map((entry) => entry.queueId),
    ...accepted.filter((entry) => entry.kind === "sends-next" && (!canSteer || entry.after)).map((entry) => entry.sendId),
  ]);
}

export function splitQueuedSends(
  messages: Message[],
  accepted: readonly AcceptedSend[] = [],
  pending: readonly { queueId: string; waited?: boolean; reason?: "sync" }[] = [],
  canSteer = false,
) {
  const ids = queuedSendIds(accepted, pending, canSteer);
  const queued = messages.filter((message) => message.placeholder && ids.has(message.id));
  if (!queued.length) return { listed: messages, queued };
  return { listed: messages.filter((message) => !queued.includes(message)), queued };
}

export function acceptedSendPaint(input: { alreadyBusy: boolean }): { kind: AcceptedSendKind } {
  return { kind: input.alreadyBusy ? "sends-next" : "thinking" };
}

export function hasAcceptedThinking(accepted?: readonly AcceptedSend[]): boolean {
  return Boolean(accepted?.some((entry) => entry.kind === "thinking"));
}

export function composerIsBusy(serverBusy: boolean, accepted?: readonly AcceptedSend[]): boolean {
  return serverBusy || hasAcceptedThinking(accepted);
}

export function turnPresenceWaiting(input: {
  busy?: boolean;
  turnActive?: boolean;
  activity?: string;
  lastMessage?: Message;
  speakerBotId?: string;
  accepted?: readonly AcceptedSend[];
}): boolean {
  if (input.activity === "waiting-on-you") return false;
  if (hasAcceptedThinking(input.accepted)) return true;
  if (input.busy && input.turnActive) return true;
  return showWorkingDots(Boolean(input.busy), undefined, input.lastMessage, input.speakerBotId);
}

export function rememberAcceptedSend(
  accepted: AcceptedSends,
  threadId: string,
  send: AcceptedSend,
): AcceptedSends {
  if (!threadId || !send.sendId) return accepted;
  const prev = accepted[threadId] ?? [];
  if (prev.some((entry) => entry.sendId === send.sendId)) return accepted;
  return { ...accepted, [threadId]: [...prev, send] };
}

export function forgetAcceptedSend(
  accepted: AcceptedSends,
  threadId: string,
  sendId: string,
): AcceptedSends {
  const prev = accepted[threadId] ?? [];
  const next = prev.filter((entry) => entry.sendId !== sendId);
  if (next.length === prev.length) return accepted;
  const copy = { ...accepted };
  if (next.length) copy[threadId] = next;
  else delete copy[threadId];
  return copy;
}

/** POST confirms a queue chip. Thinking stays until SSE busy or reject/Stop,
 * unless the server queued it (the chip then paints this send already) or
 * started no turn for it. */
export function settleAcceptedSend(
  accepted: AcceptedSends,
  threadId: string,
  sendId: string,
  queued = false,
): AcceptedSends {
  const entry = (accepted[threadId] ?? []).find((item) => item.sendId === sendId);
  if (entry?.kind !== "sends-next" && !queued) {
    if (!entry?.posting) return accepted;
    return { ...accepted, [threadId]: accepted[threadId].map((item) => item === entry ? { ...item, posting: undefined } : item) };
  }
  return forgetAcceptedSend(accepted, threadId, sendId);
}

export function clearAcceptedThinking(accepted: AcceptedSends, threadId: string, keepPosting = false): AcceptedSends {
  const prev = accepted[threadId] ?? [];
  const next = prev.filter((entry) => entry.kind !== "thinking" || (keepPosting && entry.posting));
  if (next.length === prev.length) return accepted;
  const copy = { ...accepted };
  if (next.length) copy[threadId] = next;
  else delete copy[threadId];
  return copy;
}

/** Snapshot is authoritative: an idle thread must not keep Thinking locked. */
export function dropIdleAcceptedThinking<T extends { threadId: string; busy?: boolean; busyBotId?: string | null }>(
  accepted: AcceptedSends,
  subjects: readonly T[],
): AcceptedSends {
  return subjects.reduce(
    (next, subject) =>
      subject.busy || subject.busyBotId ? next : clearAcceptedThinking(next, subject.threadId, true),
    accepted,
  );
}

export function applyOptimisticBusy<T extends { threadId: string; busy?: boolean; activity?: string }>(
  bots: T[],
  accepted: AcceptedSends,
): T[] {
  return bots.map((bot) => {
    if (bot.busy || !hasAcceptedThinking(accepted[bot.threadId])) return bot;
    return { ...bot, busy: true, activity: "working" };
  });
}

/** POST confirmed the user line but the turn never started. */
export type SendPostReceipt = {
  ok?: boolean;
  dispatchFailed?: boolean;
  cancelled?: boolean;
  queued?: boolean;
  queueId?: string;
  error?: string;
  /** A group line nobody was asked to answer: no turn will start. */
  idle?: boolean;
};

export function receiptRejectsAcceptedSend(
  body: SendPostReceipt | null | undefined,
): boolean {
  return Boolean(body?.dispatchFailed || body?.cancelled);
}

/** Keep the chip unless the server confirmed the send will not run. */
export function shouldDropQueueChip(
  result: { cancelled?: boolean; running?: boolean } | null | undefined,
): boolean {
  return result?.cancelled === true && result.running !== true;
}
