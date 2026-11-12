// Quick answers: while a bot works, a short question goes to its read-only helper first.
// The helper's answer lands as a row under the ask; a HANDOFF goes down today's busy path.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isVoiceLine } from "../shared/live-call.ts";
import { isOpenRequest, scanQuestion } from "../shared/open-question.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { estimateContextTokens } from "./context-compaction.ts";
import { callLinesSinceLastUserTurn } from "./live-call.ts";
import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { steerUntilTaken } from "./note-steer.ts";
import { endsNoteWindow } from "./pane-wake.ts";
import { nominate } from "./quick-route.ts";
import type { QuickBot, QuickResult } from "./side-chat.ts";
import { queueSteeredMessage } from "./steer-queue.ts";
import type { BotRecord, Message, Store } from "./store.ts";

const BLOCK_HEAD =
  "[Your earlier fast replies in this chat, sent while you were busy. They are your own words and the person has seen them. If one was wrong or is now out of date, correct it in one short line in your own voice, e.g. \"Correction: it's in your projects folder, not your desktop.\" Never say it came from anyone but you:]";
const NOTE_HEAD =
  "[Wink note, automated, not from the person. You already sent the person this reply earlier in this chat, and they have seen it. Do not repeat it. Use it only if it changes your current work, and then say only what changes. If it was wrong or is now out of date, correct it in one short line in your own voice, e.g. \"Correction: it's in your projects folder, not your desktop.\" Never say it came from anyone but you.]";
const BLOCK_PAIRS = 6;
const BLOCK_TOKENS = 1_500;
const INDEX_FILE = join(DATA_DIR, "quick-asks.json");
// engines that passed the real-engine accuracy bar
const QUICK_ENGINES: ReadonlySet<string> = new Set(["claudeAgent"]);

export type QuickAsk = (bot: QuickBot, threadId: string, ask: { text: string; notes?: string }) => Promise<QuickResult>;

export interface QuickGate {
  bot: BotRecord;
  threadId: string;
  text: string;
  instance: ProviderInstance | null | undefined;
  messages: Message[];
  deliverAfter: boolean;
  replyTo?: Message;
  queueId?: string;
  room: boolean;
  accountReady: boolean;
}

/** Gate 0, then the rules. Any doubt goes to the bot. */
export function routesQuick(gate: QuickGate): boolean {
  const { bot, threadId } = gate;
  if (!bot.busy || bot.threadId !== threadId || (bot.activeThreadId ?? threadId) !== threadId) return false;
  if (gate.deliverAfter || gate.replyTo || gate.queueId || gate.room || !gate.accountReady) return false;
  if (!gate.instance || !QUICK_ENGINES.has(gate.instance.driverKind)) return false;
  if (!gate.instance.fork && !gate.instance.generateText) return false;
  if (scanQuestion(gate.messages) || gate.messages.some(isOpenRequest)) return false;
  return nominate(gate.text) === "quick";
}

// The answers a thread's starting turn carries in its block, until that turn's first model event.
const carried = new Map<string, string[]>();
const MODEL_EVENTS: ReadonlySet<string> = new Set(["content.delta", "item.started", "item.completed"]);

/** Answered quick asks since the last real user turn the bot has not taken in, newest kept. A turn names its thread to carry them. */
export function quickAnswersSinceLastUserTurn(messages: Message[], excludeIds: ReadonlySet<string>, boundId?: string, turnThreadId?: string): string[] {
  const pairs: string[] = [];
  const ids: string[] = [];
  let tokens = estimateContextTokens([{ text: BLOCK_HEAD }]);
  for (let index = messages.length - 1; index >= 0 && pairs.length < BLOCK_PAIRS; index--) {
    const message = messages[index]!;
    if (message.id === boundId) break;
    if (excludeIds.has(message.id)) continue;
    if (endsNoteWindow(message)) break;
    const quick = message.quick;
    if (quick?.state !== "answer" || quick.noted || !message.text?.trim()) continue;
    const ask = messages.find((row) => row.id === quick.askId);
    if (!ask?.text?.trim()) continue;
    const pair = `Q: ${ask.text.trim()}\nA: ${message.text.trim()}`;
    tokens += estimateContextTokens([{ text: pair }]);
    if (tokens > BLOCK_TOKENS) break;
    pairs.unshift(pair);
    ids.push(message.id);
  }
  if (turnThreadId) carried.set(turnThreadId, ids);
  return pairs.length ? [[BLOCK_HEAD, ...pairs].join("\n")] : [];
}

/** Marks the carried answers noted on the turn's first model event; a turn that ends before it leaves them for the next. */
export function quickAnswersTaken(store: Pick<Store, "messagesFor" | "patchMessage">, event: RuntimeEvent): void {
  const ids = carried.get(event.threadId);
  const ended = event.type === "turn.completed" || event.type === "session.exited";
  if (!ids || (!ended && !MODEL_EVENTS.has(event.type))) return;
  carried.delete(event.threadId);
  if (ended) return;
  for (const row of store.messagesFor(event.threadId)) if (row.quick && ids.includes(row.id)) store.patchMessage(event.threadId, row.id, { quick: { ...row.quick, noted: true } });
}

export interface QuickDeps {
  store: Pick<Store, "bot" | "activePath" | "messagesFor" | "appendMessage" | "patchMessage">;
  instance(bot: BotRecord, threadId: string): ProviderInstance | null | undefined;
  ask: QuickAsk;
  userName: string;
  /** Today's busy delivery of the ask's own text. */
  handoff(ask: Message): Promise<void>;
  drain(): void;
  usage?: { start(botId: string, threadId: string, id: string): void; settle(id: string): void };
}

type AskStore = Pick<Store, "activePath" | "appendMessage" | "patchMessage">;

/** Still on the active path with its text and not yet handed to the bot; an edit or rewind drops it on purpose. */
export const pending = (store: Pick<Store, "activePath">, threadId: string, ask: Message) =>
  store.activePath(threadId).some((row) => row.id === ask.id && row.text === ask.text && !row.steered && row.quick?.state !== "handoff");

/** The ask as the bot's ordinary next turn in its own thread, else the failed-send row. */
function queueAsk(store: AskStore, botId: string, threadId: string, ask: Message): void {
  try {
    const queued = queueSteeredMessage(botId, threadId, ask.text ?? "");
    store.patchMessage(threadId, ask.id, { quick: { state: "handoff" }, queueId: queued.id });
  } catch (error) {
    store.patchMessage(threadId, ask.id, { quick: undefined });
    const name = `error: queued message could not start - ${error instanceof Error ? error.message : String(error)}`;
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name, ok: false } });
  }
}

// Asks a Stop handed back, by id since an ask need not carry a sendId; only a late answer still lands.
const stopped = new Set<string>();
export const askStopped = (ask: Message) => stopped.has(ask.id);

/** A recorded steer the engine dropped later goes once to the queue in its own thread. */
export function requeueDroppedAsk(store: AskStore, botId: string, threadId: string, ask: Message, drain: () => void): void {
  if (stopped.has(ask.id) || !store.activePath(threadId).some((row) => row.id === ask.id && row.text === ask.text && row.steered && row.quick?.state === "handoff")) return;
  store.patchMessage(threadId, ask.id, { steered: undefined });
  queueAsk(store, botId, threadId, ask);
  drain();
}

/** The same for a call's order or ask: its row stays and the queue drains into it. */
export function requeueDroppedCall(store: AskStore, botId: string, threadId: string, row: Message, drain: () => void): void {
  if (stopped.has(row.id) || !store.activePath(threadId).some((message) => message.id === row.id && message.steered)) return;
  try {
    const queued = queueSteeredMessage(botId, threadId, row.text ?? "", { sendId: row.sendId, call: row.call });
    if (queued.skipped) return;
    store.patchMessage(threadId, row.id, { steered: undefined, queueId: queued.id, queued: true });
  } catch (error) {
    console.warn(`[queue] dropped call send could not requeue: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  drain();
}

// Asks whose job is running, so a restart finds the ones left in another task without reading every thread.
const running = new Map<string, { botId: string; threadId: string }>();
let saving = false;

function saveRunning(): void {
  if (saving) return;
  saving = true;
  // after the send's response, one write per tick
  setImmediate(() => {
    saving = false;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileAtomic(INDEX_FILE, JSON.stringify([...running.values()]), { mode: 0o600 });
    } catch (error) {
      console.warn(`[quick] could not save running asks: ${error}`.replace(/\s+/g, " "));
    }
  });
}

export function trackQuickAsk(botId: string, threadId: string, askId: string): () => void {
  running.set(askId, { botId, threadId });
  saveRunning();
  return () => {
    if (running.delete(askId)) saveRunning();
  };
}

function savedThreads(): Array<{ botId: string; threadId: string }> {
  try {
    const rows: unknown = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
    return Array.isArray(rows) ? rows.filter((row) => typeof row?.botId === "string" && typeof row?.threadId === "string") : [];
  } catch {
    return [];
  }
}

/** Stop: no ask of this bot starts a turn or a queue later, even after a restart. */
export function cancelQuickAsks(store: AskStore & Pick<Store, "messagesFor">, botId: string, threadIds: string[]): void {
  const threads = new Set(threadIds);
  for (const ask of running.values()) if (ask.botId === botId) threads.add(ask.threadId);
  for (const threadId of threads) {
    const answered = new Set(store.messagesFor(threadId).map((row) => row.quick?.askId));
    const path = store.activePath(threadId);
    let turn = true;
    for (let index = path.length - 1; index >= 0; index--) {
      const row = path[index]!;
      if (endsNoteWindow(row)) turn = false;
      if (row.quick?.state === "asked" && !answered.has(row.id)) {
        stopped.add(row.id);
        // a stopped ask reads as handed off, so it is neither pending nor recovered
        store.patchMessage(threadId, row.id, { quick: { state: "handoff" } });
      } else if (turn && row.steered && (row.quick?.state === "handoff" || row.call?.order || row.call?.ask)) stopped.add(row.id);
    }
  }
}

/** Boot: an unanswered ask whose job died with the last run goes to its bot once, as an ordinary turn. */
export function recoverQuickAsks(store: AskStore & Pick<Store, "bots" | "messagesFor" | "taskByThread">): void {
  // the open chats plus the threads of asks still running at shutdown; no other thread is read
  const threads = new Map(store.bots.map((bot) => [bot.threadId, bot.id]));
  for (const { botId, threadId } of savedThreads()) if (store.taskByThread(botId, threadId)) threads.set(threadId, botId);
  for (const [threadId, id] of threads) {
    const answered = new Set(store.messagesFor(threadId).map((row) => row.quick?.askId));
    for (const ask of store.activePath(threadId)) if (ask.quick?.state === "asked" && !answered.has(ask.id)) queueAsk(store, id, threadId, ask);
  }
  saveRunning();
}

async function askHelper(deps: QuickDeps, instance: ProviderInstance, botId: string, threadId: string, ask: Message): Promise<QuickResult> {
  const usageId = `quick:${ask.id}`;
  let result: QuickResult = { route: "handoff", ms: 0 };
  deps.usage?.start(botId, threadId, usageId);
  try {
    const messages = deps.store.activePath(threadId).filter((message) => message.id !== ask.id);
    const calls = ask.call ? callLinesSinceLastUserTurn(messages, new Set()) : [];
    const notes = [...quickAnswersSinceLastUserTurn(messages, new Set()), ...calls].join("\n\n");
    result = await deps.ask({ instance, messages, userName: deps.userName }, threadId, { text: ask.text ?? "", notes });
  } catch {}
  deps.usage?.settle(usageId);
  console.info(`[quick] ${JSON.stringify({ id: usageId, accountId: instance.instanceId, route: result.route, ms: result.ms, ...result.usage })}`);
  return result;
}

/** Runs one ask after the send returned: answer row plus live note, or handoff. */
export async function answerQuick(deps: QuickDeps, botId: string, threadId: string, ask: Message): Promise<void> {
  const { store } = deps;
  const bot = store.bot(botId);
  const instance = bot ? deps.instance(bot, threadId) : null;
  const result: QuickResult = instance ? await askHelper(deps, instance, botId, threadId, ask) : { route: "handoff", ms: 0 };
  const current = store.bot(botId);
  // a stopped ask still takes its late answer; one handed to the bot any other way is the bot's
  const live = stopped.has(ask.id) ? store.activePath(threadId).some((row) => row.id === ask.id && row.text === ask.text) : pending(store, threadId, ask);
  if (!current || !live) return;
  if (result.route === "handoff" || !result.text) {
    // A turn can end or be claimed under a try; the second takes the idle or queue path.
    for (let tries = 0; tries < 2 && pending(store, threadId, ask); tries++) {
      try {
        return await deps.handoff(ask);
      } catch (error) {
        console.warn(`[quick] handoff failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!pending(store, threadId, ask)) return;
    queueAsk(store, botId, threadId, ask);
    deps.drain();
    return;
  }
  const path = store.activePath(threadId);
  // the bot's own reply already stands under the ask; a late answer could contradict it
  const asked = path.findIndex((row) => row.id === ask.id);
  if (!current.busy && !stopped.has(ask.id) && asked >= 0 && path.slice(asked + 1).some((row) => row.role === "bot" && row.kind === "text" && !row.quick && !isVoiceLine(row) && row.text?.trim())) {
    queueAsk(store, botId, threadId, ask);
    deps.drain();
    return;
  }
  const answer = store.appendMessage(threadId, { role: "bot", kind: "text", text: result.text, quick: { state: "answer", askId: ask.id } });
  if (!current.busy || current.threadId !== threadId || (current.activeThreadId ?? threadId) !== threadId) return;
  const note = `${NOTE_HEAD} Q: ${ask.text?.trim()} A: ${result.text}`;
  await steerUntilTaken(instance?.adapter, threadId, note, () => {
    const row = store.messagesFor(threadId).find((message) => message.id === answer.id);
    if (row?.quick) store.patchMessage(threadId, answer.id, { quick: { ...row.quick, noted: true } });
  })?.catch(() => false);
}
