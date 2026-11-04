import { useEffect, useRef, useSyncExternalStore } from "react";
import { api, useStore } from "@/state/store";
import { connectUsageBoard, invalidateUsageBoard, subscribeUsageBoard, usageBoardState } from "./usage-board-client";

connectUsageBoard(api);

/** The cached board at once; reads happen behind it and never gate paint. */
export function useUsageBoard() {
  const { state } = useStore();
  const panes = useRef(state.terminalPanes);
  useEffect(() => {
    if (panes.current === state.terminalPanes) return;
    panes.current = state.terminalPanes;
    invalidateUsageBoard();
  }, [state.terminalPanes]);
  return useSyncExternalStore(subscribeUsageBoard, usageBoardState, usageBoardState);
}
