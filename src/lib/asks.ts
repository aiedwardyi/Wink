import { z } from "zod";

import { latestTaskAsks } from "../../shared/task-ask-list";
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
  kind: z.string().optional(),
}).transform(({ text, ask, at, when, status, ref, kind }) => {
  const out: Ask = { text: (text ?? ask ?? "").trim(), at: at ?? when ?? NaN, status };
  if (ref) out.ref = ref;
  if (kind === "question") out.question = true;
  return out;
}).refine((ask) => ask.text !== "" && Number.isFinite(ask.at));

export interface Ask {
  text: string;
  at: number;
  status: AskStatus;
  ref?: string;
  /** the bot's own question the user skipped, not something they asked for */
  question?: true;
}

const CLOSED: ReadonlySet<AskStatus> = new Set(["done", "declined"]);
export const isClosed = (ask: Ask) => CLOSED.has(ask.status);

/** Every ask in the bot's task records, oldest first; a shared ask keeps its newest record's status. */
export function botAsks(bot: Bot): Ask[] {
  const records = (bot.tasks ?? []).flatMap(({ taskState }) => {
    if (!Array.isArray(taskState?.asks)) return [];
    const asks = taskState.asks.flatMap((raw) => {
      const parsed = Ask.safeParse(raw);
      return parsed.success ? [parsed.data] : [];
    });
    return [{ updatedAt: taskState.updatedAt, asks }];
  });
  return latestTaskAsks(records, (ask) => ask.text);
}

export const askCounts = (asks: readonly Ask[]) => {
  const closed = asks.filter(isClosed).length;
  return { open: asks.length - closed, closed };
};
