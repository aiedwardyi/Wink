import type { Message } from "@/state/store";

import { forgetMemory } from "./memory-last";

type Listener = (message?: Message) => void;
const listeners = new Map<string, Set<Listener>>();
const saves = new Map<string, Set<() => void>>();

export function watchMemoryChange(botId: string, listener: Listener): () => void {
  return watch(listeners, botId, listener);
}

export function watchMemoryArrival(botId: string, listener: (message: Message) => void): () => void {
  return watchMemoryChange(botId, (message) => { if (message) listener(message); });
}

export function watchMemorySave(botId: string, listener: () => void): () => void {
  return watch(saves, botId, listener);
}

function watch<T>(registry: Map<string, Set<T>>, botId: string, listener: T): () => void {
  const set = registry.get(botId) ?? new Set<T>();
  registry.set(botId, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) registry.delete(botId);
  };
}

export function noteMemoryFrame(frame: { kind: string; botId?: string; threadId?: string; replayed?: boolean; imported?: boolean; message?: { id: string; tool?: { name: string; lines?: readonly string[]; ok?: boolean; memoryBotId?: string } } }, state: { hydrated: boolean; bots: readonly { id: string; threadId: string; tasks?: readonly { threadId: string }[]; messages?: readonly { id: string }[] }[] }): void {
  if (!state.hydrated) return;
  if (frame.kind === "memory.changed" && frame.botId !== undefined) {
    forgetMemory(frame.botId);
    listeners.get(frame.botId)?.forEach((listener) => listener());
    saves.get(frame.botId)?.forEach((listener) => listener());
    return;
  }
  if (frame.kind !== "message" || frame.imported || frame.message?.tool?.name !== "memory.save" || frame.message.tool.ok === false) return;
  const bot = state.bots.find((bot) => bot.threadId === frame.threadId);
  const owner = frame.message.tool.memoryBotId ?? bot?.id ?? state.bots.find((bot) => bot.tasks?.some((task) => task.threadId === frame.threadId))?.id;
  if (owner) forgetMemory(owner);
  if (owner) saves.get(owner)?.forEach((listener) => listener());
  if (frame.replayed || !bot || bot.messages?.some((message) => message.id === frame.message!.id)) return;
  listeners.get(bot.id)?.forEach((listener) => listener(frame.message as Message));
}

export function noteMemorySnapshot(): void {
  for (const set of saves.values()) set.forEach((listener) => listener());
}