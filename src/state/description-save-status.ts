import type { BotUpdatePatch } from "./bot-patch-queue";

type Save = "saving" | number;
const saves = new Map<string, Save>();
const listeners = new Map<string, Set<() => void>>();

export function descriptionSaveStatus(botId: string): Save | null {
  return saves.get(botId) ?? null;
}

export function watchDescriptionSaveStatus(botId: string, changed: () => void): () => void {
  const views = listeners.get(botId) ?? new Set();
  listeners.set(botId, views);
  views.add(changed);
  return () => {
    views.delete(changed);
    if (views.size === 0) listeners.delete(botId);
  };
}

export function setDescriptionSaveStatus(botId: string, patch: BotUpdatePatch, status: "saving" | "saved" | "idle", pending: BotUpdatePatch = {}): void {
  if (!Object.hasOwn(patch, "description") || Object.hasOwn(pending, "description")) return;
  if (status === "idle") saves.delete(botId);
  else saves.set(botId, status === "saved" ? Date.now() : status);
  for (const view of listeners.get(botId) ?? []) view();
}
