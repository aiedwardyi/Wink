import type { Message } from "@/state/store";

type Listener = (message: Message) => void;
const listeners = new Map<string, Set<Listener>>();
const saves = new Map<string, Set<Listener>>();

export function watchMemoryArrival(botId: string, listener: Listener): () => void {
  return watch(listeners, botId, listener);
}

export function watchMemorySave(botId: string, listener: Listener): () => void {
  return watch(saves, botId, listener);
}

function watch(registry: Map<string, Set<Listener>>, botId: string, listener: Listener): () => void {
  const set = registry.get(botId) ?? new Set<Listener>();
  registry.set(botId, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) registry.delete(botId);
  };
}

export function noteMemoryFrame(frame: { kind: string; threadId?: string; replayed?: boolean; imported?: boolean; message?: { id: string; tool?: { name: string; lines?: readonly string[]; ok?: boolean; memoryBotId?: string } } }, state: { hydrated: boolean; bots: readonly { id: string; threadId: string; tasks?: readonly { threadId: string }[]; messages?: readonly { id: string }[] }[] }): void {
  if (!state.hydrated || frame.kind !== "message" || frame.imported || frame.message?.tool?.name !== "memory.save" || frame.message.tool.ok === false) return;
  const bot = state.bots.find((bot) => bot.threadId === frame.threadId);
  const owner = frame.message.tool.memoryBotId ?? bot?.id ?? state.bots.find((bot) => bot.tasks?.some((task) => task.threadId === frame.threadId))?.id;
  if (owner) saves.get(owner)?.forEach((listener) => listener(frame.message as Message));
  if (frame.replayed || !bot || bot.messages?.some((message) => message.id === frame.message!.id)) return;
  listeners.get(bot.id)?.forEach((listener) => listener(frame.message as Message));
}
