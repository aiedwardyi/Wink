import { UserTagScanner, unwrapUserTags } from "../shared/user-tags.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { startQueuedTurn, writeChatError } from "./chat-error.ts";
import { hasPeerWatch } from "./peer-takeover.ts";
import { foldQueuedSends } from "./steer-queue.ts";
import type { Message, Store } from "./store.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

interface UserInput {
  botId: string;
  prompt: string;
  message?: Message;
  answered: boolean;
  starting?: boolean;
}

interface SplitTurn {
  turnId?: string;
  ready: boolean;
  inputs: Map<number, UserInput>;
}

const turns = new Map<string, SplitTurn>();
const liveTurns = new Map<string, string | undefined>();
const streams = new Map<string, { turnId?: string; scanner: UserTagScanner }>();
let nextInput = 0;

function splitText(text: string): { peer: string; users: Array<{ id: number; text: string }> } {
  const users: Array<{ id: number; text: string }> = [];
  const peer = text.replace(/<user(\d+)>([\s\S]*?)<\/user\1>/g, (_match, id: string, body: string) => {
    users.push({ id: Number(id), text: body.trim() });
    return "";
  });
  return { peer: users.length ? peer.trim() : peer, users };
}

export const peerReplyText = (text: string): string => splitText(text).peer;

export function beginPeerUserReply(botId: string, threadId: string, prompt: string) {
  if (!hasPeerWatch(threadId)) return undefined;
  const turn = turns.get(threadId) ?? { turnId: liveTurns.get(threadId), ready: false, inputs: new Map<number, UserInput>() };
  const id = ++nextInput;
  const input: UserInput = { botId, prompt, answered: false };
  turn.inputs.set(id, input);
  turns.set(threadId, turn);
  return {
    prompt: `${prompt}\n\nFor this reply only, answer in <user${id}>one short line</user${id}>; keep the peer answer outside. Never use that tag in later turns.`,
    accept: (message: Message) => { input.message = message; },
    cancel: () => {
      turn.inputs.delete(id);
      if (!turn.inputs.size && turns.get(threadId) === turn) turns.delete(threadId);
    },
  };
}

export function foldPeerQueuedSends(store: Store, botId: string, threadId: string, since: number, steering: boolean): string[] {
  if (hasPeerWatch(threadId) && !steering) return [];
  const prompts = foldQueuedSends(store, botId, threadId, since);
  const messages = store.activePath(threadId).slice(-prompts.length);
  return prompts.map((prompt, index) => {
    const input = beginPeerUserReply(botId, threadId, prompt);
    if (input) input.accept(messages[index]!);
    return input?.prompt ?? prompt;
  });
}

function splitTurn(event: RuntimeEvent): SplitTurn | undefined {
  const turn = turns.get(event.threadId);
  return turn && !turn.ready && (!turn.turnId || !event.turnId || turn.turnId === event.turnId) ? turn : undefined;
}

export function stripStrayUserTags(event: RuntimeEvent): RuntimeEvent {
  const held = streams.get(event.threadId);
  const own = held && held.turnId === event.turnId;
  if (event.type === "turn.started" || (own && event.type === "turn.completed")) streams.delete(event.threadId);
  if (event.type === "item.completed" && event.itemType === "assistant_text") {
    if (own) streams.delete(event.threadId);
    return splitTurn(event) ? event : { ...event, text: unwrapUserTags(event.text) };
  }
  if (event.type !== "content.delta" || event.streamKind !== "assistant_text" || splitTurn(event)) return event;
  const stream = own ? held! : { turnId: event.turnId, scanner: new UserTagScanner() };
  streams.set(event.threadId, stream);
  const next = stream.scanner.push(event.delta);
  return { ...event, delta: next };
}

export function peerUserRuntime(event: RuntimeEvent): RuntimeEvent | null {
  if (event.type === "turn.started" && hasPeerWatch(event.threadId)) {
    liveTurns.set(event.threadId, event.turnId);
    const turn = turns.get(event.threadId);
    if (turn && !turn.ready) turn.turnId ??= event.turnId;
  }
  const turn = splitTurn(event);
  if (!turn) return event;
  if (event.type === "content.delta" && event.streamKind === "assistant_text") return null;
  if (event.type !== "item.completed" || event.itemType !== "assistant_text") return event;
  const text = event.summarized ? "" : splitText(event.text).users
    .filter((user) => turn.inputs.has(user.id) && !turn.inputs.get(user.id)!.answered)
    .map((user) => user.text).filter(Boolean).join("\n");
  return { ...event, text, phase: undefined };
}

export function persistPeerUserReply(
  store: Pick<Store, "appendMessage">,
  event: RuntimeEvent,
  lastReply?: Map<string, { text: string; messageId: string }>,
): boolean {
  const turn = splitTurn(event);
  if (!turn || event.type !== "item.completed" || event.itemType !== "assistant_text") return false;
  if (event.summarized) return true;
  for (const user of splitText(event.text).users) {
    const input = turn.inputs.get(user.id);
    if (!input || input.answered || !user.text) continue;
    const message = store.appendMessage(event.threadId, { role: "bot", kind: "text", text: user.text });
    input.answered = true;
    lastReply?.set(event.threadId, { text: user.text, messageId: message.id });
  }
  return true;
}

export function settlePeerUserReplies(threadId: string, turnId?: string): void {
  const turn = turns.get(threadId);
  if (turn && (!turn.turnId || !turnId || turn.turnId === turnId)) turn.ready = true;
  if (!turnId || liveTurns.get(threadId) === turnId) liveTurns.delete(threadId);
}

export function cancelPeerUserReplies(botId: string): void {
  for (const [threadId, turn] of turns) {
    for (const [id, input] of turn.inputs) {
      if (input.botId === botId) turn.inputs.delete(id);
    }
    if (!turn.inputs.size) turns.delete(threadId);
  }
}

type ReplyStart = (botId: string, prompt: string, opts: { threadId: string; userMessage: Message; excludeMessageIds: string[] }) => Promise<unknown>;

export function drainPeerUserReplies(store: Pick<Store, "bot" | "taskByThread" | "appendMessage">, start: ReplyStart, busy: (botId: string, threadId: string) => boolean, access: TerminalBridgeAccess | null = null): void {
  const started = new Set<string>();
  for (const [threadId, turn] of turns) {
    if (!turn.ready) continue;
    for (const [id, input] of turn.inputs) {
      const bot = store.bot(input.botId);
      if (input.answered || !input.message || !bot || !store.taskByThread(input.botId, threadId)) {
        turn.inputs.delete(id);
        continue;
      }
      if (input.starting || started.has(bot.id) || busy(bot.id, threadId)) continue;
      input.starting = true;
      started.add(bot.id);
      const message = input.message;
      const cancelled = () => turns.get(threadId) !== turn || !turn.inputs.has(id);
      void startQueuedTurn(() => start(bot.id, input.prompt, { threadId, userMessage: message, excludeMessageIds: [message.id] }), cancelled, access).catch((error) => {
        if (cancelled()) return;
        const line = `queued message could not start - ${error instanceof Error ? error.message : String(error)}`;
        if (writeChatError(line, access)) store.appendMessage(threadId, {
          role: "bot", kind: "activity", tool: { name: `error: ${line}`, ok: false },
        });
      }).finally(() => {
        if (cancelled()) return;
        turn.inputs.delete(id);
        if (!turn.inputs.size) turns.delete(threadId);
        queueMicrotask(() => drainPeerUserReplies(store, start, busy, access));
      });
    }
    if (!turn.inputs.size) turns.delete(threadId);
  }
}

export function _resetPeerUserReplies(): void {
  turns.clear();
  liveTurns.clear();
  streams.clear();
  nextInput = 0;
}
