import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { File as FileIcon, FileArchive, FileAudio, FileCode, FileSpreadsheet, FileText, Play, Presentation, type LucideIcon } from "lucide-react";

import { formatSize } from "@/lib/composer-attachments";
import { localeTag, useI18n } from "@/lib/i18n";
import { FILE_ROW, GAP, HEAD, PAD, monthAt, useMediaGrid, type GridLayout, type GridMonth } from "@/lib/media-grid";
import { heldMedia, loadMedia, mediaMonths, pickKind, pickedKind, withLive, type MediaKind } from "@/lib/media-index";
import { useThumb } from "@/lib/media-thumbs";
import { chatMedia, type MediaFile, type MediaSource } from "@/lib/show-media";
import { showItem } from "@/lib/show-pane";
import { MediaClip } from "./MediaClip";
import { MediaMenu } from "./MediaMenu";
import { MediaViewer } from "./MediaViewer";
import { RoomFilesNotice, RoomMedia, useRoomFilesRemoved } from "./RoomMedia";

const ROW = "flex w-full min-w-0 items-center gap-3 rounded-lg px-2 text-left text-[13.5px] text-ink hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-accent";
const BUBBLE_MS = 600;
const KINDS: MediaKind[] = ["photos", "files"];
const ICONS: Array<[RegExp, LucideIcon]> = [
  [/\.(pdf|docx?|txt|md|rtf|odt)$/i, FileText],
  [/\.(xlsx?|csv|ods)$/i, FileSpreadsheet],
  [/\.(pptx?|odp|key)$/i, Presentation],
  [/\.(zip|rar|7z|tar|gz)$/i, FileArchive],
  [/\.(html?|css|jsx?|tsx?|json|py|xml|ya?ml)$/i, FileCode],
  [/\.(mp3|wav|m4a|flac|ogg)$/i, FileAudio],
];

/** Mounts only while the Media tab is open, so nothing here loads on a keystroke. */
function useMediaFiles({ threadId, messages, roomId }: MediaSource) {
  const [index, setIndex] = useState(() => heldMedia(threadId, roomId));
  const latest = roomId ? messages.findLast((message) => message.roomFiles?.length)?.id : undefined;
  const removed = useRoomFilesRemoved();

  // A room lists again when a new message brings files.
  useEffect(() => {
    let alive = true;
    loadMedia(threadId, roomId).then((got) => { if (alive) setIndex(got); }, () => { if (alive) setIndex((was) => was ?? { files: [], list: roomId ? { files: [], error: "unreachable" } : undefined }); });
    return () => { alive = false; };
  }, [threadId, roomId, latest, removed]);

  const files = useMemo(() => roomId || !index ? index?.files ?? null : withLive(index.files, chatMedia(threadId, messages)), [threadId, roomId, index, messages]);
  return { files, room: index?.list ?? null };
}

export const ShowMedia = memo(function ShowMedia({ source, maximized }: { source: MediaSource; maximized: boolean }) {
  const { t, locale } = useI18n();
  const { files, room } = useMediaFiles(source);
  const photos = useMemo(() => files?.filter((file) => file.image || file.video) ?? [], [files]);
  const others = useMemo(() => files?.filter((file) => !file.image && !file.video) ?? [], [files]);
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const kind: MediaKind = others.length && (!photos.length || pickedKind(source.threadId, source.roomId) === "files") ? "files" : "photos";
  const months = useMemo(() => mediaMonths(kind === "photos" ? photos : others, locale), [kind, photos, others, locale]);
  const day = useMemo(() => new Intl.DateTimeFormat(localeTag(locale), { month: "short", day: "numeric" }), [locale]);
  const images = useMemo(() => files?.filter((file) => file.image) ?? [], [files]);
  const [open, setOpen] = useState<MediaFile | null>(null);
  const at = open ? images.indexOf(open) : -1;
  const scroller = useRef<HTMLDivElement>(null);
  const { layout, viewport, from, to } = useMediaGrid(scroller, months);
  const choose = (next: MediaKind) => {
    if (next === kind) return;
    pickKind(source.threadId, source.roomId, next);
    scroller.current!.scrollTop = 0;
    repaint();
  };

  return (
    <div className="verify-watch-frame show-media" data-show-media data-maximized={maximized || undefined} aria-busy={!files || undefined}>
      {room && <RoomFilesNotice list={room} />}
      {photos.length > 0 && others.length > 0 && (
        <div role="tablist" data-media-kinds className="show-media-kinds">
          {KINDS.map((each) => <button key={each} type="button" role="tab" aria-selected={kind === each} onClick={() => choose(each)}>{t(each === "photos" ? "show.photos" : "show.files")}</button>)}
        </div>
      )}
      <div className="show-media-body">
        <div ref={scroller} className="show-media-scroll">
          {files?.length === 0 && <p className="show-media-empty">{t("show.empty")}</p>}
          {layout.height > 0 && (
            <div data-media-grid style={{ height: layout.height }}>
              {layout.months.map((month) => month.top < to && month.top + month.height > from && (
                <MediaMonthRows key={month.key} month={month} layout={layout} from={from - month.top} to={to - month.top} day={day} onOpen={setOpen} />
              ))}
            </div>
          )}
        </div>
        <MediaScrollThumb scroller={scroller} layout={layout} viewport={viewport} />
      </div>
      {open && at >= 0 && (
        <MediaViewer image={{ src: open.src!, name: open.name }} onClose={() => setOpen(null)} previous={at > 0} next={at < images.length - 1}
          onNavigate={(step) => setOpen(images[at + step] ?? open)} />
      )}
      <MediaMenu frame={scroller} files={files} roomId={source.roomId} readOnly={Boolean(room?.error)} />
      {source.roomId && room && <RoomMedia list={room} />}
    </div>
  );
});

const MediaMonthRows = memo(function MediaMonthRows({ month, layout, from, to, day, onOpen }: { month: GridMonth; layout: GridLayout; from: number; to: number; day: Intl.DateTimeFormat; onOpen: (file: MediaFile) => void }) {
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
      {month.images.slice(firstCell, Math.max(firstCell, endCell)).map((file, n) => {
        const top = HEAD + Math.floor((firstCell + n) / columns) * pitch;
        const left = ((firstCell + n) % columns) * pitch;
        return file.video ? <MediaVideo key={file.key} file={file} top={top} left={left} size={cell} /> : <MediaCell key={file.key} file={file} top={top} left={left} size={cell} onOpen={onOpen} />;
      })}
      {month.files.slice(firstFile, Math.max(firstFile, endFile)).map((file, n) => <MediaRow key={file.key} file={file} top={filesTop + (firstFile + n) * FILE_ROW} day={day} />)}
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
        <div ref={thumb} data-media-thumb className="show-media-thumb" style={{ height: size }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      </div>
      <div ref={bubble} data-media-bubble data-shown={shown || undefined} className="show-media-bubble" aria-hidden="true">{label}</div>
    </>
  );
}

function MediaVideo({ file, top, left, size }: { file: MediaFile; top: number; left: number; size: number }) {
  const tile = <><Play size={22} aria-hidden="true" /><span className="w-full truncate text-center text-[11px]">{file.name}</span></>;
  return (
    <MediaOpen file={file} style={{ top, left, width: size, height: size }}
      className="absolute flex flex-col items-center justify-center gap-1.5 overflow-hidden rounded-lg bg-raised px-2 text-ink-secondary focus-visible:outline-2 focus-visible:outline-accent">
      {file.src && !file.whole ? <MediaClip src={file.src} name={file.name}>{tile}</MediaClip> : tile}
    </MediaOpen>
  );
}

function MediaRow({ file, top, day }: { file: MediaFile; top: number; day: Intl.DateTimeFormat }) {
  const Icon = ICONS.find(([type]) => type.test(file.name))?.[1] ?? FileIcon;
  const about = [file.size !== undefined && formatSize(file.size), file.sender, day.format(file.at)].filter(Boolean).join(" · ");
  return (
    <MediaOpen file={file} style={{ top }} className={ROW} row>
      <Icon aria-hidden="true" className="size-8 shrink-0 rounded-md bg-raised p-2 text-ink-secondary" />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{file.name}</span>
        <span className="block truncate text-[11.5px] text-ink-secondary">{about}</span>
      </span>
    </MediaOpen>
  );
}

/** Shows what Show can draw, opens the rest in its app on the desktop, else downloads it. */
function MediaOpen({ file, style, className, row, children }: { file: MediaFile; style: CSSProperties; className: string; row?: boolean; children: ReactNode }) {
  const props = { "data-media-file": row || undefined, "data-media-key": file.key, style, className };
  const show = file.show;
  const openFile = file.path ? window.ogb?.openFile : undefined;
  if (show) return <button type="button" {...props} title={file.name} onClick={() => showItem(show)}>{children}</button>;
  if (openFile) return <button type="button" {...props} title={file.path} onClick={() => void openFile(file.path!).catch(() => {})}>{children}</button>;
  if (file.src) return <a href={file.src} download={file.name} {...props} title={file.name}>{children}</a>;
  return <div {...props} title={file.name}>{children}</div>;
}
