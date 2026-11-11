import { uploadAttachment, type UploadAttachment } from "./composer-attachments";
import { markDraftEdited, restoreComposerDraft, useComposerDraft } from "./drafts";

// File handles survive navigation; after a reload the stored chip needs a re-pick.
const handles = new Map<string, File>();

export function useRoomDraft(id: string) {
  const [text, setText, attachments, setAttachments] = useComposerDraft(id);
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
  return { text, setText: editText, files: files.map((file) => ({ ...file, file: handles.get(file.id) })), keepFiles, removeFile, clear };
}
