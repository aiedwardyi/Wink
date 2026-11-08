import { startTransition, useEffect, useState } from "react";
import type { Bot } from "@/state/store";
import { currentTask } from "./MemoryGroups";

/** Counts up to `last` one transition per commit, so the map paints in parts after the tab's first frame. */
export function useStage(last: number, now = false): number {
  const [stage, setStage] = useState(now ? last : 0);
  useEffect(() => {
    if (stage < last) startTransition(() => setStage(stage + 1));
  }, [stage]);
  return stage;
}

// the stacked Live card's height before its text lands, from the MemoryMap.css line heights
export function liveHeight(bot: Bot, learned: number) {
  const task = currentTask(bot);
  const working = task ? 34 + 19 + (task.plan.length ? 38 : 0) + (task.nextAction.trim() ? 24 : 0) : 26;
  return 34 + 14 + 16 + 20 + working + 16 + 20 + (learned ? 6 + learned * 33 - 1 : 26);
}
