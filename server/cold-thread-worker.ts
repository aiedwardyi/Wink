import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import { newestPaneLines, paneLines, type PaneLine } from "../shared/pane-note.ts";
import { notesSinceOn, threadRowsOn, threadTailOn, writeRowsOn, type ThreadRows } from "./message-db.ts";
import type { Message } from "./store.ts";

/** The newest `count` rows, with `writes` the rows that wrote files, with `notesSince` the newest reason lines of the notes since then, or with `after` a page of stored rows past that cursor. */
export type TailRead = { threadId: string } & ({ count: number } | { writes: true } | { notesSince: number } | { after: number });
export type TailRequest = TailRead & { id: number; file: string };
export type TailReply<R extends TailRead> = R extends { notesSince: number } ? PaneLine[]
  : R extends { after: number } ? Array<{ cursor: number; json: string }> : ThreadRows & { options: Message[] };

// one read-only handle per burst of requests: an idle close leaves the file free to be replaced or removed
let open: { file: string; db: DatabaseSync } | undefined;
let idle: NodeJS.Immediate | undefined;

function close(): void {
  try {
    open?.db.close();
  } catch {}
  open = undefined;
}

parentPort!.on("message", (request: TailRequest) => {
  const { id, file, threadId } = request;
  clearImmediate(idle);
  try {
    // no messages.db yet: no rows here, so the store answers and imports any legacy file
    if (!existsSync(file)) {
      close();
      parentPort!.postMessage({ id, value: "notesSince" in request ? [] : "after" in request ? [] : { messages: [], options: [], activeLeafId: null } });
      return;
    }
    if (open?.file !== file) {
      close();
      open = { file, db: new DatabaseSync(file, { readOnly: true }) };
    }
    const value = "notesSince" in request ? newestPaneLines(paneLines(notesSinceOn(open.db, threadId, request.notesSince), request.notesSince))
      : "writes" in request ? { messages: writeRowsOn(open.db, threadId), options: [], activeLeafId: null }
      : "after" in request ? threadRowsOn(open.db, threadId, request.after, 1024) : threadTailOn(open.db, threadId, request.count);
    parentPort!.postMessage({ id, value });
  } catch (error) {
    close();
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
  idle = setImmediate(close);
});
