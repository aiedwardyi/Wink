// One renderer for team room lines, on the host and the teammate side.
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Languages } from "lucide-react";

import { cn } from "@/lib/cn";
import { captureTranscriptScroll, restoreTranscriptScroll, shouldResumeBottomFollow, type TranscriptScroll } from "@/lib/bottom-follow";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { localeTag, useI18n } from "@/lib/i18n";
import { useRoomFilesState } from "@/lib/room-files-state";
import { alreadyInLanguage, useRoomTranslation, useTranslationAvailable } from "@/lib/room-translate";
import { isRoomPicture, roomFileUrl, type JoinedPerson, type RoomLine } from "@/lib/team-rooms";
import { formatTime } from "@/state/store";

import { AttachedImageGallery } from "./AttachmentPreview";
import { FileAttachmentRow } from "./FileAttachmentRow";

export function TeamRoomRow({ line, mine, named, base, authorName, canTranslate = false }: { line: RoomLine; mine: boolean; named: boolean; base: string; authorName?: string; canTranslate?: boolean }) {
  const { t, locale } = useI18n();
  const translation = useRoomTranslation(base, line.entryId ?? line.id, locale);
  const showTranslate = !mine && canTranslate && Boolean(line.text.trim()) && !alreadyInLanguage(line.text, locale);
  const pictures = line.files.filter((file) => !file.deleted && isRoomPicture(file)).map((file) => ({ src: roomFileUrl(base, file, true), name: file.name }));
  const files = line.files.filter((file) => !file.deleted && !isRoomPicture(file));
  return (
    <div className="contents" data-mid={line.id} data-team-room-line={mine ? "mine" : "theirs"}>
      {named && <div className="mt-1 pl-8 text-[11px] font-medium text-ink-secondary">{authorName ?? line.author.name}</div>}
      <div className={cn("group flex w-full flex-col", mine ? "items-end" : "items-start")}>
        <div className={cn("relative w-fit max-w-[min(42rem,78%)]", !mine && "ml-8")}>
          {!mine && <span data-room-translate-gutter className="absolute top-0 -left-8 flex w-8 justify-start">
            {showTranslate && <button
              type="button"
              data-room-translate
              aria-label={t(translation.visible ? "teamRoom.showOriginal" : "teamRoom.translate")}
              title={t(translation.visible ? "teamRoom.showOriginal" : "teamRoom.translate")}
              aria-pressed={translation.visible}
              onClick={translation.toggle}
              className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            ><Languages size={16} /></button>}
          </span>}
          <div
            className={cn(
              "w-fit max-w-full rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap",
              mine ? "bg-bubble-user text-ink" : "bg-card text-ink",
            )}
            title={new Date(line.at).toLocaleString(localeTag(locale))}
          >
            {pictures.length > 0 && <AttachedImageGallery pictures={pictures} className={cn(!mine && "justify-start", !line.text && !files.length && "mb-0")} />}
            {line.text}
            {translation.visible && <div data-room-translation role="status" className="mt-2 border-t border-hairline pt-2">
              {translation.pending ? t("teamRoom.translating") : translation.failed
                ? <button type="button" onClick={() => void translation.retry()} className="text-left text-ink-secondary hover:text-ink">{t("teamRoom.translationFailed")}</button>
                : translation.text}
            </div>}
            {line.files.filter((file) => file.deleted).map((file) => <div key={file.id} className="text-[13px] text-ink-secondary">{t("teamRoom.fileDeleted")}</div>)}
            {files.length > 0 && (
              <div className={cn("flex flex-col gap-1.5", line.text && "mt-2")}>
                {files.map((file) => (
                  <a
                    key={file.id}
                    href={roomFileUrl(base, file, false)}
                    download={file.name}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t("viewer.download", { name: file.name })}
                    title={t("viewer.downloadTitle")}
                    className="block rounded-lg hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  >
                    <FileAttachmentRow file={{ path: file.id, name: file.name, size: file.bytes }} />
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
        <span className="mt-0.5 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          {formatTime(line.at, localeTag(locale))}
        </span>
      </div>
    </div>
  );
}

/** Follows the newest line while the reader is at the bottom, or just sent one. */
export function TeamRoomTranscript({ lines, mine, base, label, hasMore = false, loadOlder, people = [], hostName }: { lines: RoomLine[]; mine: (line: RoomLine) => boolean; base: string; label: string; hasMore?: boolean; loadOlder?: (beforeCommit: () => void) => void; people?: JoinedPerson[]; hostName?: string }) {
  const { t } = useI18n();
  const fileState = useRoomFilesState(base);
  const canTranslate = useTranslationAvailable(base);
  const scrollRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const previousTop = useRef(0);
  const previousSize = useRef({ height: 0, viewport: 0 });
  const touchY = useRef(0);
  const beforePage = useRef<TranscriptScroll | null>(null);
  const loadPage = useCallback(() => loadOlder?.(() => { beforePage.current = captureTranscriptScroll(scrollRef.current); }), [loadOlder]);
  const fill = useCallback(() => {
    const el = scrollRef.current;
    if (hasMore && el && el.clientHeight > 0 && el.scrollHeight - el.clientHeight < 48) loadPage();
  }, [hasMore, loadPage]);
  useLayoutEffect(() => {
    if (beforePage.current && scrollRef.current) restoreTranscriptScroll(scrollRef.current, beforePage.current);
    beforePage.current = null;
  }, [lines]);
  const last = lines.at(-1);
  const lastId = last?.id;
  const lastMine = last ? mine(last) : false;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && (atEnd.current || lastMine)) {
      atEnd.current = true;
      el.scrollTop = el.scrollHeight;
      previousTop.current = el.scrollTop;
      previousSize.current = { height: el.scrollHeight, viewport: el.clientHeight };
    }
  }, [lastId, lastMine]);
  useEffect(fill, [fill, lines]);
  // Layout scrolls must not disarm follow before pictures finish growing.
  useEffect(() => {
    const el = scrollRef.current;
    const log = logRef.current;
    if (!el || !log || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atEnd.current) {
        el.scrollTop = el.scrollHeight;
        previousTop.current = el.scrollTop;
      }
      previousSize.current = { height: el.scrollHeight, viewport: el.clientHeight };
      fill();
    });
    observer.observe(log);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fill]);
  return (
    <div
      ref={scrollRef}
      data-team-room-transcript
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      onWheel={(event) => { if (event.deltaY < 0) atEnd.current = false; }}
      onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY ?? 0; }}
      onTouchMove={(event) => {
        const y = event.touches[0]?.clientY ?? touchY.current;
        if (y > touchY.current) atEnd.current = false;
        touchY.current = y;
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && ["ArrowUp", "PageUp", "Home"].includes(event.key)) atEnd.current = false;
      }}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        const size = { height: el.scrollHeight, viewport: el.clientHeight };
        if (el.scrollTop < previousTop.current && size.height === previousSize.current.height && size.viewport === previousSize.current.viewport) atEnd.current = false;
        if (shouldResumeBottomFollow({ following: atEnd.current, previousScrollTop: previousTop.current, scrollTop: el.scrollTop, distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight })) atEnd.current = true;
        previousTop.current = el.scrollTop;
        previousSize.current = size;
        if (el.scrollTop < 80) loadPage();
      }}
    >
      <div ref={logRef} role="log" aria-live="polite" aria-label={label} className={cn("flex w-full flex-col gap-3 px-5 pb-4", CHAT_COLUMN_CLASS)}>
        {fileState.error && <div role="alert" className="text-[13px] text-danger">{t("teamRoom.folderError")}</div>}
        {lines.map((line, index) => {
          const own = mine(line);
          const before = lines[index - 1];
          const named = !own && (!before || before.author.id !== line.author.id || before.author.kind !== line.author.kind);
          const authorName = line.author.kind === "host" ? hostName : people.find((person) => person.id === line.author.id)?.name;
          const visible = { ...line, files: line.files.map((file) => fileState.deleted.includes(file.id) ? { ...file, deleted: true } : file) };
          return <TeamRoomRow key={line.id} line={visible} mine={own} named={named} base={base} authorName={authorName} canTranslate={canTranslate} />;
        })}
      </div>
    </div>
  );
}
