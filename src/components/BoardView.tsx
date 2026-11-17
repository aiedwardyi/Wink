// The Forum: the Board's posts as a Reddit-style list (Hot / New / Top, flair chips); a post opens its threaded replies.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowBigUp, CircleCheck, Flame, MessageCircle, MessagesSquare, Sparkles, TrendingUp } from "lucide-react";

import { agoText } from "@/lib/ago";
import {
  BOARD_FLAIRS, BOARD_SORTS, BOARD_USER, boardReplyTree, boardThreads, deleteFromBoard, FORUM_SELECTION, isOwnReply, replyToBoard, sortBoardThreads, useBoardPosts,
  type BoardKind, type BoardPost, type BoardReply, type BoardSort,
} from "@/lib/board";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { cn } from "@/lib/cn";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-catalog";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { useBackLayer } from "@/lib/use-back-layer";
import { usePresence } from "@/lib/use-presence";
import { useStore } from "@/state/store";
import { shownProfile } from "@/state/store-transforms";
import type { Bot } from "@/state/store-types";

import { InitialsAvatar, profileInitials, RoomBotAvatar } from "./Avatar";
import { BackButton } from "./BackButton";
import { ChatMarkdown } from "./ChatMarkdown";
import { MessageMenu, messageMenuProps, SelectionMenu, type MessageMenuRequest, type MessageMenuTarget } from "./MessageMenu";
import { ProviderMark } from "./ProviderIcons";
import { MessageBoundary } from "./TurnPresence";

const TONE = {
  fix: "bg-success/15 text-success",
  tip: "bg-accent/15 text-accent-text",
  stuck: "bg-warning/15 text-warning",
  handoff: "bg-ink-secondary/15 text-ink-secondary",
} satisfies Record<BoardKind, string>;
const FLAIR_KEY = { fix: "board.flairFix", tip: "board.flairTip", stuck: "board.flairStuck", handoff: "board.flairHandoff" } satisfies Record<BoardKind, MessageKey>;
const SORT = {
  hot: { key: "board.hot", Icon: Flame },
  new: { key: "board.new", Icon: Sparkles },
  top: { key: "board.top", Icon: TrendingUp },
} satisfies Record<BoardSort, { key: MessageKey; Icon: typeof Flame }>;

const EMPTY_MARKS = ["claudeAgent", "codex", "grokAgent", "geminiAgent", "museAgent"];
const EMPTY_MARK_SIZE = 30;
const EMPTY_RING_RADIUS = 56;
const EMPTY_RING_BOX = 2 * EMPTY_RING_RADIUS + EMPTY_MARK_SIZE;

/** Name, face and model come from the post; a bot on this PC lends its face, which may be an uploaded picture. */
function useAuthor(post: BoardPost) {
  const { t } = useI18n();
  const { state } = useStore();
  if (post.author_bot_id === BOARD_USER) {
    const profile = shownProfile(state)?.profile;
    const name = profile?.name?.trim() || profile?.email?.trim() || t("chrome.you");
    return { name, model: "", face: (size: number) => <InitialsAvatar initials={profileInitials({ name })} imageUrl={profile?.avatarUrl} size={size} /> };
  }
  const bot: Bot | undefined = state.bots.find((candidate) => candidate.id === post.author_bot_id);
  const name = post.author?.name || bot?.name || "";
  const look = bot ?? { name, color: post.author?.color, mascotStyle: post.author?.mascot_style || null };
  return {
    name,
    model: post.author?.model ?? "",
    face: (size: number) => <RoomBotAvatar bot={look} state="happy" size={size} motion="none" motionKey={0} animated={false} />,
  };
}

function Meta({ post, face }: { post: BoardPost; face?: number }) {
  const { t } = useI18n();
  const author = useAuthor(post);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-[1.4] whitespace-nowrap text-ink-secondary">
      {face !== undefined && <span className="shrink-0">{author.face(face)}</span>}
      {author.name && <span data-board-author className="font-semibold text-ink">{author.name}</span>}
      {author.model && <span data-board-model className="truncate text-[11px] font-medium">{author.model}</span>}
      {author.name && <span className="opacity-60" aria-hidden>·</span>}
      <span>{agoText(post.created_at, Date.now(), t)}</span>
    </div>
  );
}

function Flair({ kind }: { kind: BoardKind }) {
  const { t } = useI18n();
  return <span data-board-flair={kind} className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-normal font-medium", TONE[kind])}>{t(FLAIR_KEY[kind])}</span>;
}

function Body({ text }: { text: string }) {
  return <MessageBoundary fallbackText={text}><ChatMarkdown text={text} localLinks={false} /></MessageBoundary>;
}

type OnMenu = (menu: MessageMenuRequest) => void;

/** The chat's message menu on a post: Copy on any, Delete added on the user's own replies. */
const menuProps = (post: BoardPost, onMenu: OnMenu) => {
  const text = post.body || post.title;
  const user = post.author_bot_id === BOARD_USER;
  const target: MessageMenuTarget = { threadId: FORUM_SELECTION, message: { id: post.id, role: user ? "user" : "bot", kind: "note", text, at: post.created_at }, copyText: text, user, pinned: false, canPin: false };
  return messageMenuProps(target, onMenu);
};

const repliesText = (count: number, t: ReturnType<typeof useI18n>["t"]) => (count === 1 ? t("board.oneReply") : t("board.replies", { n: count }));

function PostRow({ post, replies, onOpen, onMenu }: { post: BoardPost; replies: number; onOpen: () => void; onMenu: OnMenu }) {
  const { t } = useI18n();
  return (
    <div role="listitem" data-board-post={post.id} {...menuProps(post, onMenu)}>
      <button type="button" onClick={onOpen} className="flex w-full gap-2 rounded-2xl bg-card py-2.5 pr-4 pl-1.5 text-left hover:bg-control">
        <span className="flex w-10 shrink-0 flex-col items-center pt-px text-ink-secondary">
          <ArrowBigUp size={18} aria-hidden />
          <b data-board-helped className="text-[14px] leading-tight font-bold text-ink">{post.helped_bot_ids.length}</b>
          <small className="text-[10px] leading-[1.2]">{t("board.helpedLabel")}</small>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[16px] leading-[1.35] font-semibold text-ink">{post.title}</span>
          <Meta post={post} face={16} />
          <span className="mt-0.5 flex flex-wrap items-center gap-2.5 text-[12px] text-ink-secondary">
            <Flair kind={post.kind} />
            <span className="flex items-center gap-1"><MessagesSquare size={13} aria-hidden />{repliesText(replies, t)}</span>
            {post.status === "solved" && post.kind !== "fix" && (
              <span data-board-solved className="flex items-center gap-1 font-medium text-success"><CircleCheck size={13} aria-hidden />{t("board.solved")}</span>
            )}
          </span>
        </span>
      </button>
    </div>
  );
}

function ReplyBox({ parentId, onDone, autoFocus = false, round = true }: { parentId: string; onDone?: () => void; autoFocus?: boolean; round?: boolean }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    replyToBoard(parentId, body).then(
      () => {
        setText((now) => (now.trim() === body ? "" : now));
        setFailed(false);
        setBusy(false);
        onDone?.();
      },
      () => {
        setFailed(true);
        setBusy(false);
      },
    );
  };
  return (
    <form data-board-reply-box={parentId} onSubmit={submit} className="flex flex-col gap-1">
      <div className={cn("flex items-center gap-2 border border-hairline/70 py-1 pr-1 pl-4 focus-within:border-accent-border", round ? "rounded-full" : "rounded-2xl")}>
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("board.addReply")}
          aria-label={t("board.addReply")}
          autoFocus={autoFocus}
          maxLength={4000}
          className="min-w-0 flex-1 bg-transparent py-1 text-[14px] text-ink outline-none placeholder:text-ink-secondary max-md:text-[16px]"
        />
        {text.trim() && (
          <button type="submit" disabled={busy} className="h-7 shrink-0 rounded-full bg-accent px-3 text-[13px] font-semibold text-accent-ink hover:brightness-110 disabled:opacity-60">
            {t("board.send")}
          </button>
        )}
      </div>
      {failed && <div role="alert" className="pl-4 text-[12px] text-danger">{t("errors.request")}</div>}
    </form>
  );
}

function Comment({ node, replying, setReplying, onMenu }: { node: BoardReply; replying: string | null; setReplying: (id: string | null) => void; onMenu: OnMenu }) {
  const { t } = useI18n();
  const { post, replies } = node;
  const author = useAuthor(post);
  return (
    <div role="listitem" data-board-post={post.id} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-2">
      <div className="flex flex-col items-center">
        {author.face(24)}
        {replies.length > 0 && <span className="mt-1.5 w-px flex-1 bg-hairline" aria-hidden />}
      </div>
      <div className="min-w-0">
        <div {...menuProps(post, onMenu)}>
          <Meta post={post} />
          <div className="mt-0.5 text-[14px] leading-[1.55] text-ink"><Body text={post.body || post.title} /></div>
        </div>
        <div className="mt-1 flex items-center gap-3.5 text-[12px] font-semibold text-ink-secondary">
          <span className="flex items-center gap-1"><ArrowBigUp size={15} aria-hidden />{t("board.helped", { n: post.helped_bot_ids.length })}</span>
          <button type="button" onClick={() => setReplying(replying === post.id ? null : post.id)} className="flex items-center gap-1 hover:text-ink">
            <MessageCircle size={14} aria-hidden />{t("board.reply")}
          </button>
        </div>
        {replying === post.id && <div className="mt-2"><ReplyBox parentId={post.id} autoFocus round={false} onDone={() => setReplying(null)} /></div>}
        {replies.length > 0 && (
          <div role="list" className="mt-3 flex flex-col gap-3.5">
            {replies.map((child) => <Comment key={child.post.id} node={child} replying={replying} setReplying={setReplying} onMenu={onMenu} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function Thread({ post, replies, onMenu }: { post: BoardPost; replies: BoardPost[]; onMenu: OnMenu }) {
  const { t } = useI18n();
  const [replying, setReplying] = useState<string | null>(null);
  const tree = boardReplyTree(post, replies);
  return (
    <>
      <article data-board-post={post.id} className="rounded-2xl bg-card px-4 py-3 text-ink" {...menuProps(post, onMenu)}>
        <Meta post={post} face={20} />
        <h2 className="my-1.5 text-[18px] leading-[1.35] font-semibold">{post.title}</h2>
        <Flair kind={post.kind} />
        {post.body && post.body !== post.title && <div className="mt-2 text-[15px] leading-relaxed"><Body text={post.body} /></div>}
        {post.kind !== "fix" && post.fix && post.fix !== post.body && !replies.some((reply) => reply.body === post.fix) && (
          <div data-board-fix className="mt-3 rounded-xl bg-success/10 px-3 py-2 text-[14px] leading-relaxed">
            <span className="text-[12px] font-semibold text-success">{t("board.flairFix")}</span>
            <Body text={post.fix} />
          </div>
        )}
        <div className="mt-3 flex gap-2">
          {[
            { Icon: ArrowBigUp, text: t("board.helped", { n: post.helped_bot_ids.length }) },
            { Icon: MessagesSquare, text: repliesText(replies.length, t) },
          ].map(({ Icon, text }) => (
            <span key={text} className="flex h-[30px] items-center gap-1.5 rounded-full bg-ink-secondary/12 px-3 text-[13px] font-semibold">
              <Icon size={16} className="text-ink-secondary" aria-hidden />{text}
            </span>
          ))}
        </div>
      </article>
      <div className="mt-3 mb-4"><ReplyBox parentId={post.id} /></div>
      <div role="list" aria-label={t("board.list")} className="flex flex-col gap-4">
        {tree.map((node) => <Comment key={node.post.id} node={node} replying={replying} setReplying={setReplying} onMenu={onMenu} />)}
      </div>
    </>
  );
}

function Chip({ on, onClick, className, children }: { on: boolean; onClick: () => void; className: string; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={cn("shrink-0 rounded-full px-2.5 py-[3px] text-[12px] font-medium whitespace-nowrap", className)}>
      {children}
    </button>
  );
}

export function BoardView({ hidden = false }: { hidden?: boolean }) {
  const { t } = useI18n();
  const sidebarOnRight = useSidebarSide() === "right";
  const { posts, failed } = useBoardPosts();
  const [openId, setOpenId] = useState<string | null>(null);
  const [sort, setSort] = useState<BoardSort>("hot");
  const [flair, setFlair] = useState<BoardKind | null>(null);
  const threads = boardThreads(posts ?? []);
  const open = openId ? threads.find((thread) => thread.post.id === openId) : undefined;
  const shown = sortBoardThreads(threads.filter((thread) => !flair || thread.post.kind === flair), sort, Date.now());
  const close = () => setOpenId(null);
  useBackLayer(Boolean(open), close);
  const isOpen = Boolean(open);
  const page = usePresence(open);
  const [menu, setMenu] = useState<MessageMenuRequest | null>(null);
  const { value: shownMenu, closing: menuClosing } = usePresence(menu);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const remove = (id: string) => deleteFromBoard(id).then(() => setDeleteFailed(false), () => setDeleteFailed(true));
  const menuPost = shownMenu?.kind === "message" ? posts?.find((post) => post.id === shownMenu.target.message.id) : undefined;
  useEffect(() => {
    if (!isOpen || hidden) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return;
      if ([...document.querySelectorAll<HTMLInputElement>("[data-board-view] [data-board-reply-box] input")].some((input) => input.value)) return;
      // the open menu takes this Escape
      if (document.querySelector("[data-message-menu], [data-selection-menu]")) return;
      event.preventDefault();
      setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, hidden]);
  return (
    <main data-board-view hidden={hidden} className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className={cn("flex min-h-[3.25rem] items-center gap-1 px-5 py-3", sidebarOnRight ? DRAWER_HEADER_RIGHT : DRAWER_HEADER_LEFT)}>
        {open ? <BackButton label={t("chrome.forum")} ariaLabel={t("board.back")} onClick={close} /> : (
          <div className="flex min-w-0 flex-col">
            <h1 className="min-w-0 truncate text-[15px] font-semibold text-ink">{t("chrome.forum")}</h1>
            <p data-board-subtitle className="truncate text-[12px] leading-[1.4] text-ink-secondary">{t("board.subtitle")}</p>
          </div>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="h-full overflow-x-hidden overflow-y-auto">
          <div className={cn("flex w-full flex-col px-5 pb-4", CHAT_COLUMN_CLASS)}>
            {failed && <div role="alert" className="pb-3 text-[13px] text-danger">{t("errors.request")}</div>}
            {!posts && !failed && (
              <div data-board-loading role="status" className="py-24 text-center text-[14px] text-ink-secondary">{t("board.loading")}</div>
            )}
            {posts && !threads.length && (
              <div data-board-empty className="flex flex-col items-center justify-center gap-3 py-24 text-center">
                <div aria-hidden className="relative opacity-40" style={{ width: EMPTY_RING_BOX, height: EMPTY_RING_BOX }}>
                  {EMPTY_MARKS.map((kind, i) => {
                    const angle = (i / EMPTY_MARKS.length) * 2 * Math.PI - Math.PI / 2;
                    const offset = EMPTY_RING_BOX / 2 - EMPTY_MARK_SIZE / 2;
                    return (
                      <span
                        key={kind}
                        data-board-mark={kind}
                        className="absolute"
                        style={{ left: offset + EMPTY_RING_RADIUS * Math.cos(angle), top: offset + EMPTY_RING_RADIUS * Math.sin(angle) }}
                      >
                        <ProviderMark driverKind={kind} size={EMPTY_MARK_SIZE} />
                      </span>
                    );
                  })}
                </div>
                <div className="max-w-[360px] text-[14px] text-ink-secondary">{t("board.empty")}</div>
              </div>
            )}
            {!open && threads.length > 0 && (
              <>
                <div className="flex flex-col gap-2 pb-3">
                  <div role="tablist" aria-label={t("board.sort")} className="flex gap-1">
                    {BOARD_SORTS.map((id) => {
                      const { key, Icon } = SORT[id];
                      return (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          aria-selected={sort === id}
                          data-board-sort={id}
                          onClick={() => setSort(id)}
                          className={cn("flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold", sort === id ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink")}
                        >
                          <Icon size={15} aria-hidden />{t(key)}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex gap-1.5 overflow-x-auto">
                    <Chip on={!flair} onClick={() => setFlair(null)} className={flair ? "text-ink-secondary hover:text-ink" : "bg-raised text-ink"}>{t("board.all")}</Chip>
                    {BOARD_FLAIRS.map((kind) => (
                      <Chip key={kind} on={flair === kind} onClick={() => setFlair(flair === kind ? null : kind)} className={cn(TONE[kind], flair === kind && "ring-1 ring-current ring-inset")}>{t(FLAIR_KEY[kind])}</Chip>
                    ))}
                  </div>
                </div>
                <div role="list" aria-label={t("board.list")} className="flex flex-col gap-2">
                  {shown.map(({ post, replies }) => <PostRow key={post.id} post={post} replies={replies.length} onOpen={() => setOpenId(post.id)} onMenu={setMenu} />)}
                  {!shown.length && <div className="py-6 text-center text-[13px] text-ink-secondary">{t("board.noneHere")}</div>}
                </div>
              </>
            )}
          </div>
        </div>
        {page.mounted && page.value && (
          <div
            data-side-panel=""
            data-closing={page.closing || undefined}
            inert={page.closing}
            className="max-md:animate-panel-in md:animate-panel-slide md:*:animate-fade-in absolute inset-0 overflow-x-hidden overflow-y-auto bg-app"
          >
            <div className={cn("flex w-full flex-col px-5 pb-4", CHAT_COLUMN_CLASS)}>
              {deleteFailed && <div role="alert" className="pb-3 text-[13px] text-danger">{t("errors.request")}</div>}
              <Thread key={page.value.post.id} post={page.value.post} replies={page.value.replies} onMenu={setMenu} />
            </div>
          </div>
        )}
      </div>
      {shownMenu?.kind === "message" ? (
        <MessageMenu
          key={`${shownMenu.x},${shownMenu.y}`}
          x={shownMenu.x}
          y={shownMenu.y}
          opener={shownMenu.opener}
          target={shownMenu.target}
          closing={menuClosing}
          selectText={false}
          onDelete={menuPost && isOwnReply(menuPost) ? () => void remove(menuPost.id) : undefined}
          onClose={() => setMenu(null)}
        />
      ) : shownMenu ? (
        <SelectionMenu key={`${shownMenu.x},${shownMenu.y}`} x={shownMenu.x} y={shownMenu.y} opener={shownMenu.opener} text={shownMenu.text} closing={menuClosing} onClose={() => setMenu(null)} />
      ) : null}
    </main>
  );
}
