import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { api, useStore } from "@/state/store";
import { connectUsageBoard, invalidateUsageBoard, subscribeUsageBoard, usageBoardInstances, usageBoardState } from "./usage-board-client";
import { useChatPreview } from "./chat-preview";

connectUsageBoard(api);

/** Workers follow the pane labels; the 15 s pane poll hands over equal copies that must not re-read the board. */
function panesKey(panes: Record<string, string[]> = {}) {
  return Object.keys(panes).sort().map((bot) => `${bot}\u0000${panes[bot].join("\u0001")}`).join("\u0002");
}

// The last pane contents any caller has seen, so one change invalidates once however many lines and desks read the board.
let seenPanes = "";
// The same for sign-ins: a login another client replaced or saw expire reaches the engine rows this client draws.
let seenSignIns: string | null = null;
const cachedBoard = () => () => {};

/** The cached board at once; reads happen behind it and never gate paint. */
export function useUsageBoard() {
  const preview = useChatPreview();
  const { state, refreshInstances } = useStore();
  useLayoutEffect(() => { if (!preview) usageBoardInstances(state.instances); }, [state.instances, preview]);
  const key = panesKey(state.terminalPanes);
  const panes = useRef(key);
  useEffect(() => {
    if (preview) return;
    if (panes.current === key) { seenPanes = key; return; }
    panes.current = key;
    if (seenPanes === key) return;
    seenPanes = key;
    invalidateUsageBoard();
  }, [key, preview]);
  const board = useSyncExternalStore(preview ? cachedBoard : subscribeUsageBoard, usageBoardState, usageBoardState);
  const signIns = board.board?.engines.flatMap((engine) => engine.accounts.map((account) => `${account.id}\u0000${account.signIn}`)).join("\u0001") ?? null;
  useEffect(() => {
    if (preview || signIns === null || seenSignIns === signIns) return;
    const changed = seenSignIns !== null;
    seenSignIns = signIns;
    if (changed) void refreshInstances();
  }, [signIns, preview, refreshInstances]);
  return board;
}
