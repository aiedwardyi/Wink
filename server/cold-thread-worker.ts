import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import { newestPaneLines, paneLines, type PaneLine } from "../shared/pane-note.ts";
import { notesSinceOn, openCredentialCardsOn, sendIdsOn, threadRowsOn, threadTailOn, writeRowsOn, type OpenCredentialCard, type SendIdRows, type ThreadRows } from "./message-db.ts";
import type { Message } from "./store.ts";

/** The newest `count` rows, with `writes` the rows that wrote files, with `notesSince` the newest reason lines of the notes since then, with `after` a page of stored rows past that cursor, or with `sendIds` the user rows' sendIds. */
export type TailRead = { openCredentials: true } | ({ threadId: string } & ({ count: number } | { writes: true } | { notesSince: number } | { after: number } | { sendIds: true }));
export type TailRequest = TailRead & { id: number; file: string };
export type TailReply<R extends TailRead> = R extends { notesSince: number } ? PaneLine[]
  : R extends { after: number } ? Array<{ cursor: number; json: string }>
  : R extends { openCredentials: true } ? OpenCredentialCard[]
  : R extends { sendIds: true } ? SendIdRows : ThreadRows & { options: Message[] };

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
  const { id, file } = request;
  clearImmediate(idle);
  try {
    // no messages.db yet: no rows here, so the store answers and imports any legacy file
    if (!existsSync(file)) {
      close();
      parentPort!.postMessage({ id, value: "notesSince" in request || "after" in request || "openCredentials" in request ? [] : "sendIds" in request ? { cursor: 0, rows: [] } : { messages: [], options: [], activeLeafId: null } });
      return;
    }
    if (open?.file !== file) {
      close();
      open = { file, db: new DatabaseSync(file, { readOnly: true }) };
    }
    const value = "openCredentials" in request ? openCredentialCardsOn(open.db)
      : "notesSince" in request ? newestPaneLines(paneLines(notesSinceOn(open.db, request.threadId, request.notesSince), request.notesSince))
      : "writes" in request ? { messages: writeRowsOn(open.db, request.threadId), options: [], activeLeafId: null }
      : "after" in request ? threadRowsOn(open.db, request.threadId, request.after, 1024)
      : "sendIds" in request ? sendIdsOn(open.db, request.threadId) : threadTailOn(open.db, request.threadId, request.count);
    parentPort!.postMessage({ id, value });
  } catch (error) {
    close();
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
  idle = setImmediate(close);
});
