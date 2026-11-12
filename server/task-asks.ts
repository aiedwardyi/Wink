import { z } from "zod";

export const ASK_STATUSES = ["open", "building", "waiting-for-user", "done", "declined"] as const;
export const ASK_STALE_MS = 6 * 60 * 60 * 1000;
export const ASK_LIMITS = { ask: 80, ref: 80, kept: 40, update: 20 } as const;
const BRIEF_ASKS = 5;

export const TASK_ASKS_PROMPT =
  "Add each ask the user makes to update_task_state asks in the same turn, and close it as done or declined as soon as it settles; never drop one. Build any summary, status or release from the asks list, not from memory. Never leave work waiting for the user's review without showing it to them.";

export const taskAskSchema = z.object({
  id: z.string().regex(/^A\d{1,6}$/),
  ask: z.string().min(1).max(ASK_LIMITS.ask),
  status: z.enum(ASK_STATUSES),
  ref: z.string().min(1).max(ASK_LIMITS.ref).optional(),
  at: z.number().int().nonnegative(),
  changedAt: z.number().int().nonnegative(),
}).strict();

export type TaskAsk = z.output<typeof taskAskSchema>;

export interface TaskAskUpdate {
  id?: string;
  ask?: string;
  status: TaskAsk["status"];
  ref?: string;
}

const STATUS_TURN = /\b(summar(y|ies|i[sz]e)|recap|status|stand-?up|morning|brief(ing)?|release|progress|catch me up|where (are|were) we|what(['’]?s| is| are) (left|open|pending|next)|to-?dos?|open items)\b|요약|정리|현황|상태|상황|브리핑|아침|릴리[스즈]|남은|어디까지/i;

export const isStatusTurn = (text: string): boolean => STATUS_TURN.test(text);
export const isOpenAsk = (ask: TaskAsk): boolean => ask.status !== "done" && ask.status !== "declined";
const isStale = (ask: TaskAsk, now: number) => isOpenAsk(ask) && now - ask.changedAt >= ASK_STALE_MS;
const words = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** No id adds an ask, an id updates it; closing keeps it, and only the oldest closed asks fall off past the cap. */
export function mergeTaskAsks(
  existing: readonly TaskAsk[] | undefined,
  updates: readonly TaskAskUpdate[],
  now: number,
): { asks: TaskAsk[]; note: string } | { error: string } {
  const asks = (existing ?? []).map((ask) => ({ ...ask }));
  const added: string[] = [];
  let last = Math.max(0, ...asks.map((ask) => Number(ask.id.slice(1))));
  for (const update of updates) {
    const id = update.id?.trim().toUpperCase();
    const text = update.ask?.trim() ?? "";
    const target = id
      ? asks.find((ask) => ask.id === id)
      : text ? asks.find((ask) => isOpenAsk(ask) && words(ask.ask) === words(text)) : undefined;
    if (id && !target) {
      return { error: `Unknown ask id ${id}. Open asks: ${asks.filter(isOpenAsk).map((ask) => ask.id).join(", ") || "none"}.` };
    }
    if (target) {
      if (id && text) target.ask = text;
      target.status = update.status;
      if (update.ref) target.ref = update.ref;
      else if (update.ref !== undefined) delete target.ref;
      target.changedAt = now;
      continue;
    }
    if (!text) return { error: "A new ask needs ask, the user's words in brief; send id to update one." };
    last += 1;
    asks.push({ id: `A${last}`, ask: text, status: update.status, ...(update.ref ? { ref: update.ref } : {}), at: now, changedAt: now });
    added.push(`A${last}`);
  }
  while (asks.length > ASK_LIMITS.kept) {
    const closed = asks.findIndex((ask) => !isOpenAsk(ask));
    if (closed < 0) {
      return { error: `That would leave ${asks.length} asks open; Wink keeps ${ASK_LIMITS.kept}. Close finished ones as done or declined first.` };
    }
    asks.splice(closed, 1);
  }
  return { asks, note: `Asks saved${added.length ? `: added ${added.join(", ")}` : ""}; ${asks.filter(isOpenAsk).length} open.` };
}

function day(at: number): string {
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Open asks, stale first and then oldest: five unless `all`. Empty when none is open. */
export function asksBlock(asks: readonly TaskAsk[] | undefined, now: number, all = false): string {
  const open = (asks ?? []).filter(isOpenAsk);
  if (!open.length) return "";
  const byAge = (left: TaskAsk, right: TaskAsk) => left.at - right.at;
  const stale = open.filter((ask) => isStale(ask, now)).sort(byAge);
  const ordered = [...stale, ...open.filter((ask) => !isStale(ask, now)).sort(byAge)];
  const shown = all ? ordered : ordered.slice(0, BRIEF_ASKS);
  const them = stale.length === 1 ? "it" : "them";
  const flagged = stale.length ? `, ${stale.length} stale: no change in 6+ hours, so raise ${them} with the user now, then update ${them}` : "";
  return [
    `[Wink asks list - ${open.length} open${flagged}.${all ? " Build any summary or status from this list." : ""}]`,
    ...shown.map((ask) => `- ${ask.id} ${ask.status}${isStale(ask, now) ? " stale" : ""} ${day(ask.at)}: ${ask.ask}${ask.ref ? ` (${ask.ref})` : ""}`),
    ...(ordered.length > shown.length ? [`+${ordered.length - shown.length} more open`] : []),
  ].join("\n");
}

/** For a turn the record does not ride: every open ask on a status turn, otherwise only once one went stale. */
export function asksNudge(asks: readonly TaskAsk[] | undefined, now: number, text: string): string {
  if (isStatusTurn(text)) return asksBlock(asks, now, true);
  return (asks ?? []).some((ask) => isStale(ask, now)) ? asksBlock(asks, now) : "";
}
