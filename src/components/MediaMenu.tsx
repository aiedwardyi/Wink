import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Copy, Download, ExternalLink, FolderOpen, Trash2, type LucideIcon } from "lucide-react";

import { request } from "@/lib/api-request";
import { cn } from "@/lib/cn";
import { MENU_ITEM_HOVER } from "@/lib/menu-style";
import { useI18n, type MessageKey } from "@/lib/i18n";
import type { MediaFile } from "@/lib/show-media";
import { saveFile, showName } from "@/lib/show-pane";
import { hostRoomBase } from "@/lib/team-rooms";
import { useBackLayer } from "@/lib/use-back-layer";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { Presence, usePresence } from "@/lib/use-presence";

import { ConfirmDialog } from "./ConfirmDialog";
import { HOLD_MS, HOLD_SLOP, MENU_CLASS, menuKeyDown } from "./MessageMenu";
import { roomFileRemoved } from "./RoomMedia";

const EDGE = 8;
const ITEM = "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]";

type Action = "copy" | "save" | "show" | "delete";
const LABELS: Record<Action, [MessageKey, LucideIcon]> = { copy: ["show.copyImage", Copy], save: ["show.saveAs", Download], show: ["show.showInFolder", FolderOpen], delete: ["teamRoom.deleteFile", Trash2] };

function actionsFor(file: MediaFile, roomId?: string, localPath?: string | null, readOnly = false, copyable = true): Action[] {
  const actions: Action[] = [];
  if (file.image && file.src && copyable) actions.push("copy");
  if (file.src || (localPath && window.ogb?.saveFile)) actions.push("save");
  if (localPath && window.ogb?.showInFolder) actions.push("show");
  if (roomId && !readOnly) actions.push("delete");
  return actions;
}

function sameOrigin(src: string): boolean {
  try {
    const url = new URL(src, window.location.href);
    return url.protocol === "data:" || url.origin === window.location.origin;
  } catch { return false; }
}

async function imagePng(src: string): Promise<Blob> {
  let blob: Blob;
  if (window.ogb?.readMediaImage) {
    const image = await window.ogb.readMediaImage(src);
    blob = new Blob([new Uint8Array(image.bytes)], { type: image.type });
  }
  else {
    const response = await fetch(src);
    if (!response.ok) throw new Error("Image unavailable");
    blob = await response.blob();
  }
  if (blob.type === "image/png") return blob;
  const image = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")!.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((png) => png ? resolve(png) : reject(new Error("Image unavailable")), "image/png"));
  } finally { image.close(); }
}

function fileAt(frame: HTMLElement, files: readonly MediaFile[], target: EventTarget | null): MediaFile | undefined {
  const tile = target instanceof Element ? target.closest<HTMLElement>("[data-media-key]") : null;
  return tile && frame.contains(tile) ? files.find((file) => file.key === tile.dataset.mediaKey) : undefined;
}

export function MediaMenu({ frame, files, roomId, readOnly }: { frame: RefObject<HTMLDivElement | null>; files: readonly MediaFile[] | null; roomId?: string; readOnly: boolean }) {
  const { t } = useI18n();
  const phone = useIsPhone();
  const [menu, setMenu] = useState<{ file: MediaFile; x: number; y: number } | null>(null);
  const [place, setPlace] = useState({ top: 0, left: 0 });
  const [deleting, setDeleting] = useState<MediaFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [readable, setReadable] = useState<MediaFile | null>(null);
  const [imageFailed, setImageFailed] = useState<{ file: MediaFile; action: "copy" | "save" } | null>(null);
  const shown = useRef(files);
  shown.current = files;
  const box = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  const probe = Boolean(phone && !window.ogb?.readMediaImage && menu?.file.image && menu.file.src && !sameOrigin(menu.file.src));
  const copyable = !probe || readable === menu?.file;
  const actions = menu ? actionsFor(menu.file, roomId, localPath, readOnly, copyable) : [];
  useBackLayer(actions.length > 0, () => setMenu(null));
  const { value: visible, closing } = usePresence(menu && actions.length > 0 ? { ...menu, actions } : null);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    let hold: { x: number; y: number; timer: number } | null = null;
    let held = false;
    const open = (target: EventTarget | null, x: number, y: number) => {
      const list = shown.current;
      const file = list && fileAt(el, list, target);
      if (!file) return false;
      setLocalPath(null);
      setReadable(null);
      setImageFailed(null);
      setMenu({ file, x, y });
      return true;
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
      held = false;
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
    if (!menu || !window.ogb?.localMediaFile) return;
    let alive = true;
    void window.ogb.localMediaFile({ path: menu.file.path, src: menu.file.src }).then((path) => { if (alive) setLocalPath(path); }, () => {});
    return () => { alive = false; };
  }, [menu]);

  useEffect(() => {
    if (!menu || !probe) return;
    let alive = true;
    void fetch(menu.file.src!).then((response) => response.ok ? response.blob() : null).then((blob) => {
      if (alive && blob) setReadable(menu.file);
    }).catch(() => {});
    return () => { alive = false; };
  }, [menu, probe]);

  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node && box.current?.contains(event.target))) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The pane closes on an Escape nobody took.
      event.preventDefault();
      setMenu(null);
    };
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
  }, [menu, localPath, imageFailed, readOnly, copyable]);

  const run = (action: Action, file: MediaFile) => {
    if (action === "copy") {
      setImageFailed(null);
      const png = imagePng(file.src!);
      void png.catch(() => {});
      try {
        void navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(() => setMenu((current) => current === menu ? null : current), () => setImageFailed({ file, action: "copy" }));
      } catch { setImageFailed({ file, action: "copy" }); }
      return;
    }
    if (action === "save" && file.image && file.src && window.ogb?.saveMediaImage) {
      if (saving.current) return;
      saving.current = true;
      setImageFailed(null);
      void window.ogb.saveMediaImage(file.src, file.name).then(() => setMenu((current) => current === menu ? null : current), () => setImageFailed({ file, action: "save" })).finally(() => { saving.current = false; });
      return;
    }
    setMenu(null);
    if (action === "save") saveFile(file.src ?? "", file.name, file.path ? localPath ?? undefined : undefined);
    else if (action === "show") void window.ogb?.showInFolder?.(localPath!).catch(() => {});
    else {
      setFailed(false);
      setDeleting(file);
    }
  };

  const remove = async () => {
    if (!deleting || busy || !roomId) return;
    setBusy(true);
    setFailed(false);
    try {
      await request(`${hostRoomBase(roomId)}/files/${deleting.key}`, { method: "DELETE" });
      setDeleting(null);
      roomFileRemoved();
    } catch { setFailed(true); }
    finally { setBusy(false); }
  };

  return <>
    {visible && createPortal(
      <div key={`${visible.x},${visible.y}`} ref={box} role="menu" aria-label={visible.file.name} data-closing={closing || undefined} inert={closing} style={place} className={cn(MENU_CLASS, "z-[60] min-w-44")} onKeyDown={(event) => menuKeyDown(box, event)}>
        {visible.actions.map((action, n) => {
          const [label, Icon] = LABELS[action];
          return (
            <Fragment key={action}>
              {action === "delete" && n > 0 && <div role="separator" className="mx-2 my-1 border-t border-hairline/40" />}
              <button type="button" role="menuitem" autoFocus={n === 0} onClick={() => run(action, visible.file)}
                className={cn(ITEM, MENU_ITEM_HOVER, action === "delete" ? "text-danger" : "text-ink")}>
                <Icon size={16} />{t(label)}
              </button>
            </Fragment>
          );
        })}
        {imageFailed?.file === visible.file && <p role="alert" className="max-w-56 px-3.5 py-2 text-[12px] text-danger">{t(imageFailed.action === "copy" ? "show.copyImageFailed" : "show.saveImageFailed")}</p>}
      </div>, document.body)}
    <Presence open={deleting !== null}>
      {(leaving) => <ConfirmDialog closing={leaving} title={t("teamRoom.deleteFileTitle")} body={deleting?.name} confirmLabel={t("teamRoom.deleteFile")} confirmDisabled={busy} onConfirm={() => void remove()} onCancel={() => setDeleting(null)}>
        {failed && <div role="alert" className="mt-2 text-[12.5px] text-danger">{t("teamRoom.folderError")}</div>}
      </ConfirmDialog>}
    </Presence>
  </>;
}

type FileAction = "open" | "show" | "save" | "copyPath";
const FILE_LABELS = { open: ["show.open", ExternalLink], show: ["show.showInFolder", FolderOpen], save: ["show.saveAs", Download], copyPath: ["chat.fileLink.copyPath", Copy] } satisfies Record<FileAction, [MessageKey, LucideIcon]>;

export type FileMenuAt = { x: number; y: number; opener: HTMLElement };

/** A chat file link's right-click menu, the Show pane's look with the native file menu's actions. */
export function FileMenu({ at, path, base, onOpen, onError, onClose }: { at: FileMenuAt | null; path: string; base?: string; onOpen: () => void; onError?: (reason: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ top: 0, left: 0 });
  const [localPath, setLocalPath] = useState<string | null>(null);
  const { value: shown, closing } = usePresence(at);

  useEffect(() => {
    if (!at) return;
    setLocalPath(null);
    let alive = true;
    // null for a folder or a missing file, so Save as stays off for both
    void window.ogb?.localMediaFile?.({ path }).then((file) => { if (alive) setLocalPath(file); }, () => {});
    return () => { alive = false; };
  }, [at, path]);

  useEffect(() => {
    if (!at) return;
    const inside = (event: Event) => event.target instanceof Node && Boolean(box.current?.contains(event.target));
    const outside = (event: Event) => { if (!inside(event)) onClose(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      at.opener.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", outside, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("blur", onClose);
    };
  }, [at, onClose]);

  useLayoutEffect(() => {
    if (!at || !box.current) return;
    const { offsetWidth: width, offsetHeight: height } = box.current;
    setPlace({ top: Math.max(EDGE, Math.min(at.y, window.innerHeight - height - EDGE)), left: Math.max(EDGE, Math.min(at.x, window.innerWidth - width - EDGE)) });
  }, [at, localPath]);

  if (!shown) return null;
  const actions: FileAction[] = ["open"];
  if (window.ogb?.showInFolder) actions.push("show");
  if (localPath && window.ogb?.saveFile) actions.push("save");
  actions.push("copyPath");
  const run = (action: FileAction) => {
    onClose();
    shown.opener.focus({ preventScroll: true });
    if (action === "open") onOpen();
    else if (action === "show") void window.ogb?.showInFolder?.(path, base).catch((error) => onError?.(error instanceof Error ? error.message : "That file could not be opened"));
    else if (action === "save") void window.ogb?.saveFile?.(localPath!).catch(() => {});
    else void navigator.clipboard?.writeText(localPath ?? path).catch(() => {});
  };
  return createPortal(
    <div key={`${shown.x},${shown.y}`} ref={box} role="menu" aria-label={showName(path)} data-file-menu="" data-closing={closing || undefined} inert={closing} style={place} className={cn(MENU_CLASS, "z-[60] min-w-44")} onKeyDown={(event) => menuKeyDown(box, event)}>
      {actions.map((action, n) => {
        const [label, Icon] = FILE_LABELS[action];
        return (
          <button key={action} type="button" role="menuitem" autoFocus={n === 0} onClick={() => run(action)} className={cn(ITEM, MENU_ITEM_HOVER, "text-ink")}>
            <Icon size={16} />{t(label)}
          </button>
        );
      })}
    </div>, document.body);
}
