// The rows a linked-file request checks, read by the file's name: an image in a 237k-row chat loaded all of it (952 ms, 146 MB kept).
import type { LinkedMessage } from "./linked-files.ts";
import { storedHead, textRows } from "./message-db.ts";
import type { Message, Store } from "./store.ts";

const MEMO = 200;

/** The longest run of the file's name that no link form, tag or escape rewrites, so every message naming the file contains it. */
export function nameRun(target: string): string {
  const name = target.split(/[\\/]/).pop() ?? "";
  return (name.match(/[A-Za-z0-9._~-]+/g) ?? []).reduce((longest, run) => (run.length > longest.length ? run : longest), "");
}

function* fromThread(messages: readonly Message[]): Iterable<LinkedMessage> {
  for (const message of messages) yield { id: message.id, role: message.role, text: message.text, fromBotId: message.from?.botId };
}

/** Messages that may link `target`: the loaded thread's rows, else the stored rows naming it, kept until the thread changes. */
export function linkedRows(store: Pick<Store, "loaded" | "messagesFor" | "onChange">): (threadId: string, target: string) => Iterable<LinkedMessage> {
  const memo = new Map<string, LinkedMessage[]>();
  store.onChange((change) => {
    // room imports write their rows outside the store and announce only the room
    if (change.type === "group" || change.type === "group.deleted") memo.clear();
    else if ("threadId" in change) for (const key of memo.keys()) if (key.startsWith(`${change.threadId}\n`)) memo.delete(key);
  });
  return (threadId, target) => {
    // no stored rows: the store imports a legacy file on read
    if (store.loaded(threadId) || storedHead(threadId) === undefined) return fromThread(store.messagesFor(threadId));
    const needle = nameRun(target);
    const key = `${threadId}\n${needle}`;
    let rows = memo.get(key);
    if (!rows) {
      rows = textRows(threadId, needle).map((row) => ({ id: row.id, role: row.role, text: row.text, fromBotId: row.fromBotId ?? undefined }));
      if (memo.size >= MEMO) memo.delete(memo.keys().next().value!);
      memo.set(key, rows);
    }
    return rows;
  };
}
