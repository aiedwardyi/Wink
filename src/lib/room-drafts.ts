import { useSyncExternalStore } from "react";

import { uploadAttachment, type UploadAttachment } from "./composer-attachments";
import { draftRevision } from "./drafts";
import type { RoomProblem } from "./team-rooms";

// File handles survive navigation; after a reload the stored chip needs a re-pick.
const handles = new Map<string, File>();
const sends = new Map<string, { sendId: string; revision: number; sending: boolean }>();
const watchers = new Set<() => void>();
const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};
const publish = () => { for (const watcher of [...watchers]) watcher(); };

export const roomFile = (chipId: string) => handles.get(chipId);

export const dropRoomFile = (chipId: string) => void handles.delete(chipId);

export function holdRoomFiles(picked: readonly File[], replace?: string): UploadAttachment[] {
  if (replace) handles.delete(replace);
  return picked.map((file) => {
    const attachment = uploadAttachment(file);
    handles.set(attachment.id, file);
    return attachment;
  });
}

export function useRoomSending(id: string) {
  return useSyncExternalStore(watch, () => sends.get(id)?.sending ?? false);
}

/** null while a send is already in flight; a retry of an unedited draft reuses its send id. */
export function startRoomSend(id: string, work: (sendId: string) => Promise<RoomProblem | null>) {
  const current = sends.get(id);
  if (current?.sending) return null;
  const revision = draftRevision(id);
  const pending = current?.revision === revision ? current : { sendId: crypto.randomUUID(), revision, sending: false };
  pending.sending = true;
  sends.set(id, pending);
  publish();
  return Promise.resolve().then(() => work(pending.sendId)).then((problem) => {
    if (!problem) sends.delete(id);
    return problem;
  }).finally(() => {
    pending.sending = false;
    publish();
  });
}
