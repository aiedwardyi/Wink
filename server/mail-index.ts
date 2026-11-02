import { messageDatabase } from "./message-db.ts";
import type { Message, Store, TaskRecord } from "./store.ts";

export function indexMailRow(task: TaskRecord, row: Message): boolean {
  const read = row.comm?.read;
  const pending = Boolean(row.comm?.mailKey && row.comm.peer === "reply")
    && (read?.state !== "read" || (read.upto ?? row.text?.length ?? 0) < (row.text?.length ?? 0));
  const ids = task.mailUnread ?? [];
  if (pending === ids.includes(row.id)) return false;
  task.mailUnread = pending ? [...ids, row.id] : ids.filter((id) => id !== row.id);
  return true;
}

export function rebuildMailIndex(task: TaskRecord, rows: Message[]): void {
  task.mailUnread = [];
  for (const row of rows) indexMailRow(task, row);
}

export function recoverHandedMail(store: Store): void {
  const rows = messageDatabase().prepare("SELECT thread_id, id, json FROM messages WHERE json_extract(json, '$.comm.read.state') = 'handed'").all();
  for (const value of rows) {
    const threadId = String(value.thread_id);
    if (!store.botByThread(threadId) && !store.groupByThread(threadId)) continue;
    const row = JSON.parse(String(value.json)) as Message;
    const read = row.comm?.read;
    if (read?.state !== "handed") continue;
    store.patchMessage(threadId, row.id, { comm: { ...row.comm!, read: read.upto ? { ...read, state: "read" } : undefined } });
  }
}
