import { useEffect, useMemo, useSyncExternalStore } from "react";
import { VERIFY_ROUTES, type VerifyCardData } from "../../shared/live-verify";
import { request } from "@/lib/api-request";

const onThisPc = new Map<string, Set<string>>();
const listedAt = new Map<string, number>();
const flights = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

async function ask(threadId: string): Promise<void> {
  const flight = flights.get(threadId);
  if (flight) return flight;
  const next = (async () => {
    try {
      const at = Date.now();
      const body = await request(VERIFY_ROUTES.replays.replace(":threadId", encodeURIComponent(threadId)));
      if (!Array.isArray(body?.runs)) return;
      onThisPc.set(threadId, new Set<string>(body.runs));
      listedAt.set(threadId, at);
      version++;
      for (const listener of listeners) listener();
    } catch { /* unanswered: the card keeps its replay, as before */ }
  })().finally(() => flights.delete(threadId));
  flights.set(threadId, next);
  return next;
}

/** A card synced from another PC lists replays that are not on this PC: keep only the ones that can play here. One list per chat, asked once; a card that ended after the list was read is not on it, so it keeps its replay. */
export function useReplaysHere(card: VerifyCardData | undefined, threadId: string | undefined): VerifyCardData | undefined {
  const seen = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => version, () => 0);
  const runs = card?.replay;
  useEffect(() => {
    if (threadId && runs?.length && !listedAt.has(threadId)) void ask(threadId);
  }, [threadId, !!runs?.length]);
  return useMemo(() => {
    const at = threadId ? listedAt.get(threadId) : undefined;
    if (!card || !threadId || !runs?.length || at === undefined || (card.endedAt ?? Infinity) > at) return card;
    const here = runs.filter(run => onThisPc.get(threadId)?.has(run));
    return here.length === runs.length ? card : { ...card, replay: here };
  }, [card, threadId, seen]);
}
