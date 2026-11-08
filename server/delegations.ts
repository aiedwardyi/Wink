// Durable peer handoffs and their turn-scoped queues.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { peerMessagePrompt } from "./chief-of-staff.ts";
import { releaseOpenAsk } from "./comms-budget.ts";
import { release, type Reservation } from "./comms-root.ts";
import { findDelegationReceipt, loadDelegationReceipts, recordDelegationReceipt, receiptSnapshot, resetDelegationReceipts } from "./delegation-ledger.ts";
import { terminalMailState, type MailDestination, type MailState } from "./mail-types.ts";
import { recoverHandedMail } from "./mail-index.ts";
import { publishPeerReply, replyDestinations, wakeForPeerReply } from "./peer-reply-publication.ts";
import { turnRegistry } from "./turn-registry.ts";
import {
  commLink,
  getOrCreateChannel,
  mirrorActivity,
  mirrorExchange,
  mirrorReply,
  patchDelegationChip,
  settleDelegationChip,
  trackDelegationChip,
  type CommsBus,
} from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import { peerReplyText } from "./peer-user-reply.ts";
import { redactSecretsInText } from "./redact.ts";
import { hasQueuedSends } from "./steer-queue.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";

export interface DelegationItem {
  toBotId: string;
  message: string;
  reason?: string;
  /** The source depth; the peer runs at depth + 1 and cannot delegate again. */
  depth: number;
  root?: string;
}

interface PendingDelegationItem extends DelegationItem {
  kind?: "ask" | "delegation";
  turnId?: string;
  seq?: number;
  /** The bot that queued this item. Required for shared room threads. */
  fromBotId?: string;
  /** Stable acknowledgement key for crash-safe removal from the queue —
   * and the task id the delegating bot uses with check/wait_delegation. */
  id: string;
  /** Busy settles observed; waiting has no retry cap. */
  attempts: number;
  /** The user allowed this handoff. */
  approved?: boolean;
}

export type DelegationOutcome = "done" | "failed" | "denied" | "busy_gave_up" | "dropped" | "error" | "queued" | "running";

export interface DelegationReceipt {
  id: string;
  sourceThreadId: string;
  toBotId: string;
  toBotName: string;
  status: DelegationOutcome;
  /** the peer's reply on success; the failure name otherwise (bounded) */
  result?: string;
  finishedAt: number;
  kind?: "ask" | "delegation";
  deliver?: "queued" | "now";
  state?: MailState;
  source?: { botId: string; threadId: string; turnId: string };
  target?: { botId: string; threadId?: string; turnId?: string };
  seq?: number;
  publish?: MailDestination[];
  root?: string;
  fallback?: string;
}

export { findDelegationReceipt, recordDelegationReceipt } from "./delegation-ledger.ts";

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many";

interface PendingDelegationSnapshot {
  sourceThreadId: string;
  sourceBotId?: string;
  toBotId: string;
  reason?: string;
}

/** What queueDelegation hands back: the verdict, and on success the task id
 * the delegating bot can later read back with check/wait_delegation. */
export interface QueuedDelegation {
  result: QueueResult;
  id?: string;
}

const pendingDelegations = new Map<string, PendingDelegationItem[]>();
const dispatchingTargets = new Set<string>();
const approvingItems = new Set<string>();
let readySeq = 0;
const DELEGATIONS_FILE = join(DATA_DIR, "delegations.json");
const persistedFromBotId = z.string().min(1).optional().catch(undefined);
/** Dispatched handoffs by id, so a taken-over turn can queue the same one again. */
// In memory only: a handle never reaches delegations.json. Dispatch hands it to the turn start.
const reservations = new WeakMap<PendingDelegationItem, Reservation>();

function takeReservation(item: PendingDelegationItem): Reservation | undefined {
  const reservation = reservations.get(item);
  reservations.delete(item);
  return reservation;
}

function dropReservation(item: PendingDelegationItem): void {
  const reservation = takeReservation(item);
  if (reservation) release(reservation);
}

export const DELEGATION_PREFIX_MIN = 8;

export type DelegationIdMatch = { id: string } | { error: "too_short" | "ambiguous" };

/** Full ids pass through; a prefix only matches the caller's own thread, so it never reaches another bot's task. */
export function resolveDelegationId(input: string, sourceThreadId: string, runningIds: Iterable<string> = []): DelegationIdMatch {
  const own = new Set<string>([
    ...receiptSnapshot().filter((receipt) => receipt.sourceThreadId === sourceThreadId).map((receipt) => receipt.id),
    ...(pendingDelegations.get(sourceThreadId) ?? []).map((item) => item.id),
    ...runningIds,
  ]);
  if (own.has(input)) return { id: input };
  if (input.length < DELEGATION_PREFIX_MIN) return { error: "too_short" };
  const matches = [...own].filter((id) => id.startsWith(input));
  if (matches.length > 1) return { error: "ambiguous" };
  return { id: matches[0] ?? input };
}

/** A still-queued task's routing info, or null once it dispatched/settled. */
export function pendingDelegationInfo(id: string): { sourceThreadId: string; toBotId: string; attempts: number } | null {
  for (const [sourceThreadId, items] of pendingDelegations) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) return { sourceThreadId, toBotId: item.toBotId, attempts: item.attempts };
  }
  return null;
}

/** Queued by the asking bot's running turn: it sends only when that turn ends,
 * so a wait inside the same turn could never see it run. */
function queuedThisTurn(id: string, fromBotId: string): boolean {
  for (const items of pendingDelegations.values()) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) return findDelegationReceipt(id)?.state === "held" && item.fromBotId === fromBotId;
  }
  return false;
}

export interface DelegationPollResult {
  code: 200 | 403 | 404;
  body: { error: string } | { status: string; toBotName: string; result?: string; sameTurn?: true };
}

/** check/wait_delegation's read: a bounded long-poll, so the delegating bot parks
 * one cheap request instead of burning a model inference per status check. */
export async function pollDelegation(
  taskId: string,
  fromBotId: string,
  fromThreadId: string,
  waitMs: number,
  running: (taskId: string) => DelegatedTurn | undefined,
  botName: (botId: string) => string,
): Promise<DelegationPollResult> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const receipt = findDelegationReceipt(taskId);
    if (receipt && (!receipt.state || terminalMailState(receipt.state))) {
      if (receipt.sourceThreadId !== fromThreadId) return { code: 403, body: { error: "that task belongs to a different conversation" } };
      return { code: 200, body: { status: receipt.status, toBotName: receipt.toBotName, result: receipt.result ?? "" } };
    }
    const stillQueued = pendingDelegationInfo(taskId);
    const watched = running(taskId);
    const owner = stillQueued?.sourceThreadId ?? watched?.sourceThreadId ?? receipt?.sourceThreadId;
    if (!owner) return { code: 404, body: { error: "unknown task id - delegation receipts are kept for about 48 hours" } };
    if (owner !== fromThreadId) return { code: 403, body: { error: "that task belongs to a different conversation" } };
    const toBotName = botName(stillQueued?.toBotId ?? watched?.toBotId ?? "");
    if (stillQueued && queuedThisTurn(taskId, fromBotId)) return { code: 200, body: { status: "queued", toBotName, sameTurn: true } };
    if (Date.now() >= deadline) return { code: 200, body: { status: watched || receipt?.state === "running" || receipt?.state === "dispatching" ? "running" : "queued", toBotName } };
    await new Promise((wake) => setTimeout(wake, 500));
  }
}

export function drainWaitingOn(bus: CommsBus, approvalBus: ApprovalBus, runTarget: Parameters<typeof drainDelegations>[3]): void {
  pumpReady(bus, approvalBus, runTarget);
}

function savePending(): void {
  try {
    writeFileAtomic(DELEGATIONS_FILE, JSON.stringify(Object.fromEntries(pendingDelegations), null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("delegations: could not persist queue", error);
  }
}

/** Load what a previous process left queued. Missing or corrupt → empty. */
export function _loadPending(): void {
  pendingDelegations.clear();
  dispatchingTargets.clear();
  approvingItems.clear();
  try {
    const raw = JSON.parse(readFileSync(DELEGATIONS_FILE, "utf8")) as Record<string, unknown>;
    for (const [threadId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const items = list.flatMap((value): PendingDelegationItem[] => {
        if (!value || typeof value !== "object") return [];
        const item = value as Partial<PendingDelegationItem>;
        if (
          typeof item.toBotId !== "string" ||
          typeof item.message !== "string" ||
          !Number.isFinite(item.depth)
        ) return [];
        const loaded: PendingDelegationItem = {
          id: typeof item.id === "string" && item.id ? item.id : newId(),
          toBotId: item.toBotId,
          message: item.message,
          depth: Math.max(0, Math.trunc(item.depth!)),
          attempts: Number.isFinite(item.attempts) ? Math.max(0, Math.trunc(item.attempts!)) : 0,
        };
        const fromBotId = persistedFromBotId.parse(item.fromBotId);
        if (fromBotId) loaded.fromBotId = fromBotId;
        if (typeof item.reason === "string") loaded.reason = item.reason;
        if (typeof item.root === "string") loaded.root = item.root;
        if (typeof item.turnId === "string") loaded.turnId = item.turnId;
        if (typeof item.seq === "number" && Number.isFinite(item.seq)) loaded.seq = item.seq;
        if (item.kind === "ask" || item.kind === "delegation") loaded.kind = item.kind;
        if (item.approved === true) loaded.approved = true;
        return [loaded];
      });
      if (items.length) pendingDelegations.set(threadId, items);
    }
  } catch {
    /* fresh install, or unreadable — start empty */
  }
  loadDelegationReceipts();
  readySeq = Math.max(0, ...receiptSnapshot().map((row) => row.seq ?? 0));

}

/** Source threads with something queued — what a boot drain iterates. */
export function pendingThreads(): string[] {
  return [...pendingDelegations.keys()];
}

export function pendingDelegationSnapshot(): PendingDelegationSnapshot[] {
  return [...pendingDelegations.entries()].flatMap(([sourceThreadId, items]) =>
    items.map((item) => {
      const snapshot: PendingDelegationSnapshot = { sourceThreadId, toBotId: item.toBotId };
      if (item.fromBotId) snapshot.sourceBotId = item.fromBotId;
      if (item.reason) snapshot.reason = item.reason;
      return snapshot;
    }),
  );
}

/** How many handoffs one turn may queue. Small on purpose: this is the only
 * thing standing between a confused bot and a fan-out of real turns. */
const MAX_QUEUED_PER_THREAD = 4;

function appendDelegationActivity(
  bus: CommsBus,
  sourceThreadId: string,
  tool: NonNullable<Message["tool"]>,
  from?: BotRecord | null,
  taskId?: string,
): Message {
  const activity: Omit<Message, "id" | "at"> = { role: "bot", kind: "activity", tool };
  const receipt = taskId ? findDelegationReceipt(taskId) : undefined;
  if (receipt) activity.comm = { groupId: "", withBotId: receipt.toBotId, withName: receipt.toBotName, withColor: "", taskId, mailKey: `${taskId}:status:${sourceThreadId}`, state: receipt.state, deliver: receipt.deliver };
  if (from && sourceThreadId !== from.threadId) {
    activity.from = { botId: from.id, name: from.name, color: from.color };
  }
  return bus.store.appendMessage(sourceThreadId, activity);
}

/** Validate and enqueue a delegation. Pushes a "Queued for @B" chip to the
 * source thread; later states rewrite that same chip. */
export function queueDelegation(
  bus: CommsBus,
  from: BotRecord,
  item: DelegationItem,
  maxDepth: number,
  sourceThreadId = from.threadId,
  options: { kind?: "ask" | "delegation"; ready?: boolean; approved?: boolean; turnId?: string; id?: string; reservation?: Reservation } = {},
): QueuedDelegation {
  if (item.toBotId === from.id) return { result: "self" };
  if (item.depth >= maxDepth) return { result: "too_deep" };
  const target = bus.store.bot(item.toBotId);
  if (!target) return { result: "no_target" };
  const list = pendingDelegations.get(sourceThreadId) ?? [];
  // Async handoff removes the backpressure that ask_bot got for free by
  // making the caller wait. Without a cap, one turn can queue unboundedly
  // and fan out into as many real turns on the next settle.
  if (options.kind !== "ask" && list.filter((item) => item.kind !== "ask").length >= MAX_QUEUED_PER_THREAD) return { result: "too_many" };
  const id = options.id ?? newId();
  // The handoff prompt and its label are bot-authored and outlive the turn on
  // disk — scrub them the way the transcript copy of the same strings is.
  const queued: PendingDelegationItem = {
    ...item,
    message: redactSecretsInText(item.message),
    id,
    fromBotId: from.id,
    turnId: options.turnId ?? turnRegistry.current(sourceThreadId)?.turnId,
    kind: options.kind ?? "delegation",
    approved: options.approved,
    attempts: 0,
  };
  if (queued.reason !== undefined) queued.reason = redactSecretsInText(queued.reason);
  if (options.reservation) reservations.set(queued, options.reservation);
  acceptPeerTask(from, target, sourceThreadId, queued.kind!, "held", id, queued.root, queued.turnId);
  if (options.ready) readyItem(queued);
  list.push(queued);
  pendingDelegations.set(sourceThreadId, list);
  savePending();
  const label = `Queued for @${target.name}, sends when this reply ends${item.reason ? `: ${item.reason}` : ""}`;
  trackDelegationChip(id, sourceThreadId, appendDelegationActivity(bus, sourceThreadId, { name: label }, from, id).id);
  return { result: "ok", id };
}

export function drainDelegations(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  threadId: string,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel: GroupRecord | undefined,
    taskId: string,
    sourceBotId: string,
    transcriptText?: string,
    root?: string,
    reservation?: Reservation,
  ) => void | Promise<void>,
  sourceBotId?: string,
  waitingOn?: string,
): void {
  for (const item of pendingDelegations.get(threadId) ?? []) {
    if (sourceBotId && item.fromBotId !== sourceBotId) continue;
    if (!waitingOn && findDelegationReceipt(item.id)?.state === "held") readyItem(item);
  }
  savePending();
  pumpReady(bus, approvalBus, runTarget);
}

export function acceptPeerTask(from: BotRecord, target: BotRecord, threadId: string, kind: "ask" | "delegation", state: MailState, id: string = newId(), root?: string, sourceTurnId?: string): string {
  recordDelegationReceipt({ id, sourceThreadId: threadId, toBotId: target.id, toBotName: target.name, status: "queued", kind, deliver: "queued", state, root,
    source: { botId: from.id, threadId, turnId: sourceTurnId ?? turnRegistry.current(threadId)?.turnId ?? "" }, target: { botId: target.id, ...(state === "dispatching" ? { threadId: target.threadId } : {}) } });
  return id;
}

function readyItem(item: PendingDelegationItem): void {
  const receipt = findDelegationReceipt(item.id);
  item.seq ??= ++readySeq;
  if (receipt) recordDelegationReceipt({ ...receipt, status: "queued", state: "ready", seq: item.seq });
}

function pumpReady(bus: CommsBus, approvalBus: ApprovalBus, runTarget: Parameters<typeof drainDelegations>[3]): void {
  const ready = [...pendingDelegations].flatMap(([threadId, items]) => items.map((item) => ({ threadId, item })))
    .filter(({ item }) => findDelegationReceipt(item.id)?.state === "ready")
    .sort((a, b) => (a.item.seq ?? 0) - (b.item.seq ?? 0));
  for (const { threadId, item } of ready) {
    if (!pendingDelegations.get(threadId)?.some((candidate) => candidate.id === item.id) || findDelegationReceipt(item.id)?.state !== "ready") continue;
    if (approvingItems.has(item.id)) continue;
    const from = item.fromBotId ? bus.store.conversationForBot(item.fromBotId, threadId)?.bot : bus.store.botByThread(threadId);
    const target = bus.store.bot(item.toBotId);
    if (!from || !target) {
      failQueued(bus, threadId, item, from ? `error: delegation to ${item.toBotId} failed — no such bot` : "error: delegation failed — source bot no longer belongs to this conversation");
      continue;
    }
    if (from.approvePeerComms && !item.approved) {
      approvingItems.add(item.id);
      updateReceipt(item.id, { state: "approval" });
      void requestPeerApproval(approvalBus, from, target, item.message, item.kind === "ask" ? "ask_bot" : "delegate_bot", threadId).then((verdict) => {
        if (findDelegationReceipt(item.id)?.state !== "approval") return;
        if (verdict !== "allow") return failQueued(bus, threadId, item, "the user denied this handoff", "denied");
        item.approved = true;
        updateReceipt(item.id, { state: "ready" });
        savePending();
      }).catch((error) => failQueued(bus, threadId, item, failedLine(error))).finally(() => {
        approvingItems.delete(item.id);
        pumpReady(bus, approvalBus, runTarget);
      });
      continue;
    }
    if (target.busy || bus.senderBusy?.(target.id, target.threadId) || hasQueuedSends(target.id) || dispatchingTargets.has(target.id)) {
      item.attempts++;
      savePending();
      patchDelegationChip(bus, item.id, { name: `Delegation to @${target.name} waiting - they're busy` });
      continue;
    }
    dispatchingTargets.add(target.id);
    updateReceipt(item.id, { state: "dispatching", status: "running", target: { botId: target.id, threadId: target.threadId } });
    void processOne(bus, from, threadId, item, runTarget).catch((error) => failQueued(bus, threadId, item, failedLine(error))).finally(() => {
      acknowledgeDelegation(threadId, item.id);
      dispatchingTargets.delete(item.toBotId);
      pumpReady(bus, approvalBus, runTarget);
    });
  }
}

export function updateReceipt(id: string, patch: Partial<DelegationReceipt>): void {
  const receipt = findDelegationReceipt(id);
  if (receipt) recordDelegationReceipt({ ...receipt, ...patch });
}

export function bindPeerTurn(threadId: string, turnId: string): void {
  for (const receipt of receiptSnapshot()) {
    if (receipt.target?.threadId !== threadId || receipt.state !== "dispatching" && receipt.state !== "running") continue;
    updateReceipt(receipt.id, { state: "running", status: "running", target: { ...receipt.target, turnId } });
  }
}

const failedLine = (error: unknown) => `error: delegation failed — ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`;

function failQueued(bus: CommsBus, threadId: string, item: PendingDelegationItem, result: string, status: DelegationOutcome = "failed"): void {
  dropReservation(item);
  acknowledgeDelegation(threadId, item.id);
  finishDelegatedTurn(bus, { taskId: item.id, toBotId: item.toBotId, sourceThreadId: threadId, sourceBotId: item.fromBotId }, false, "", result);
  if (status === "denied") {
    updateReceipt(item.id, { status, state: "refused" });
    patchDelegationChip(bus, item.id, { name: `Delegation to @${bus.store.bot(item.toBotId)?.name ?? item.toBotId} denied by user`, ok: false });
  }
}

/** Remove one terminal handoff only after approval/dispatch has settled. */
function acknowledgeDelegation(threadId: string, itemId: string): void {
  const current = pendingDelegations.get(threadId);
  if (!current) return;
  const remaining = current.filter((item) => item.id !== itemId);
  if (remaining.length) pendingDelegations.set(threadId, remaining);
  else pendingDelegations.delete(threadId);
  savePending();
}

/** Drop a thread's queued handoffs without running them, telling the user
 * they were dropped. Used when the queueing turn failed or was interrupted. */
export function discardDelegations(bus: CommsBus, threadId: string, sourceBotId?: string, turnId?: string): void {
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  const privateSourceId = bus.store.botByThread(threadId)?.id;
  const scoped = Boolean(sourceBotId || turnId);
  const dropped = list.filter((item) => (!sourceBotId || (item.fromBotId ?? privateSourceId) === sourceBotId)
    && (!turnId || item.turnId === turnId)
    && (!scoped || findDelegationReceipt(item.id)?.state === "held"
      || Boolean(turnId) && ["ready", "approval"].includes(findDelegationReceipt(item.id)?.state ?? "")));
  if (!dropped.length) return;
  const remaining = list.filter((item) => !dropped.includes(item));
  if (remaining.length) pendingDelegations.set(threadId, remaining);
  else pendingDelegations.delete(threadId);
  savePending();
  for (const item of dropped) {
    dropReservation(item);
    releaseOpenAsk(threadId, item.id);
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId: threadId,
      toBotId: item.toBotId,
      toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
      status: "dropped",
      result: "the delegating turn did not finish",
    });
  }
  // An unfiltered drop can span several room members; one status per source
  // keeps every dropped handoff attributable to the bot that queued it.
  const counts = new Map<string | undefined, number>();
  for (const item of dropped) {
    const toName = bus.store.bot(item.toBotId)?.name ?? item.toBotId;
    // a handoff with its own chip says so there; only the rest get the tally
    if (patchDelegationChip(bus, item.id, { name: `Delegation to @${toName} dropped - the turn did not finish`, ok: false })) continue;
    const fromId = item.fromBotId ?? privateSourceId;
    counts.set(fromId, (counts.get(fromId) ?? 0) + 1);
  }
  for (const [fromId, count] of counts) {
    const from = fromId ? bus.store.bot(fromId) : null;
    appendDelegationActivity(
      bus,
      threadId,
      { name: `${count} queued delegation${count > 1 ? "s" : ""} dropped — the turn did not finish`, ok: false },
      from,
    );
  }
}

export function discardOrphanedDelegations(bus: CommsBus): number {
  const threads = pendingThreads();
  for (const receipt of receiptSnapshot()) {
    if (receipt.state === "finishing") {
      publishPeerReply(bus, receipt, true);
      recordDelegationReceipt({ ...receipt, state: receipt.status === "done" ? "done" : "failed" });
    } else if (receipt.state && !terminalMailState(receipt.state)) {
      const queued = receipt.state === "held" || receipt.state === "ready" || receipt.state === "approval";
      finishDelegatedTurn(bus, { taskId: receipt.id, toBotId: receipt.toBotId, sourceThreadId: receipt.sourceThreadId, sourceBotId: receipt.source?.botId }, false, "", queued ? `Delegation to @${receipt.toBotName} dropped - the turn did not finish` : "interrupted by a restart");
      if (queued) {
        updateReceipt(receipt.id, { status: "dropped", state: "dropped" });
        patchDelegationChip(bus, receipt.id, { name: `Delegation to @${receipt.toBotName} dropped - the turn did not finish`, ok: false });
      }
    }
  }
  for (const threadId of threads) {
    for (const item of pendingDelegations.get(threadId) ?? []) {
      dropReservation(item);
      if (!findDelegationReceipt(item.id)) recordDelegationReceipt({ id: item.id, sourceThreadId: threadId, toBotId: item.toBotId, toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId, status: "dropped", result: "the delegating turn did not finish" });
    }
  }
  pendingDelegations.clear();
  savePending();
  recoverHandedMail(bus.store);
  return threads.length;
}

/** Drop every queue this bot owns, wherever it queued them. A room queue lives
 * on the room thread, so deleting the bot would strand it there without a
 * sender. Call this before the bot record disappears. */
export function discardDelegationsFrom(bus: CommsBus, sourceBotId: string): void {
  const threads = new Set(
    pendingDelegationSnapshot()
      .filter((queued) => queued.sourceBotId === sourceBotId)
      .map((queued) => queued.sourceThreadId),
  );
  for (const threadId of threads) {
    const held = (pendingDelegations.get(threadId) ?? []).filter((item) => item.fromBotId === sourceBotId && ["held", "ready", "approval"].includes(findDelegationReceipt(item.id)?.state ?? "held"));
    for (const item of held) {
      dropReservation(item);
      releaseOpenAsk(threadId, item.id);
      acknowledgeDelegation(threadId, item.id);
      updateReceipt(item.id, { status: "dropped", state: "dropped", result: "source bot deleted" });
      patchDelegationChip(bus, item.id, { name: `Delegation to @${bus.store.bot(item.toBotId)?.name ?? item.toBotId} dropped - the turn did not finish`, ok: false });
    }
  }
  for (const receipt of receiptSnapshot()) {
    if (receipt.toBotId !== sourceBotId || !receipt.state || terminalMailState(receipt.state)) continue;
    const item = pendingDelegations.get(receipt.sourceThreadId)?.find((item) => item.id === receipt.id);
    if (item) dropReservation(item);
    finishDelegatedTurn(bus, { taskId: receipt.id, toBotId: sourceBotId, sourceThreadId: receipt.sourceThreadId, sourceBotId: receipt.source?.botId }, false, "", `error: delegation to ${receipt.toBotId} failed — no such bot`);
    acknowledgeDelegation(receipt.sourceThreadId, receipt.id);
  }
}

async function processOne(
  bus: CommsBus,
  from: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel: GroupRecord | undefined,
    taskId: string,
    sourceBotId: string,
    transcriptText?: string,
    root?: string,
    reservation?: Reservation,
  ) => void | Promise<void>,
): Promise<void> {
  const sender = from;
  const target = bus.store.bot(item.toBotId);
  if (!target) throw new Error("no such bot");
  const channel = getOrCreateChannel(bus.store, sender, target);
  const body = channel.threadId === sourceThreadId ? undefined : item.message;
  const delivered = patchDelegationChip(bus, item.id, { name: `Delivered to @${target.name}` }, commLink(channel, target), body);
  mirrorExchange(bus, sender, target, item.message, channel, sourceThreadId, !delivered);
  await runTarget(item.toBotId, delegatedPrompt(sender, item), item.depth + 1, sourceThreadId, channel, item.id, sender.id, `${item.message}${reasonLine(item)}`, item.root, takeReservation(item));
}

const reasonLine = (item: PendingDelegationItem) => item.reason ? `\n\n[Reason: ${item.reason}]` : "";

const delegatedPrompt = (sender: BotRecord, item: PendingDelegationItem) =>
  peerMessagePrompt(sender, `${item.message}${reasonLine(item)}`, item.kind === "ask" ? "ask" : "delegation");

/** A delegated turn on the target's own thread, watched until it ends. */
export interface DelegatedTurn {
  inline?: true;
  channelId?: string;
  toBotId: string;
  taskId?: string;
  sourceThreadId?: string;
  sourceBotId?: string;
  /** An ask that outlived its wait. */
  ask?: true;
  /** Backstop for a pane note that still reached this turn: the reply before it; later text answers the note. */
  answer?: string;
}

/** Settle one delegated turn and return whether its sender got the outcome. */
export function finishDelegatedTurn(
  bus: CommsBus,
  turn: DelegatedTurn,
  ok: boolean,
  reply = "",
  failureName = "Delegated turn did not finish",
): boolean {
  reply = peerReplyText(turn.answer ?? reply);
  const target = bus.store.bot(turn.toBotId);
  if (turn.taskId && turn.sourceThreadId) releaseOpenAsk(turn.sourceThreadId, turn.taskId);
  const existing = turn.taskId ? findDelegationReceipt(turn.taskId) : null;
  if (existing?.state && terminalMailState(existing.state)) return false;
  // tool calls or summaries only: a blank success would read as an answer
  if (ok && !reply.trim()) {
    ok = false;
    failureName = `No reply from @${target?.name ?? turn.toBotId}`;
  }
  const channel = turn.channelId ? bus.store.group(turn.channelId) : undefined;
  const sender = turn.sourceBotId ? bus.store.bot(turn.sourceBotId) : turn.sourceThreadId ? bus.store.botByThread(turn.sourceThreadId) : undefined;
  if (turn.taskId && turn.sourceThreadId) {
    const terminal: DelegationReceipt = {
      ...existing, id: turn.taskId, sourceThreadId: turn.sourceThreadId, toBotId: turn.toBotId,
      toBotName: target?.name ?? existing?.toBotName ?? turn.toBotId,
      status: ok ? "done" : "failed", state: ok ? "done" : "failed", result: redactSecretsInText(ok ? reply : failureName),
      finishedAt: Date.now(), kind: existing?.kind ?? (turn.ask ? "ask" : "delegation"), deliver: existing?.deliver ?? "queued",
      source: existing?.source ?? (sender ? { botId: sender.id, threadId: turn.sourceThreadId, turnId: "" } : undefined),
    };
    terminal.publish = replyDestinations(bus, terminal);
    recordDelegationReceipt({ ...terminal, state: "finishing" });
    publishPeerReply(bus, terminal);
    recordDelegationReceipt(terminal);
    if (target) settleDelegationChip(bus, target, turn.sourceThreadId, channel, turn.taskId, ok ? `@${target.name} replied` : failureName, ok);
    if (!turn.inline) wakeForPeerReply(bus, terminal);
    return terminal.publish.length > 0;
  }
  if (target && ok && reply.trim()) mirrorReply(bus, target, reply, channel);
  else if (target) mirrorActivity(bus, target, channel, failureName, false);
  return false;
}

/** A dispatched handoff whose target had no thread to watch: settle it as failed. */
export function failUnwatchedDelegation(taskId: string, sourceThreadId: string, toBotId: string, toBotName: string, result: string, bus?: CommsBus): boolean {
  if (bus) return finishDelegatedTurn(bus, { taskId, sourceThreadId, toBotId, sourceBotId: findDelegationReceipt(taskId)?.source?.botId }, false, "", result);
  recordDelegationReceipt({ id: taskId, sourceThreadId, toBotId, toBotName, status: "failed", result });
  return false;
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}

/** Test helper: forget the in-memory queue (a simulated restart). */
export function _resetPending(): void {
  pendingDelegations.clear();
  dispatchingTargets.clear();
  approvingItems.clear();
  readySeq = 0;
  resetDelegationReceipts();
}
