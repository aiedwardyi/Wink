// Quick answers: while a bot works, a short question goes to its read-only helper first.
// The helper's answer lands as a row under the ask; a HANDOFF goes down today's busy path.
import { estimateContextTokens } from "./context-compaction.ts";
import type { ProviderInstance } from "./contracts.ts";
import { steerUntilTaken } from "./note-steer.ts";
import { endsNoteWindow } from "./pane-wake.ts";
import { nominate } from "./quick-route.ts";
import type { QuickBot, QuickResult } from "./side-chat.ts";
import type { BotRecord, Message, Store } from "./store.ts";

const BLOCK_HEAD =
  "[Quick answers given beside your work. While you were busy, the person asked your quick helper these; the helper is a read-only copy of you. Treat them as said in this chat:]";
const NOTE_HEAD =
  "[Wink note, automated, not from the person. Your read-only quick helper already answered this for the person, who has seen the answer. Do not mention or repeat it. Use it only if it changes your current work, and then say only what changes.]";
const BLOCK_PAIRS = 6;
const BLOCK_TOKENS = 1_500;

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

const openAsk = (message: Message) =>
  message.kind === "options" && Boolean(message.card?.requestId || message.card?.askUser) && !message.card?.answered && !message.card?.dismissed;

/** Gate 0, then the rules. Any doubt goes to the bot. */
export function routesQuick(gate: QuickGate): boolean {
  const { bot, threadId } = gate;
  if (!bot.busy || bot.threadId !== threadId || (bot.activeThreadId ?? threadId) !== threadId) return false;
  if (gate.deliverAfter || gate.replyTo || gate.queueId || gate.room || !gate.accountReady) return false;
  if (!gate.instance?.fork && !gate.instance?.generateText) return false;
  if (gate.messages.some(openAsk)) return false;
  return nominate(gate.text) === "quick";
}

/** Answered quick asks since the last real user turn the bot has not taken in, newest kept. */
export function quickAnswersSinceLastUserTurn(messages: Message[], excludeIds: ReadonlySet<string>, boundId?: string): string[] {
  const pairs: string[] = [];
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
  }
  return pairs.length ? [[BLOCK_HEAD, ...pairs].join("\n")] : [];
}

export interface QuickDeps {
  store: Pick<Store, "bot" | "activePath" | "messagesFor" | "appendMessage" | "patchMessage">;
  instance(bot: BotRecord, threadId: string): ProviderInstance | null | undefined;
  ask: QuickAsk;
  userName: string;
  /** Today's busy delivery of the ask's own text. */
  handoff(ask: Message): Promise<void>;
  usage?: { start(botId: string, threadId: string, id: string): void; settle(id: string): void };
}

async function askHelper(deps: QuickDeps, instance: ProviderInstance, botId: string, threadId: string, ask: Message): Promise<QuickResult> {
  const usageId = `quick:${ask.id}`;
  let result: QuickResult = { route: "handoff", ms: 0 };
  deps.usage?.start(botId, threadId, usageId);
  try {
    const messages = deps.store.activePath(threadId).filter((message) => message.id !== ask.id);
    const notes = quickAnswersSinceLastUserTurn(messages, new Set()).join("\n\n");
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
  if (!current || current.threadId !== threadId || !store.messagesFor(threadId).some((message) => message.id === ask.id)) return;
  if (result.route === "handoff" || !result.text) {
    // The turn can end mid-steer (409); the second try takes the idle or queue path.
    for (let tries = 0; tries < 2; tries++) {
      try {
        return await deps.handoff(ask);
      } catch (error) {
        console.warn(`[quick] handoff failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    store.patchMessage(threadId, ask.id, { quick: undefined });
    return;
  }
  const answer = store.appendMessage(threadId, { role: "bot", kind: "text", text: result.text, quick: { state: "answer", askId: ask.id } });
  if (!current.busy || (current.activeThreadId ?? threadId) !== threadId) return;
  const note = `${NOTE_HEAD} Q: ${ask.text?.trim()} A: ${result.text}`;
  await steerUntilTaken(instance?.adapter, threadId, note, () => {
    const row = store.messagesFor(threadId).find((message) => message.id === answer.id);
    if (row?.quick) store.patchMessage(threadId, answer.id, { quick: { ...row.quick, noted: true } });
  })?.catch(() => false);
}
