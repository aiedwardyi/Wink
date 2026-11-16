import { useEffect, useState } from "react";

import { request } from "./api-request";
import { useChatPreview } from "./chat-preview";

export function useRoomFilesState(base: string) {
  const preview = useChatPreview();
  const [state, setState] = useState<{ deleted: string[]; error: string | null }>({ deleted: [], error: null });
  useEffect(() => {
    setState({ deleted: [], error: null });
    if (preview || !base.startsWith("/api/rooms/")) return;
    let alive = true;
    const refresh = () => request(`${base}/files-state`).then((next) => {
      if (alive) setState(next);
    }, () => {});
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [base, preview]);
  return state;
}
