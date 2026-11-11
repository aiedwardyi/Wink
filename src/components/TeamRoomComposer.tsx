import { useRef, useState } from "react";
import { ArrowUp, File as FileIcon, Image as ImageIcon, Paperclip, X } from "lucide-react";

import { formatSize } from "@/lib/composer-attachments";
import { composerEnterIntent } from "@/lib/composer-enter";
import { useI18n } from "@/lib/i18n";
import { filesProblem, isRoomPicture, sendToRoom, type RoomProblem } from "@/lib/team-rooms";

/** Text, pictures and files for one team room. Nothing here talks to a bot. */
export function TeamRoomComposer({ name, base }: { name: string; base: string }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [problem, setProblem] = useState<RoomProblem | null>(null);
  const [sending, setSending] = useState(false);
  const sendId = useRef(crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const composeEnded = useRef(0);
  const ready = Boolean(text.trim() || files.length);

  const add = (picked: File[]) => {
    if (!picked.length) return;
    const next = [...files, ...picked];
    const ahead = filesProblem(next);
    setProblem(ahead);
    if (!ahead) setFiles(next);
  };

  const send = async () => {
    if (!ready || sending) return;
    setSending(true);
    const failed = await sendToRoom(base, text.trim(), files, sendId.current);
    setSending(false);
    setProblem(failed);
    if (failed) return;
    sendId.current = crypto.randomUUID();
    setText("");
    setFiles([]);
  };

  return (
    <div className="relative px-5 pb-3">
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
          {files.map((file, index) => (
            <div key={`${file.name}:${index}`} className="flex max-w-[220px] items-center gap-2 rounded-xl border border-hairline/40 bg-raised px-2.5 py-1.5">
              {isRoomPicture(file) ? <ImageIcon size={14} className="shrink-0 text-ink-secondary" /> : <FileIcon size={14} className="shrink-0 text-ink-secondary" />}
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{file.name}</span>
              <span className="shrink-0 text-[10.5px] text-ink-secondary/70">{formatSize(file.size)}</span>
              <button
                type="button"
                disabled={sending}
                onClick={() => setFiles((list) => list.filter((_, at) => at !== index))}
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
            add(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <textarea
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
            onClick={() => fileInput.current?.click()}
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
              disabled={sending}
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
