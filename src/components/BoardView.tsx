// The Forum: the Board's posts as a Threads-style feed on one raised sheet (Hot / New / Top, flair chips); a post opens its replies down a thread line.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SetStateAction } from "react";
import { ArrowBigUp, CircleCheck, Flame, MessageCircle, Sparkles, TrendingUp, type LucideIcon } from "lucide-react";

import { agoText } from "@/lib/ago";
import {
  BOARD_FLAIRS, BOARD_SORTS, BOARD_USER, boardReplyTree, boardThreads, deleteFromBoard, FORUM_SELECTION, forumKept, isOwnReply, isRemovable, replyToBoard, sortBoardThreads, useBoardPosts,
  type BoardKind, type BoardPost, type BoardReply, type BoardSort,
} from "@/lib/board";
import { PRIMARY_BUTTON } from "@/lib/button-style";
import { cn } from "@/lib/cn";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { draftRevision, markDraftEdited, restoreComposerDraft, useDraft } from "@/lib/drafts";
import { useI18n } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-catalog";
import { hapticTick } from "@/lib/phone-swipe";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { useBackLayer } from "@/lib/use-back-layer";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { usePresence } from "@/lib/use-presence";
import { useSettingsSwipe } from "@/lib/use-settings-swipe";
import { useStore } from "@/state/store";
import { shownProfile } from "@/state/store-transforms";
import type { Bot } from "@/state/store-types";

import { InitialsAvatar, profileInitials, RoomBotAvatar } from "./Avatar";
import { BackButton } from "./BackButton";
import { useToggleForum } from "./BoardButton";
import { ChatMarkdown } from "./ChatMarkdown";
import { ConfirmDialog } from "./ConfirmDialog";
import { MessageMenu, messageMenuProps, SelectionMenu, type MessageMenuRequest, type MessageMenuTarget } from "./MessageMenu";
import { ProviderBrandMark } from "./ProviderIcons";
import { MessageBoundary } from "./TurnPresence";
import { WORKER_STATUS } from "./WorkerRows";

const TONE = {
  fix: "bg-success/15 text-success",
  tip: "bg-accent/15 text-accent-text",
  stuck: "bg-warning/15 text-warning",
  handoff: "bg-ink-secondary/15 text-ink-secondary",
} satisfies Record<BoardKind, string>;
const DOT = { fix: "bg-success", tip: "bg-accent-text", stuck: "bg-warning", handoff: "bg-ink-secondary" } satisfies Record<BoardKind, string>;
const FLAIR_KEY = { fix: "board.flairFix", tip: "board.flairTip", stuck: "board.flairStuck", handoff: "board.flairHandoff" } satisfies Record<BoardKind, MessageKey>;
const SORT = {
  hot: { key: "board.hot", Icon: Flame },
  new: { key: "board.new", Icon: Sparkles },
  top: { key: "board.top", Icon: TrendingUp },
} satisfies Record<BoardSort, { key: MessageKey; Icon: typeof Flame }>;

/** The one raised sheet; on a phone the page is the sheet. */
const SHEET = "mx-auto flex w-full break-words max-w-[640px] flex-col pb-4 md:min-h-full md:rounded-t-[28px] md:border md:border-b-0 md:border-hairline/75 md:bg-card md:shadow-2xl md:shadow-black/30";
const ROW = "grid grid-cols-[52px_minmax(0,1fr)] px-6 max-md:grid-cols-[46px_minmax(0,1fr)] max-md:px-4";
const SIDE = "px-6 max-md:px-4";
// replies after this many share the last delay, so a long thread is never slow to show
const STAGGER_CAP = 4;
const FORUM_BACK = "flex min-h-11 items-center gap-0.5 px-1.5 text-[15px] font-medium text-accent hover:text-ink";

const EMPTY_MARKS = ["claudeAgent", "codex", "grokAgent", "geminiAgent", "museAgent"];
const EMPTY_MARK_SIZE = 30;
const EMPTY_RING_RADIUS = 56;
const EMPTY_RING_BOX = 2 * EMPTY_RING_RADIUS + EMPTY_MARK_SIZE;

type UserLook = { name: string; initials: string; avatarUrl?: string };

function useUserLook(): UserLook {
  const { t } = useI18n();
  const { state } = useStore();
  const profile = shownProfile(state)?.profile;
  const name = profile?.name?.trim() || profile?.email?.trim() || t("chrome.you");
  const initials = profileInitials(profile);
  const avatarUrl = profile?.avatarUrl;
  return useMemo(() => ({ name, initials, avatarUrl }), [name, initials, avatarUrl]);
}

const userFace = (user: UserLook) => (size: number) => <InitialsAvatar initials={user.initials} imageUrl={user.avatarUrl} size={size} />;

function useUserFace() {
  const user = useUserLook();
  return { name: user.name, face: userFace(user) };
}

type Instances = ReturnType<typeof useStore>["state"]["instances"];

// the bot may have switched engines since it posted, so the mark follows the model it posted with
const engineOf = (instances: Instances, post: BoardPost) => {
  const model = post.author?.model;
  return (model && instances.find((instance) => instance.models?.options.some((option) => option.label === model || option.id === model))?.driverKind) || "";
};

/** Name, face, model and its engine mark come from the post; a bot on this PC lends its face, which may be an uploaded picture. */
function authorOf(post: BoardPost, bot: Bot | undefined, driverKind: string, user: UserLook) {
  if (post.author_bot_id === BOARD_USER) return { name: user.name, face: userFace(user), model: "", driverKind: "", working: false };
  const name = post.author?.name || bot?.name || "";
  const look = bot ?? { name, color: post.author?.color, mascotStyle: post.author?.mascot_style || null };
  const working = Boolean(bot?.busy);
  return {
    name,
    model: post.author?.model ?? "",
    driverKind,
    working,
    face: (size: number) => <RoomBotAvatar bot={look} state="happy" size={size} motion="none" motionKey={0} animated={false} />,
  };
}

function useAuthor(post: BoardPost) {
  const { state } = useStore();
  const user = useUserLook();
  return authorOf(post, state.bots.find((candidate) => candidate.id === post.author_bot_id), engineOf(state.instances, post), user);
}

type Author = ReturnType<typeof authorOf>;

function Solved() {
  const { t } = useI18n();
  return <span data-board-solved className="flex shrink-0 items-center gap-1 text-[12px] font-semibold text-success"><CircleCheck size={14} aria-hidden />{t("board.solved")}</span>;
}

/** Name, flair, age and Working on one line, the model under it. */
function Byline({ post, author, flair, solved, working: showWorking = false }: { post: BoardPost; author: Author; flair: boolean; solved: boolean; working?: boolean }) {
  const { t } = useI18n();
  const working = WORKER_STATUS.working;
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-h-[22px] min-w-0 items-center gap-2 whitespace-nowrap">
        {author.name && <span data-board-author className="truncate text-[15px] font-semibold text-ink">{author.name}</span>}
        {flair && <Flair kind={post.kind} />}
        <span className="text-[14px] text-ink-secondary">{agoText(post.created_at, Date.now(), t)}</span>
        {showWorking && author.working && (
          <span data-board-working className={cn("flex items-center gap-[5px] text-[12px] font-semibold", working.text)}>
            <span aria-hidden className={cn("size-1.5 rounded-full", working.dot)} />{t(working.key)}
          </span>
        )}
        {solved && <span className="ml-auto"><Solved /></span>}
      </span>
      {author.model && (
        <span data-board-model className="mt-px flex min-w-0 items-center gap-[5px] text-[12.5px] font-medium text-ink-secondary">
          {author.driverKind && <ProviderBrandMark driverKind={author.driverKind} size={13} />}
          <span className="truncate">{author.model}</span>
        </span>
      )}
    </span>
  );
}

function Flair({ kind }: { kind: BoardKind }) {
  const { t } = useI18n();
  return <span data-board-flair={kind} className={cn("inline-flex h-5 items-center rounded-full px-2 text-[11px] leading-none font-semibold", TONE[kind])}>{t(FLAIR_KEY[kind])}</span>;
}

/** An icon with its count; the count shows once there is one, the full words stay for screen readers. */
function Stat({ Icon, n, label, helped }: { Icon: LucideIcon; n: number; label: string; helped?: boolean }) {
  return (
    <span data-board-helped={helped ? n : undefined} className="flex h-9 min-w-9 items-center justify-center gap-[5px] rounded-full px-[9px] text-[13.5px] font-medium text-ink-secondary">
      <Icon size={18} aria-hidden />
      {n > 0 && <span aria-hidden>{n}</span>}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Body({ text }: { text: string }) {
  return <MessageBoundary fallbackText={text}><ChatMarkdown text={text} localLinks={false} /></MessageBoundary>;
}

/** The body's opening words for the list, without markdown marks. */
const preview = (post: BoardPost) => (post.body && post.body !== post.title ? post.body.slice(0, 400).replace(/\*\*|`/g, "").replace(/^\s*(?:#+|>|[-*]|\d+\.)\s+/gm, "").replace(/\s+/g, " ").trim() : "");

type OnMenu = (menu: MessageMenuRequest) => void;

/** The chat's message menu on a post: Copy on any, Delete added on a top-level post and on the user's own replies. */
const menuProps = (post: BoardPost, onMenu: OnMenu) => {
  const text = post.body || post.title;
  const user = post.author_bot_id === BOARD_USER;
  const target: MessageMenuTarget = { threadId: FORUM_SELECTION, message: { id: post.id, role: user ? "user" : "bot", kind: "note", text, at: post.created_at }, copyText: text, user, pinned: false, canPin: false };
  return messageMenuProps(target, onMenu);
};

const repliesText = (count: number, t: ReturnType<typeof useI18n>["t"]) => (count === 1 ? t("board.oneReply") : t("board.replies", { n: count }));

// rows take what they show as props, so an app state change elsewhere redraws none of them
const PostRow = memo(function PostRow({ post, replies, bot, driverKind, user, onOpen, onMenu }: { post: BoardPost; replies: number; bot: Bot | undefined; driverKind: string; user: UserLook; onOpen: (id: string) => void; onMenu: OnMenu }) {
  const { t } = useI18n();
  const author = authorOf(post, bot, driverKind, user);
  const more = preview(post);
  return (
    <div role="listitem" data-board-post={post.id} className="border-t border-hairline/55 first:border-t-0" {...menuProps(post, onMenu)}>
      <button type="button" onClick={() => onOpen(post.id)} className={cn(ROW, "w-full pt-3.5 pb-2 text-left hover:bg-raised/50 max-md:pt-3 max-md:pb-1.5")}>
        <span className="pt-0.5">{author.face(40)}</span>
        <span className="flex min-w-0 flex-col">
          <Byline post={post} author={author} flair solved={post.status === "solved" && post.kind !== "fix"} working={false} />
          <span className="mt-[7px] text-[15px] leading-normal text-pretty text-ink max-md:text-[14.5px]">{post.title}</span>
          {more && <span className="mt-1 line-clamp-2 text-[14.5px] leading-normal text-ink-secondary">{more}</span>}
          <span className="mt-1.5 -ml-2.5 flex gap-0.5">
            <Stat Icon={ArrowBigUp} n={post.helped_bot_ids.length} label={t("board.helped", { n: post.helped_bot_ids.length })} helped />
            <Stat Icon={MessageCircle} n={replies} label={repliesText(replies, t)} />
          </span>
        </span>
      </button>
    </div>
  );
});

// a retry of an unedited reply keeps its id; outlives the box, which Back or another Reply unmounts
const sends = new Map<string, { id: string; revision: number }>();

type OnSaved = (post: BoardPost) => void;

function ReplyBox({ parentId, to, onSaved, onDone, autoFocus = false, top = false }: { parentId: string; to: string; onSaved: OnSaved; onDone?: (parentId: string) => void; autoFocus?: boolean; top?: boolean }) {
  const { t } = useI18n();
  const user = useUserFace();
  const draftId = `forum:${parentId}`;
  const [text, setText] = useDraft(draftId);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    const revision = draftRevision(draftId);
    const held = sends.get(draftId);
    const send = held?.revision === revision ? held : { id: crypto.randomUUID(), revision };
    sends.set(draftId, send);
    setBusy(true);
    replyToBoard(parentId, body, send.id).then(
      ({ post }) => {
        // a newer send of this draft keeps its id for its own retry
        if (sends.get(draftId) === send) sends.delete(draftId);
        onSaved(post);
        setFailed(false);
        setBusy(false);
        // only the draft that was sent clears and closes; one typed since stays
        if (draftRevision(draftId) !== revision) return;
        restoreComposerDraft(draftId, { text: "", attachments: [] });
        // the box closes; keyboard focus goes back to its Reply button, not to the top of the page
        if (!top && form.current?.contains(document.activeElement)) form.current.parentElement?.querySelector<HTMLElement>(`[data-board-reply-to="${parentId}"]`)?.focus();
        onDone?.(parentId);
      },
      () => {
        setFailed(true);
        setBusy(false);
      },
    );
  };
  return (
    <form ref={form} data-board-reply-box={parentId} onSubmit={submit} className={cn("flex flex-col gap-1", top ? cn(SIDE, "border-b border-hairline/55 pt-1 pb-4 focus-within:border-accent-border") : "mt-2")}>
      <div className={cn("flex items-center", top ? "gap-3" : "gap-2 rounded-2xl border border-hairline/70 py-1 pr-1 pl-4 focus-within:border-accent-border")}>
        {top && <span className="shrink-0">{user.face(32)}</span>}
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            markDraftEdited(draftId);
          }}
          placeholder={to ? t("board.replyTo", { name: to }) : t("board.addReply")}
          aria-label={to ? t("board.replyTo", { name: to }) : t("board.addReply")}
          autoFocus={autoFocus}
          maxLength={4000}
          className="min-w-0 flex-1 bg-transparent py-1 text-[15px] text-ink outline-none placeholder:text-ink-secondary max-md:text-[16px]"
        />
        {text.trim() && (
          <button type="submit" disabled={busy} className={cn("h-7 shrink-0 rounded-full px-3 text-[13px] font-semibold disabled:opacity-60", PRIMARY_BUTTON)}>
            {t("board.send")}
          </button>
        )}
      </div>
      {failed && <div role="alert" className={cn("text-[12px] text-danger", !top && "pl-4")}>{t("errors.request")}</div>}
    </form>
  );
}

/** "Helped Jennovar" with the faces of the bots this reply helped, as far as this PC knows them. */
function HelpedChip({ ids }: { ids: string[] }) {
  const { t } = useI18n();
  const { state } = useStore();
  const helped = ids.flatMap((id) => state.bots.find((bot) => bot.id === id) ?? []);
  if (!helped.length) return null;
  const [before, after] = t("board.helpedBot", { name: "\u0000" }).split("\u0000");
  return (
    <span data-board-helped-chip className="mt-2.5 inline-flex h-[30px] max-w-full items-center gap-2 rounded-full bg-accent/13 pr-3 pl-[5px] text-[13px] font-medium text-accent-text">
      <span className="flex shrink-0 -space-x-[5px]">
        {helped.map((bot) => <RoomBotAvatar key={bot.id} bot={bot} state="happy" size={20} motion="none" motionKey={0} animated={false} />)}
      </span>
      <span className="truncate">{before}<b className="font-semibold">{helped.map((bot) => bot.name).join(", ")}</b>{after}</span>
    </span>
  );
}

type Chain = { end: string; order: Map<string, number> | null };

function Comment({ node, chain, replying, setReplying, onMenu, onSaved }: { node: BoardReply; chain: Chain; replying: string | null; setReplying: Dispatch<SetStateAction<string | null>>; onMenu: OnMenu; onSaved: OnSaved }) {
  const { t } = useI18n();
  const { post, replies } = node;
  const author = useAuthor(post);
  const step = chain.order?.get(post.id);
  return (
    <div role="listitem" data-board-post={post.id}>
      <div
        className={cn(ROW, "animate-fade-in pt-3.5 pb-2 [animation-fill-mode:backwards]")}
        style={step ? { animationDelay: `calc(var(--motion-fast) * ${Math.min(step, STAGGER_CAP)})` } : undefined}
      >
        <div className="relative pt-0.5">
          {author.face(36)}
          {post.id !== chain.end && <span data-board-chain aria-hidden className="absolute top-11 -bottom-3.5 left-[17px] w-0.5 rounded-full bg-hairline" />}
        </div>
        <div className="min-w-0">
          <div tabIndex={0} {...menuProps(post, onMenu)}>
            <Byline post={post} author={author} flair={post.kind === "fix"} solved={false} working />
            <div className="mt-[7px] text-[15px] leading-normal text-ink max-md:text-[14.5px]"><Body text={post.body || post.title} /></div>
          </div>
          <HelpedChip ids={post.helped_bot_ids} />
          <div className="mt-1.5 -ml-2.5 flex gap-0.5">
            <Stat Icon={ArrowBigUp} n={post.helped_bot_ids.length} label={t("board.helped", { n: post.helped_bot_ids.length })} helped />
            <button
              type="button"
              data-board-reply-to={post.id}
              onClick={() => setReplying(replying === post.id ? null : post.id)}
              className="flex h-9 items-center gap-[5px] rounded-full pr-3 pl-[9px] text-[13.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <MessageCircle size={18} aria-hidden />{t("board.reply")}
            </button>
          </div>
          {replying === post.id && <ReplyBox parentId={post.id} to={author.name} autoFocus onSaved={onSaved} onDone={(id) => setReplying((open) => (open === id ? null : open))} />}
        </div>
      </div>
      {replies.length > 0 && (
        <div role="list">
          {replies.map((child) => <Comment key={child.post.id} node={child} chain={chain} replying={replying} setReplying={setReplying} onMenu={onMenu} onSaved={onSaved} />)}
        </div>
      )}
    </div>
  );
}

const lastOf = (node: BoardReply): string => (node.replies.length ? lastOf(node.replies[node.replies.length - 1]!) : node.post.id);
const walk = (nodes: BoardReply[]): string[] => nodes.flatMap((node) => [node.post.id, ...walk(node.replies)]);

function Thread({ post, replies, onMenu, onSaved }: { post: BoardPost; replies: BoardPost[]; onMenu: OnMenu; onSaved: OnSaved }) {
  const { t } = useI18n();
  const author = useAuthor(post);
  const [replying, setReplying] = useState<string | null>(null);
  const tree = boardReplyTree(post, replies);
  // replies there when the post opens fade in one after another down the line; later ones just fade in
  const [order] = useState(() => new Map(walk(tree).map((id, step) => [id, step])));
  return (
    <>
      <article data-board-post={post.id} className={cn(SIDE, "pt-[22px] pb-2.5 text-ink max-md:pt-3.5 max-md:pb-2")} {...menuProps(post, onMenu)}>
        <div className="flex items-center gap-3">
          <span className="shrink-0">{author.face(44)}</span>
          <Byline post={post} author={author} flair solved={false} working />
          {post.status === "solved" && post.kind !== "fix" && <Solved />}
        </div>
        <h2 className="mt-3.5 text-[18px] leading-normal font-normal text-pretty max-md:text-[16.5px]">{post.title}</h2>
        {post.body && post.body !== post.title && <div className="mt-2 text-[15px] leading-relaxed"><Body text={post.body} /></div>}
        {post.kind !== "fix" && post.fix && post.fix !== post.body && !replies.some((reply) => reply.body === post.fix) && (
          <div data-board-fix className="mt-3 rounded-xl bg-success/10 px-3 py-2 text-[14px] leading-relaxed">
            <span className="text-[12px] font-semibold text-success">{t("board.flairFix")}</span>
            <Body text={post.fix} />
          </div>
        )}
        <div className="mt-2.5 -ml-2.5 flex gap-0.5">
          <Stat Icon={ArrowBigUp} n={post.helped_bot_ids.length} label={t("board.helped", { n: post.helped_bot_ids.length })} helped />
          <Stat Icon={MessageCircle} n={replies.length} label={repliesText(replies.length, t)} />
        </div>
      </article>
      <h3 className={cn(SIDE, "border-t border-hairline/65 py-3.5 text-[15px] font-semibold text-ink max-md:py-3")}>{t("board.repliesHead")}</h3>
      <ReplyBox parentId={post.id} to={author.name} onSaved={onSaved} top />
      <div role="list" aria-label={t("board.list")}>
        {tree.map((node) => <Comment key={node.post.id} node={node} chain={{ end: lastOf(node), order }} replying={replying} setReplying={setReplying} onMenu={onMenu} onSaved={onSaved} />)}
      </div>
    </>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13.5px] font-semibold whitespace-nowrap max-md:h-[30px] max-md:px-[11px] max-md:text-[13px]",
        on ? "bg-ink text-card" : "text-ink ring-1 ring-hairline ring-inset hover:bg-raised/70",
      )}
    >
      {children}
    </button>
  );
}

export function BoardView({ hidden = false, closing = false }: { hidden?: boolean; closing?: boolean }) {
  const { t } = useI18n();
  const sidebarOnRight = useSidebarSide() === "right";
  const { posts, failed, saved, removed, retry } = useBoardPosts();
  const { state } = useStore();
  const user = useUserLook();
  const [openId, setOpenId] = useState(() => forumKept.openId);
  const [sort, setSort] = useState<BoardSort>(() => forumKept.sort);
  const [flair, setFlair] = useState(() => forumKept.flair);
  useEffect(() => {
    Object.assign(forumKept, { sort, flair, openId });
  }, [sort, flair, openId]);
  const threads = boardThreads(posts ?? []);
  const botById = new Map(state.bots.map((bot) => [bot.id, bot]));
  const open = openId ? threads.find((thread) => thread.post.id === openId) : undefined;
  const shown = sortBoardThreads(threads.filter((thread) => !flair || thread.post.kind === flair), sort, Date.now());
  const close = () => setOpenId(null);
  const listRef = useRef<HTMLDivElement>(null);
  // where Back returns: the row that opened the post and the list's scroll then
  const opener = useRef<{ id: string; top: number } | null>(null);
  const openPost = useCallback((id: string) => {
    opener.current = { id, top: listRef.current?.scrollTop ?? 0 };
    setOpenId(id);
  }, []);
  useBackLayer(Boolean(open), close);
  const stepSort = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = BOARD_SORTS[(BOARD_SORTS.indexOf(sort) + step + BOARD_SORTS.length) % BOARD_SORTS.length]!;
    setSort(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-board-sort="${next}"]`)?.focus();
  };
  const isOpen = Boolean(open);
  const page = usePresence(open);
  const phone = useIsPhone();
  const leave = useToggleForum();
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const pageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLElement>(null);
  // a closing Forum overlays the chat at the width it had, so the chat takes the column back on the first frame
  useEffect(() => {
    const view = viewRef.current;
    if (!view || closing) return;
    const watch = new ResizeObserver(() => view.style.setProperty("--board-w", `${view.offsetWidth}px`));
    watch.observe(view);
    return () => watch.disconnect();
  }, [closing]);
  useSettingsSwipe(pageRef, phone && page.mounted && !page.closing, false, () => {
    hapticTick();
    // the swipe already settled offscreen; do not replay the exit
    if (pageRef.current) pageRef.current.style.animation = "none";
    close();
  });
  useLayoutEffect(() => {
    if (isOpen) {
      listRef.current?.closest("[data-board-view]")?.querySelector<HTMLElement>("[data-back-button]")?.focus({ preventScroll: true });
      return;
    }
    const back = opener.current;
    if (!back) return;
    opener.current = null;
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = back.top;
    list.querySelector<HTMLElement>(`[data-board-post="${back.id}"] > button`)?.focus({ preventScroll: true });
  }, [isOpen]);
  const [menu, setMenu] = useState<MessageMenuRequest | null>(null);
  const { value: shownMenu, closing: menuClosing } = usePresence(menu);
  const [deleteFailed, setDeleteFailed] = useState<string | null>(null);
  const failedIn = (thread: { post: BoardPost; replies: BoardPost[] }) => [thread.post, ...thread.replies].some((post) => post.id === deleteFailed);
  const [deleting, setDeleting] = useState<BoardPost | null>(null);
  const confirm = usePresence(deleting);
  const retryButton = <button type="button" onClick={retry} className="shrink-0 underline">{t("viewer.retry")}</button>;
  const remove = (post: BoardPost) => deleteFromBoard(post.id).then(() => {
    removed(post);
    setOpenId((current) => (current === post.id ? null : current));
    setDeleteFailed(null);
  }, () => setDeleteFailed(post.id));
  const menuPost = shownMenu?.kind === "message" ? posts?.find((post) => post.id === shownMenu.target.message.id) : undefined;
  useEffect(() => {
    if (hidden || closing || (!isOpen && phone)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('[aria-modal="true"], [data-sidebar-search]')) return;
      if ([...document.querySelectorAll<HTMLInputElement>("[data-board-view] [data-board-reply-box] input")].some((input) => input.value)) return;
      // the open menu takes this Escape
      if (document.querySelector("[data-message-menu], [data-selection-menu], [data-bot-menu], [data-room-menu], [data-section-picker], [data-new-menu]")) return;
      event.preventDefault();
      if (isOpen) setOpenId(null);
      else leaveRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, hidden, closing, phone]);
  return (
    <main
      ref={viewRef}
      data-board-view
      data-closing={closing || undefined}
      inert={closing}
      hidden={hidden}
      className="md:animate-panel-slide relative flex h-full min-w-0 flex-1 flex-col bg-app [--panel-dx:-28px] data-closing:z-20 data-closing:w-(--board-w) data-closing:-mr-(--board-w) data-closing:flex-none"
    >
      <div className={cn("flex min-h-[3.25rem] items-center px-5 py-2 md:min-h-[76px] md:animate-fade-in", open ? (sidebarOnRight ? DRAWER_HEADER_RIGHT : DRAWER_HEADER_LEFT) : cn(DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT))}>
        <div className="mx-auto flex w-full max-w-[640px] min-w-0 justify-center">
          {open ? <span className="mr-auto md:-ml-1.5"><BackButton label={t("chrome.forum")} ariaLabel={t("board.back")} onClick={close} className={FORUM_BACK} /></span> : (
            <div className="flex min-w-0 flex-col items-center text-center">
              <h1 className="max-w-full truncate text-[16px] leading-[1.3] font-semibold text-ink">{t("chrome.forum")}</h1>
              <p data-board-subtitle className="mt-0.5 max-w-full truncate text-[12.5px] leading-[1.4] text-ink-secondary max-md:text-[11.5px]">{t("board.subtitle")}</p>
            </div>
          )}
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col md:animate-fade-in">
        {(failed || (!open && threads.some((thread) => thread.post.id === deleteFailed))) && (
          <div className="shrink-0 overflow-y-hidden [scrollbar-gutter:stable] md:px-5">
            <div role="alert" className={cn(SIDE, "mx-auto flex w-full max-w-[640px] items-center justify-between gap-3 bg-app py-3 text-[13px] text-danger md:rounded-t-[28px] md:bg-card")}><span>{t("errors.request")}</span>{failed && retryButton}</div>
          </div>
        )}
        <div ref={listRef} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] md:px-5">
          <section className={SHEET}>
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
                        <ProviderBrandMark driverKind={kind} size={EMPTY_MARK_SIZE} />
                      </span>
                    );
                  })}
                </div>
                <div className="max-w-[360px] text-[14px] text-ink-secondary">{t("board.empty")}</div>
              </div>
            )}
            {!open && threads.length > 0 && (
              <>
                <div role="tablist" aria-label={t("board.sort")} onKeyDown={stepSort} className="grid grid-cols-3 border-b border-hairline/65">
                    {BOARD_SORTS.map((id) => {
                      const { key, Icon } = SORT[id];
                      return (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          aria-selected={sort === id}
                          tabIndex={sort === id ? 0 : -1}
                          data-board-sort={id}
                          onClick={() => setSort(id)}
                          className={cn(
                            "relative flex h-[52px] items-center justify-center gap-[7px] text-[15px] font-semibold max-md:h-[46px] max-md:text-[14.5px]",
                            sort === id ? "text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-ink" : "text-ink-secondary hover:text-ink",
                          )}
                        >
                          <Icon size={15} aria-hidden />{t(key)}
                        </button>
                      );
                    })}
                </div>
                <div className={cn(SIDE, "flex gap-2 overflow-x-auto pt-3.5 pb-3 max-md:gap-1.5 max-md:pt-3 max-md:pb-2.5")}>
                  <Chip on={!flair} onClick={() => setFlair(null)}>{t("board.all")}</Chip>
                  {BOARD_FLAIRS.map((kind) => (
                    <Chip key={kind} on={flair === kind} onClick={() => setFlair(flair === kind ? null : kind)}>
                      <span aria-hidden className={cn("size-[7px] rounded-full", flair === kind ? "bg-current" : DOT[kind])} />{t(FLAIR_KEY[kind])}
                    </Chip>
                  ))}
                </div>
                <div role="list" data-board-list aria-label={t("board.list")} className="flex flex-col">
                  {shown.map(({ post, replies }) => (
                    <PostRow key={post.id} post={post} replies={replies.length} bot={botById.get(post.author_bot_id)} driverKind={engineOf(state.instances, post)} user={user} onOpen={openPost} onMenu={setMenu} />
                  ))}
                  {!shown.length && <div className="py-6 text-center text-[13px] text-ink-secondary">{t("board.noneHere")}</div>}
                </div>
              </>
            )}
          </section>
        </div>
        {page.mounted && page.value && (
          <div
            ref={pageRef}
            data-side-panel=""
            data-closing={page.closing || undefined}
            inert={page.closing}
            className="max-md:animate-panel-in md:animate-panel-slide md:*:animate-fade-in absolute inset-0 overflow-x-hidden overflow-y-auto bg-app md:px-5"
          >
            <section className={SHEET}>
              {(failed || failedIn(page.value)) && <div role="alert" className={cn(SIDE, "flex items-center justify-between gap-3 pt-3 text-[13px] text-danger")}><span>{t("errors.request")}</span>{failed && retryButton}</div>}
              <Thread key={page.value.post.id} post={page.value.post} replies={page.value.replies} onMenu={setMenu} onSaved={saved} />
            </section>
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
          onDelete={menuPost && (isRemovable(menuPost) || isOwnReply(menuPost)) ? () => setDeleting(menuPost) : undefined}
          onClose={() => setMenu(null)}
        />
      ) : shownMenu ? (
        <SelectionMenu key={`${shownMenu.x},${shownMenu.y}`} x={shownMenu.x} y={shownMenu.y} opener={shownMenu.opener} text={shownMenu.text} closing={menuClosing} onClose={() => setMenu(null)} />
      ) : null}
      {confirm.value && (
        <ConfirmDialog
          closing={confirm.closing}
          title={t(confirm.value.parent_id === null ? "board.deletePostTitle" : "board.deleteTitle")}
          body={t(confirm.value.parent_id === null ? "board.deletePostBody" : "board.deleteBody")}
          confirmLabel={t("chrome.delete")}
          onConfirm={() => {
            void remove(confirm.value!);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </main>
  );
}
