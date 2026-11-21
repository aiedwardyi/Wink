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
import { isOrder, nominate } from "./quick-route.ts";
import type { QuickBot, QuickResult } from "./side-chat.ts";
import { queueSteeredMessage } from "./steer-queue.ts";
import type { BotRecord, Message, Store } from "./store.ts";

const BLOCK_HEAD =
  "[Your earlier fast replies in this chat, sent while you were busy. They are your own words and the person has seen them. If one was wrong or is now out of date, correct it in one short line in your own voice, e.g. \"Correction: it's in your projects folder, not your desktop.\" Never say it came from anyone but you:]";
const NOTE_HEAD =
  "[Wink note, automated, not from the person. You already sent the person this reply earlier in this chat, and they have seen it. Do not repeat it. Use it only if it changes your current work, and then say only what changes. If it was wrong or is now out of date, correct it in one short line in your own voice, e.g. \"Correction: it's in your projects folder, not your desktop.\" Never say it came from anyone but you. The user's own words decide; if they don't match what you asked (like 'both' for 3 items), take every item or ask one short question.]";
// An order gets a fixed line, never the helper's reading of it; the bot decides what the order means.
const ORDER_ACK = "Got it, one moment while I finish this step, then I'll do it.";
const ORDER_ACK_KO = "알겠어요, 이 단계 마무리하고 바로 할게요. 잠시만요.";
const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/g;
const LATIN = /[a-z]/gi;
// the message's main script: one stray Hangul character ("merge 2번") stays English
const isKorean = (text: string) => {
  const korean = text.match(HANGUL)?.length ?? 0;
  return korean > 0 && korean * 4 >= korean + (text.match(LATIN)?.length ?? 0);
};
const orderAck = (text: string) => (isKorean(text) ? ORDER_ACK_KO : ORDER_ACK);
const BLOCK_PAIRS = 6;
const BLOCK_TOKENS = 1_500;
const INDEX_FILE = join(DATA_DIR, "quick-asks.json");
// engines that passed the real-engine accuracy bar
const QUICK_ENGINES: ReadonlySet<string> = new Set(["claudeAgent"]);

export type QuickAsk = (bot: QuickBot, threadId: string, ask: { text: string; notes?: string; ack?: boolean }) => Promise<QuickResult>;

export interface QuickGate {
  bot: BotRecord;
  threadId: string;
  text: string;
  instance: ProviderInstance | null | undefined;
  messages: Message[];
  deliverAfter: boolean;
  replyTo?: Message;
  queueId?: string;
  answersCard?: string;
  room: boolean;
  accountReady: boolean;
}

/** Gate 0, then the rules. Any doubt goes to the bot. */
function route(gate: QuickGate): ReturnType<typeof nominate> {
  const { bot, threadId } = gate;
  if (!bot.busy || bot.threadId !== threadId) return "main";
  if (gate.deliverAfter || gate.replyTo || gate.queueId || gate.answersCard || gate.room || !gate.accountReady) return "main";
  if (!gate.instance || !QUICK_ENGINES.has(gate.instance.driverKind)) return "main";
  if (!gate.instance.fork && !gate.instance.generateText) return "main";
  // typing answers a pinned card without choices, or a tapped choice's text
  const question = scanQuestion(gate.messages)?.card;
  if (question && (!question.staysOpen || !question.options.length || question.options.includes(gate.text.trim()))) return "main";
  if (gate.messages.some(isOpenRequest)) return "main";
  // a turn in another thread (a room hand-off, a routine) cannot take the line, so the helper answers or hands off any of it
  if ((bot.activeThreadId ?? threadId) !== threadId) return "quick";
  return nominate(gate.text);
}

export const routesQuick = (gate: QuickGate) => route(gate) === "quick";
/** Steered to the bot as the person's own words, with one short helper reply beside it. */
export const routesAck = (gate: QuickGate) => route(gate) === "ack";

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
export function quickAnswersTaken(store: Pick<Store, "row" | "patchRow">, event: RuntimeEvent): void {
  const ids = carried.get(event.threadId);
  const ended = event.type === "turn.completed" || event.type === "session.exited";
  if (!ids || (!ended && !MODEL_EVENTS.has(event.type))) return;
  carried.delete(event.threadId);
  if (ended) return;
  for (const id of ids.toReversed()) {
    const row = store.row(event.threadId, id);
    if (row?.quick) store.patchRow(event.threadId, id, { quick: { ...row.quick, noted: true } });
  }
}

export interface QuickDeps {
  store: Pick<Store, "bot" | "activePath" | "messagesFor" | "appendMessage" | "patchMessage" | "patchRow">;
  instance(bot: BotRecord, threadId: string): ProviderInstance | null | undefined;
  ask: QuickAsk;
  userName: string;
  /** Today's busy delivery of the ask's own text. */
  handoff(ask: Message): Promise<void>;
  drain(): void;
  usage?: { start(botId: string, threadId: string, id: string): void; settle(id: string): void };
}

type AskStore = Pick<Store, "activePath" | "appendMessage" | "patchMessage" | "patchRow">;

/** Still on the active path with its text and not yet handed to the bot; an edit or rewind drops it on purpose. */
export const pending = (store: Pick<Store, "activePath">, threadId: string, ask: Message) =>
  store.activePath(threadId).some((row) => row.id === ask.id && row.text === ask.text && !row.steered && row.quick?.state !== "handoff");

/** The ask as the bot's ordinary next turn in its own thread, else the failed-send row. */
export function queueAsk(store: AskStore, botId: string, threadId: string, ask: Message, prompt?: string): void {
  try {
    const queued = queueSteeredMessage(botId, threadId, ask.text ?? "", { prompt });
    store.patchRow(threadId, ask.id, { quick: { state: "handoff" }, queueId: queued.id });
  } catch (error) {
    store.patchRow(threadId, ask.id, { quick: undefined });
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

/** The same for a call's order or ask, or a promised order: its row stays and the queue drains into it. */
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
      } else if (turn && row.steered) stopped.add(row.id);
    }
  }
}

/** The open chats plus the threads of asks still running at shutdown; no other thread can hold a recovered ask. */
export function quickAskThreads(store: Pick<Store, "bots" | "taskByThread">): Map<string, string> {
  const threads = new Map(store.bots.map((bot) => [bot.threadId, bot.id]));
  for (const { botId, threadId } of savedThreads()) if (store.taskByThread(botId, threadId)) threads.set(threadId, botId);
  return threads;
}

const recovering = new Map<string, Promise<void>>();

/** A send to this chat waits here first, so a recovered ask still queues ahead of it. */
export const quickAskRecovery = (threadId: string): Promise<void> | undefined => recovering.get(threadId);

/** Boot: an unanswered ask whose job died with the last run goes to its bot once, as an ordinary turn. `asks` come from boot-reads.ts. */
export function recoverQuickAsks(store: AskStore & Pick<Store, "bots" | "taskByThread" | "activePathBack">, asks: Promise<Array<{ threadId: string; id: string; at: number }>>): Promise<void> {
  const threads = quickAskThreads(store);
  const done = asks.then((found) => {
    for (const [threadId, botId] of threads) {
      const ids = new Map(found.filter((ask) => ask.threadId === threadId).map((ask) => [ask.id, ask.at]));
      if (!ids.size) continue;
      const path: Message[] = [];
      // newest first by key, and only until every ask is seen: timestamps need not fall along the path
      let left = ids.size;
      // an answer that landed after the boot read sits newer on the path than its ask, so the walk meets it first
      const answered = new Set<string>();
      for (const row of store.activePathBack(threadId)) {
        if (row.role === "bot" && row.quick?.askId) answered.add(row.quick.askId);
        if (ids.has(row.id)) {
          left--;
          if (row.quick?.state === "asked" && !answered.has(row.id)) path.push(row);
        }
        if (!left) break;
      }
      for (const ask of path.toReversed()) queueAsk(store, botId, threadId, ask);
    }
    saveRunning();
  }).finally(() => {
    for (const threadId of threads.keys()) if (recovering.get(threadId) === done) recovering.delete(threadId);
  });
  for (const threadId of threads.keys()) recovering.set(threadId, done);
  return done;
}

type HelperDeps = Omit<QuickDeps, "handoff" | "drain">;

async function askHelper(deps: HelperDeps, instance: ProviderInstance, botId: string, threadId: string, ask: Message, ack?: boolean): Promise<QuickResult> {
  const usageId = `quick:${ask.id}`;
  let result: QuickResult = { route: "handoff", ms: 0 };
  deps.usage?.start(botId, threadId, usageId);
  try {
    const messages = deps.store.activePath(threadId).filter((message) => message.id !== ask.id);
    const calls = ask.call ? callLinesSinceLastUserTurn(messages, new Set()) : [];
    const notes = [...quickAnswersSinceLastUserTurn(messages, new Set()), ...calls].join("\n\n");
    result = await deps.ask({ instance, messages, userName: deps.userName }, threadId, { text: ask.text ?? "", notes, ack });
  } catch {}
  deps.usage?.settle(usageId);
  console.info(`[quick] ${JSON.stringify({ id: usageId, accountId: instance.instanceId, route: result.route, ms: result.ms, ack, ...result.usage })}`);
  return result;
}

/** Runs one ask after the send returned: answer row plus live note, or handoff. */
export async function answerQuick(deps: QuickDeps, botId: string, threadId: string, ask: Message): Promise<void> {
  const { store } = deps;
  const bot = store.bot(botId);
  const instance = bot ? deps.instance(bot, threadId) : null;
  const text = ask.text ?? "";
  if (isOrder(text)) {
    if (!bot || !pending(store, threadId, ask)) return;
    store.appendMessage(threadId, { role: "bot", kind: "text", text: orderAck(text), engine: instance?.driverKind, quick: { state: "answer", askId: ask.id } });
    // this route never gave the bot the order, so it waits for the bot's next turn here
    queueAsk(store, botId, threadId, ask);
    deps.drain();
    return;
  }
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
  // the bot's own reply already stands under the ask; a late answer could contradict it
  if (!current.busy && !stopped.has(ask.id) && repliedUnder(store.activePath(threadId), ask)) {
    queueAsk(store, botId, threadId, ask);
    deps.drain();
    return;
  }
  await land(store, instance, current, threadId, ask, result.text);
}

export const repliedUnder = (path: Message[], ask: Message) => {
  const asked = path.findIndex((row) => row.id === ask.id);
  return asked >= 0 && path.slice(asked + 1).some((row) => row.role === "bot" && row.kind === "text" && !row.quick && !isVoiceLine(row) && row.text?.trim());
};

/** The helper's reply as a row under the ask, then a note to the bot while it still works there. */
async function land(store: QuickDeps["store"], instance: ProviderInstance | null | undefined, current: BotRecord, threadId: string, ask: Message, text: string): Promise<void> {
  const answer = store.appendMessage(threadId, { role: "bot", kind: "text", text, engine: instance?.driverKind, quick: { state: "answer", askId: ask.id } });
  if (!current.busy || current.threadId !== threadId || (current.activeThreadId ?? threadId) !== threadId) return;
  const note = `${NOTE_HEAD} Q: ${ask.text?.trim()} A: ${text}`;
  await steerUntilTaken(instance?.adapter, threadId, note, () => {
    const row = store.messagesFor(threadId).find((message) => message.id === answer.id);
    if (row?.quick) store.patchMessage(threadId, answer.id, { quick: { ...row.quick, noted: true } });
  })?.catch(() => false);
}

/** One short helper reply under a send the bot already took as the person's own words; none when the helper has none. */
export async function ackQuick(deps: HelperDeps, botId: string, threadId: string, sent: Message): Promise<void> {
  const { store } = deps;
  const bot = store.bot(botId);
  const instance = bot ? deps.instance(bot, threadId) : null;
  if (!instance) return;
  const text = sent.text ?? "";
  const result: QuickResult = isOrder(text)
    ? { route: "answer", text: orderAck(text), ms: 0 }
    : await askHelper(deps, instance, botId, threadId, sent, true);
  const current = store.bot(botId);
  if (!current || result.route === "handoff" || !result.text) return;
  const path = store.activePath(threadId);
  // an edit or rewind dropped the send, or the finished turn already replied to it
  if (!path.some((row) => row.id === sent.id && row.text === sent.text) || (!current.busy && repliedUnder(path, sent))) return;
  await land(store, instance, current, threadId, sent, result.text);
}
