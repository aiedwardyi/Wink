import type { Message, TaskRecord } from "./store.ts";

export function indexMailRow(task: TaskRecord, row: Message): boolean {
  const read = row.comm?.read;
  const pending = read?.state !== "read" || (read.upto ?? row.text?.length ?? 0) < (row.text?.length ?? 0);
  const ids = task.mailUnread ?? [];
  if (pending === ids.includes(row.id)) return false;
  task.mailUnread = pending ? [...ids, row.id] : ids.filter((id) => id !== row.id);
  return true;
}
