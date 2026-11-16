// The Forum: the Board's posts in the room message look, newest first; a post opens its replies.
import { useState } from "react";
import { ChevronLeft, MessagesSquare } from "lucide-react";

import { BOARD_USER, boardThreads, useBoardPosts, type BoardPost } from "@/lib/board";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { cn } from "@/lib/cn";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { useI18n } from "@/lib/i18n";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { useBackLayer } from "@/lib/use-back-layer";
import { useStore } from "@/state/store";
import type { Bot } from "@/state/store-types";

import { RoomBotAvatar } from "./Avatar";
import { TimestampLabel } from "./ChatBubble";
import { ChatMarkdown } from "./ChatMarkdown";
import { PersonLabel } from "./GroupPeople";
import { MessageBoundary } from "./TurnPresence";

const BUBBLE = "w-fit max-w-full rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed break-words";

function Author({ post, bots }: { post: BoardPost; bots: readonly Bot[] }) {
  const { t } = useI18n();
  if (post.author_bot_id === BOARD_USER) return <PersonLabel name={t("chat.you")} />;
  const bot = bots.find((candidate) => candidate.id === post.author_bot_id);
  return (
    <div className="mt-1 flex items-center gap-1.5 pl-0.5">
      <RoomBotAvatar bot={bot ?? { name: t("errors.bot") }} state="happy" size={16} motion="none" motionKey={0} animated={false} />
      <span className="text-[11px] font-medium text-ink-secondary">{bot?.name ?? t("errors.bot")}</span>
    </div>
  );
}

function PostText({ post }: { post: BoardPost }) {
  const text = post.kind === "fix" || !post.body || post.body === post.title ? post.body || post.title : `**${post.title}**\n\n${post.body}`;
  return <MessageBoundary fallbackText={text}><ChatMarkdown text={text} localLinks={false} /></MessageBoundary>;
}

function PostRow({ post, replies, bots, onOpen }: { post: BoardPost; replies?: number; bots: readonly Bot[]; onOpen?: () => void }) {
  const { t } = useI18n();
  const mine = post.author_bot_id === BOARD_USER;
  const helped = post.helped_bot_ids.map((id) => bots.find((bot) => bot.id === id)?.name).filter(Boolean).map((name) => `@${name}`);
  const bubble = cn(BUBBLE, mine ? "bg-bubble-user text-ink" : "bg-card text-ink");
  return (
    <div data-board-post={post.id} className={cn("flex w-full flex-col", mine ? "items-end" : "items-start")}>
      {!mine && <Author post={post} bots={bots} />}
      <div className="relative w-fit max-w-[min(42rem,78%)]">
        {onOpen ? (
          <button type="button" onClick={onOpen} className={cn(bubble, "block text-left hover:brightness-[1.04]")}>
            <PostText post={post} />
          </button>
        ) : (
          <div className={bubble}><PostText post={post} /></div>
        )}
      </div>
      {post.kind !== "fix" && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-0.5 text-[12px] text-ink-secondary">
          <span
            data-board-status={post.status}
            className={cn("flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", post.status === "solved" ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}
          >
            {t(post.status === "solved" ? "board.solved" : "board.open")}
          </span>
          {helped.length > 0 && <span data-board-used-by>{t("board.usedBy", { names: helped.join(", ") })}</span>}
          {replies !== undefined && replies > 0 && <span className="flex items-center gap-1"><MessagesSquare size={12} aria-hidden />{replies}</span>}
        </div>
      )}
      <TimestampLabel at={post.created_at} />
    </div>
  );
}

export function BoardView({ hidden = false }: { hidden?: boolean }) {
  const { t } = useI18n();
  const { state } = useStore();
  const sidebarOnRight = useSidebarSide() === "right";
  const { posts, failed } = useBoardPosts();
  const [openId, setOpenId] = useState<string | null>(null);
  const threads = boardThreads(posts ?? []);
  const open = openId ? threads.find((thread) => thread.post.id === openId) : undefined;
  useBackLayer(Boolean(open), () => setOpenId(null));
  return (
    <main data-board-view hidden={hidden} className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className={cn("flex min-h-[3.25rem] items-center gap-1 px-5 py-3", sidebarOnRight ? DRAWER_HEADER_RIGHT : DRAWER_HEADER_LEFT)}>
        {open && (
          <button
            type="button"
            onClick={() => setOpenId(null)}
            aria-label={t("board.back")}
            title={t("board.back")}
            className="-ml-2 flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <ChevronLeft size={18} />
          </button>
        )}
        <h1 className="min-w-0 truncate text-[15px] font-semibold text-ink">{t("chrome.forum")}</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        <div role="list" aria-label={t("board.list")} className={cn("flex w-full flex-col gap-3 px-5 pb-4", CHAT_COLUMN_CLASS)}>
          {failed && <div role="alert" className="text-[13px] text-danger">{t("errors.request")}</div>}
          {posts && !threads.length && (
            <div data-board-empty className="flex flex-col items-center justify-center gap-3 py-24 text-center">
              <MessagesSquare size={40} className="text-ink-secondary" aria-hidden />
              <div className="max-w-[360px] text-[14px] text-ink-secondary">{t("board.empty")}</div>
            </div>
          )}
          {open ? (
            <>
              <div role="listitem"><PostRow post={open.post} bots={state.bots} /></div>
              {open.replies.map((reply) => <div role="listitem" key={reply.id}><PostRow post={reply} bots={state.bots} /></div>)}
              {!open.replies.length && <div className="py-3 text-center text-[13px] text-ink-secondary">{t("board.noReplies")}</div>}
            </>
          ) : threads.map(({ post, replies }) => (
            <div role="listitem" key={post.id}><PostRow post={post} replies={replies.length} bots={state.bots} onOpen={() => setOpenId(post.id)} /></div>
          ))}
        </div>
      </div>
    </main>
  );
}
