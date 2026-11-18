import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "node:worker_threads";

import type { BootReadInput, BootRows } from "./boot-reads.ts";
import { threadTailOn, type ThreadRows } from "./message-db.ts";
import type { Message } from "./store.ts";

export type Tail = ThreadRows & { options: Message[] };
export type ReadRequest = { kind: "tail"; file: string; threadId: string; count: number } | { kind: "boot"; input: BootReadInput };
export type ReadReply = { id: number } & ({ tail: Tail } | { rows: BootRows } | { error: string });

const port = parentPort!;

// one read-only handle per burst of requests: an idle close leaves the file free to be replaced or removed
let open: { file: string; db: DatabaseSync } | undefined;
let idle: NodeJS.Immediate | undefined;

function close(): void {
  try {
    open?.db.close();
  } catch {}
  open = undefined;
}

function readTail({ file, threadId, count }: Extract<ReadRequest, { kind: "tail" }>): Tail {
  // no messages.db yet: no rows here, so the store answers and imports any legacy file
  if (!existsSync(file)) {
    close();
    return { messages: [], options: [], activeLeafId: null };
  }
  if (open?.file !== file) {
    close();
    open = { file, db: new DatabaseSync(file, { readOnly: true }) };
  }
  return threadTailOn(open.db, threadId, count);
}

port.on("message", async (message: { id: number; request: ReadRequest } | null) => {
  if (message === null) {
    clearImmediate(idle);
    close();
    port.close();
    return;
  }
  const { id, request } = message;
  try {
    if (request.kind === "boot") {
      // Keep the boot finders' imports off the first cold page path.
      const { findBootRows } = await import("./boot-reads.ts");
      port.postMessage({ id, rows: findBootRows(request.input) } satisfies ReadReply);
      return;
    }
    clearImmediate(idle);
    port.postMessage({ id, tail: readTail(request) } satisfies ReadReply);
    idle = setImmediate(close);
  } catch (error) {
    close();
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies ReadReply);
  }
});
