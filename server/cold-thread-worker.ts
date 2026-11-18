import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import { threadTailOn, writeRowsOn } from "./message-db.ts";

/** The newest `count` rows, or with `writes` the rows that wrote files. */
export type TailRead = { threadId: string } & ({ count: number } | { writes: true });
export type TailRequest = TailRead & { id: number; file: string };

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
      parentPort!.postMessage({ id, tail: { messages: [], options: [], activeLeafId: null } });
      return;
    }
    if (open?.file !== file) {
      close();
      open = { file, db: new DatabaseSync(file, { readOnly: true }) };
    }
    parentPort!.postMessage({ id, tail: "writes" in request ? { messages: writeRowsOn(open.db, threadId), options: [], activeLeafId: null } : threadTailOn(open.db, threadId, request.count) });
  } catch (error) {
    close();
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
  idle = setImmediate(close);
});
