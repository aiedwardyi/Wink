import { useEffect, useMemo, useSyncExternalStore } from "react";
import { VERIFY_ROUTES, type VerifyCardData } from "../../shared/live-verify";
import { request } from "@/lib/api-request";

const onThisPc = new Map<string, Set<string>>();
const answered = new Map<string, Set<string>>();
const flights = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

const unanswered = (threadId: string, runs: readonly string[]) => runs.filter(run => !answered.get(threadId)?.has(run));

async function ask(threadId: string, runs: readonly string[]): Promise<void> {
  const flight = flights.get(threadId);
  if (flight) return flight.then(() => unanswered(threadId, runs).length ? ask(threadId, runs) : undefined);
  const next = (async () => {
    try {
      const body = await request(VERIFY_ROUTES.replays.replace(":threadId", encodeURIComponent(threadId)));
      if (!Array.isArray(body?.runs)) return;
      onThisPc.set(threadId, new Set<string>(body.runs));
      answered.set(threadId, new Set([...answered.get(threadId) ?? [], ...runs]));
      version++;
      for (const listener of listeners) listener();
    } catch { /* unanswered: the card keeps its replay, as before */ }
  })().finally(() => flights.delete(threadId));
  flights.set(threadId, next);
  return next;
}

/** A card synced from another PC lists replays that are not on this PC: keep only the ones that can play here. One list per chat, asked once for each new run id. */
export function useReplaysHere(card: VerifyCardData | undefined, threadId: string | undefined): VerifyCardData | undefined {
  const seen = useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => version, () => 0);
  const runs = card?.replay;
  const key = runs?.join(" ") ?? "";
  useEffect(() => {
    if (threadId && runs?.length && unanswered(threadId, runs).length) void ask(threadId, runs);
  }, [threadId, key]);
  return useMemo(() => {
    if (!card || !threadId || !runs?.length) return card;
    const here = runs.filter(run => !answered.get(threadId)?.has(run) || onThisPc.get(threadId)?.has(run));
    return here.length === runs.length ? card : { ...card, replay: here };
  }, [card, threadId, seen]);
}
