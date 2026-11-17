// Chips for what is attached to the next message, plus the window-wide
// file drop that creates them. A long paste collapses into a card of its
// first lines instead of flooding the composer; a file dropped anywhere
// on the window attaches by path.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ClipboardPaste, File as FileIcon, Image as ImageIcon, MessageSquareText, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { useFileDrop } from "@/lib/use-file-drop";
import {
  attachmentImageUrl,
  intakeFiles,
  pasteSummary,
  type Attachment,
  type PasteAttachment,
  type UploadAttachment,
} from "@/lib/composer-attachments";
import { shrunkPicture } from "@/lib/shrink-image";
import { usePresence } from "@/lib/use-presence";
import { AttachmentPreviewDialog, previewImage, type PreviewImage } from "./AttachmentPreview";
import { FileDropOverlay } from "./FileDropOverlay";
import { MediaClip } from "./MediaClip";
import { trayMedia } from "@/lib/tray-media";
import { trackScreen } from "@/lib/usage-stats";

/** Electron 32 removed File.path; only the preload can name a file. */
export function pathForFile(file: File): string {
  return window.ogb?.getPathForFile?.(file) ?? "";
}

export function ComposerAttachments({
  disabled = false,
  items,
  onAdd,
  onRemove,
  onDisplayInChatBox,
  allowImages = true,
  notice,
  onNotice,
  onCancelUpload = onRemove,
  onRetryUpload,
  onRepickUpload,
  localFile,
  onDropFiles,
  dropLabel,
  roomCopy,
  quote,
}: {
  disabled?: boolean;
  items: Attachment[];
  onAdd: (attachments: Attachment[], uploads: { id: string; file: File }[], startedAt?: number) => void;
  onRemove: (id: string) => void;
  onDisplayInChatBox: (attachment: PasteAttachment) => void;
  allowImages?: boolean;
  notice: string | null;
  onNotice: (notice: string | null) => void;
  onCancelUpload?: (id: string) => void;
  onRetryUpload?: (id: string) => void;
  onRepickUpload?: (id: string) => void;
  /** An upload chip whose bytes are still on this PC, sent later in one go. */
  localFile?: (id: string) => { file: File; picture: boolean } | undefined;
  onDropFiles?: (files: File[]) => void;
  dropLabel?: string;
  /** A hosted room's copy of a desktop file, for teammates. */
  roomCopy?: (file: File) => Promise<string | undefined>;
  /** The reply quote; beside attachments that are only pictures and files, they share one row of small thumbs. */
  quote?: ReactNode;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  const previewPresence = usePresence(preview);
  const dragging = useFileDrop(useCallback(async (files: File[], isActive: () => boolean) => {
    if (onDropFiles) return onDropFiles(files);
    const startedAt = performance.now();
    const { attachments, uploads, notice: message } = await intakeFiles(files, {
      t,
      allowImages,
      getPath: pathForFile,
      shrunkPath: shrunkPicture,
      roomCopy,
    });
    if (!isActive()) return;
    if (attachments.length) onAdd(attachments, uploads, startedAt);
    // A concurrent intake's notice must survive this drop.
    if (message) onNotice(message);
  }, [onAdd, allowImages, onNotice, onDropFiles, roomCopy, t]), disabled);
  const row = Boolean(quote) && items.length > 0 && items.every((a) => a.kind === "image" || a.kind === "file" || (a.kind === "upload" && localFile?.(a.id)));

  return (
    <>
      {dragging && <FileDropOverlay label={dropLabel ?? "Drop to attach \u2014 the bot gets the file path"} />}
      {quote && !row && <div className="mb-2 px-1">{quote}</div>}

      {notice && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">{notice}</span>
          <button
            onClick={() => onNotice(null)}
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div data-attachment-tray={row ? "row" : ""} className={cn("mb-2", row && "flex items-end gap-3 px-1")}>
        {row && <div className="min-w-0 flex-1">{quote}</div>}
        <div className={cn("flex gap-2 overflow-x-auto pr-1.5 pt-1.5", row && "max-w-[50%] shrink-0 gap-2.5")}>
          {items.map((a) => {
            const local = a.kind === "upload" ? localFile?.(a.id) : undefined;
            const media = local ? undefined : trayMedia(a.id);
            return a.kind === "upload" && local?.picture ? (
              <LocalPictureChip key={a.id} name={a.name} blob={local.file} onRemove={() => onRemove(a.id)} onPreview={setPreview} small={row} />
            ) : a.kind === "upload" && local ? (
              <Chip key={a.id} kind="FILE" title={a.name} onRemove={() => onRemove(a.id)} small={row} compact="file">
                <FileBody name={a.name} small={row} />
              </Chip>
            ) : a.kind === "paste" ? (
              <Chip
                key={a.id}
                kind="PASTED"
                title={a.text.slice(0, 4000)}
                onRemove={() => onRemove(a.id)}
              >
                <div className="relative h-[76px] overflow-hidden">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.45] text-ink-secondary">
                    {a.text.slice(0, 400)}
                  </pre>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-b from-transparent to-raised" />
                </div>
                <div className="mt-1 text-[10.5px] text-ink-secondary/70">{pasteSummary(a)}</div>
                <button
                  type="button"
                  onClick={() => onDisplayInChatBox(a)}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent/25 bg-accent/5 px-2 py-1.5 text-[10.5px] font-medium text-accent-text hover:border-accent/50 hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60"
                  aria-label="Display pasted text in chat box"
                  title="Display in chat box"
                >
                  <MessageSquareText size={12} aria-hidden="true" />
                  <span>Display in chat box</span>
                </button>
              </Chip>
            ) : a.kind === "image" ? (
              <Chip key={a.id} kind="IMAGE" title={a.name} onRemove={() => onRemove(a.id)} small={row} compact="thumb">
                <button
                  type="button"
                  onClick={() => { trackScreen("attachment-preview"); setPreview(previewImage(a.path)); }}
                  className={thumbBox(row)}
                  aria-label={`Preview ${a.name}`}
                >
                  {media && !attachmentImageUrl(a.path) ? <MediaThumb blob={media} name={a.name} /> : <img src={attachmentImageUrl(a.path) ?? undefined} alt={a.name} loading="lazy" className="size-full object-cover" />}
                </button>
              </Chip>
            ) : a.kind === "upload" ? (
              <Chip
                key={a.id}
                kind={media?.type.startsWith("image/") ? "IMAGE" : "FILE"}
                title={a.name}
                onRemove={() => onCancelUpload(a.id)}
                removeLabel={t("composer.uploadCancel")}
                compact={media ? "thumb" : "file"}
              >
                <UploadBody upload={a} media={media} onRetry={() => onRetryUpload?.(a.id)} onRepick={() => onRepickUpload?.(a.id)} />
              </Chip>
            ) : media ? (
              <Chip key={a.id} kind={media.type.startsWith("image/") ? "IMAGE" : "FILE"} title={a.path} onRemove={() => onRemove(a.id)} small={row} compact="thumb">
                <div className={thumbBox(row)}>
                  <MediaThumb blob={media} name={a.name} small={row} />
                </div>
              </Chip>
            ) : (
              <Chip key={a.id} kind="FILE" title={a.path} onRemove={() => onRemove(a.id)} small={row} compact="file">
                <FileBody name={a.name} small={row} />
              </Chip>
            );
          })}
        </div>
        </div>
      )}
      {previewPresence.value && (
        <AttachmentPreviewDialog image={previewPresence.value} closing={previewPresence.closing} onClose={() => setPreview(null)} />
      )}
    </>
  );
}

const PICTURE = "flex items-center justify-center overflow-hidden bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50";
const SMALL_PICTURE = "size-full rounded-[inherit]";

function FileBody({ name, small = false }: { name: string; small?: boolean }) {
  if (small) return <div className="flex size-full items-center justify-center"><FileIcon size={16} className="text-ink-secondary" /></div>;
  return (
    <div className="flex h-full items-center gap-2">
      <FileIcon size={16} className="shrink-0 text-ink-secondary" />
      <div className="min-w-0 truncate text-[12px] text-ink">{name}</div>
    </div>
  );
}

const thumbBox = (small: boolean) => cn(PICTURE, "relative overflow-hidden", small ? SMALL_PICTURE : "size-[76px] rounded-xl");

function LocalPictureChip({ name, blob, onRemove, onPreview, small = false }: { name: string; blob: File; onRemove: () => void; onPreview: (image: PreviewImage) => void; small?: boolean }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <Chip kind="IMAGE" title={name} onRemove={onRemove} small={small} compact="thumb">
      <button type="button" onClick={() => onPreview({ src: url, name })} className={thumbBox(small)} aria-label={`Preview ${name}`}>
        <img src={url} alt={name} className="size-full object-cover" />
      </button>
    </Chip>
  );
}

function clock(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function useClipLength(src: string | undefined): string | undefined {
  const [length, setLength] = useState<string>();
  useEffect(() => {
    if (!src) return;
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration)) setLength(clock(video.duration));
    };
    video.src = src;
    return () => {
      video.onloadedmetadata = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [src]);
  return length;
}

/** A picked picture, or a clip's first frame with a play mark and its length, from the file in memory; its box is `relative`. */
function MediaThumb({ blob, name, small = false }: { blob: Blob; name: string; small?: boolean }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const video = blob.type.startsWith("video/");
  const length = useClipLength(video ? url : undefined);
  if (!video) return <img src={url} alt={name} className="size-full object-cover" />;
  return (
    <>
      <MediaClip src={url} name={name}>
        <span className="flex min-w-0 items-center gap-2 px-2">
          <FileIcon size={16} className="shrink-0 text-ink-secondary" />
          {!small && <span className="truncate text-[12px] text-ink">{name}</span>}
        </span>
      </MediaClip>
      {length && !small && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1 text-[10px] leading-4 text-white tabular-nums">{length}</span>}
    </>
  );
}

function UploadBody({ upload, media, onRetry, onRepick }: { upload: UploadAttachment; media?: Blob; onRetry: () => void; onRepick: () => void }) {
  const { t } = useI18n();
  const percent = upload.size ? Math.min(100, Math.floor((upload.sent / upload.size) * 100)) : 0;
  const action = "mt-0.5 block break-keep text-left text-[10.5px] leading-snug text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60";
  const status = upload.state === "uploading" ? `${percent}%` : upload.state === "resuming" ? t("composer.uploadResuming") : "";
  const lines = (
    <>
      {status && <div className="truncate text-[10.5px] text-ink-secondary/70">{status}</div>}
      {upload.state === "failed" && (
        <button type="button" onClick={onRetry} className={action}>
          {t("composer.uploadRetry")}
        </button>
      )}
      {upload.state === "repick" && (
        <button type="button" onClick={onRepick} className={action}>
          {t("composer.uploadRepick")}
        </button>
      )}
    </>
  );
  return (
    <>
      {media ? (
        <>
          <div className={thumbBox(false)}>
            <MediaThumb blob={media} name={upload.name} />
          </div>
          {(status || upload.state === "failed" || upload.state === "repick") && <div className="px-1.5 pb-1">{lines}</div>}
        </>
      ) : (
        <div className="flex h-full items-center gap-2">
          <FileIcon size={16} className="shrink-0 text-ink-secondary" />
          <div className="min-w-0">
            {/* an action line lifts the name under the always-on touch x */}
            <div className={cn("truncate text-[12px] text-ink", (upload.state === "failed" || upload.state === "repick") && "pointer-coarse:pr-5")}>
              {upload.name}
            </div>
            {lines}
          </div>
        </div>
      )}
      {upload.state !== "repick" && (
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
          <div className="absolute bottom-0 left-0 h-[2px] bg-accent" style={{ width: `${percent}%` }} />
        </div>
      )}
    </>
  );
}

function Chip({
  children,
  kind,
  title,
  onRemove,
  removeLabel,
  small = false,
  compact,
}: {
  children: React.ReactNode;
  kind: "PASTED" | "FILE" | "IMAGE";
  title: string;
  onRemove: () => void;
  removeLabel?: string;
  /** a 40px thumb with no kind line, for the row beside a reply quote */
  small?: boolean;
  /** a pending picture, clip or file as a chat app's composer shows it: a 76px thumb, or an icon and name; no size or kind line */
  compact?: "thumb" | "file";
}) {
  const { t } = useI18n();
  const Icon = kind === "PASTED" ? ClipboardPaste : kind === "IMAGE" ? ImageIcon : FileIcon;
  const label = t(kind === "PASTED" ? "composer.chipPasted" : kind === "IMAGE" ? "composer.chipImage" : "composer.chipFile");
  return (
    <div
      title={title}
      className={cn(
        "group relative shrink-0 rounded-xl border border-hairline/40 bg-raised",
        small ? "size-10 rounded-lg" : compact === "thumb" ? "w-[76px]" : compact === "file" ? "h-[76px] w-[172px] px-2.5" : "w-[172px] px-2.5 py-2",
        "hover:border-hairline",
      )}
    >
      {children}
      {!small && !compact && <div className="mt-1 flex items-center gap-1">
        <Icon size={11} className="text-ink-secondary/70" />
        <span className="rounded border border-hairline/60 px-1 py-px text-[9.5px] font-medium tracking-wide text-ink-secondary">
          {label}
        </span>
      </div>}
      {/* hover reveals it, but so must focus: `hidden` would take the only
          way to drop a chip out of reach of the keyboard. Touch has no hover, so
          it always shows there. */}
      <button
        onClick={onRemove}
        aria-label={removeLabel ?? t(kind === "PASTED" ? "composer.removePasted" : kind === "IMAGE" ? "composer.removeImage" : "composer.removeFile")}
        className={cn(
          "absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-hairline/60 bg-panel text-ink-secondary opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
          // a small thumb keeps its x on the corner, so the picture under it stays tappable
          small || compact === "thumb" ? "z-10 pointer-coarse:after:absolute pointer-coarse:after:-inset-2" : "pointer-coarse:right-1 pointer-coarse:top-1 pointer-coarse:size-6",
        )}
      >
        <X size={11} />
      </button>
    </div>
  );
}
