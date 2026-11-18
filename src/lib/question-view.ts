import { useSyncExternalStore } from "react";

type Flag = "row" | "shrunk" | "hidden" | "glowed";
type Pick = { id: string; newest: string };
type View = Partial<Record<Flag, boolean>>;
const KEY = "wink.question-view";
const flags = new Map<string, View>();
const picks = new Map<string, Pick>();
const watchers = new Set<() => void>();

try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  for (const [id, value] of Object.entries(saved.flags ?? {})) {
    if (!value || typeof value !== "object") continue;
    const view: View = {};
    for (const flag of ["row", "shrunk", "hidden", "glowed"] as const) {
      if ((value as View)[flag] === true) view[flag] = true;
    }
    flags.set(id, view);
  }
  for (const [thread, value] of Object.entries(saved.picks ?? {})) {
    const pick = value as Pick | null;
    if (pick && typeof pick.id === "string" && typeof pick.newest === "string") picks.set(thread, pick);
  }
} catch { /* unavailable or older storage */ }

function publish() {
  try { localStorage.setItem(KEY, JSON.stringify({ flags: Object.fromEntries(flags), picks: Object.fromEntries(picks) })); }
  catch { /* the view still survives task switches */ }
  for (const notify of watchers) notify();
}

function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

export const questionFlag = (id: string, flag: Flag) => flags.get(id)?.[flag] === true;
export const useQuestionFlag = (id: string, flag: Flag) => useSyncExternalStore(subscribe, () => questionFlag(id, flag), () => false);

export function markQuestion(id: string, flag: Flag, value: boolean) {
  if (questionFlag(id, flag) === value) return;
  flags.set(id, { ...flags.get(id), [flag]: value });
  publish();
}

export function foldQuestion(id: string) {
  flags.set(id, { ...flags.get(id), shrunk: true, row: true });
  publish();
}

export function carryQuestionFold(from: string, to: string) {
  flags.set(to, { ...flags.get(to), glowed: true, shrunk: questionFlag(from, "shrunk"), row: questionFlag(from, "row") });
  publish();
}

export function useQuestionPick(threadId: string | undefined): Pick | null {
  return useSyncExternalStore(subscribe, () => picks.get(threadId ?? "") ?? null, () => null);
}

export function pickQuestion(threadId: string | undefined, pick: Pick) {
  if (!threadId) return;
  picks.set(threadId, pick);
  publish();
}
