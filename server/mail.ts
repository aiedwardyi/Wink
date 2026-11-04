import { peerMessagePrompt } from "./chief-of-staff.ts";
import { postRefusalNotice, type NoticeStore } from "./comms-notice.ts";
import { reserve, type ReserveResult } from "./comms-root.ts";
import type { Message, Store } from "./store.ts";
import type { MailRead } from "./mail-types.ts";
import { paneNoteWaiting, type WakeAdmission } from "./pane-wake.ts";
import { findDelegationReceipt, receiptSnapshot } from "./delegation-ledger.ts";
import { delegationGist } from "./delegation-context.ts";

export function recentDelegations(store: Pick<Store, "botByThread" | "messagesFor">, botId: string, threadId: string) {
  const rows = new Map<string, Message[]>();
  const tasks = receiptSnapshot().filter((row) => row.sourceThreadId === threadId && (row.source?.botId ?? store.botByThread(row.sourceThreadId)?.id) === botId);
  const created = (task: typeof tasks[number]) => {
    if (!rows.has(task.sourceThreadId)) rows.set(task.sourceThreadId, store.messagesFor(task.sourceThreadId));
    const messages = rows.get(task.sourceThreadId)!;
    const index = messages.findIndex((row) => row.comm?.taskId === task.id);
    return { at: messages[index]?.at ?? task.finishedAt, index };
  };
  return tasks.sort((a, b) => created(b).at - created(a).at || (a.sourceThreadId === b.sourceThreadId ? created(b).index - created(a).index : 0)).slice(0, 5).map((row) => ({
    id: row.id.slice(0, 8), peer: row.toBotName,
    status: row.state === "dispatching" ? "running" : row.status === "done" || row.status === "queued" || row.status === "running" ? row.status : "failed",
    gist: delegationGist(row.result),
  }));
}

type MailStore = Pick<Store, "bot" | "botByThread" | "taskByThread" | "groupByThread" | "activePath" | "messagesFor" | "patchMessage">;
export interface MailPart { id: string; text: string; upto: number; part?: number }
const replyWakeKeys = new Set<string>();

export function registerReplyWake(row: Message): void {
  if (row.comm?.mailKey) replyWakeKeys.add(row.comm.mailKey);
}

export function unreadMail(store: MailStore, threadId: string): Message[] {
  const bot = store.botByThread(threadId);
  const task = bot && store.taskByThread(bot.id, threadId);
  if (task && !task.mailUnread?.length) return [];
  const rows = store.activePath(threadId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ids = task?.mailUnread ?? (store.groupByThread(threadId) ? rows.filter((row) => row.comm?.mailKey && row.comm.peer === "reply").map((row) => row.id) : []);
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row?.comm?.mailKey || row.comm.peer !== "reply" || !row.text || row.comm.read?.state === "handed") return [];
    if (row.comm.read?.state === "read" && (row.comm.read.upto ?? row.text.length) >= row.text.length) return [];
    return [row];
  });
}

const frame = (store: MailStore, row: Message, text: string) => peerMessagePrompt(
  store.bot(row.comm!.withBotId) ?? { name: row.comm!.withName }, text, "reply",
);
const tokens = (text: string) => Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3)) + 6;

export function mailForTurn(store: MailStore, threadId: string, paneIds: readonly string[] = [], contextWindow = 128_000, usedTokens = 0): MailPart[] {
  const budget = Math.floor(contextWindow * 0.5);
  let left = Math.max(0, budget - Math.floor(budget * 0.35) - usedTokens);
  const parts: MailPart[] = [];
  for (const row of unreadMail(store, threadId)) {
    if (paneIds.includes(row.id)) continue;
    const offset = row.comm?.read?.upto ?? 0;
    const part = (row.comm?.read?.part ?? 0) + 1;
    const remainder = row.text!.slice(offset);
    const prefix = offset ? `[continued, part ${part}]\n` : "";
    const text = frame(store, row, `${prefix}${remainder}`);
    if (tokens(text) <= left) {
      parts.push({ id: row.id, text, upto: row.text!.length, part });
      left -= tokens(text);
      continue;
    }
    const tail = `\n[Reply continues next turn; check_delegation ${row.comm!.taskId}]`;
    let low = 0;
    let cap = remainder.length;
    while (low < cap) {
      const middle = Math.ceil((low + cap) / 2);
      if (tokens(frame(store, row, `${prefix}${remainder.slice(0, middle)}${tail}`)) <= left) low = middle;
      else cap = middle - 1;
    }
    if (cap <= 0) break;
    let cut = remainder.lastIndexOf("\n", cap - 1) + 1;
    if (!cut) cut = remainder.lastIndexOf(" ", cap - 1) + 1;
    if (!cut) cut = cap;
    parts.push({ id: row.id, text: frame(store, row, `${prefix}${remainder.slice(0, cut)}${tail}`), upto: offset + cut, part });
    break;
  }
  return parts;
}

export function markMailRead(store: MailStore, threadId: string, parts: readonly Pick<MailPart, "id" | "upto" | "part">[], turnId: string, via: "fold" | "steer" = "fold"): void {
  for (const part of parts) {
    const row = store.messagesFor(threadId).find((row) => row.id === part.id);
    if (!row?.comm?.mailKey || row.comm.peer !== "reply") continue;
    replyWakeKeys.delete(row.comm.mailKey);
    store.patchMessage(threadId, row.id, { comm: { ...row.comm, read: { state: "read", via, turnId, upto: part.upto, part: part.part, at: Date.now() } } });
  }
}

export function markPaneMailRead(store: MailStore, threadId: string, ids: readonly string[], turnId: string, via: "fold" | "steer"): void {
  markMailRead(store, threadId, store.messagesFor(threadId).filter((row) => ids.includes(row.id)).map((row) => ({ id: row.id, upto: row.text?.length ?? 0 })), turnId, via);
}

export function markSteeredMail(store: MailStore, threadId: string, noteId: string | undefined, turnId: string): void {
  if (!noteId) return;
  const rows = store.activePath(threadId);
  const end = rows.findIndex((row) => row.id === noteId);
  const ids = rows.slice(0, end + 1).filter((row) => row.comm?.wake && !row.comm.read).map((row) => row.id);
  markPaneMailRead(store, threadId, ids, turnId, "steer");
}

export function handMail(store: MailStore, threadId: string, taskId: string, turnId: string, requestId: string, handedUpto?: number): void {
  for (const row of unreadMail(store, threadId)) {
    if (row.comm!.taskId !== taskId) continue;
    store.patchMessage(threadId, row.id, { comm: { ...row.comm!, read: { state: "handed", via: "tool", turnId, requestId, upto: row.comm!.read?.upto, part: row.comm!.read?.part, handedUpto, at: Date.now() } } });
  }
}

export function toolMailResult(store: MailStore, threadId: string, taskId: string, result: string | undefined, turn?: { turnId: string; requestId: string }): string | undefined {
  const row = store.messagesFor(threadId).find((row) => row.comm?.taskId === taskId && row.comm.peer === "reply");
  if (!row) return result;
  const full = row.text ?? result ?? "";
  const read = row.comm?.read;
  if (read?.state === "handed" && (!turn || read.turnId !== turn.turnId)
    || read?.state === "read" && (read.upto ?? full.length) >= full.length) return "already in your context";
  const offset = read?.state === "handed" ? read.handedUpto ?? full.length : read?.upto ?? 0;
  if (offset >= full.length) return "already in your context";
  const text = full.slice(offset, offset + 16_000);
  if (turn) {
    if (read?.state === "handed") store.patchMessage(threadId, row.id, { comm: { ...row.comm!, read: { ...read, requestId: turn.requestId, handedUpto: offset + text.length, at: Date.now() } } });
    else handMail(store, threadId, taskId, turn.turnId, turn.requestId, offset + text.length);
  }
  return offset + text.length < full.length ? `${text}\n\n[Reply continues; check_delegation ${taskId}]` : text;
}

export function settleMail(store: MailStore, threadId: string, turnId: string, ok: boolean, stopReason?: string): boolean {
  const bot = store.botByThread(threadId);
  const task = bot && store.taskByThread(bot.id, threadId);
  if (task && !task.mailUnread?.length) return false;
  let reverted = false;
  for (const row of store.messagesFor(threadId)) {
    const read = row.comm?.read;
    if (read?.state !== "handed" || read.turnId !== turnId) continue;
    const clean = ok && stopReason !== "cancelled" && stopReason !== "interrupted";
    if (clean && row.comm?.mailKey) replyWakeKeys.delete(row.comm.mailKey);
    const next: MailRead | undefined = clean ? { ...read, state: "read", upto: read.handedUpto ?? row.text?.length, at: Date.now() }
      : read.upto ? { ...read, state: "read" } : undefined;
    store.patchMessage(threadId, row.id, { comm: { ...row.comm!, read: next } });
    reverted ||= !clean && Boolean(row.comm?.wake || row.comm?.mailKey && replyWakeKeys.has(row.comm.mailKey));
  }
  return reverted;
}

export function mailReplayText(row: Message, offset = 0, upto?: number): string | null | undefined {
  if (row.role === "user" && row.from && row.comm?.withBotId) return peerMessagePrompt(row.from, row.text ?? "", "ask");
  if (!row.comm?.mailKey || row.comm.peer !== "reply") return undefined;
  if (row.comm.read?.state !== "read" && upto === undefined) return null;
  const text = row.text?.slice(offset, upto ?? row.comm.read?.upto) ?? "";
  return text ? peerMessagePrompt({ name: row.comm.withName }, text, "reply") : null;
}

export function hasUnreadReplyWake(store: MailStore, threadId: string): boolean {
  return unreadMail(store, threadId).some((row) => row.comm!.wake || replyWakeKeys.has(row.comm!.mailKey!));
}

type Refusal = { row: Message; rootId?: string; reason: Exclude<ReserveResult, { ok: true }>["reason"] };

/** Coalesced replies reserve one wake, from the newest reply whose root has credit. */
function pickReplyWake(store: MailStore, threadId: string): WakeAdmission | Refusal[] {
  const replies = unreadMail(store, threadId).filter((row) => row.comm!.wake || replyWakeKeys.has(row.comm!.mailKey!));
  if (!replies.length) return { rootId: null, reservation: null };
  const refused: Refusal[] = [];
  const tried = new Set<string>();
  for (const row of replies.toReversed()) {
    const rootId = row.comm!.taskId ? findDelegationReceipt(row.comm!.taskId)?.root : undefined;
    if (rootId && tried.has(rootId)) continue;
    if (rootId) tried.add(rootId);
    const credit = reserve(rootId, "wake");
    if (credit.ok) return { rootId: credit.reservation.rootId, reservation: credit.reservation };
    refused.push({ row, rootId, reason: credit.reason });
  }
  return refused;
}

export function claimReplyWake(store: MailStore, threadId: string): WakeAdmission | null {
  const picked = pickReplyWake(store, threadId);
  return Array.isArray(picked) ? null : picked;
}

/** A spent reply root must not drop a pane note's own wake, and must not lend it credit. */
export function admitPaneWake(store: MailStore & NoticeStore & Pick<Store, "dmGroup">, botId: string, threadId: string, replyUnwoken?: (botId: string, detail: string) => void): WakeAdmission | null {
  const picked = pickReplyWake(store, threadId);
  if (!Array.isArray(picked)) return picked;
  if (paneNoteWaiting(store, botId, threadId)) return { rootId: null, reservation: null };
  if (unreadMail(store, threadId).some((row) => row.comm!.wake)) replyUnwoken?.(botId, "wake budget spent");
  for (const { row, rootId, reason } of picked) {
    postRefusalNotice(store, reason, rootId, row.comm!.taskId ?? row.id, threadId, store.dmGroup(botId, row.comm!.withBotId)?.threadId);
  }
  return null;
}
