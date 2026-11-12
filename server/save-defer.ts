// Keeps store saves off the reply path: a turn's last frame leaves first, and
// the bookkeeping saves behind it share one write per tick.
import type { ServerResponse } from "node:http";

/** `soon` owes one write this tick, `now` writes at once and throws, `flush` writes what `soon` still owes. */
export function coalescedSave(write: () => void) {
  let due: NodeJS.Immediate | null = null;
  let owed = false;
  const now = () => {
    if (due) clearImmediate(due);
    due = null;
    write();
    owed = false;
  };
  const flush = () => {
    if (!owed) return;
    try {
      now();
    } catch (error) {
      console.error("store: save failed, the next one retries", error);
    }
  };
  return {
    soon() {
      owed = true;
      due ??= setImmediate(flush);
    },
    now,
    flush,
  };
}

/** http holds a response write until the next tick; this sends it before the caller's next line. */
export function sendNow(res: ServerResponse): void {
  res.socket?.uncork();
}
