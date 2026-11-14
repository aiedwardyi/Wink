import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { FileText, Globe, Image as ImageIcon, PanelRight, Play } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { useThumb } from "@/lib/media-thumbs";
import { linkedFileSrc, paneKind, saveFile, showItem, showKind, showName, useShowItem } from "@/lib/show-pane";

import { FileMenu, type FileMenuAt } from "./MediaMenu";
import { useMediaViewer } from "./MediaViewerProvider";

const VIDEO = /\.(mp4|m4v|mov|webm)$/i;

function useSeen(ref: RefObject<HTMLElement | null>, watch: boolean): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!watch || seen || !node) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setSeen(true); });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, watch, seen]);
  return seen;
}

/** A bot's file in chat; lit while the pane shows it, a tap shows it again. A clip with a frame plays in the viewer; one it can't show saves, or opens via `onOpen`. `bare` leaves out a picture the chat already shows. */
export function ShowCard({ threadId, path, onOpen, bare = false }: { threadId: string; path: string; onOpen?: () => void; bare?: boolean }) {
  const { t } = useI18n();
  const shown = useShowItem();
  const kind = paneKind(path);
  const named = showKind(path);
  const name = showName(path);
  const lit = shown?.threadId === threadId && shown.path === path;
  const [menuAt, setMenuAt] = useState<FileMenuAt | null>(null);
  const viewer = useMediaViewer();
  const box = useRef<HTMLSpanElement>(null);
  const clip = VIDEO.test(name) ? linkedFileSrc(threadId, path) : "";
  const seen = useSeen(box, Boolean(clip));
  const thumb = useThumb(clip, true, !clip || !seen);
  const poster = clip && thumb !== clip ? thumb : undefined;
  const menu = (event: MouseEvent<HTMLElement>) => {
    if (!window.ogb?.openFile) return;
    event.preventDefault();
    event.stopPropagation();
    setMenuAt({ x: event.clientX, y: event.clientY, opener: event.currentTarget });
  };
  return (
    <>
      <button
        type="button"
        data-show-card
        data-showing={lit || undefined}
        aria-pressed={kind ? lit : undefined}
        aria-label={t(kind ? "show.card" : "show.openCard", { name })}
        title={path}
        onClick={(event) => {
          if (poster && viewer) viewer.open({ src: clip, name, video: true }, event.currentTarget);
          else if (onOpen) onOpen();
          else if (kind) showItem({ threadId, path, kind });
          else saveFile(linkedFileSrc(threadId, path), name, path);
        }}
        onContextMenu={menu}
        className="my-0.5 flex w-full max-w-[320px] min-w-0 items-center gap-2.5 rounded-xl border border-hairline/40 bg-raised/50 p-1.5 pr-2.5 text-left align-middle hover:bg-raised data-showing:border-accent/70 data-showing:bg-raised data-showing:ring-1 data-showing:ring-accent/40"
      >
        <span ref={box} className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-inset text-ink-secondary">
          {named === "image" && !bare ? <img src={linkedFileSrc(threadId, path)} alt="" loading="lazy" className="size-full object-cover" />
            : poster ? <>
              <img src={poster} alt="" decoding="async" className="size-full object-cover" />
              <span data-play-badge className="absolute flex size-5 items-center justify-center rounded-full bg-black/55 text-white">
                <Play size={9} aria-hidden="true" className="ml-px fill-current" />
              </span>
            </>
            : named === "page" ? <Globe size={18} /> : named === "image" ? <ImageIcon size={18} /> : <FileText size={18} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{name}</span>
          <span className="block text-[11.5px] text-ink-secondary">{named ? t(`show.kind.${named}`) : name.slice(name.lastIndexOf(".") + 1).toUpperCase()}</span>
        </span>
        {kind && <PanelRight data-show-icon size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
      </button>
      <FileMenu at={menuAt} path={path} onOpen={() => void window.ogb?.openFile?.(path).catch(() => {})} onClose={() => setMenuAt(null)} />
    </>
  );
}
