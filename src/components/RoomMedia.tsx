// A hosted room's parts of Media: the folder notice, the space used, and Delete (right-click on desktop, a hold on a phone).
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";

import { request } from "@/lib/api-request";
import { cn } from "@/lib/cn";
import { formatSize } from "@/lib/composer-attachments";
import { useI18n } from "@/lib/i18n";
import type { MediaFile } from "@/lib/show-media";
import { hostRoomBase, type RoomFile } from "@/lib/team-rooms";
import { useBackLayer } from "@/lib/use-back-layer";
import { Presence } from "@/lib/use-presence";

import { ConfirmDialog } from "./ConfirmDialog";
import { HOLD_MS, HOLD_SLOP, MENU_CLASS } from "./MessageMenu";

const PICTURES = "[data-media-grid] > button";
const EDGE = 8;

/** The room's `/files` answer; a failed list has no sizes. */
export type RoomFiles = { files: RoomFile[]; used?: number; capacity?: number; error: string | null };

const size = (bytes: number) => bytes >= 1024 ** 3 ? `${Number((bytes / 1024 ** 3).toFixed(2))} GB` : formatSize(bytes);

let removed = 0;
const watchers = new Set<() => void>();
const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};

/** Counts deletes, so Media lists the room again after one. */
export const useRoomFilesRemoved = () => useSyncExternalStore(watch, () => removed);

function fileAt(frame: HTMLElement, files: readonly MediaFile[], target: EventTarget | null): MediaFile | undefined {
  const tile = target instanceof Element ? target.closest<HTMLElement>(`${PICTURES}, [data-media-file]`) : null;
  if (!tile || !frame.contains(tile)) return;
  const picture = tile.matches(PICTURES);
  const index = [...frame.querySelectorAll(picture ? PICTURES : "[data-media-file]")].indexOf(tile);
  const file = files.filter((each) => Boolean(each.image) === picture)[index];
  // Tiles carry no id, so a list that drew in another order must not delete the wrong file; tooltips blank `title`.
  const same = picture ? tile.querySelector("img")?.getAttribute("src") === file?.src : tile.textContent === file?.name;
  return same ? file : undefined;
}

export function RoomFilesNotice({ list }: { list: RoomFiles }) {
  const { t } = useI18n();
  return list.error ? <p role="alert" className="mb-2 px-2 pt-1 text-[12px] text-danger">{t("teamRoom.folderError")}</p> : null;
}

export function RoomMedia({ roomId, list, files, frame }: { roomId: string; list: RoomFiles; files: readonly MediaFile[] | null; frame: RefObject<HTMLDivElement | null> }) {
  const { t } = useI18n();
  const base = hostRoomBase(roomId);
  const [menu, setMenu] = useState<{ file: MediaFile; x: number; y: number } | null>(null);
  const [place, setPlace] = useState({ top: 0, left: 0 });
  const [deleting, setDeleting] = useState<MediaFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const shown = useRef(files);
  shown.current = files;
  const box = useRef<HTMLDivElement>(null);
  useBackLayer(menu !== null, () => setMenu(null));

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let hold: { x: number; y: number; timer: number } | null = null;
    let held = false;
    const open = (target: EventTarget | null, x: number, y: number) => {
      const file = shown.current && fileAt(el, shown.current, target);
      if (file) setMenu({ file, x, y });
      return Boolean(file);
    };
    const cancel = () => {
      if (hold) window.clearTimeout(hold.timer);
      hold = null;
    };
    const onStart = (event: TouchEvent) => {
      cancel();
      held = false;
      const touch = event.touches[0];
      if (!touch || event.touches.length > 1) return;
      const { target } = event;
      const { clientX: x, clientY: y } = touch;
      hold = { x, y, timer: window.setTimeout(() => { hold = null; held = open(target, x, y); }, HOLD_MS) };
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (hold && (!touch || Math.hypot(touch.clientX - hold.x, touch.clientY - hold.y) > HOLD_SLOP)) cancel();
    };
    const onEnd = (event: TouchEvent) => {
      cancel();
      // the menu opened under the finger, so the lift must not open the file too
      if (held && event.cancelable) event.preventDefault();
    };
    const onMenu = (event: MouseEvent) => {
      if (hold || held || open(event.target, event.clientX, event.clientY)) event.preventDefault();
    };
    const onScroll = () => { cancel(); setMenu(null); };
    el.style.setProperty("-webkit-touch-callout", "none");
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", cancel);
    el.addEventListener("contextmenu", onMenu);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancel();
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", cancel);
      el.removeEventListener("contextmenu", onMenu);
      el.removeEventListener("scroll", onScroll);
    };
  }, [frame]);

  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node && box.current?.contains(event.target))) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu || !box.current) return;
    const { offsetWidth: width, offsetHeight: height } = box.current;
    setPlace({ top: Math.max(EDGE, Math.min(menu.y, window.innerHeight - height - EDGE)), left: Math.max(EDGE, Math.min(menu.x, window.innerWidth - width - EDGE)) });
  }, [menu]);

  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await request(`${base}/files/${deleting.key}`, { method: "DELETE" });
      setDeleting(null);
      removed++;
      for (const watcher of watchers) watcher();
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };

  return <>
    {list.capacity !== undefined && <p className="px-2 pb-1 pt-3 text-center text-[11.5px] tabular-nums text-ink-secondary">{t("teamRoom.filesUsed", { used: size(list.used ?? 0), total: size(list.capacity) })}</p>}
    {menu && createPortal(
      <div ref={box} role="menu" aria-label={menu.file.name} style={place} className={cn(MENU_CLASS, "z-[60] min-w-44")}>
        <button type="button" role="menuitem" autoFocus disabled={Boolean(list.error)} onClick={() => { setFailed(false); setDeleting(menu.file); setMenu(null); }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70 disabled:opacity-40">
          <Trash2 size={16} />{t("teamRoom.deleteFile")}
        </button>
      </div>, document.body)}
    <Presence open={deleting !== null}>
      {(leaving) => <ConfirmDialog closing={leaving} title={t("teamRoom.deleteFileTitle")} body={deleting?.name} confirmLabel={t("teamRoom.deleteFile")} confirmDisabled={busy} onConfirm={() => void remove()} onCancel={() => setDeleting(null)}>
        {failed && <div role="alert" className="mt-2 text-[12.5px] text-danger">{t("teamRoom.folderError")}</div>}
      </ConfirmDialog>}
    </Presence>
  </>;
}
