// One renderer for team room lines, on the host and the teammate side.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Languages, MessageSquareReply } from "lucide-react";

import { cn } from "@/lib/cn";
import { captureTranscriptScroll, restoreTranscriptScroll, shouldResumeBottomFollow, type TranscriptScroll } from "@/lib/bottom-follow";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { focusComposerOnActivation, shouldFocusComposerOnTranscriptClick } from "@/lib/focus-composer";
import { useI18n } from "@/lib/i18n";
import { DEFAULT_MAUS_COLOR, type MausColor } from "@/lib/mascot";
import { useRoomFilesState } from "@/lib/room-files-state";
import { useBubbleSwipe } from "@/lib/use-bubble-swipe";
import { alreadyInLanguage, useRoomTranslation, useTranslationAvailable } from "@/lib/room-translate";
import type { PreviewImage } from "@/lib/media-viewer";
import { isRoomPicture, ownerName, roomFileUrl, roomMessage, type JoinedPerson, type RoomFile, type RoomLine } from "@/lib/team-rooms";
import type { Message } from "@/state/store-types";

import { AttachedImageGallery } from "./AttachmentPreview";
import { BotAvatar } from "./Avatar";
import { CopyButton, TimestampLabel } from "./ChatBubble";
import { ChatMarkdown } from "./ChatMarkdown";
import { DaySeparator } from "./DaySeparator";
import { FileAttachmentRow } from "./FileAttachmentRow";
import { JumpToLatest } from "./JumpToLatest";
import { MediaViewerProvider, useMediaViewer } from "./MediaViewerProvider";
import { contextClickKind, holdToOpen, isTouchPrimary, keepsNativeMenu, MessageMenu, SelectionMenu, type MessageMenuRequest } from "./MessageMenu";
import { ReactionChips } from "./Reactions";
import { ReplyQuote } from "./ReplyQuote";
import { RoomNotice } from "./RoomNotice";
import { MessageBoundary } from "./TurnPresence";

export const roomPictures = (base: string, files: readonly RoomFile[]) =>
  files.filter((file) => !file.deleted && isRoomPicture(file)).map((file) => ({ src: roomFileUrl(base, file, true), name: file.name }));

/** A line's deleted notes and download rows, below its words. */
export function RoomFileRows({ base, files, className }: { base: string; files: readonly RoomFile[]; className?: string }) {
  const { t } = useI18n();
  const rows = files.filter((file) => !file.deleted && !isRoomPicture(file));
  return (
    <>
      {files.filter((file) => file.deleted).map((file) => <div key={file.id} className="text-[13px] text-ink-secondary">{t("teamRoom.fileDeleted")}</div>)}
      {rows.length > 0 && (
        <div className={cn("flex flex-col gap-1.5", className)}>
          {rows.map((file) => (
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
    </>
  );
}

const WEB_LINK = /https?:\/\/[^\s<>"]*[^\s<>"'.,;:!?)\]}]/g;

/** A person's line stays plain text; only web links become links. */
function LinkedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(WEB_LINK)) {
    parts.push(text.slice(from, match.index));
    parts.push(<a key={match.index} href={match[0]} target="_blank" rel="noreferrer" className="break-words text-accent underline decoration-accent/40 hover:decoration-accent">{match[0]}</a>);
    from = match.index + match[0].length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

export function RoomLineText({ base, entryId, text, canTranslate, children }: { base: string; entryId?: string; text: string; canTranslate: boolean; children?: ReactNode }) {
  const { t, locale } = useI18n();
  const translation = useRoomTranslation(base, entryId ?? "", locale);
  const show = Boolean(entryId) && canTranslate && Boolean(text.trim()) && !alreadyInLanguage(text, locale);
  return (
    <>
      {children ?? <LinkedText text={text} />}
      {show && <button
        type="button"
        data-room-translate
        aria-pressed={translation.visible}
        onClick={translation.toggle}
        className="mt-1 flex items-center gap-1 text-[13px] text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      ><Languages size={14} aria-hidden />{t(translation.visible ? "teamRoom.showOriginal" : "teamRoom.translate")}</button>}
      {show && translation.visible && <div data-room-translation role="status" className="mt-2 border-t border-hairline pt-2">
        {translation.pending ? t("teamRoom.translating") : translation.failed
          ? <button type="button" onClick={() => void translation.retry()} className="text-left text-ink-secondary hover:text-ink">{t("teamRoom.translationFailed")}</button>
          : translation.text}
      </div>}
    </>
  );
}

/** No `set` hides Pin; `canUnpin` covers the current notice only. */
export interface RoomNoticeControl {
  entryId?: string;
  text?: string;
  canUnpin: boolean;
  set?: (entryId: string | null) => void;
}

export function TeamRoomRow({ line, mine, named, newDay = false, base, authorName, canTranslate = false, quote, onJump, onMenu, onReply, notice, reactionNames, onReact }: {
  line: RoomLine; mine: boolean; named: boolean; newDay?: boolean; base: string; authorName?: string; canTranslate?: boolean; quote?: RoomLine;
  onJump: (id: string) => void; onMenu: (request: MessageMenuRequest) => void; onReply: (message: Message) => void;
  notice?: RoomNoticeControl; reactionNames?: ReadonlyMap<string, string>; onReact?: (message: Message, emoji: string) => void;
}) {
  const { t, locale } = useI18n();
  const viewer = useMediaViewer();
  const translation = useRoomTranslation(base, line.entryId ?? line.id, locale);
  const showTranslate = !mine && canTranslate && Boolean(line.text.trim()) && !alreadyInLanguage(line.text, locale);
  const pictures = roomPictures(base, line.files);
  const files = line.files.filter((file) => !file.deleted && !isRoomPicture(file));
  const rowRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const swiping = useBubbleSwipe({ row: rowRef, bubble: bubbleRef, canReply: true, canTranslate: showTranslate, onReply: () => onReply(roomMessage(line)), onTranslate: translation.toggle });
  const entryId = line.entryId ?? line.id;
  const pinned = notice?.entryId === entryId;
  const message = roomMessage(line);
  const target = { threadId: base, message, copyText: line.text, user: mine, pinned, canPin: Boolean(notice?.set) && (!pinned || notice!.canUnpin), notice: true };
  // The row's file list is rebuilt every render; keying on it would re-register in a loop.
  const pictureKey = JSON.stringify(pictures);
  useEffect(() => {
    if (!viewer) return;
    const off = (JSON.parse(pictureKey) as PreviewImage[]).map((picture) => viewer.register({ ...picture, messageId: line.id, id: `${line.id}:${picture.src}` }));
    return () => off.forEach((stop) => stop());
  }, [viewer, pictureKey, line.id]);
  return (
    <div className="contents">
      {newDay && <DaySeparator at={line.at} />}
      {named && line.author.kind === "bot" ? (
        <div className="mt-1 flex items-center gap-1.5 pl-8" data-team-room-bot>
          <BotAvatar bot={{ name: line.author.name, color: (line.color ?? DEFAULT_MAUS_COLOR) as MausColor }} state="happy" size={16} motion="none" motionKey={0} animated={false} />
          <span className="text-[11px] font-medium text-ink-secondary">{authorName ?? line.author.name}</span>
        </div>
      ) : named && <div className="mt-1 pl-8 text-[11px] font-medium text-ink-secondary">{authorName ?? line.author.name}</div>}
      <div
        ref={rowRef}
        data-mid={line.id}
        data-team-room-line={mine ? "mine" : "theirs"}
        className={cn("group relative flex w-full flex-col outline-none", mine ? "animate-msg-in items-end" : "items-start")}
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
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          if (event.target instanceof Element && keepsNativeMenu(event.target)) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          onMenu({ kind: "message", x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, opener: event.currentTarget, target });
        }}
      >
        {swiping && <MessageSquareReply aria-hidden size={18} className="pointer-events-none absolute top-1/2 left-1 -translate-y-1/2 text-ink-secondary opacity-0 transition-transform group-data-[swipe=right]:opacity-[var(--bubble-swipe)] group-data-[armed=right]:scale-125 group-data-[armed=right]:text-accent" />}
        {swiping && !mine && <Languages aria-hidden size={18} className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 text-ink-secondary opacity-0 transition-transform group-data-[swipe=left]:opacity-[var(--bubble-swipe)] group-data-[armed=left]:scale-125 group-data-[armed=left]:text-accent" />}
        <div ref={bubbleRef} className={cn("relative w-fit max-w-[min(42rem,78%)] pb-8", !mine && "ml-8")}>
          <div
            data-message-hover-actions
            className={cn("pointer-events-none absolute bottom-0 z-20 flex items-center gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100", mine ? "right-0" : "left-0")}
          >
            {line.text && <CopyButton text={line.text} className="opacity-100" />}
            <button
              type="button"
              onClick={() => onReply(roomMessage(line))}
              aria-label={t("chat.replyToMessage")}
              className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
              title={t("chat.replyToMessage")}
            >
              <MessageSquareReply size={14} />
            </button>
          </div>
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
              "w-fit max-w-full rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed break-words",
              line.author.kind !== "bot" && "whitespace-pre-wrap",
              mine ? "bg-bubble-user text-ink" : "bg-card text-ink",
            )}
          >
            {quote && <div className="mb-2"><ReplyQuote compact message={roomMessage(quote)} fallbackName={quote.author.name} onJump={() => onJump(quote.id)} /></div>}
            <div data-team-room-content>
              {pictures.length > 0 && <AttachedImageGallery pictures={pictures} className={cn(!mine && "justify-start", !line.text && !files.length && "mb-0")} />}
              {line.author.kind === "bot" && line.text.trim()
                ? <MessageBoundary fallbackText={line.text}><ChatMarkdown text={line.text} localLinks={false} /></MessageBoundary>
                : <LinkedText text={line.text} />}
              {translation.visible && <div data-room-translation role="status" className="mt-2 border-t border-hairline pt-2">
                {translation.pending ? t("teamRoom.translating") : translation.failed
                  ? <button type="button" onClick={() => void translation.retry()} className="text-left text-ink-secondary hover:text-ink">{t("teamRoom.translationFailed")}</button>
                  : translation.text}
              </div>}
              <RoomFileRows base={base} files={line.files} className={cn(line.text && "mt-2")} />
            </div>
          </div>
        </div>
        {onReact
          ? <ReactionChips threadId={base} message={message} corner={mine ? "right" : "left"} names={reactionNames} onToggle={(emoji) => onReact(message, emoji)} className={cn("static mt-1 max-w-full translate-y-0", !mine && "ml-8")} />
          : line.reactions?.length ? <div className={cn("pointer-events-none", !mine && "ml-8")}><ReactionChips threadId={base} message={message} corner={mine ? "right" : "left"} names={reactionNames} onToggle={() => {}} className="static mt-1 max-w-full translate-y-0" /></div> : null}
        <TimestampLabel at={line.at} />
      </div>
    </div>
  );
}

/** Follows the newest line while the reader is at the bottom, or just sent one. */
export function TeamRoomTranscript({ lines, mine, base, label, hasMore = false, loadOlder, people = [], hostName, onReply, onReact, reactionNames, notice }: {
  lines: RoomLine[]; mine: (line: RoomLine) => boolean; base: string; label: string; hasMore?: boolean; loadOlder?: (beforeCommit: () => void) => void; people?: JoinedPerson[]; hostName?: string; onReply: (message: Message) => void;
  onReact?: (message: Message, emoji: string) => void; reactionNames?: ReadonlyMap<string, string>; notice?: RoomNoticeControl;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MessageMenuRequest | null>(null);
  const byId = useMemo(() => new Map(lines.map((line) => [line.id, line])), [lines]);
  const fileState = useRoomFilesState(base);
  const canTranslate = useTranslationAvailable(base);
  const scrollRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const [behind, setBehind] = useState(false);
  const media = useMemo(() => lines.map(roomMessage), [lines]);
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
  const jump = (id: string) => {
    const row = [...(logRef.current?.querySelectorAll<HTMLElement>("[data-mid]") ?? [])].find((el) => el.dataset.mid === id);
    row?.scrollIntoView({ block: "center" });
    row?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && (atEnd.current || lastMine)) {
      atEnd.current = true;
      setBehind(false);
      el.scrollTop = el.scrollHeight;
      previousTop.current = el.scrollTop;
      previousSize.current = { height: el.scrollHeight, viewport: el.clientHeight };
    }
  }, [lastId, lastMine]);
  useEffect(fill, [fill, lines]);
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    atEnd.current = true;
    setBehind(false);
    el.scrollTop = el.scrollHeight;
    previousTop.current = el.scrollTop;
  };
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
    <MediaViewerProvider threadId={base} messages={media}>
      {menu?.kind === "message" && <MessageMenu
        {...menu}
        onReply={onReply}
        onPin={(message) => notice?.set?.(notice.entryId === (message.roomEntryId ?? message.id) ? null : message.roomEntryId ?? message.id)}
        onReact={onReact && ((emoji) => onReact(menu.target.message, emoji))}
        onClose={() => setMenu(null)}
      />}
      {notice?.entryId && <RoomNotice base={base} line={lines.find((line) => (line.entryId ?? line.id) === notice.entryId)} text={notice.text} onJump={jump} />}
      {menu?.kind === "selection" && <SelectionMenu {...menu} onClose={() => setMenu(null)} />}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-team-room-transcript
        data-orbit-transcript
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
        onClick={(e) => {
          if (!shouldFocusComposerOnTranscriptClick(e.target, e, window.getSelection()?.isCollapsed ?? true, e.currentTarget)) return;
          focusComposerOnActivation();
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const size = { height: el.scrollHeight, viewport: el.clientHeight };
          if (el.scrollTop < previousTop.current && size.height === previousSize.current.height && size.viewport === previousSize.current.viewport) atEnd.current = false;
          if (shouldResumeBottomFollow({ following: atEnd.current, previousScrollTop: previousTop.current, scrollTop: el.scrollTop, distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight })) atEnd.current = true;
          previousTop.current = el.scrollTop;
          previousSize.current = size;
          setBehind(!atEnd.current);
          if (el.scrollTop < 80) loadPage();
        }}
      >
        <div ref={logRef} data-swipe-list role="log" aria-live="polite" aria-label={label} className={cn("flex w-full flex-col gap-3 px-5 pb-4", CHAT_COLUMN_CLASS)}>
          {fileState.error && <div role="alert" className="text-[13px] text-danger">{t("teamRoom.folderError")}</div>}
          {lines.map((line, index) => {
            const own = mine(line);
            const before = lines[index - 1];
            const named = !own && (!before || before.author.id !== line.author.id || before.author.kind !== line.author.kind);
            const owner = ownerName(line.author, people);
            const authorName = owner ? t("teamRoom.botOwner", { name: line.author.name, owner }) : line.author.kind === "host" ? hostName : people.find((person) => person.id === line.author.id)?.name;
            const visible = { ...line, files: line.files.map((file) => fileState.deleted.includes(file.id) ? { ...file, deleted: true } : file) };
            const quote = line.replyToId ? byId.get(line.replyToId) : undefined;
            const newDay = !before || new Date(before.at).toDateString() !== new Date(line.at).toDateString();
            return <TeamRoomRow key={line.id} line={visible} mine={own} named={named} newDay={newDay} onReply={onReply} base={base} authorName={authorName} canTranslate={canTranslate} quote={quote} onJump={jump} onMenu={setMenu} notice={notice} reactionNames={reactionNames} onReact={onReact} />;
          })}
        </div>
      </div>
      {behind && <JumpToLatest bottom={8} onJump={jumpToLatest} />}
      </div>
    </MediaViewerProvider>
  );
}
