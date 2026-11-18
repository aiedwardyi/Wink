import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import { threadTailOn } from "./message-db.ts";

export interface TailRequest {
  id: number;
  file: string;
  threadId: string;
  count: number;
}

// one read-only handle per burst of requests: an idle close leaves the file free to be replaced or removed
let open: { file: string; db: DatabaseSync } | undefined;
let idle: NodeJS.Immediate | undefined;

function close(): void {
  try {
    open?.db.close();
  } catch {}
  open = undefined;
}

parentPort!.on("message", ({ id, file, threadId, count }: TailRequest) => {
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
    parentPort!.postMessage({ id, tail: threadTailOn(open.db, threadId, count) });
  } catch (error) {
    close();
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
  idle = setImmediate(close);
});
