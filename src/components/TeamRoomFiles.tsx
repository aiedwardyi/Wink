import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { File, X } from "lucide-react";

import { request } from "@/lib/api-request";
import { formatSize } from "@/lib/composer-attachments";
import { localeTag, useI18n } from "@/lib/i18n";
import { hostRoomBase, roomFileUrl, type RoomFile } from "@/lib/team-rooms";
import { useBackLayer } from "@/lib/use-back-layer";
import { Presence } from "@/lib/use-presence";

import { ConfirmDialog } from "./ConfirmDialog";

type ListedFile = RoomFile & { sender: string; at: number };
type FileList = { files: ListedFile[]; used: number; capacity: number; error: string | null };

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${Number((bytes / 1024 ** 3).toFixed(2))} GB` : formatSize(bytes);

export function TeamRoomFiles({ roomId, closing, onClose }: { roomId: string; closing: boolean; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [list, setList] = useState<FileList | null>(null);
  const [failed, setFailed] = useState(false);
  const [deleting, setDeleting] = useState<ListedFile | null>(null);
  const [busy, setBusy] = useState(false);
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
  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await request(`${base}/files/${deleting.id}`, { method: "DELETE" });
      setList(await request(`${base}/files`));
      setDeleting(null);
      setFailed(false);
    } catch { setFailed(true); setDeleting(null); }
    finally { setBusy(false); }
  };
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
        <div className="min-h-0 overflow-y-auto">
          {list?.files.length === 0 && <p className="py-6 text-center text-[13px] text-ink-secondary">{t("teamRoom.noFiles")}</p>}
          {list?.files.map((file) => (
            <div key={file.id} data-room-file className="flex min-w-0 items-center gap-2 border-t border-hairline/40 py-3">
              <File size={18} className="shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1">
                <a href={roomFileUrl(base, file, false)} download={file.name} className="block break-all text-[13px] text-ink hover:underline">{file.name}</a>
                <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-ink-secondary">
                  <span>{size(file.bytes)}</span><span className="max-w-full break-all">{file.sender}</span><time dateTime={new Date(file.at).toISOString()}>{new Date(file.at).toLocaleString(localeTag(locale))}</time>
                </div>
              </div>
              <button type="button" disabled={busy || Boolean(list.error)} onClick={() => setDeleting(file)} className="shrink-0 rounded-md px-2 py-2 text-[12px] text-danger hover:bg-danger/10">{t("teamRoom.deleteFile")}</button>
            </div>
          ))}
        </div>
      </div>
      <Presence open={deleting !== null}>
        {(leaving) => <ConfirmDialog closing={leaving} title={t("teamRoom.deleteFileTitle")} body={deleting?.name} confirmLabel={t("teamRoom.deleteFile")} confirmDisabled={busy} onConfirm={() => void remove()} onCancel={() => setDeleting(null)} />}
      </Presence>
    </div>, document.body,
  );
}
