import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { File as FileIcon, PanelRight } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { FILE_ROW, GAP, HEAD, PAD, monthAt, useMediaGrid, type GridLayout, type GridMonth } from "@/lib/media-grid";
import { heldMedia, loadMedia, mediaMonths, withLive } from "@/lib/media-index";
import { useThumb } from "@/lib/media-thumbs";
import { chatMedia, type MediaFile, type MediaSource } from "@/lib/show-media";
import { showItem } from "@/lib/show-pane";
import { MediaViewer } from "./MediaViewer";

const ROW = "flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-[13.5px] text-ink hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-accent";
const BUBBLE_MS = 600;

/** Mounts only while the Media tab is open, so nothing here loads on a keystroke. */
function useMediaFiles({ threadId, messages, roomId }: MediaSource): MediaFile[] | null {
  const [index, setIndex] = useState(() => heldMedia(threadId, roomId));
  const latest = roomId ? messages.findLast((message) => message.roomFiles?.length)?.id : undefined;

  // A room lists again when a new message brings files.
  useEffect(() => {
    let alive = true;
    loadMedia(threadId, roomId).then((files) => { if (alive) setIndex(files); }, () => { if (alive) setIndex((was) => was ?? []); });
    return () => { alive = false; };
  }, [threadId, roomId, latest]);

  return useMemo(() => roomId || !index ? index : withLive(index, chatMedia(threadId, messages)), [threadId, roomId, index, messages]);
}

export const ShowMedia = memo(function ShowMedia({ source, maximized }: { source: MediaSource; maximized: boolean }) {
  const { t, locale } = useI18n();
  const files = useMediaFiles(source);
  const months = useMemo(() => mediaMonths(files ?? [], locale), [files, locale]);
  const images = useMemo(() => files?.filter((file) => file.image) ?? [], [files]);
  const [open, setOpen] = useState<MediaFile | null>(null);
  const at = open ? images.indexOf(open) : -1;
  const scroller = useRef<HTMLDivElement>(null);
  const { layout, viewport, from, to } = useMediaGrid(scroller, months);

  return (
    <div className="verify-watch-frame show-media" data-show-media data-maximized={maximized || undefined} aria-busy={!files || undefined}>
      <div ref={scroller} className="show-media-scroll">
        {files?.length === 0 && <p className="show-media-empty">{t("show.empty")}</p>}
        {layout.height > 0 && (
          <div data-media-grid style={{ height: layout.height }}>
            {layout.months.map((month) => month.top < to && month.top + month.height > from && (
              <MediaMonthRows key={month.key} month={month} layout={layout} from={from - month.top} to={to - month.top} onOpen={setOpen} />
            ))}
          </div>
        )}
      </div>
      <MediaScrollThumb scroller={scroller} layout={layout} viewport={viewport} />
      {open && at >= 0 && (
        <MediaViewer image={{ src: open.src!, name: open.name }} onClose={() => setOpen(null)} previous={at > 0} next={at < images.length - 1}
          onNavigate={(step) => setOpen(images[at + step] ?? open)} />
      )}
    </div>
  );
});

const MediaMonthRows = memo(function MediaMonthRows({ month, layout, from, to, onOpen }: { month: GridMonth; layout: GridLayout; from: number; to: number; onOpen: (file: MediaFile) => void }) {
  const { columns, cell } = layout;
  const pitch = cell + GAP;
  const rows = Math.ceil(month.images.length / columns);
  const firstCell = Math.max(0, Math.floor((from - HEAD) / pitch)) * columns;
  const endCell = Math.min(rows, Math.ceil((to - HEAD) / pitch)) * columns;
  const filesTop = HEAD + rows * pitch;
  const firstFile = Math.max(0, Math.floor((from - filesTop) / FILE_ROW));
  const endFile = Math.min(month.files.length, Math.ceil((to - filesTop) / FILE_ROW));
  return (
    <section style={{ top: month.top, height: month.height }}>
      <h3 data-media-month className="show-media-month">{month.label}</h3>
      {month.images.slice(firstCell, Math.max(firstCell, endCell)).map((file, n) => (
        <MediaCell key={file.key} file={file} top={HEAD + Math.floor((firstCell + n) / columns) * pitch} left={((firstCell + n) % columns) * pitch} size={cell} onOpen={onOpen} />
      ))}
      {month.files.slice(firstFile, Math.max(firstFile, endFile)).map((file, n) => <MediaRow key={file.key} file={file} top={filesTop + (firstFile + n) * FILE_ROW} />)}
    </section>
  );
});

function MediaCell({ file, top, left, size, onOpen }: { file: MediaFile; top: number; left: number; size: number; onOpen: (file: MediaFile) => void }) {
  const { t } = useI18n();
  const thumb = useThumb(file.src!);
  const [loaded, setLoaded] = useState(false);
  return (
    <button type="button" data-media-key={file.key} title={file.name} aria-label={t("viewer.open", { name: file.name })} onClick={() => onOpen(file)} style={{ top, left, width: size, height: size }}
      className="absolute overflow-hidden rounded-lg bg-raised focus-visible:outline-2 focus-visible:outline-accent">
      {thumb && <img src={thumb} alt="" decoding="async" data-loaded={loaded || undefined} onLoad={() => setLoaded(true)} className="size-full object-cover" />}
    </button>
  );
}

/** Stands in for the hidden scrollbar: a drag shows the month it is passing in a bubble beside it. */
function MediaScrollThumb({ scroller, layout, viewport }: { scroller: RefObject<HTMLDivElement | null>; layout: GridLayout; viewport: number }) {
  const thumb = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState(false);
  const content = layout.height + PAD * 2;
  const size = viewport > 0 && content > viewport ? Math.max(32, viewport * viewport / content) : 0;
  const track = viewport - size;
  const range = content - viewport;

  // follows every scroll frame without a render
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !size) return;
    const place = () => {
      const top = track * Math.min(1, el.scrollTop / range);
      thumb.current!.style.transform = `translateY(${top}px)`;
      bubble.current!.style.transform = `translateY(${top + size / 2}px)`;
    };
    place();
    el.addEventListener("scroll", place, { passive: true });
    return () => el.removeEventListener("scroll", place);
  }, [scroller, size, track, range]);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!size) return null;
  const name = (y: number) => setLabel(monthAt(layout, y - PAD)?.label ?? "");
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = scroller.current!;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, top: track * Math.min(1, el.scrollTop / range) };
    clearTimeout(timer.current);
    name(el.scrollTop);
    setShown(true);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const y = Math.max(0, Math.min(track, drag.current.top + event.clientY - drag.current.y)) / track * range;
    scroller.current!.scrollTop = y;
    name(y);
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    timer.current = setTimeout(() => setShown(false), BUBBLE_MS);
  };
  return (
    <>
      <div className="show-media-rail" aria-hidden="true">
        <div ref={thumb} data-media-thumb data-dragging={shown || undefined} className="show-media-thumb" style={{ height: size }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      </div>
      <div ref={bubble} data-media-bubble data-shown={shown || undefined} className="show-media-bubble" aria-hidden="true">{label}</div>
    </>
  );
}

function MediaRow({ file, top }: { file: MediaFile; top: number }) {
  const body = <>
    {file.show ? <PanelRight size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" /> : <FileIcon size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
    <span className="min-w-0 flex-1 truncate">{file.name}</span>
  </>;
  const show = file.show;
  const openFile = file.path ? window.ogb?.openFile : undefined;
  const style = { top };
  if (show) return <button type="button" data-media-file data-media-key={file.key} title={file.name} onClick={() => showItem(show)} style={style} className={ROW}>{body}</button>;
  if (openFile) return <button type="button" data-media-file data-media-key={file.key} title={file.path} onClick={() => void openFile(file.path!).catch(() => {})} style={style} className={ROW}>{body}</button>;
  if (file.src) return <a href={file.src} download={file.name} data-media-file data-media-key={file.key} title={file.name} style={style} className={ROW}>{body}</a>;
  return <div data-media-file data-media-key={file.key} title={file.name} style={style} className={ROW}>{body}</div>;
}
