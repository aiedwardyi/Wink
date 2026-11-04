import type { Message } from "@/state/store";

type Listener = (message: Message) => void;
const listeners = new Map<string, Set<Listener>>();

export function watchMemoryArrival(botId: string, listener: Listener): () => void {
  const set = listeners.get(botId) ?? new Set<Listener>();
  listeners.set(botId, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(botId);
  };
}

export function noteMemoryFrame(frame: { kind: string; threadId?: string; replayed?: boolean; imported?: boolean; message?: { id: string; tool?: { name: string; lines?: readonly string[]; ok?: boolean } } }, state: { hydrated: boolean; bots: readonly { id: string; threadId: string; messages?: readonly { id: string }[] }[] }): void {
  if (!state.hydrated || frame.kind !== "message" || frame.replayed || frame.imported || frame.message?.tool?.name !== "memory.save" || frame.message.tool.ok === false) return;
  const bot = state.bots.find((bot) => bot.threadId === frame.threadId);
  if (!bot || bot.messages?.some((message) => message.id === frame.message!.id)) return;
  listeners.get(bot.id)?.forEach((listener) => listener(frame.message as Message));
}
