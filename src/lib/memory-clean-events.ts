import type { Message } from "@/state/store";

type Listener = (message?: Message) => void;
const listeners = new Map<string, Set<Listener>>();

export function watchMemoryChange(botId: string, listener: Listener): () => void {
  const set = listeners.get(botId) ?? new Set<Listener>();
  listeners.set(botId, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(botId);
  };
}

export function watchMemoryArrival(botId: string, listener: (message: Message) => void): () => void {
  return watchMemoryChange(botId, (message) => { if (message) listener(message); });
}

export function noteMemoryFrame(frame: { kind: string; botId?: string; threadId?: string; replayed?: boolean; imported?: boolean; message?: { id: string; tool?: { name: string; lines?: readonly string[]; ok?: boolean } } }, state: { hydrated: boolean; bots: readonly { id: string; threadId: string; messages?: readonly { id: string }[] }[] }): void {
  if (!state.hydrated) return;
  if (frame.kind === "memory.changed" && frame.botId !== undefined) {
    listeners.get(frame.botId)?.forEach((listener) => listener());
    return;
  }
  if (frame.kind !== "message" || frame.replayed || frame.imported || frame.message?.tool?.name !== "memory.save" || frame.message.tool.ok === false) return;
  const bot = state.bots.find((bot) => bot.threadId === frame.threadId);
  if (!bot || bot.messages?.some((message) => message.id === frame.message!.id)) return;
  listeners.get(bot.id)?.forEach((listener) => listener(frame.message as Message));
}
