import { useEffect, useRef, useSyncExternalStore } from "react";
import { api, useStore } from "@/state/store";
import { connectUsageBoard, invalidateUsageBoard, subscribeUsageBoard, usageBoardState } from "./usage-board-client";

connectUsageBoard(api);

/** Workers follow the pane labels; the 15 s pane poll hands over equal copies that must not re-read the board. */
function panesKey(panes: Record<string, string[]> = {}) {
  return Object.keys(panes).sort().map((bot) => `${bot}\u0000${panes[bot].join("\u0001")}`).join("\u0002");
}

// The last pane contents any caller has seen, so one change invalidates once however many lines and desks read the board.
let seenPanes = "";

/** The cached board at once; reads happen behind it and never gate paint. */
export function useUsageBoard() {
  const { state } = useStore();
  const key = panesKey(state.terminalPanes);
  const panes = useRef(key);
  useEffect(() => {
    if (panes.current === key) { seenPanes = key; return; }
    panes.current = key;
    if (seenPanes === key) return;
    seenPanes = key;
    invalidateUsageBoard();
  }, [key]);
  return useSyncExternalStore(subscribeUsageBoard, usageBoardState, usageBoardState);
}
