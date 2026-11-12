import { z } from "zod";

import type { Bot } from "@/state/store";

export const ASK_STATUSES = ["open", "building", "waiting-for-user", "done", "declined"] as const;
export type AskStatus = (typeof ASK_STATUSES)[number];

// the tool's shape may still name these ask/when or underscore a status
const Ask = z.object({
  text: z.string().optional(),
  ask: z.string().optional(),
  at: z.union([z.number(), z.string().transform(Date.parse)]).optional(),
  when: z.union([z.number(), z.string().transform(Date.parse)]).optional(),
  status: z.string().transform((status) => status.replace(/_/g, "-")).pipe(z.enum(ASK_STATUSES)),
  ref: z.string().optional(),
}).transform(({ text, ask, at, when, status, ref }) => {
  const out: Ask = { text: (text ?? ask ?? "").trim(), at: at ?? when ?? NaN, status };
  if (ref) out.ref = ref;
  return out;
}).refine((ask) => ask.text !== "" && Number.isFinite(ask.at));

export interface Ask {
  text: string;
  at: number;
  status: AskStatus;
  ref?: string;
}

const CLOSED: ReadonlySet<AskStatus> = new Set(["done", "declined"]);
export const isClosed = (ask: Ask) => CLOSED.has(ask.status);

/** Every ask in the bot's task records, oldest first; a shared ask keeps its newest record's status. */
export function botAsks(bot: Bot): Ask[] {
  const records = (bot.tasks ?? []).flatMap((task) => (task.taskState ? [task.taskState] : [])).sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  const asks = new Map<string, Ask>();
  for (const record of records) {
    if (!Array.isArray(record.asks)) continue;
    for (const raw of record.asks) {
      const parsed = Ask.safeParse(raw);
      if (parsed.success) asks.set(`${parsed.data.at}\0${parsed.data.text}`, parsed.data);
    }
  }
  return [...asks.values()].sort((a, b) => a.at - b.at);
}

export const askCounts = (asks: readonly Ask[]) => {
  const closed = asks.filter(isClosed).length;
  return { open: asks.length - closed, closed };
};
