import { useEffect, useState } from "react";

import { api } from "@/state/store";

export const FIRST_SYNC_POLL_MS = 5000;

type Status = { firstSync?: true; finishing?: true; progress: { done: number; total: number } | null };
export type FirstSync = { done: number; total: number } | "finishing" | null;

let current: FirstSync = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let asking = false;
const listeners = new Set<(sync: FirstSync) => void>();

export function firstSyncOf(body: Status | null): FirstSync {
  if (!body?.firstSync) return null;
  const progress = body.progress;
  return body.finishing || !progress || progress.done >= progress.total ? "finishing" : progress;
}

function check(): void {
  if (asking || !listeners.size) return;
  asking = true;
  clearTimeout(timer);
  api("/api/google-sync")
    .then((body: Status) => {
      current = firstSyncOf(body);
      for (const listener of listeners) listener(current);
      if (current) timer = setTimeout(check, FIRST_SYNC_POLL_MS);
    })
    .catch(() => {})
    .finally(() => { asking = false; });
}

/** This PC's first sync with its other PCs; one shared poll that runs only while it does. */
export function useFirstSync(recheck: string): FirstSync {
  const [sync, setSync] = useState(current);
  useEffect(() => {
    listeners.add(setSync);
    return () => { listeners.delete(setSync); };
  }, []);
  useEffect(check, [recheck]);
  return sync;
}

/** The poll files the open chat's bot next, so an empty chat tells the server it is open. */
export function useOpenWhileSyncing(threadId: string, syncing: boolean): void {
  useEffect(() => {
    if (syncing) void api(`/api/threads/${encodeURIComponent(threadId)}/messages?limit=0`).catch(() => {});
  }, [threadId, syncing]);
}
