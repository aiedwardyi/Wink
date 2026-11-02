import { useEffect } from "react";
import type { Bot, InstanceInfo } from "@/state/store";
import { shownModelSelection } from "@/state/store-transforms";
import { displayedChipEffort } from "./model-chip";
import { useSkin } from "./skins";

/** Servo's composer gauge reads the open bot's effort from data-hud-effort on the root. */
export function useMonoHud(bot: Bot | undefined, instances: InstanceInfo[]): void {
  const skin = useSkin();
  const on = skin === "mono-hud" || skin === "servo-gray";
  const selection = on && bot ? shownModelSelection(bot) : undefined;
  const effort = selection && displayedChipEffort(instances.find((item) => item.instanceId === selection.instanceId), selection.model, selection.effort);
  useEffect(() => {
    if (!effort) return;
    const root = document.documentElement.dataset;
    root.hudEffort = effort;
    return () => {
      delete root.hudEffort;
    };
  }, [effort]);
}
