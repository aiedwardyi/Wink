import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import { newestPaneLines, paneLines, type PaneLine } from "../shared/pane-note.ts";
import { newestStampOn, notesSinceOn, openCredentialCardsOn, quickAsksOn, searchMessagesOn, sendIdsOn, threadPageBeforeOn, threadRowsOn, threadTailOn, writeRowsOn, type FindPlace, type OpenCredentialCard, type SearchHit, type SendIdRows, type ThreadRows } from "./message-db.ts";
import type { Message } from "./store.ts";

/** In-chat find: searchMessages' arguments for one chat, `skip` as a list. */
export type FindRead = { query: string; limit: number; before?: string; place?: FindPlace; chips?: boolean; skip: string[] };

/** The newest `count` rows (before the rowid `before` when given), with `writes` the rows that wrote files, with `notesSince` the newest reason lines of the notes since then, with `after` a page of stored rows past that cursor, with `sendIds` the user rows' sendIds, with `newest` the stamp a send is clocked past, with `asks` its open quick asks, with `find` a page of an in-chat find, or with `openCredentials` every unanswered key card. */
export type TailRead = { openCredentials: true } | ({ threadId: string } & ({ count: number; before?: number } | { writes: true } | { notesSince: number } | { after: number } | { sendIds: true } | { newest: true } | { asks: true } | { find: FindRead }));
export type TailRequest = TailRead & { id: number; file: string };
export type TailReply<R extends TailRead> = R extends { notesSince: number } ? PaneLine[]
  : R extends { after: number } ? Array<{ cursor: number; json: string }>
  : R extends { openCredentials: true } ? OpenCredentialCard[]
  : R extends { sendIds: true } ? SendIdRows
  : R extends { newest: true } ? number
  : R extends { asks: true } ? Array<{ id: string; at: number }>
  : R extends { find: FindRead } ? SearchHit[] : ThreadRows & { options: Message[] };

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
      parentPort!.postMessage({ id, value: "notesSince" in request ? [] : "after" in request ? [] : "sendIds" in request ? { cursor: 0, rows: [] } : "newest" in request ? 0 : "asks" in request ? [] : "find" in request || "openCredentials" in request ? [] : { messages: [], options: [], activeLeafId: null } });
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
      : "sendIds" in request ? sendIdsOn(open.db, request.threadId)
      : "newest" in request ? newestStampOn(open.db, request.threadId)
      : "asks" in request ? quickAsksOn(open.db, request.threadId)
      : "find" in request ? searchMessagesOn(open.db, request.find.query, request.find.limit, request.threadId, { before: request.find.before, place: request.find.place, chips: request.find.chips, skip: new Set(request.find.skip) })
      : request.before !== undefined ? threadPageBeforeOn(open.db, request.threadId, request.before, request.count) : threadTailOn(open.db, request.threadId, request.count);
    parentPort!.postMessage({ id, value });
  } catch (error) {
    close();
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
  idle = setImmediate(close);
});
