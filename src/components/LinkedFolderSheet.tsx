import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Download, File as FileIcon, X } from "lucide-react";
import { z } from "zod";

import { formatSize } from "@/lib/composer-attachments";
import { useI18n } from "@/lib/i18n";
import { markdownImage, type PreviewImage } from "@/lib/media-viewer";
import { useBackLayer } from "@/lib/use-back-layer";
import { MediaViewer } from "./MediaViewer";

const listingSchema = z.object({
  files: z.array(z.object({ name: z.string().min(1), path: z.string().min(1), size: z.number() })),
  more: z.number(),
});

type Listing = z.infer<typeof listingSchema>;

const FOCUSABLE = 'a[href], button:not([disabled])';
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const IN_TAB = /\.(html?|pdf|mp4|webm|mov|m4v|mp3|m4a|wav|ogg|aac|flac)$/i;
const ROW = "flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-left hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-accent";

function folderName(folderPath: string): string {
  return folderPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folderPath;
}

/** A folder link on a PC without the folder: lists the PC's copy, or says it opens on the desktop. */
export function LinkedFolderLink({ folderPath, threadId, fileSrc, children }: { folderPath: string; threadId: string; fileSrc: (filePath: string) => string; children?: ReactNode }) {
  const { t } = useI18n();
  const [listing, setListing] = useState<Listing | null>(null);
  const [refused, setRefused] = useState(false);
  const open = async () => {
    const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/linked-folder?path=${encodeURIComponent(folderPath)}`).catch(() => null);
    const body = res?.ok ? listingSchema.safeParse(await res.json().catch(() => null)) : null;
    setRefused(!body?.success);
    if (body?.success) setListing(body.data);
  };
  return (
    <>
      <button type="button" onClick={() => void open()} title={folderPath} className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent">
        {children}
      </button>
      {refused && <span className="ml-1.5 text-[12px] text-ink-secondary">{t("chat.fileLink.desktopOnly")}</span>}
      {listing && <LinkedFolderSheet name={folderName(folderPath)} listing={listing} fileSrc={fileSrc} onClose={() => setListing(null)} />}
    </>
  );
}

function LinkedFolderSheet({ name, listing, fileSrc, onClose }: { name: string; listing: Listing; fileSrc: (filePath: string) => string; onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [image, setImage] = useState<PreviewImage | null>(null);
  const images = listing.files.filter((file) => IMAGE.test(file.name));
  const others = listing.files.filter((file) => !IMAGE.test(file.name));
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useBackLayer(true, onClose);
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, []);
  // The image viewer owns the keyboard while it is open.
  useEffect(() => {
    if (image) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      const focusables = event.key === "Tab" ? [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])] : [];
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const wrapTo = !panelRef.current?.contains(active) ? (event.shiftKey ? last : first)
        : event.shiftKey && active === first ? last
        : !event.shiftKey && active === last ? first
        : null;
      if (!wrapTo) return;
      event.preventDefault();
      event.stopPropagation();
      wrapTo.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [image]);

  return createPortal(
    <div
      className="animate-fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/55 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        data-linked-folder
        className="animate-pop-in flex max-h-[80dvh] w-full flex-col rounded-t-[24px] border border-hairline/50 bg-panel px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl shadow-black/50 sm:max-w-[480px] sm:rounded-[24px] sm:pb-4"
      >
        <div className="mb-1 flex min-w-0 items-center justify-between gap-3 pl-2">
          <h2 id={titleId} title={name} className="min-w-0 truncate text-[15px] font-semibold text-ink">{name}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("chat.folder.close")} className="flex size-11 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <div className="-mx-1 min-h-0 overflow-y-auto px-1">
          {listing.files.length === 0 && <p className="px-2 py-3 text-[13px] text-ink-secondary">{t("chat.folder.empty")}</p>}
          {images.length > 0 && (
            <div data-folder-grid className="grid grid-cols-3 gap-1.5 px-1 pb-2 pt-1 sm:grid-cols-4">
              {images.map((file) => {
                const src = fileSrc(file.path);
                return (
                  <button key={file.path} type="button" title={file.name} aria-label={t("viewer.open", { name: file.name })}
                    onClick={() => setImage(markdownImage(src, file.name))}
                    className="aspect-square overflow-hidden rounded-lg bg-raised focus-visible:outline-2 focus-visible:outline-accent">
                    <img src={src} alt="" loading="lazy" className="size-full object-cover" />
                  </button>
                );
              })}
            </div>
          )}
          {others.map((file) => {
            const src = fileSrc(file.path);
            const size = formatSize(file.size);
            const inTab = IN_TAB.test(file.name);
            return (
              <div key={file.path} className="flex min-w-0 items-center">
                <a href={src} data-folder-file title={file.name} aria-label={t("chat.fileRow", { name: file.name, size })} className={ROW}
                  target={inTab ? "_blank" : undefined} download={inTab ? undefined : true} rel="noreferrer">
                  <FileIcon size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{file.name}</span>
                  <span className="shrink-0 text-[11.5px] text-ink-secondary">{size}</span>
                </a>
                <a href={src} download={file.name} data-folder-download aria-label={t("viewer.download", { name: file.name })} title={t("viewer.downloadTitle")}
                  className="flex size-11 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
                  <Download size={16} />
                </a>
              </div>
            );
          })}
          {listing.more > 0 && <p className="px-2 pb-1 pt-2 text-[12px] text-ink-secondary">{t("chat.folder.more", { count: listing.more })}</p>}
        </div>
      </div>
      {image && <MediaViewer image={image} onClose={() => setImage(null)} />}
    </div>,
    document.body,
  );
}
