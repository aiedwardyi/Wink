// The rows a linked-file request checks, read by the file's name: an image in a 237k-row chat loaded all of it (952 ms, 146 MB kept).
import type { LinkedMessage } from "./linked-files.ts";
import { storedHead, textRows } from "./message-db.ts";
import type { Message, Store } from "./store.ts";

/** Text kept across memoized lookups; a lookup over it is read again next time instead. */
const MEMO_CHARS = 4_000_000;

/** The longest run of the file's name that no link form, tag or escape rewrites, so every message naming the file contains it. */
export function nameRun(target: string): string {
  const name = target.split(/[\\/]/).pop() ?? "";
  return (name.match(/[A-Za-z0-9._~-]+/g) ?? []).reduce((longest, run) => (run.length > longest.length ? run : longest), "");
}

function* fromThread(messages: readonly Message[]): Iterable<LinkedMessage> {
  for (const message of messages) yield { id: message.id, role: message.role, text: message.text, fromBotId: message.from?.botId };
}

/** Messages that may link `target`: the loaded thread's rows, else the stored rows naming it, kept until the thread changes. */
export function linkedRows(store: Pick<Store, "loaded" | "messagesFor" | "onChange" | "group">): (threadId: string, target: string) => Iterable<LinkedMessage> {
  const memo = new Map<string, { rows: LinkedMessage[]; chars: number }>();
  let kept = 0;
  const drop = (key: string) => {
    kept -= memo.get(key)?.chars ?? 0;
    memo.delete(key);
  };
  const forget = (threadId: string) => {
    for (const key of memo.keys()) if (key.startsWith(`${threadId}\n`)) drop(key);
  };
  store.onChange((change) => {
    // room imports write their rows outside the store and announce only the room
    if (change.type === "group") {
      const room = store.group(change.groupId);
      if (room) forget(room.threadId);
    } else if ("threadId" in change) forget(change.threadId);
  });
  return (threadId, target) => {
    const needle = nameRun(target);
    const key = `${threadId}\n${needle}`;
    const hit = memo.get(key);
    if (hit) return hit.rows;
    // no stored rows: the store imports a legacy file on read
    if (store.loaded(threadId) || storedHead(threadId) === undefined) return fromThread(store.messagesFor(threadId));
    const rows = textRows(threadId, needle).map((row) => ({ id: row.id, role: row.role, text: row.text, fromBotId: row.fromBotId ?? undefined }));
    const chars = rows.reduce((sum, row) => sum + row.text.length, 0);
    if (chars > MEMO_CHARS) return rows;
    while (kept + chars > MEMO_CHARS) drop(memo.keys().next().value!);
    memo.set(key, { rows, chars });
    kept += chars;
    return rows;
  };
}
