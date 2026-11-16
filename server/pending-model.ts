// A model picked mid-reply waits for the turn to end: stop, approvals and
// steers must keep reaching the engine that is running it.
import type { ModelSelection } from "./contracts.ts";
import { sameModelSelection } from "../shared/model-selection.ts";

export interface PendingModelBot {
  modelSelection: ModelSelection;
  pendingModelSelection?: ModelSelection;
  busy?: boolean;
}

/** Bot fields a model pick writes: busy holds it, idle applies it. */
export function modelPickPatch(
  bot: PendingModelBot,
  selection: ModelSelection,
): Partial<Pick<PendingModelBot, "modelSelection" | "pendingModelSelection">> {
  if (!bot.busy) return { modelSelection: selection, pendingModelSelection: undefined };
  return { pendingModelSelection: sameModelSelection(bot.modelSelection, selection) ? undefined : selection };
}

/** Moves a held pick onto an idle bot; true when it did. */
export function applyPendingModel(bot: PendingModelBot): boolean {
  if (bot.busy || !bot.pendingModelSelection) return false;
  bot.modelSelection = bot.pendingModelSelection;
  delete bot.pendingModelSelection;
  return true;
}

/** A held engine or model pick: the turn running now is not the one the chip shows. Effort alone is no switch. */
export function switchHeld(bot: Pick<PendingModelBot, "modelSelection" | "pendingModelSelection">): boolean {
  const next = bot.pendingModelSelection;
  if (!next) return false;
  const running = bot.modelSelection;
  return next.instanceId !== running.instanceId || next.model !== running.model || (next.mode ?? "pinned") !== (running.mode ?? "pinned");
}
