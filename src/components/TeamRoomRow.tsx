// One renderer for team room lines, on the host and the teammate side.
import { useEffect, useLayoutEffect, useRef } from "react";

import { cn } from "@/lib/cn";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { localeTag, useI18n } from "@/lib/i18n";
import { isRoomPicture, roomFileUrl, type JoinedPerson, type RoomLine } from "@/lib/team-rooms";
import { formatTime } from "@/state/store";

import { AttachedImageGallery } from "./AttachmentPreview";
import { FileAttachmentRow } from "./FileAttachmentRow";

export function TeamRoomRow({ line, mine, named, base, authorName }: { line: RoomLine; mine: boolean; named: boolean; base: string; authorName?: string }) {
  const { t, locale } = useI18n();
  const pictures = line.files.filter(isRoomPicture).map((file) => ({ src: roomFileUrl(base, file, true), name: file.name }));
  const files = line.files.filter((file) => !isRoomPicture(file));
  return (
    <div className="contents" data-mid={line.id} data-team-room-line={mine ? "mine" : "theirs"}>
      {named && <div className="mt-1 pl-0.5 text-[11px] font-medium text-ink-secondary">{authorName ?? line.author.name}</div>}
      <div className={cn("group flex w-full flex-col", mine ? "items-end" : "items-start")}>
        <div className="relative w-fit max-w-[min(42rem,78%)]">
          <div
            className={cn(
              "w-fit max-w-full rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap",
              mine ? "bg-bubble-user text-ink" : "bg-card text-ink",
            )}
            title={new Date(line.at).toLocaleString(localeTag(locale))}
          >
            {pictures.length > 0 && <AttachedImageGallery pictures={pictures} className={cn(!mine && "justify-start", !line.text && !files.length && "mb-0")} />}
            {line.text}
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
        <span className="mt-0.5 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {formatTime(line.at, localeTag(locale))}
        </span>
      </div>
    </div>
  );
}

/** Follows the newest line while the reader is at the bottom, or just sent one. */
export function TeamRoomTranscript({ lines, mine, base, label, people = [], hostName }: { lines: RoomLine[]; mine: (line: RoomLine) => boolean; base: string; label: string; people?: JoinedPerson[]; hostName?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const last = lines.at(-1);
  const lastId = last?.id;
  const lastMine = last ? mine(last) : false;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && (atEnd.current || lastMine)) el.scrollTop = el.scrollHeight;
  }, [lastId, lastMine]);
  // pictures loading and a growing composer fire no scroll event; re-pin while following
  useEffect(() => {
    const el = scrollRef.current;
    const log = logRef.current;
    if (!el || !log || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(log);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={scrollRef}
      data-team-room-transcript
      className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      }}
    >
      <div ref={logRef} role="log" aria-live="polite" aria-label={label} className={cn("flex w-full flex-col gap-3 px-5 pb-4", CHAT_COLUMN_CLASS)}>
        {lines.map((line, index) => {
          const own = mine(line);
          const before = lines[index - 1];
          const named = !own && (!before || before.author.id !== line.author.id || before.author.kind !== line.author.kind);
          const authorName = line.author.kind === "host" ? hostName : people.find((person) => person.id === line.author.id)?.name;
          return <TeamRoomRow key={line.id} line={line} mine={own} named={named} base={base} authorName={authorName} />;
        })}
      </div>
    </div>
  );
}
