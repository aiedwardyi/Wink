// Same-tick chrome after composer accepts a send. Thinking / busy / Sends-next
// must not wait for POST or the SSE busy patch: startTurn still runs
// prepareModelContext on the request path before the server flips busy.
import { showWorkingDots } from "./turn-tail";
import type { Message } from "@/state/store";

export { noteServerTime, sendClock } from "../../shared/send-clock";

export type AcceptedSendKind = "thinking" | "sends-next";

export type AcceptedSend = {
  sendId: string;
  kind: AcceptedSendKind;
  text: string;
  at?: number;
  sendSeq?: number;
  sentAfterId?: string | null;
  /** Sent "after this turn": waits even on an engine that could steer it. */
  after?: boolean;
  /** Held until the room settled: drawn where it lands, as its stored row is. */
  waited?: boolean;
  replyToId?: string;
  /** The POST has not answered: an idle snapshot cannot say whether the server has this send yet. */
  posting?: true;
};

export type AcceptedSends = Record<string, AcceptedSend[]>;

export function withAcceptedMessages(
  messages: Message[],
  accepted: readonly AcceptedSend[] = [],
  pending: readonly { queueId: string; text: string; at?: number; sendId?: string; replyToId?: string; sendSeq?: number; sentAfterId?: string | null }[] = [],
): Message[] {
  if (!accepted.length && !pending.length) return messages;
  const seen = new Set(messages.flatMap((message) => [message.id, message.sendId, message.queueId]));
  const waiting: Omit<AcceptedSend, "kind">[] = [
    ...pending.filter((entry) => !entry.sendId || !seen.has(entry.sendId)).map((entry) => ({ sendId: entry.queueId, text: entry.text, at: entry.at, replyToId: entry.replyToId, sendSeq: entry.sendSeq, sentAfterId: entry.sentAfterId })),
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
      sentAfterId: entry.sentAfterId,
      waited: entry.waited,
      placeholder: true,
    });
  }
  return added.length ? [...messages, ...added] : messages;
}

/** A person's line keeps the place it was sent from: rows that landed after it draw below it, live and on reload. */
export function inSendOrder(messages: Message[], queued?: ReadonlySet<string>): Message[] {
  if (!messages.some((row) => row.sentAfterId !== undefined)) return bySentTime(messages, queued);

  const positions = new Map<string, number | undefined>();
  for (const row of messages) {
    if (typeof row.sentAfterId === "string") positions.set(row.sentAfterId, undefined);
  }
  const anchors = new Map<Message, number>();
  for (let index = 0; index < messages.length; index++) {
    const row = messages[index]!;
    const anchor = row.sentAfterId === null ? -1 : row.sentAfterId === undefined ? undefined : positions.get(row.sentAfterId);
    if (anchor !== undefined && !queued?.has(row.id) && isOrderedSend(row)) anchors.set(row, anchor);
    if (!row.placeholder && positions.has(row.id)) positions.set(row.id, index);
  }
  if (!anchors.size) return bySentTime(messages, queued);

  const unanchored = messages.filter((row) => !anchors.has(row));
  const ordered = bySentTime(unanchored, queued);
  const order = ordered === unanchored ? undefined : new Map(ordered.map((row, index) => [row, index]));
  // The anchor covers every row already seen, even if a send in that prefix is drawn earlier.
  const prefix = new Int32Array(messages.length);
  let original = -1;
  let last = -1;
  for (let index = 0; index < messages.length; index++) {
    const row = messages[index]!;
    if (!anchors.has(row)) {
      original++;
      last = Math.max(last, order?.get(row) ?? original);
    }
    prefix[index] = last;
  }
  const buckets = new Map<number, Message[]>();
  for (const [row, anchor] of anchors) {
    const after = anchor === -1 ? -1 : prefix[anchor]!;
    const bucket = buckets.get(after) ?? [];
    bucket.push(row);
    buckets.set(after, bucket);
  }
  const result: Message[] = [];
  for (let index = -1; index < ordered.length; index++) {
    if (index >= 0) result.push(ordered[index]!);
    const sends = buckets.get(index);
    if (!sends) continue;
    sends.sort((a, b) => anchors.get(a)! - anchors.get(b)! || a.sendSeq! - b.sendSeq!);
    for (const row of sends) result.push(row);
  }
  return result;
}

function bySentTime(messages: Message[], queued?: ReadonlySet<string>): Message[] {
  let ordered: Message[] | undefined;
  // Bound the total scans and shifts while keeping small moves on the cheap path.
  let remaining = 2 * messages.length;
  for (let i = 1; i < messages.length; i++) {
    const message = messages[i]!;
    // a held send draws below the turn; moving it here would only push it out of the mounted window
    const sent = queued?.has(message.id) ? undefined : sentAt(message);
    if (sent === undefined) continue;
    const list = ordered ?? messages;
    let to = i;
    while (to > 0 && landedAfter(list[to - 1]!, sent, message.sendSeq)) {
      to--;
      if (--remaining < 0) return batchBySentTime(messages, queued);
    }
    if (to === i) continue;
    remaining -= (messages.length - i) + (messages.length - to);
    if (remaining < 0) return batchBySentTime(messages, queued);
    ordered ??= messages.slice();
    ordered.splice(i, 1);
    ordered.splice(to, 0, message);
  }
  return ordered ?? messages;
}

function batchBySentTime(messages: Message[], queued?: ReadonlySet<string>): Message[] {
  const fixed: Message[] = [];
  const times = new Float64Array(messages.length);
  const sequences = new Float64Array(messages.length);
  const positions = new Int32Array(messages.length);
  const gaps = new Map<number, { row: Message; at: number; seq: number }[]>();
  let count = 0;
  for (const row of messages) {
    const sent = sentAt(row);
    const seq = sent === undefined ? Infinity : row.sendSeq ?? 0;
    if (sent === undefined || queued?.has(row.id)) {
      const at = sent ?? row.at;
      // A later fixed row with a lower key always wins the same insertion searches.
      while (count > 0 && (times[count - 1]! > at || (times[count - 1] === at && sequences[count - 1]! >= seq))) count--;
      times[count] = at;
      sequences[count] = seq;
      positions[count++] = fixed.length;
      fixed.push(row);
      continue;
    }
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (times[mid]! > sent || (times[mid] === sent && sequences[mid]! > seq)) high = mid;
      else low = mid + 1;
    }
    const gap = low === 0 ? -1 : positions[low - 1]!;
    const sends = gaps.get(gap) ?? [];
    sends.push({ row, at: sent, seq });
    gaps.set(gap, sends);
  }
  const result: Message[] = [];
  let index = 0;
  for (const [gap, sends] of [...gaps].sort(([a], [b]) => a - b)) {
    while (index <= gap) result.push(fixed[index++]!);
    sends.sort((a, b) => a.at - b.at || a.seq - b.seq);
    for (const send of sends) result.push(send.row);
  }
  while (index < fixed.length) result.push(fixed[index++]!);
  return result;
}

// sendClock stamps a send past every row it saw, so a row in its millisecond landed after it; two sends stamped alike keep the order sent
function landedAfter(row: Message, sent: number, sendSeq = 0): boolean {
  const at = sentAt(row);
  return at === undefined ? row.at >= sent : at > sent || (at === sent && (row.sendSeq ?? 0) > sendSeq);
}

function sentAt(message: Message): number | undefined {
  // a line stored before lines kept a send order stays where it was stored
  if (!isOrderedSend(message)) return undefined;
  return (message.placeholder ? message.at : message.actedAt) || undefined;
}

function isOrderedSend(message: Message): boolean {
  return message.role === "user" && Boolean(message.sendId) && !message.waited && message.sendSeq !== undefined;
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
