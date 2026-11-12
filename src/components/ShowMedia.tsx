import { useEffect, useMemo, useRef, useState } from "react";
import { File as FileIcon, PanelRight } from "lucide-react";

import { request } from "@/lib/api-request";
import { useI18n } from "@/lib/i18n";
import { fetchOlderPage } from "@/lib/message-pages";
import { chatMedia, roomMedia, type MediaFile, type MediaSource } from "@/lib/show-media";
import { showItem } from "@/lib/show-pane";
import { hostRoomBase, type RoomFile } from "@/lib/team-rooms";
import type { Message } from "@/state/store";
import { MediaViewer } from "./MediaViewer";

const ROW = "flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-[13.5px] text-ink hover:bg-raised/60 focus-visible:outline-2 focus-visible:outline-accent";

/** Mounts only while the Media tab is open, so nothing here loads on a keystroke. */
function useMediaFiles({ threadId, messages, hasMore, roomId }: MediaSource): MediaFile[] | null {
  const [older, setOlder] = useState<Message[]>([]);
  const [room, setRoom] = useState<RoomFile[] | null>(null);
  const start = useRef({ before: messages[0]?.id, hasMore });
  const latest = messages.at(-1)?.id;

  useEffect(() => {
    const { before, hasMore: more } = start.current;
    if (roomId || !more || !before) return;
    let alive = true;
    void (async () => {
      let got: Message[] = [];
      for (let cursor = before; ;) {
        const page = await fetchOlderPage(threadId, cursor, 5);
        if (!alive) return;
        got = [...page.messages, ...got];
        setOlder(got);
        if (!page.hasMore || !page.messages[0]) return;
        cursor = page.messages[0].id;
      }
    })().catch(() => {});
    return () => { alive = false; };
  }, [threadId, roomId]);

  // A new room message may carry a file.
  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    request(`${hostRoomBase(roomId)}/files`).then((list: { files: RoomFile[] }) => { if (alive) setRoom(list.files); }, () => { if (alive) setRoom((was) => was ?? []); });
    return () => { alive = false; };
  }, [roomId, latest]);

  return useMemo(() => {
    if (roomId) return room && roomMedia(threadId, roomId, room);
    const loaded = new Set(messages.map((message) => message.id));
    return chatMedia(threadId, [...older.filter((message) => !loaded.has(message.id)), ...messages]);
  }, [threadId, roomId, room, older, messages]);
}

export function ShowMedia({ source, maximized }: { source: MediaSource; maximized: boolean }) {
  const { t } = useI18n();
  const files = useMediaFiles(source);
  const [open, setOpen] = useState<MediaFile | null>(null);
  const images = useMemo(() => files?.filter((file) => file.image) ?? [], [files]);
  const at = open ? images.indexOf(open) : -1;

  return (
    <div className="verify-watch-frame show-media @container/media" data-show-media data-maximized={maximized || undefined} aria-busy={!files || undefined}>
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
