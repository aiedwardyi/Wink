import { useSyncExternalStore } from "react";

import { uploadAttachment, type UploadAttachment } from "./composer-attachments";
import { draftRevision, markDraftEdited, restoreComposerDraft, useComposerDraft } from "./drafts";
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

export function useRoomDraft(id: string) {
  const [text, setText, attachments, setAttachments] = useComposerDraft(id);
  const sending = useSyncExternalStore(watch, () => sends.get(id)?.sending ?? false);
  const startSend = (work: (sendId: string) => Promise<RoomProblem | null>) => {
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
  };
  const files = attachments.filter((a): a is UploadAttachment => a.kind === "upload");
  const keepFiles = (picked: File[], replace?: string) => {
    markDraftEdited(id);
    const next = picked.map((file) => {
      const attachment = uploadAttachment(file);
      handles.set(attachment.id, file);
      return attachment;
    });
    if (replace) handles.delete(replace);
    setAttachments([...files.filter((file) => file.id !== replace), ...next]);
  };
  const removeFile = (chipId: string) => {
    markDraftEdited(id);
    handles.delete(chipId);
    setAttachments(files.filter((file) => file.id !== chipId));
  };
  const clear = () => {
    for (const file of files) handles.delete(file.id);
    restoreComposerDraft(id, { text: "", attachments: [] });
  };
  const editText = (next: string) => {
    markDraftEdited(id);
    setText(next);
  };
  return { text, setText: editText, files: files.map((file) => ({ ...file, file: handles.get(file.id) })), keepFiles, removeFile, clear, sending, startSend };
}
