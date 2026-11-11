import { useEffect, useRef, useState } from "react";
import { ArrowUp, File as FileIcon, Image as ImageIcon, Paperclip, X } from "lucide-react";

import { formatSize } from "@/lib/composer-attachments";
import { fitComposerHeight } from "@/lib/composer-dock";
import { composerEnterIntent } from "@/lib/composer-enter";
import { draftRevision } from "@/lib/drafts";
import { focusComposerOnActivation } from "@/lib/focus-composer";
import { useI18n } from "@/lib/i18n";
import { useRoomDraft } from "@/lib/room-drafts";
import { filesProblem, isRoomPicture, sendToRoom, type RoomProblem } from "@/lib/team-rooms";
import { useBackLayer } from "@/lib/use-back-layer";
import { useFileDrop } from "@/lib/use-file-drop";
import type { Message } from "@/state/store-types";

import { FileDropOverlay } from "./FileDropOverlay";
import { ReplyQuote } from "./ReplyQuote";

export function useTeamRoomReply(base: string) {
  const [draft, setDraft] = useState<{ base: string; message: Message } | null>(null);
  const replyTo = draft?.base === base ? draft.message : null;
  const clearReply = () => setDraft(null);
  useBackLayer(Boolean(replyTo), clearReply);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[data-message-menu], [data-selection-menu]")) setDraft(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDraft]);
  return { replyTo, selectReply: (message: Message) => setDraft({ base, message }), clearReply };
}

export function TeamRoomComposer({ name, base, draftId, replyTo, onClearReply }: { name: string; base: string; draftId: string; replyTo: Message | null; onClearReply: () => void }) {
  const { t } = useI18n();
  const { text, setText, files, keepFiles, removeFile, clear, sending, startSend } = useRoomDraft(draftId);
  const [problem, setProblem] = useState<RoomProblem | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const repick = useRef<string | undefined>(undefined);
  const composing = useRef(false);
  const composeEnded = useRef(0);
  const ready = Boolean(text.trim() || files.length);
  const needsFile = files.some((file) => !file.file);

  useEffect(() => {
    if (replyTo) inputRef.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    const el = inputRef.current;
    if (el) fitComposerHeight(el, parseFloat(getComputedStyle(el).lineHeight) || 24);
  }, [text]);

  useEffect(() => {
    focusComposerOnActivation({ composer: inputRef.current });
  }, []);

  const add = (picked: File[], replace?: string) => {
    if (!picked.length) return;
    const next = [...files.filter((file) => file.id !== replace), ...picked];
    const ahead = filesProblem(next);
    setProblem(ahead);
    if (!ahead) keepFiles(picked, replace);
  };
  const dragging = useFileDrop((picked) => add(picked));

  const send = async () => {
    if (!ready || sending || needsFile) return;
    const revision = draftRevision(draftId);
    const request = startSend((sendId) => sendToRoom(base, text.trim(), files.flatMap((file) => file.file ? [file.file] : []), sendId, replyTo?.roomEntryId ?? replyTo?.id));
    if (!request) return;
    const failed = await request;
    setProblem(failed);
    if (failed) return;
    if (draftRevision(draftId) === revision) {
      clear();
      onClearReply();
    }
  };

  return (
    <div className="relative px-5 pb-3">
      {dragging && <FileDropOverlay label={t("teamRoom.dropToAttach")} />}
      {replyTo && <div className="mb-2"><ReplyQuote message={replyTo} fallbackName={replyTo.author?.name} onClear={onClearReply} /></div>}
      {problem && (
        <div role="alert" className="mb-2 flex w-full items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          <span className="min-w-0 flex-1">{t(problem.key, problem.vars)}</span>
          <button
            type="button"
            onClick={() => setProblem(null)}
            aria-label={t("chat.dismiss")}
            title={t("chat.dismiss")}
            className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-danger/10"
          >
            <X size={13} strokeWidth={2.5} />
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((file) => (
            <div key={file.id} className="flex max-w-[220px] items-center gap-2 rounded-xl border border-hairline/40 bg-raised px-2.5 py-1.5">
              {isRoomPicture(file) ? <ImageIcon size={14} className="shrink-0 text-ink-secondary" /> : <FileIcon size={14} className="shrink-0 text-ink-secondary" />}
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{file.name}</span>
              <span className="shrink-0 text-[10.5px] text-ink-secondary/70">{formatSize(file.size)}</span>
              {!file.file && (
                <button
                  type="button"
                  onClick={() => { repick.current = file.id; fileInput.current?.click(); }}
                  className="text-[10.5px] text-accent hover:underline"
                >
                  {t("composer.uploadRepick")}
                </button>
              )}
              <button
                type="button"
                disabled={sending}
                onClick={() => removeFile(file.id)}
                aria-label={t("teamRoom.dropFile", { name: file.name })}
                title={t("teamRoom.dropFile", { name: file.name })}
                className="flex size-5 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:text-ink"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="relative grid grid-cols-[auto_1fr_auto] items-center gap-x-2 rounded-3xl bg-raised px-3 pb-2 pt-1">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            add(Array.from(e.target.files ?? []), repick.current);
            repick.current = undefined;
            e.target.value = "";
          }}
        />
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (!pasted.length) return;
            e.preventDefault();
            add(pasted);
          }}
          onCompositionStart={() => {
            composing.current = true;
            composeEnded.current = 0;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            composeEnded.current = Date.now();
          }}
          onBlur={() => {
            composing.current = false;
            composeEnded.current = 0;
          }}
          onKeyDown={(e) => {
            const enter = composerEnterIntent(e, {
              composing: composing.current,
              justEnded: Date.now() - composeEnded.current < 50,
              touch: window.matchMedia?.("(pointer: coarse)").matches,
            });
            if (enter !== "send" && enter !== "send-after") return;
            e.preventDefault();
            void send();
          }}
          placeholder={t("composer.roomLead", { name })}
          aria-label={t("composer.messageAria", { name })}
          className="col-span-full row-start-1 max-h-[9rem] min-h-6 w-full resize-none overflow-y-auto self-center bg-transparent px-1 py-1 text-[15px] leading-6 text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <div className="col-start-1 row-start-2 mt-1 flex items-center gap-1">
          <button
            type="button"
            onClick={() => { repick.current = undefined; fileInput.current?.click(); }}
            aria-label={t("composer.attach")}
            title={t("composer.attach")}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
          >
            <Paperclip size={17} />
          </button>
        </div>
        <div className="col-start-3 row-start-2 mt-1 flex items-center gap-1">
          {ready && (
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || needsFile}
              aria-label={t("composer.send")}
              title={t("composer.send")}
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink hover:brightness-110 disabled:opacity-40"
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Stands where the composer would, when this side can't send. */
export function TeamRoomStatus({ text }: { text: string }) {
  return (
    <div className="px-5 pb-3">
      <div role="status" className="rounded-3xl bg-raised px-4 py-3 text-center text-[13px] text-ink-secondary">
        {text}
      </div>
    </div>
  );
}
