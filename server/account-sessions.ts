import type { BotRecord } from "./store.ts";

export function clearAccountSessions(bots: BotRecord[], instanceId: string): string[] {
  const changed: string[] = [];
  for (const bot of bots) {
    let touched = Object.hasOwn(bot.resumeCursors, instanceId);
    delete bot.resumeCursors[instanceId];
    for (const task of bot.tasks ?? []) {
      const cursor = task.resumeCursors[instanceId];
      if (Object.hasOwn(task.resumeCursors, instanceId)) { delete task.resumeCursors[instanceId]; touched = true; }
      if (task.resumeSeed?.instanceId === instanceId) { delete task.resumeSeed; touched = true; }
      if (task.lastInstanceId === instanceId || (task.lastInstanceId === undefined && cursor !== undefined && task.nativePrompt?.cursor === cursor)) {
        delete task.nativePrompt;
        if (task.usage) delete task.usage.lastInput;
        touched = true;
      }
    }
    if (touched) changed.push(bot.id);
  }
  return changed;
}
