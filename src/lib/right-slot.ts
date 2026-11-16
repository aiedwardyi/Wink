import { useLayoutEffect, useRef } from "react";

/** The pane (Show, Check, Media), Bot Details and the Inspector share one right slot. */
export type SlotPanel = "show" | "details" | "inspector";

/** Every open panel but the one that just opened. */
export function slotEvictions(was: readonly SlotPanel[], now: readonly SlotPanel[]): SlotPanel[] {
  const fresh = now.find((panel) => !was.includes(panel));
  return fresh ? now.filter((panel) => panel !== fresh) : [];
}

// a layout effect, so both panels never paint side by side for a frame
export function useRightSlot(open: readonly SlotPanel[], close: (panel: SlotPanel) => void) {
  const was = useRef(open);
  useLayoutEffect(() => {
    for (const panel of slotEvictions(was.current, open)) close(panel);
    was.current = open;
  });
}
