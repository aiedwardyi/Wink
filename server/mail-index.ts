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

/** Mail a dead turn was handed goes back to unread; `rows` come from boot-reads.ts and are read again by key. */
export function recoverHandedMail(store: Pick<Store, "botByThread" | "groupByThread" | "row" | "patchRow">, rows: Array<{ threadId: string; id: string }>): void {
  for (const { threadId, id } of rows) {
    if (!store.botByThread(threadId) && !store.groupByThread(threadId)) continue;
    const row = store.row(threadId, id);
    const read = row?.comm?.read;
    if (read?.state !== "handed") continue;
    store.patchRow(threadId, id, { comm: { ...row!.comm!, read: read.upto ? { ...read, state: "read" } : undefined } });
  }
}
