// The rows a linked-file request checks: only a row with link syntax can link a file, and the 237k-row Wink chat has 521 (loading all of it took 952 ms and kept 146 MB).
import type { LinkedMessage } from "./linked-files.ts";
import { linkRows, storedHead } from "./message-db.ts";
import type { Message, Store } from "./store.ts";

/** Every form linkingMessages reads a link from: markdown links and images, reference definitions, file: autolinks, attached-file tags. */
export const LINK_MARKS = ["](", "]:", "<file:", "<attached-file"] as const;
/** Link-row text kept across chats; a chat with more is read again on each request instead. */
const MEMO_CHARS = 4_000_000;

/** Matches what the SQL LIKE in linkRows keeps (ASCII case-insensitive). */
export function linkish(text: string): boolean {
  const lower = text.toLowerCase();
  return LINK_MARKS.some((mark) => lower.includes(mark));
}

const linked = (message: Message): LinkedMessage => ({ id: message.id, role: message.role, text: message.text, fromBotId: message.from?.botId });

function* fromThread(messages: readonly Message[]): Iterable<LinkedMessage> {
  for (const message of messages) yield linked(message);
}

type Kept = { rows: LinkedMessage[]; chars: number };

/** Messages that may link a file: the loaded thread's rows, else its stored link rows, kept and updated as rows arrive; one read answers every file in the chat. */
export function linkedRows(store: Pick<Store, "loaded" | "messagesFor" | "onChange" | "group">): (threadId: string, target: string) => Iterable<LinkedMessage> {
  const memo = new Map<string, Kept>();
  let total = 0;
  const drop = (threadId: string) => {
    total -= memo.get(threadId)?.chars ?? 0;
    memo.delete(threadId);
  };
  const fit = () => {
    while (total > MEMO_CHARS && memo.size) drop(memo.keys().next().value!);
  };
  store.onChange((change) => {
    if (change.type === "message" || change.type === "message.patch") {
      const kept = memo.get(change.threadId);
      if (!kept) return;
      const at = kept.rows.findIndex((row) => row.id === change.message.id);
      const text = change.message.text ?? "";
      const keep = linkish(text);
      // a patch that adds a link mid-thread would sit out of order; read the chat again instead
      if (at < 0 && keep && change.type === "message.patch") return drop(change.threadId);
      const before = at < 0 ? 0 : (kept.rows[at]!.text ?? "").length;
      if (at >= 0 && keep) kept.rows[at] = linked(change.message);
      else if (at >= 0) kept.rows.splice(at, 1);
      else if (keep) kept.rows.push(linked(change.message));
      const delta = (keep ? text.length : 0) - before;
      kept.chars += delta;
      total += delta;
      fit();
    } else if (change.type === "group") {
      // room imports write their rows outside the store and announce only the room
      const room = store.group(change.groupId);
      if (room) drop(room.threadId);
    } else if ("threadId" in change && change.type !== "task.packet") drop(change.threadId);
  });
  return (threadId) => {
    const hit = memo.get(threadId);
    if (hit) return hit.rows;
    // no stored rows: the store imports a legacy file on read
    if (store.loaded(threadId) || storedHead(threadId) === undefined) return fromThread(store.messagesFor(threadId));
    const rows = linkRows(threadId, LINK_MARKS).map((row) => ({ id: row.id, role: row.role, text: row.text, fromBotId: row.fromBotId ?? undefined }));
    const chars = rows.reduce((sum, row) => sum + row.text.length, 0);
    if (chars > MEMO_CHARS) return rows;
    memo.set(threadId, { rows, chars });
    total += chars;
    fit();
    return rows;
  };
}
