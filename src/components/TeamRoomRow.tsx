// One renderer for team room lines, on the host and the teammate side.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { localeTag, useI18n } from "@/lib/i18n";
import { isRoomPicture, roomFileUrl, roomMessage, type RoomLine } from "@/lib/team-rooms";
import { formatTime } from "@/state/store";
import type { Message } from "@/state/store-types";

import { AttachedImageGallery } from "./AttachmentPreview";
import { FileAttachmentRow } from "./FileAttachmentRow";
import { contextClickKind, holdToOpen, isTouchPrimary, MessageMenu, SelectionMenu, type MessageMenuRequest } from "./MessageMenu";
import { ReplyQuote } from "./ReplyQuote";

export function TeamRoomRow({ line, mine, named, base, quote, onJump, onMenu }: {
  line: RoomLine; mine: boolean; named: boolean; base: string; quote?: RoomLine;
  onJump: (id: string) => void; onMenu: (request: MessageMenuRequest) => void;
}) {
  const { t, locale } = useI18n();
  const pictures = line.files.filter(isRoomPicture).map((file) => ({ src: roomFileUrl(base, file, true), name: file.name }));
  const files = line.files.filter((file) => !isRoomPicture(file));
  const target = { threadId: base, message: roomMessage(line), copyText: line.text, user: mine, pinned: false, canPin: false };
  return (
    <div className="contents">
      {named && <div className="mt-1 pl-0.5 text-[11px] font-medium text-ink-secondary">{line.author.name}</div>}
      <div
        data-mid={line.id}
        data-team-room-line={mine ? "mine" : "theirs"}
        className={cn("group flex w-full flex-col outline-none", mine ? "items-end" : "items-start")}
        tabIndex={-1}
        {...holdToOpen((x, y, opener) => onMenu({ kind: "message", x, y, opener, target }))}
        onContextMenu={(event) => {
          if (isTouchPrimary() || !(event.target instanceof Element)) return;
          const kind = contextClickKind(event.target, event.clientX, event.clientY);
          if (kind === "native") return;
          event.preventDefault();
          event.stopPropagation();
          const point = { x: event.clientX, y: event.clientY, opener: event.currentTarget };
          onMenu(kind === "selection" ? { kind, ...point, text: window.getSelection()?.toString() ?? "" } : { kind, ...point, target });
        }}
      >
        <div className="relative w-fit max-w-[min(42rem,78%)]">
          <div
            className={cn(
              "w-fit max-w-full rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap",
              mine ? "bg-bubble-user text-ink" : "bg-card text-ink",
            )}
            title={new Date(line.at).toLocaleString(localeTag(locale))}
          >
            {quote && <div className="mb-2"><ReplyQuote compact message={roomMessage(quote)} fallbackName={quote.author.name} onJump={() => onJump(quote.id)} /></div>}
            <div data-team-room-content>
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
        </div>
        <span className="mt-0.5 text-[11px] tabular-nums text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {formatTime(line.at, localeTag(locale))}
        </span>
      </div>
    </div>
  );
}

/** Follows the newest line while the reader is at the bottom, or just sent one. */
export function TeamRoomTranscript({ lines, mine, base, label, onReply }: { lines: RoomLine[]; mine: (line: RoomLine) => boolean; base: string; label: string; onReply: (message: Message) => void }) {
  const [menu, setMenu] = useState<MessageMenuRequest | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const last = lines.at(-1);
  const lastId = last?.id;
  const lastMine = last ? mine(last) : false;
  const jump = (id: string) => {
    const row = [...(logRef.current?.querySelectorAll<HTMLElement>("[data-mid]") ?? [])].find((el) => el.dataset.mid === id);
    row?.scrollIntoView({ block: "center" });
    row?.focus({ preventScroll: true });
  };
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
    <>
      {menu?.kind === "message" && <MessageMenu {...menu} onReply={onReply} onPin={() => {}} onClose={() => setMenu(null)} />}
      {menu?.kind === "selection" && <SelectionMenu {...menu} onClose={() => setMenu(null)} />}
      <div
        ref={scrollRef}
        data-team-room-transcript
        data-orbit-transcript
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
            const quote = line.replyToId ? lines.find((candidate) => candidate.id === line.replyToId) : undefined;
            return <TeamRoomRow key={line.id} line={line} mine={own} named={named} base={base} quote={quote} onJump={jump} onMenu={setMenu} />;
          })}
        </div>
      </div>
    </>
  );
}
