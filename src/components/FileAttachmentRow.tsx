import { useState, type ReactNode } from "react";
import { File as FileIcon } from "lucide-react";

import { showKind, linkedFileSrc } from "@/lib/chat-media";
import { cn } from "@/lib/cn";
import { attachmentBasename, attachmentImageUrl, formatSize, type AttachedFile } from "@/lib/composer-attachments";
import { useI18n } from "@/lib/i18n";
import { useThumb } from "@/lib/media-thumbs";
import { usePresence } from "@/lib/use-presence";
import { AttachmentPreviewDialog, type PreviewImage } from "./AttachmentPreview";
import { useMediaViewer } from "./MediaViewerProvider";

// the attachment store names every saved picture this way, and its dot folder is never a linked file
const STORED = /^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/;

function pictureSrc(file: AttachedFile, threadId?: string): string | null {
  const preview = file.preview && attachmentImageUrl(file.preview);
  if (preview) return preview;
  if (STORED.test(attachmentBasename(file.path))) return attachmentImageUrl(file.path);
  return threadId && showKind(file.path) === "image" ? linkedFileSrc(threadId, file.path) : null;
}

/** A picture shows a thumbnail that opens the viewer; a PC without the file shows the plain row. */
export function FileAttachmentRow({ file, threadId }: { file: AttachedFile; threadId?: string }) {
  const { t } = useI18n();
  const src = pictureSrc(file, threadId);
  const [broken, setBroken] = useState<string | null>(null);
  const picture = src && broken !== src ? src : null;
  const size = file.size === undefined ? "" : formatSize(file.size);
  const label = size ? t("chat.fileRow", { name: file.name, size }) : file.name;
  const row = (
    <>
      {picture ? (
        <Thumb src={picture} name={file.name} onError={() => setBroken(picture)} />
      ) : (
        <FileIcon size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      )}
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{file.name}</span>
      {size && <span className="shrink-0 text-[11.5px] text-ink-secondary">{size}</span>}
    </>
  );
  const className = "flex min-w-0 items-center gap-2 rounded-lg border border-hairline/40 px-2.5 py-1.5 whitespace-nowrap";
  if (!picture) {
    return (
      <div data-file-row aria-label={label} className={className}>
        {row}
      </div>
    );
  }
  return <PictureRow image={{ src: picture, name: file.name }} label={label} className={className}>{row}</PictureRow>;
}

function Thumb({ src, name, onError }: { src: string; name: string; onError: () => void }) {
  const thumb = useThumb(src);
  return thumb ? (
    <img src={thumb} alt={name} loading="lazy" onError={onError} className="size-10 shrink-0 rounded-md border border-hairline/40 bg-inset object-cover" />
  ) : (
    <span aria-hidden="true" className="size-10 shrink-0 rounded-md border border-hairline/40 bg-inset" />
  );
}

function PictureRow({ image, label, className, children }: { image: PreviewImage; label: string; className: string; children: ReactNode }) {
  const viewer = useMediaViewer();
  const [open, setOpen] = useState(false);
  const preview = usePresence(open && image);
  return (
    <>
      <button
        type="button"
        data-file-row
        aria-label={label}
        title={image.name}
        onClick={(event) => { if (viewer) viewer.open(image, event.currentTarget); else { event.currentTarget.focus({ preventScroll: true }); setOpen(true); } }}
        className={cn(className, "w-full text-left hover:bg-raised/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50")}
      >
        {children}
      </button>
      {preview.value && <AttachmentPreviewDialog image={preview.value} closing={preview.closing} onClose={() => setOpen(false)} />}
    </>
  );
}

export function FileAttachmentRows({ files, threadId, className }: { files: AttachedFile[]; threadId?: string; className?: string }) {
  if (files.length === 0) return null;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {files.map((file, index) => (
        <FileAttachmentRow key={`${file.path}:${index}`} file={file} threadId={threadId} />
      ))}
    </div>
  );
}
