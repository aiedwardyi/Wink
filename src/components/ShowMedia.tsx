import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { File as FileIcon, PanelRight } from "lucide-react";

import { request } from "@/lib/api-request";
import { useI18n } from "@/lib/i18n";
import { fetchOlderPage } from "@/lib/message-pages";
import { chatMedia, messageMedia, roomMedia, type MediaFile, type MediaSource } from "@/lib/show-media";
import { showItem } from "@/lib/show-pane";
import { hostRoomBase, type RoomFile } from "@/lib/team-rooms";
import type { Message } from "@/state/store";
import { MediaViewer } from "./MediaViewer";
import { RoomFileMenu, useRoomFilesRemoved } from "./RoomFileMenu";

const ROW = "flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-[13.5px] text-ink hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-accent";

/** Older batches of 1,000 messages a long chat lists at most. */
const MEDIA_BATCHES = 5;

/** Mounts only while the Media tab is open, so nothing here loads on a keystroke. */
function useMediaFiles({ threadId, messages, hasMore, roomId }: MediaSource, frame: RefObject<HTMLDivElement | null>) {
  const [older, setOlder] = useState<Message[]>([]);
  const [room, setRoom] = useState<RoomFile[] | null>(null);
  const paging = useRef({ before: messages[0]?.id, more: !!hasMore, busy: false, batches: 0, alive: true });
  const latest = roomId ? messages.findLast((message) => message.roomFiles?.length)?.id : undefined;
  const removed = useRoomFilesRemoved();

  const loadOlder = useCallback(() => {
    const page = paging.current;
    if (roomId || page.busy || !page.more || !page.before || page.batches >= MEDIA_BATCHES) return;
    page.busy = true;
    page.batches++;
    fetchOlderPage(threadId, page.before, 5).then((got) => {
      page.busy = false;
      if (!page.alive) return;
      page.more = got.hasMore && !!got.messages[0];
      page.before = got.messages[0]?.id;
      setOlder((was) => [...got.messages, ...was]);
    }, () => { page.busy = false; });
  }, [threadId, roomId]);

  useEffect(() => {
    paging.current.alive = true;
    return () => { paging.current.alive = false; };
  }, []);

  // Keeps going until the list fills the pane; scrolling down loads the rest.
  useEffect(() => {
    const el = frame.current;
    if (!older.length || (el && el.scrollHeight <= el.clientHeight)) loadOlder();
  }, [older, loadOlder, frame]);

  // Lists again when a new message brings files.
  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    request(`${hostRoomBase(roomId)}/files`).then((list: { files: RoomFile[] }) => { if (alive) setRoom(list.files); }, () => { if (alive) setRoom((was) => was ?? []); });
    return () => { alive = false; };
  }, [roomId, latest, removed]);

  // A streamed chunk without a new file keeps the same list.
  const keys = roomId ? "" : messages.flatMap((message) => messageMedia(threadId, message).map((file) => file.key)).join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const current = useMemo(() => messages, [keys]);

  const files = useMemo(() => {
    if (roomId) return room && roomMedia(threadId, roomId, room);
    const loaded = new Set(current.map((message) => message.id));
    return chatMedia(threadId, [...older.filter((message) => !loaded.has(message.id)), ...current]);
  }, [threadId, roomId, room, older, current]);
  return { files, loadOlder };
}

export function ShowMedia({ source, maximized }: { source: MediaSource; maximized: boolean }) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const { files, loadOlder } = useMediaFiles(source, frame);
  const [open, setOpen] = useState<MediaFile | null>(null);
  const images = useMemo(() => files?.filter((file) => file.image) ?? [], [files]);
  const at = open ? images.indexOf(open) : -1;

  return (
    <div ref={frame} onScroll={(event) => {
      const el = event.currentTarget;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 600) loadOlder();
    }} className="verify-watch-frame show-media @container/media" data-show-media data-maximized={maximized || undefined} aria-busy={!files || undefined}>
      {files?.length === 0 && <p className="show-media-empty">{t("show.empty")}</p>}
      {images.length > 0 && (
        <div data-media-grid className="grid grid-cols-3 gap-1.5 @[420px]/media:grid-cols-4">
          {images.map((file) => (
            <button key={file.key} type="button" title={file.name} aria-label={t("viewer.open", { name: file.name })} onClick={() => setOpen(file)}
              className="aspect-square overflow-hidden rounded-lg bg-raised focus-visible:outline-2 focus-visible:outline-accent">
              <img src={file.src} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
            </button>
          ))}
        </div>
      )}
      {files?.filter((file) => !file.image).map((file) => <MediaRow key={file.key} file={file} />)}
      {open && at >= 0 && (
        <MediaViewer image={{ src: open.src!, name: open.name }} onClose={() => setOpen(null)} previous={at > 0} next={at < images.length - 1}
          onNavigate={(step) => setOpen(images[at + step] ?? open)} />
      )}
      {source.roomId && <RoomFileMenu roomId={source.roomId} files={files} frame={frame} />}
    </div>
  );
}

function MediaRow({ file }: { file: MediaFile }) {
  const body = <>
    {file.show ? <PanelRight size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" /> : <FileIcon size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
    <span className="min-w-0 flex-1 truncate">{file.name}</span>
  </>;
  const show = file.show;
  const openFile = file.path ? window.ogb?.openFile : undefined;
  if (show) return <button type="button" data-media-file title={file.name} onClick={() => showItem(show)} className={ROW}>{body}</button>;
  if (openFile) return <button type="button" data-media-file title={file.path} onClick={() => void openFile(file.path!).catch(() => {})} className={ROW}>{body}</button>;
  if (file.src) return <a href={file.src} download={file.name} data-media-file title={file.name} className={ROW}>{body}</a>;
  return <div data-media-file title={file.name} className={ROW}>{body}</div>;
}
