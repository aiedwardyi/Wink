import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Images, X } from "lucide-react";

import { request } from "@/lib/api-request";
import { formatSize } from "@/lib/composer-attachments";
import { useI18n } from "@/lib/i18n";
import { showMedia } from "@/lib/show-pane";
import { hostRoomBase, type RoomFile } from "@/lib/team-rooms";
import { useBackLayer } from "@/lib/use-back-layer";

type FileList = { files: RoomFile[]; used: number; capacity: number; error: string | null };

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${Number((bytes / 1024 ** 3).toFixed(2))} GB` : formatSize(bytes);

export function TeamRoomFiles({ roomId, threadId, closing, onClose }: { roomId: string; threadId: string; closing: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [list, setList] = useState<FileList | null>(null);
  const [failed, setFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const base = hostRoomBase(roomId);
  useBackLayer(!closing, onClose);
  useEffect(() => {
    if (closing) return;
    let alive = true;
    const refresh = () => request(`${base}/files`).then((next: FileList) => {
      if (alive) { setList(next); setFailed(false); }
    }, () => { if (alive) setFailed(true); });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [base, closing]);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return createPortal(
    <div data-closing={closing || undefined} inert={closing} className="animate-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-3" onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        if (event.key !== "Tab") return;
        const controls = [...panelRef.current!.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
        const first = controls[0];
        const last = controls.at(-1);
        if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }}>
      <div ref={panelRef} role={closing ? undefined : "dialog"} aria-modal={!closing || undefined} aria-label={t("teamRoom.files")} data-room-files
        className="animate-pop-in flex max-h-[85dvh] w-full max-w-[580px] flex-col rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-ink">{t("teamRoom.files")}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("teamRoom.closeFiles")} className="rounded-md p-2 text-ink-secondary hover:bg-raised"><X size={18} /></button>
        </div>
        <div className="mb-3 text-[12px] tabular-nums text-ink-secondary">{list ? t("teamRoom.filesUsed", { used: size(list.used), total: size(list.capacity) }) : t("teamRoom.loadingFiles")}</div>
        {(failed || list?.error) && <div role="alert" className="mb-2 text-[12px] text-danger">{t("teamRoom.folderError")}</div>}
        <button type="button" data-room-media-row onClick={() => { onClose(); showMedia(threadId); }} className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg border-t border-hairline/40 px-2 text-left text-[14px] text-ink hover:bg-raised">
          <Images size={18} className="shrink-0 text-ink-secondary" />
          <span className="min-w-0 flex-1 truncate">{t("teamRoom.mediaAndFiles")}</span>
          <span className="tabular-nums text-ink-secondary">{list?.files.length}</span>
          <ChevronRight size={16} className="shrink-0 text-ink-secondary" />
        </button>
      </div>
    </div>, document.body,
  );
}
