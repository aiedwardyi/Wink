// pin_goal's route: a goal rides in every prompt, so only the owner's own chat, mid-turn, may set or finish one.
import type { IncomingMessage, ServerResponse } from "node:http";

import { json, readBody } from "./http-helpers.ts";
import { maskSecretValues } from "./memory-pass.ts";
import { GOAL_MAX } from "./picks.ts";
import { pinGoal } from "./workspace.ts";

type Caller = { botId: string; threadId: string };
const MASK = /«redacted \d+ chars»/g;
const masks = (text: string) => text.match(MASK)?.length ?? 0;
export type GoalDeps = {
  caller: (header: string | string[] | undefined) => Caller | undefined;
  /** the user's own chat with this bot, its turn still running: a token outlives its turn */
  ownerTurn: (caller: Caller) => boolean;
};

export async function goalRoute(req: IncomingMessage, res: ServerResponse, deps: GoalDeps): Promise<void> {
  const source = deps.caller(req.headers.authorization);
  if (!source) return json(res, 403, { error: "unknown sender" });
  // a room holds other people's words: a teammate or guest must not set the owner's goals
  if (!deps.ownerTurn(source)) return json(res, 403, { error: "pin_goal works only in the user's own chat with you" });
  const body = await readBody(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  const done = body.done === true;
  if (!name || (!done && !goal)) return json(res, 400, { error: "pin_goal needs name, and goal unless done is true." });
  if (!done && goal.length > GOAL_MAX) {
    return json(res, 400, { error: `The goal is ${goal.length} characters, over ${GOAL_MAX}. Pin the spec in the user's words in under ${GOAL_MAX}, and keep the rest in a memory/ side file.` });
  }
  const safeName = maskSecretValues(name);
  const safeGoal = maskSecretValues(goal);
  if (!done && !/[\p{L}\p{N}]/u.test(safeGoal.replace(MASK, ""))) {
    return json(res, 400, { error: "The goal is only key-shaped text. A key never goes in a goal; pin what the user wants done, in their words." });
  }
  const masked = masks(safeName) + masks(safeGoal) - masks(name) - masks(goal);
  const text = pinGoal(source.botId, { name: safeName, goal: safeGoal, done });
  return json(res, 200, { text: masked ? `${text} ${masked} part(s) masked as key-shaped.` : text });
}
