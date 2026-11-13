// A room: several bots + you in one shared thread. The sidebar and call view
// carry the personality; avatars inside the room stay still so a busy group
// does not become a wall of competing motion. Plain messages go to the room's
// default responder; @mentions override that routing.
import { ActivityChip, ErrorRow, NoteMessage, PinnedBanner, commPeer } from "./ChatView";
import { FoldToggle, TimestampLabel, USER_FOLD_CLASS, userTextFolds } from "./ChatBubble";
import { AppErrorBanner } from "./AppErrorBanner";
import { DaySeparator } from "./DaySeparator";
import { JumpToLatest } from "./JumpToLatest";
import { VerifyCard } from "./VerifyCard";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, FolderOpen, Loader2, MessageSquareReply } from "lucide-react";
import { isVoiceLine } from "../../shared/live-call";
import {
  api,
  useStore,
  useStreaming,
  openNotificationTarget,
  type Bot,
  type Group,
  type GroupDefaultResponder,
  type Message,
} from "@/state/store";
import type { RoomJoin } from "@/state/store-types";
import { BotAvatar } from "./Avatar";
import { CallWidgetSlot } from "./CallSlots";
import { DockedPresence, MessageBoundary, TurnPresence, replySlot, useReplyDock, type ReplyDock } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { isTerminalSkin, isTerminalToolSkin, useSkin } from "@/lib/skins";
import { logLine } from "@/lib/terminal-skin";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { isAskUserCard, pinnedQuestion } from "@/lib/open-question";
import { isRinging } from "@/lib/routine-ring";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { DEFAULT_MAUS_COLOR, normalizeState } from "@/lib/mascot";
import { groupResponseHint } from "@/lib/group-routing";
import { ChatMarkdown } from "./ChatMarkdown";
import { LinkedText } from "./LinkedText";
import { ChatOptionChips } from "./ChatOptionChips";
import { AskUserRecord } from "./AskUserRecord";
import { MemorySaveChip, MemorySaveRun } from "./MemorySaveChip";
import { PeerMessageBody, commLabel } from "./PeerMessage";
import { detectChatOptions, laterUserAnswer } from "@/lib/chat-options";
import { focusComposerOnActivation, shouldFocusComposerOnTranscriptClick } from "@/lib/focus-composer";
import { Composer } from "./Composer";
import { ContextCompactionDivider, TaskRecoveryCard } from "./TaskRecoveryCard";
import { roomRecoveryBusy, roomRecoveryPacket } from "@/lib/task-recovery";
import { ChatFindBar } from "./ChatFindBar";
import { ReconnectingCue } from "./ReconnectingCue";
import { showChannelCallControl } from "@/lib/friends-chrome";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { WorkerRow, WorkerChip, useWorkerRows, type ShownRun } from "./WorkerRows";
import { shownState, workerRuns } from "@/lib/worker-runs";
import { AttachedImageGallery, ShownImage } from "./AttachmentPreview";
import { MediaViewerProvider } from "./MediaViewerProvider";
import { FileAttachmentRows } from "./FileAttachmentRow";
import { RoomFileRows, RoomLineText, roomPictures } from "./TeamRoomRow";
import { GroupCallButton, GroupCallOverlay } from "./GroupCallView";
import { ReactionBar, ReactionChips } from "./Reactions";
import { MessageMenu, SelectionMenu, contextClickKind, endSelectMode, holdToOpen, isTouchPrimary, keepsNativeMenu, type MessageMenuRequest } from "./MessageMenu";
import { ApprovalCard } from "./ApprovalCard";
import { RoomTitle } from "./RoomTitle";
import { RoomAlertsBell } from "./RoomAlertsBell";
import { RoomNotice } from "./RoomNotice";
import { RoomPicture } from "./RoomPicture";
import { ShowPaneButton } from "./ShowPaneButton";
import { GroupArchiveBar } from "./GroupArchiveBar";
import { PersonLabel, RoomJoinLine } from "./GroupPeople";
import { useGroupArchive } from "@/lib/group-archive";
import { placeJoins } from "@/lib/room-joins";
import { hostLines, hostRoomBase, reactionNames, roomJoins, roomNoticeText, roomPeople, roomPictureUrl, setHostNotice } from "@/lib/team-rooms";
import { groupActivityRuns, itemMatchesFind, shownRunStep, type LinkedApproval } from "@/lib/activity-runs";
import { messageVisible, roomTranscriptRows } from "@/lib/room-transcript";
import { isShownMessage } from "@/lib/shown-message";
import { roomRetry } from "@/lib/room-retry";
import { useTranslationAvailable } from "@/lib/room-translate";
import { ActivityRun } from "./ActivityRun";
import { FolderFix } from "./FolderFix";
import { CHAT_IMAGE } from "@/lib/chat-image";
import { cn } from "@/lib/cn";
import { useSearchFindSeed } from "@/lib/chat-find";
import { useFindCurrentId } from "@/lib/chat-find";
import { useFocusMessage } from "@/lib/focus-message";
import { createEarlierWindow, screenImageUrl, useEarlierPage, useForwardWindow, useJumpWindow, useOlderMessages, useThreadMessage } from "@/lib/message-pages";
import { useOlderOnScroll } from "@/lib/use-older-on-scroll";
import { BOTTOM_FOLLOW_THRESHOLD, captureTranscriptScroll, newestBelowView, restoreTranscriptScroll, shouldResumeBottomFollow, spaceAfterNewestRow, transcriptUnderfilled, type TranscriptScroll } from "@/lib/bottom-follow";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { TRANSCRIPT_GAP, useComposerDockPad } from "@/lib/composer-dock";
import { turnPresenceWaiting } from "@/lib/send-accept";
import { useI18n } from "@/lib/i18n";
import { useRoomTurnStage } from "@/lib/room-turn";
import { buffersForTurn } from "@/lib/turn-stage";
import { splitAttachedImages } from "@/lib/composer-attachments";
import { usePresence } from "@/lib/use-presence";
import {
  TRANSCRIPT_WINDOW_SIZE,
  focusWindow,
  followedWindow,
  resolveTranscriptWindow,
  shiftForPrepend,
  tailWindowStart,
} from "@/lib/transcript-window";
import { useReplyDraft } from "@/lib/drafts";

/** One activity row in a room: the 1:1 rows, plus the room's folder fix and a still comm avatar. */
export function RoomToolChip({
  message,
  notices,
  onRetry,
  group,
}: {
  message: Message;
  notices?: LinkedApproval[];
  onRetry?: (callbacks?: { onError?: () => void }) => void;
  group?: Group;
}) {
  const { dispatch, state } = useStore();
  const { t } = useI18n();
  const [retried, setRetried] = useState(false);
  const tool = message.tool;
  if (!tool) return null;
  if (tool.name === "memory.save") return <MemorySaveChip summary={tool.spoken ?? ""} at={message.at} room />;
  const handleRetry = onRetry
    ? () => {
        if (retried) return;
        setRetried(true);
        onRetry({ onError: () => setRetried(false) });
      }
    : undefined;
  if (tool.folder) return <FolderFix folder={tool.folder} botId={message.from?.botId} group={group} onRetry={handleRetry} />;
  const comm = message.comm;
  if (comm) {
    const peer = commPeer(state.bots, comm);
    const chip = (
      <div className="flex justify-start">
        <button
          type="button"
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={t("chat.openConversation", { name: comm.withName })}
          className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-transparent px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-ink focus-visible:bg-control focus-visible:text-ink"
        >
          <BotAvatar bot={peer ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />
          <span className="min-w-0 max-w-[480px] truncate">{commLabel(message, t)}</span>
          <ChevronRight size={13} className="shrink-0" />
        </button>
      </div>
    );
    if (!message.text) return chip;
    return (
      <div>
        {chip}
        <PeerMessageBody text={message.text} />
      </div>
    );
  }
  if (!tool.name.startsWith("error:")) return <ActivityChip message={message} notices={notices} />;
  const member = message.from?.botId ? state.bots.find((bot) => bot.id === message.from?.botId) : undefined;
  const accountId = tool.accountId;
  const setupId = accountId ?? (tool.setup || tool.signIn ? member?.modelSelection?.instanceId : undefined);
  return (
    <ErrorRow
      botId={member?.id ?? ""}
      botName={member?.name ?? message.from?.name}
      message={tool.name.slice(6).trim()}
      onRetry={handleRetry}
      retryDisabled={retried}
      setupInstance={setupId ? state.instances.find((instance) => instance.instanceId === setupId) : undefined}
      bound={Boolean(accountId)}
      usageLimit={tool.usageLimit}
      usageWait={tool.usageWait}
      signIn={tool.signIn}
      identities={state.instances.map((instance) => instance.snapshot.account)}
    />
  );
}

/** 16px maus + name, shown once per sender cluster. */
function ClusterLabel({ bot, name, color }: { bot?: Bot; name: string; color: Bot["color"] }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 pl-0.5">
      <BotAvatar
        bot={bot ?? { name, color }}
        state={normalizeState(bot?.mascotExpression) ?? "happy"}
        size={16}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span className="text-[11px] font-medium text-ink-secondary">{name}</span>
    </div>
  );
}

function RoomReplyQuote({ group, replyToId, transcript, fallbackName }: { group: Group; replyToId: string; transcript: Message[]; fallbackName?: string }) {
  const { dispatch } = useStore();
  const target = useThreadMessage(
    group.threadId,
    group.hasMore ? replyToId : undefined,
    transcript.find((candidate) => candidate.id === replyToId),
  );
  return target ? (
    <div className="mb-2">
      <ReplyQuote
        message={target}
        fallbackName={fallbackName}
        compact
        onJump={() => dispatch({ type: "focusMessage", threadId: group.threadId, messageId: target.id })}
      />
    </div>
  ) : null;
}

const NO_JOINS: RoomJoin[] = [];

export const Transcript = memo(function Transcript({
  group,
  members,
  messages,
  transcript,
  streamingMessage,
  dock,
  onReply,
  onMessageMenu,
  workers,
  joins = NO_JOINS,
  readOnly = false,
}: {
  group: Group;
  members: Bot[];
  /** The windowed suffix of group.messages — the boundary lives in GroupView. */
  messages: Message[];
  /** Full room transcript, used to resolve quoted messages outside the mounted window. */
  transcript: Message[];
  streamingMessage: Message | null;
  dock: ReplyDock | null;
  onReply: (message: Message) => void;
  onMessageMenu: (menu: MessageMenuRequest) => void;
  workers: ShownRun[];
  joins?: RoomJoin[];
  /** An older task: shown, never changed. */
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const skin = useSkin();
  const roomBase = group.hosted ? hostRoomBase(group.hosted.roomId) : null;
  const canTranslate = useTranslationAvailable(roomBase ?? "");
  const terminal = isTerminalToolSkin(skin);
  const showToolCalls = showToolCallsEnabled(state.config);
  const showActivities = showToolCalls || terminal;
  const memberOf = (id?: string) => members.find((b) => b.id === id);
  const people = useMemo(() => {
    if (!group.hosted) return undefined;
    const names = reactionNames(roomPeople(group));
    for (const m of transcript) if (m.author?.kind === "person") names.set(`person:${m.author.id}`, m.author.name);
    return names;
  }, [group, transcript]);
  // Several bots working at once turn a room into a wall of chips; fold the
  // finished ones the same way a 1:1 chat does.
  const { workerAt, open, toggle } = useWorkerRows(workers, messages);
  const items = useMemo(
    () => groupActivityRuns(
      streamingMessage ? [...messages, streamingMessage] : messages,
      terminal,
      (m) => workerAt.has(m.id) ? Boolean(workerAt.get(m.id)) : messageVisible(m, showToolCalls, showActivities),
    ),
    [messages, streamingMessage, terminal, showToolCalls, showActivities, workerAt],
  );
  const rows = useMemo(
    () => roomTranscriptRows(items, { showToolCalls, showActivities, workers: workerAt }),
    [items, showToolCalls, showActivities, workerAt],
  );
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const toggleFold = (id: string) => setUnfolded((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const joinsAt = useMemo(
    () => placeJoins(joins, items.map((item, i) => (rows[i].visible ? (item.kind === "message" ? item.message : item.messages[0]).at : null)), messages[0]?.id === transcript[0]?.id),
    [joins, items, rows, messages, transcript],
  );
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === group.threadId ? focus.messageId : null;
  const findCurrent = useFindCurrentId();
  const lastBotTextId = [...transcript].reverse().find((entry) => entry.role === "bot" && entry.kind === "text" && !isVoiceLine(entry) && isShownMessage(entry))?.id;
  const target = roomRetry(group.messages, members, group, group.threadId, group.busyBotId, { allowSetup: true });
  const onRetryFor = (messageId: string) =>
    target && !readOnly && messageId === target.messageId
      ? (callbacks?: { onError?: () => void }) => {
          const onError = callbacks?.onError;
          dispatch({
            type: "sendGroup",
            groupId: group.id,
            text: target.text,
            replyToId: target.replyToId,
            threadId: target.threadId,
            onError,
          });
        }
      : undefined;
  const slots = new Set<string>();
  // Two branches can share a reply slot; only the newest visible reply takes the dock.
  const dockTargetId = dock
    ? items.reduce<string | null>(
        (target, item, i) =>
          rows[i].visible && item.kind === "message" && item.message.role === "bot" && item.message.kind === "text" && !isVoiceLine(item.message) ? item.message.id : target,
        null,
      )
    : null;
  return (
    <>
      {items.map((item, i) => {
        const { visible, newDay, cluster } = rows[i];
        const found = item.kind === "message"
          ? item.message.kind === "activity" && itemMatchesFind(item, findCurrent)
          : itemMatchesFind(item, findCurrent);
        if (!visible && !found) return null;
        if (item.kind !== "message") {
          const first = item.messages[0];
          const forceOpen = found || item.messages.some((step) => step.id === focusedId);
          return (
            <div key={item.id} className="contents" data-run={item.id} {...logLine(skin === "logfile", first.at, item.messages)}>
              {newDay && <DaySeparator at={first.at} />}
              {joinsAt.at.get(i)?.map((join) => <RoomJoinLine key={join.personId} name={join.name} />)}
              {first.from && cluster && (
                <ClusterLabel bot={memberOf(first.from.botId)} name={first.from.name} color={first.from.color} />
              )}
              {item.kind === "memory" ? (
                <MemorySaveRun messages={item.messages} forceOpen={forceOpen}>
                  {item.messages.map((step) => (
                    <div key={step.id} className="contents" data-mid={step.id}>
                      <RoomToolChip message={step} />
                    </div>
                  ))}
                </MemorySaveRun>
              ) : (
                <ActivityRun messages={item.messages} forceOpen={forceOpen}>
                  {item.messages
                    .filter((step) => shownRunStep(step, { terminal, showActivities, findId: findCurrent, notices: item.notices?.get(step.id) }))
                    .map((step) => (
                    <div key={step.id} className="contents" data-mid={step.id} data-find-for={item.notices?.get(step.id)?.map((notice) => notice.message.id).join(" ") || undefined}>
                      <RoomToolChip
                        group={group}
                        message={step}
                        notices={item.notices?.get(step.id)}
                        onRetry={onRetryFor(step.id)}
                      />
                    </div>
                  ))}
                </ActivityRun>
              )}
            </div>
          );
        }
        const m = item.message;
        const user = m.role === "user";
        const person = user && m.author?.kind === "person" ? m.author : null;
        const mine = user && !person;
        const streaming = m === streamingMessage;
        // rooms ship every branch, so two replies can share a parent
        const slot = !user && m.kind === "text" ? replySlot(group.threadId, m, transcript) : null;
        const key = slot && !slots.has(slot) ? slot : m.id;
        slots.add(key);
        const docked = dock && dock.slot === slot && m.id === dockTargetId ? dock : null;
        const attachedImages = user && m.text ? splitAttachedImages(m.text) : null;
        const folded = mine && !unfolded.has(m.id) && userTextFolds(attachedImages?.display ?? m.text ?? "");
        const menuTarget =
          m.kind === "text" && (m.text || m.roomFiles?.length) && !m.placeholder && !readOnly
            ? {
              threadId: group.threadId,
              message: m,
              copyText: attachedImages?.display ?? m.text ?? "",
              user: mine,
              pinned: roomBase ? group.notice?.entryId === m.roomEntryId : group.pinnedMessageId === m.id,
              canPin: (!roomBase || Boolean(m.roomEntryId)) && (user || (!streaming && !docked?.live)),
              notice: Boolean(roomBase),
            }
            : null;
        const detectedOptions =
          !user && !streaming && m.kind === "text" ? detectChatOptions(m.text ?? "") : null;
        const answeredChoice = detectedOptions ? laterUserAnswer(transcript, m.id) : null;
        const optionChoices =
          detectedOptions && (answeredChoice != null || m.id === lastBotTextId)
            ? detectedOptions
            : null;
        const markdownText =
          optionChoices?.messagePrefix != null ? optionChoices.messagePrefix : (m.text ?? "");
        const choicesOnly = Boolean(optionChoices) && !markdownText.trim() && !m.replyToId;
        // the room's pinned folder, else its shared desk, else the writer's own
        const botFolder = (group.pinnedCwd === undefined ? group.cwd : group.pinnedCwd) ?? memberOf(m.from?.botId)?.cwd;
        const routineOwner = m.kind === "routine.run" ? memberOf(m.from?.botId) : undefined;
        const routineExecutionThreadId = m.routineRun?.executionThreadId;
        const routineTarget = routineOwner && hasRoutineExecutionTask(routineOwner.tasks, routineExecutionThreadId)
          ? { botId: routineOwner.id, threadId: routineExecutionThreadId }
          : undefined;
        const routineRun = m.kind === "routine.run" ? state.routineRuns.find((run) => run.id === m.routineRun?.runId) : undefined;
        const worker = workerAt.get(m.id);
        const row = worker ? (
          <WorkerRow {...worker} live={null} open={open.has(worker.run.id)} onToggle={() => toggle(worker.run.id)} />
        ) :
          // a member can hit a permission ask mid-turn; without this the
          // card never rendered here and the bot waited out its timeout.
          // `tool` distinguishes a permission from a QUESTION — a question
          // only accepts an "answer", so routing it here would offer an
          // Allow the broker rejects
          m.kind === "note" ? (
            m.verify ? <VerifyCard card={m.verify} threadId={group.threadId} messageId={m.id} /> : <NoteMessage message={m} />
          ) : m.kind === "secret" && m.secret && m.from?.botId ? (
            <SecretRequestCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "connector" && m.connector && m.from?.botId ? (
            <ConnectorCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "options" && m.card?.requestId && m.card.tool ? (
            <div className="flex justify-start">
              <ApprovalCard bot={memberOf(m.from?.botId)} message={m} />
            </div>
          ) : isAskUserCard(m) ? (
            <div className="flex justify-start empty:hidden">
              <AskUserRecord
                message={m}
                transcript={transcript}
                askerName={memberOf(m.from?.botId)?.name ?? m.from?.name}
                pinned={pinnedQuestion(group.messages)?.id === m.id}
                onPick={readOnly ? undefined : (answer) => dispatch({ type: "answerGroupCard", groupId: group.id, messageId: m.id, answer })}
              />
            </div>
          ) : m.kind === "compaction" ? (
            <ContextCompactionDivider message={m} />
          ) : m.kind === "routine.run" ? (
            <div className="flex justify-start">
              <RoutineRunCard
                message={m}
                ringing={Boolean(routineRun && isRinging(routineRun))}
                onOpen={routineTarget
                  ? () => openNotificationTarget(dispatch, routineTarget, state)
                  : undefined}
              />
            </div>
          ) : m.kind === "activity" && m.tool ? (
            <RoomToolChip
              group={group}
              message={m}
              notices={item.notices}
              onRetry={onRetryFor(m.id)}
            />
          ) : m.kind === "screen" && m.image ? (
            <ShownImage name={m.image} caption={m.text} />
          ) : m.kind === "screen" && (m.png || m.hasImage) ? (
            <div className="flex flex-col items-start gap-1">
              <img
                src={m.png ? `data:${m.mime ?? "image/png"};base64,${m.png}` : screenImageUrl(group.threadId, m.id)}
                alt={m.text || t("chrome.screenFrame")}
                style={CHAT_IMAGE}
                className="rounded-2xl border border-hairline/40"
              />
              {m.text && <p className="max-w-[min(42rem,78%)] px-1 text-[13px] text-ink-secondary">{m.text}</p>}
            </div>
          ) : m.kind === "text" && (m.text || m.roomFiles?.length) ? (
            <div
              data-orbit-message={user ? "user" : "bot"}
              className={cn("group flex w-full flex-col outline-none", mine ? "animate-msg-in items-end" : "items-start")}
              tabIndex={-1}
              {...holdToOpen(menuTarget && ((x, y, opener) => onMessageMenu({ kind: "message", x, y, opener, target: menuTarget })))}
              onContextMenu={menuTarget ? (e) => {
                if (isTouchPrimary() || !(e.target instanceof Element)) return;
                const kind = contextClickKind(e.target, e.clientX, e.clientY);
                if (kind === "native") return;
                e.preventDefault();
                e.stopPropagation();
                onMessageMenu(kind === "selection"
                  ? { kind, x: e.clientX, y: e.clientY, opener: e.currentTarget, text: window.getSelection()?.toString() ?? "" }
                  : { kind, x: e.clientX, y: e.clientY, opener: e.currentTarget, target: menuTarget });
              } : undefined}
              onKeyDown={menuTarget ? (e) => {
                if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
                if (e.target instanceof Element && keepsNativeMenu(e.target)) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                onMessageMenu({
                  kind: "message",
                  x: rect.left + rect.width / 2,
                  y: rect.top + rect.height / 2,
                  opener: e.currentTarget,
                  target: menuTarget,
                });
              } : undefined}
            >
              <div
                data-orbit-message-body
                data-strip={m.reactions?.length ? "" : undefined}
                className={cn("relative w-fit max-w-[min(42rem,78%)]", Boolean(m.reactions?.length) && "pb-3.5")}
              >
                {mine && !readOnly && (
                  <div
                    data-message-hover-actions
                    className="pointer-events-none absolute top-1/2 right-full z-20 mr-0.5 flex -translate-y-1/2 items-center gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                  >
                    <button
                      type="button"
                      onClick={() => onReply(m)}
                      aria-label={t("chat.replyToMessage")}
                      title={t("chat.replyToMessage")}
                      className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                    >
                      <MessageSquareReply size={14} />
                    </button>

                  </div>
                )}
                {!choicesOnly && (
                <div
                  data-orbit-message-content
                  className={cn(
                    "w-fit max-w-full rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed break-words",
                    user ? cn("whitespace-pre-wrap text-ink", mine ? "bg-bubble-user" : "bg-card") : "bg-card text-ink",
                  )}
                >
                  {m.replyToId && <RoomReplyQuote group={group} replyToId={m.replyToId} transcript={transcript} fallbackName={members.length === 1 ? members[0].name : undefined} />}
                  {user ? (
                    <>
                      {attachedImages && attachedImages.images.length > 0 && (
                        <AttachedImageGallery paths={attachedImages.images} />
                      )}
                      {roomBase && m.roomFiles && <AttachedImageGallery pictures={roomPictures(roomBase, m.roomFiles)} className={cn(!mine && "justify-start")} />}
                      <div className={cn(folded && USER_FOLD_CLASS)}>
                        {roomBase ? <RoomLineText base={roomBase} entryId={person ? m.roomEntryId : undefined} text={attachedImages?.display ?? m.text ?? ""} canTranslate={canTranslate} /> : <LinkedText text={attachedImages?.display ?? m.text ?? ""} />}
                      </div>
                      {attachedImages && <FileAttachmentRows files={attachedImages.files} className={cn(attachedImages.display && "mt-2")} />}
                      {roomBase && m.roomFiles && <RoomFileRows base={roomBase} files={m.roomFiles} className={cn(m.text && "mt-2")} />}
                      {(folded || unfolded.has(m.id)) && <FoldToggle expanded={!folded} onToggle={() => toggleFold(m.id)} />}
                    </>
                  ) : markdownText.trim() ? (
                    <MessageBoundary fallbackText={markdownText}>
                      {roomBase ? <RoomLineText base={roomBase} entryId={`m-${m.id}`} text={markdownText} canTranslate={canTranslate && !streaming}>
                        <ChatMarkdown text={markdownText} streaming={streaming} whole={m.streamWhole} baseDir={botFolder} threadId={group.threadId} />
                      </RoomLineText> : <ChatMarkdown text={markdownText} streaming={streaming} whole={m.streamWhole} baseDir={botFolder} threadId={group.threadId} />}
                    </MessageBoundary>
                  ) : null}
                </div>
                )}
                {!mine && !streaming && !docked?.live && !readOnly && (
                  <div
                    data-message-hover-actions
                    className="pointer-events-none absolute top-1/2 left-full z-20 ml-0.5 flex -translate-y-1/2 items-center gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100"
                  >
                    <ReactionBar threadId={group.threadId} message={m} />
                    <button
                      type="button"
                      onClick={() => onReply(m)}
                      aria-label={t("chat.replyToMessage")}
                      title={t("chat.replyToMessage")}
                      className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
                    >
                      <MessageSquareReply size={14} />
                    </button>

                  </div>
                )}
                <ReactionChips
                  threadId={group.threadId}
                  message={m}
                  members={members}
                  names={people}
                  corner={mine ? "left" : "right"}
                  className={cn("bottom-3.5", readOnly && "pointer-events-none")}
                />
              </div>
              {optionChoices && (
                <ChatOptionChips
                  options={optionChoices.options}
                  question={optionChoices.question}
                  answeredText={answeredChoice}
                  disabled={readOnly || (!answeredChoice && Boolean(group.busyBotId))}
                  onPick={(option) => dispatch({ type: "sendGroup", groupId: group.id, text: option })}
                />
              )}
              <div className="relative flex">
                <TimestampLabel at={m.at} hidden={streaming} />
                {docked && <DockedPresence {...docked} className="absolute inset-y-0 left-0" />}
              </div>
            </div>
          ) : null;
        if (!row) return null;
        return (
          <div key={key} className="contents" data-mid={m.id} data-find-for={item.notices?.map((notice) => notice.message.id).join(" ") || undefined} {...logLine(skin === "logfile", m.at, [m])}>
            {newDay && <DaySeparator at={m.at} />}
            {joinsAt.at.get(i)?.map((join) => <RoomJoinLine key={join.personId} name={join.name} />)}
            {!user && m.from && cluster && (
              <ClusterLabel bot={memberOf(m.from.botId)} name={m.from.name} color={m.from.color} />
            )}
            {person && cluster && <PersonLabel name={person.name} />}
            {row}
          </div>
        );
      })}
      {joinsAt.tail.map((join) => <RoomJoinLine key={join.personId} name={join.name} />)}
    </>
  );
});

type RoomSetupFields = {
  setupPending?: boolean;
  setupRequired?: boolean;
  setupState?: "required" | "completed" | "skipped";
  setupCompletedAt?: number | string | null;
  setupSkippedAt?: number | string | null;
};

type RoomResponderMode = "lead" | "everyone" | "mentions";

function setupResponderMode(responder: GroupDefaultResponder): RoomResponderMode {
  return responder.kind === "member" ? "lead" : responder.kind;
}

function roomNeedsSetup(group: Group): boolean {
  if (group.dm || group.messages.length > 0) return false;
  // SAFETY: setup fields are additive server metadata; the existing Group shape remains valid when absent.
  const marker = group as Group & RoomSetupFields;
  const hasSetupMarker =
    Object.prototype.hasOwnProperty.call(marker, "setupCompletedAt") ||
    Object.prototype.hasOwnProperty.call(marker, "setupSkippedAt");
  // Legacy empty rooms omit both keys and remain immediately usable.
  if (!hasSetupMarker) return false;
  if (
    marker.setupPending === false ||
    marker.setupRequired === false ||
    marker.setupState === "completed" ||
    marker.setupState === "skipped" ||
    marker.setupCompletedAt != null ||
    marker.setupSkippedAt != null
  ) {
    return false;
  }
  return true;
}

function RoomSetup({ group, members }: { group: Group; members: Bot[] }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [folder, setFolder] = useState(group.cwd ?? "");
  const [behavior, setBehavior] = useState<RoomResponderMode>(setupResponderMode(group.defaultResponder));
  const [leadId, setLeadId] = useState(
    group.defaultResponder.kind === "member" ? group.defaultResponder.botId : members[0]?.id ?? "",
  );
  const [instructions, setInstructions] = useState(group.bulletin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leadPickerOpen, setLeadPickerOpen] = useState(false);
  const leadPickerRef = useRef<HTMLDivElement>(null);
  const selectedLead = members.find((member) => member.id === leadId) ?? members[0];

  useEffect(() => {
    if (!leadPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!leadPickerRef.current?.contains(event.target as Node)) setLeadPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLeadPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [leadPickerOpen]);

  const responder = (): GroupDefaultResponder => {
    if (behavior === "everyone") return { kind: "everyone" };
    if (behavior === "mentions") return { kind: "mentions" };
    return members.some((member) => member.id === leadId)
      ? { kind: "member", botId: leadId }
      : group.defaultResponder;
  };

  const finish = async (action: "complete" | "skip") => {
    setLeadPickerOpen(false);
    setSaving(true);
    setError(null);
    try {
      const payload =
        action === "skip"
          ? { action }
          : {
              action,
              cwd: folder.trim() || null,
              defaultResponder: responder(),
              bulletin: instructions,
            };
      const result = await api(`/api/groups/${group.id}/setup`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const now = Date.now();
      const nextGroup = {
        ...(result.group ?? group),
        id: group.id,
        setupPending: false,
        ...(action === "skip" ? { setupSkippedAt: now } : { setupCompletedAt: now }),
      };
      dispatch({ type: "groupPatched", group: nextGroup });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    const chosen = await window.ogb?.pickFolder?.(folder || group.cwd);
    if (chosen) setFolder(chosen);
  };

  return (
    <section
      data-testid="room-setup"
      aria-labelledby="room-setup-title"
      className="relative z-20 w-full overflow-visible rounded-3xl border border-hairline/50 bg-card shadow-xl shadow-black/10"
    >
      <div className="rounded-t-3xl border-b border-hairline/40 bg-panel/70 px-5 py-5 sm:px-7">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-sm font-bold text-accent-ink">1</span>
          <div>
            <h1 id="room-setup-title" className="text-xl font-semibold tracking-tight text-ink">{t("room.setupTitle", { name: group.name })}</h1>
            <p className="mt-1 max-w-[560px] text-[13.5px] leading-relaxed text-ink-secondary">
              {t("room.setupBody")}
            </p>
          </div>
        </div>
      </div>
      <form
        className="space-y-5 px-5 py-5 sm:px-7 sm:py-6"
        onSubmit={(event) => {
          event.preventDefault();
          void finish("complete");
        }}
      >
        <label className="block">
          <span className="text-[13px] font-semibold text-ink">{t("room.workingFolder")}</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">{t("room.workingFolderHelp")}</span>
          <div className="mt-2 flex gap-2">
            <input
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
              placeholder={t("room.chooseSharedFolder")}
              className="min-w-0 flex-1 rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 font-mono text-[12.5px] text-ink placeholder:font-sans placeholder:text-ink-secondary focus:border-accent focus:outline-none"
            />
            {window.ogb?.pickFolder && (
              <button
                type="button"
                onClick={() => void pickFolder()}
                disabled={saving}
                className="flex shrink-0 items-center gap-1.5 rounded-xl border border-hairline/50 bg-raised px-3 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                <FolderOpen size={14} /> {t("room.choose")}
              </button>
            )}
          </div>
        </label>

        <fieldset className="block">
          <legend className="text-[13px] font-semibold text-ink">{t("room.defaultResponder")}</legend>
          <p className="mt-1 text-[12px] text-ink-secondary">{t("room.defaultResponderHelp")}</p>
          <div role="radiogroup" aria-label={t("room.defaultResponder")} className="mt-2 grid gap-2 sm:grid-cols-3">
            <div ref={leadPickerRef} className="relative min-w-0">
              <button
                type="button"
                role="radio"
                aria-checked={behavior === "lead"}
                aria-haspopup="listbox"
                aria-expanded={behavior === "lead" && leadPickerOpen}
                onClick={() => {
                  setBehavior("lead");
                  setLeadPickerOpen((open) => !open);
                }}
                disabled={saving}
                className={cn(
                  "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                  behavior === "lead"
                    ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                    : "border-hairline/50 bg-panel text-ink-secondary hover:border-hairline hover:bg-raised",
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[13px] font-semibold">
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        behavior === "lead" ? "border-accent bg-accent" : "border-ink-secondary/60",
                      )}
                    >
                      {behavior === "lead" && <span className="size-1.5 rounded-full bg-white" />}
                    </span>
                    {t("room.specificLead")}
                  </span>
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className={cn("shrink-0 text-ink-secondary transition-transform", leadPickerOpen && "rotate-180")}
                  />
                </span>
                <span className="ml-6 mt-2 truncate text-[11.5px] text-ink-secondary">
                  {selectedLead?.name ?? t("room.chooseTeammate")}
                </span>
              </button>
              {behavior === "lead" && leadPickerOpen && (
                <div
                  role="listbox"
                  aria-label={t("room.chooseLead")}
                  className="absolute left-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-3rem)] overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl shadow-black/20"
                >
                  <div className="border-b border-hairline/40 px-3 py-2.5">
                    <div className="text-[12.5px] font-semibold text-ink">{t("room.chooseLead")}</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t("room.chooseLeadHelp")}</div>
                  </div>
                  <div className="max-h-48 overflow-y-auto p-1.5">
                    {members.map((member) => {
                      const selected = member.id === leadId;
                      return (
                        <button
                          key={member.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setLeadId(member.id);
                            setLeadPickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition",
                            selected ? "bg-accent/10" : "hover:bg-raised",
                          )}
                        >
                          <BotAvatar
                            bot={member}
                            state={normalizeState(member.mascotExpression) ?? "happy"}
                            size={24}
                            animated={false}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-ink">{member.name}</span>
                            <span className="block truncate text-[11px] text-ink-secondary">{member.title}</span>
                          </span>
                          {selected && <Check size={15} className="shrink-0 text-accent" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              role="radio"
              aria-checked={behavior === "everyone"}
              onClick={() => {
                setBehavior("everyone");
                setLeadPickerOpen(false);
              }}
              disabled={saving}
              className={cn(
                "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                behavior === "everyone"
                  ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                  : "border-hairline/50 bg-panel text-ink-secondary hover:border-hairline hover:bg-raised",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    behavior === "everyone" ? "border-accent bg-accent" : "border-ink-secondary/60",
                  )}
                >
                  {behavior === "everyone" && <span className="size-1.5 rounded-full bg-white" />}
                </span>
                {t("room.everyoneResponds")}
              </span>
              <span className="ml-6 mt-2 text-[11.5px] text-ink-secondary">{t("room.allMembers")}</span>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={behavior === "mentions"}
              onClick={() => {
                setBehavior("mentions");
                setLeadPickerOpen(false);
              }}
              disabled={saving}
              className={cn(
                "flex min-h-[72px] w-full flex-col items-start justify-between rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50",
                behavior === "mentions"
                  ? "border-accent bg-accent/10 text-ink ring-1 ring-accent/30"
                  : "border-hairline/50 bg-panel text-ink-secondary hover:border-hairline hover:bg-raised",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border",
                    behavior === "mentions" ? "border-accent bg-accent" : "border-ink-secondary/60",
                  )}
                >
                  {behavior === "mentions" && <span className="size-1.5 rounded-full bg-white" />}
                </span>
                {t("room.onlyWhenMentioned")}
              </span>
              <span className="ml-6 mt-2 text-[11.5px] text-ink-secondary">{t("room.onlyMentionedMembers")}</span>
            </button>
          </div>
        </fieldset>

        <label className="block">
          <span className="text-[13px] font-semibold text-ink">{t("room.instructions")}</span>
          <span className="mt-1 block text-[12px] text-ink-secondary">{t("room.instructionsHelp")}</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={5}
            placeholder={t("room.instructionsPlaceholder")}
            className="mt-2 w-full resize-y rounded-xl border border-hairline/50 bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:border-accent focus:outline-none"
          />
        </label>

        {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] text-ink"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" /><span className="min-w-0 break-words">{error}</span></div>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={() => void finish("skip")}
            disabled={saving}
            className="rounded-xl px-3 py-2 text-left text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            {t("room.skipForNow")}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-semibold text-accent-ink hover:brightness-110 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {t("room.saveContinue")}
          </button>
        </div>
      </form>
    </section>
  );
}
export function GroupView({ group: live }: { group: Group }) {
  const archive = useGroupArchive(live.id);
  const group = useMemo(() => (archive ? { ...live, threadId: archive.threadId, messages: archive.messages, hasMore: false } : live), [archive, live]);
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const sidebarOnRight = useSidebarSide() === "right";
  const stream = useStreaming();
  const streaming = stream.streaming[group.threadId];
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const focusComposer = useCallback(() => {
    focusComposerOnActivation({ composer: composerInputRef.current });
  }, []);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);
  const find = useSearchFindSeed(group.threadId);
  const findOpen = find.findOpen;
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    group.threadId,
    `group:${group.id}:${group.threadId}`,
    group.messages,
  );
  // Profile patches sync the pin to other devices.
  const togglePin = (message: Message) => {
    if (group.hosted) return void setHostNotice(group.id, group.notice?.entryId === message.roomEntryId ? null : message.roomEntryId!).catch(() => {});
    dispatch({
      type: "patchGroup",
      groupId: group.id,
      patch: { pinnedMessageId: group.pinnedMessageId === message.id ? "" : message.id },
    });
  };
  const [menu, setMenu] = useState<MessageMenuRequest | null>(null);
  const { value: shownMenu, closing: menuClosing } = usePresence(menu);
  // Same instance can show another thread without a click outside the menu.
  const [menuThread, setMenuThread] = useState(group.threadId);
  if (menuThread !== group.threadId) {
    setMenuThread(group.threadId);
    setMenu(null);
  }
  useEffect(() => endSelectMode, [group.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        find.openFind();
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, [find.openFind]);

  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)),
    [group.memberIds, state.bots],
  );
  const speaker = members.find((b) => b.id === group.busyBotId);
  const recoveryPacket = roomRecoveryPacket(group);
  const recoveryBot = recoveryPacket
    ? members.find((b) => b.id === recoveryPacket.botId) ?? members[0]
    : undefined;
  const setupPending = roomNeedsSetup(group);

  // Mascot stays while a member works. Live reply text is a transcript row
  // the settled reply takes over, with the mascot docked under it.
  const lastGroupMessage = group.messages.at(-1);
  const toolInFlight = lastGroupMessage?.kind === "activity" && lastGroupMessage.tool?.ok === undefined;
  const skin = useSkin();
  const terminal = isTerminalSkin(skin);
  const showToolCalls = showToolCallsEnabled(state.config);
  const showActivities = showToolCalls || isTerminalToolSkin(skin);
  const speakerEngine = state.instances.find((instance) => instance.instanceId === speaker?.modelSelection?.instanceId);
  const { label: activityLabel, noReply } = useRoomTurnStage(group.threadId, group.messages, stream, showActivities, speakerEngine?.driverKind);
  const reveal = stream.reveal?.[group.threadId];
  const waiting = !reveal?.ended && turnPresenceWaiting({
    busy: Boolean(speaker),
    turnActive: stream.signal[group.threadId] !== undefined,
    activity: speaker?.activity,
    lastMessage: group.messages.at(-1),
    speakerBotId: speaker?.id,
    accepted: state.acceptedSends[group.threadId],
  });
  const liveText = buffersForTurn(stream, group.threadId, lastGroupMessage?.id).streaming;
  const streamingMessage = useMemo<Message | null>(() => (waiting || reveal?.ended) && liveText ? {
    id: `stream:${group.threadId}:${lastGroupMessage?.id ?? ""}`,
    parentId: lastGroupMessage?.id,
    role: "bot",
    kind: "text",
    text: liveText,
    at: lastGroupMessage?.at ?? 0,
    placeholder: true,
    streamWhole: reveal?.whole,
    from: speaker ? { botId: speaker.id, name: speaker.name, color: speaker.color } : undefined,
  } : null, [waiting, liveText, reveal, group.threadId, lastGroupMessage?.id, lastGroupMessage?.at, speaker]);
  const presenceSpeaker = speaker ?? members[0];

  // Windowed transcript, mirroring ChatView: only a tail of the room mounts;
  // the anchored boundary re-tails on a render-phase reset when the room (or
  // its thread) changes. Working dots below stay on the FULL list's tail.
  const transcriptKey = `${group.id}:${group.threadId}`;
  // an old jump shows its own window; the live pages below keep taking arrivals
  const jump = useJumpWindow(dispatch, transcriptKey, group.threadId, group.messages, null, state.olderPatches[group.threadId], state.snapshots);
  const shown = jump.messages ?? group.messages;
  // rooms have no pane liveness, so a run without a report stays Working
  const workers = useMemo(() => workerRuns(group.messages).map((run) => ({ run, state: shownState(run, null) })), [group.messages]);
  const rowWorkers = useMemo(() => jump.messages ? workerRuns(group.messages, jump.messages).map((run) => ({ run, state: shownState(run, null) })) : workers, [group.messages, jump.messages, workers]);
  const renders = useCallback(
    (index: number) => messageVisible(group.messages[index], showToolCalls, showActivities),
    [group.messages, showToolCalls, showActivities],
  );
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
    expanded?: boolean;
  }>(() => ({
    key: transcriptKey,
    start: tailWindowStart(group.messages.length, TRANSCRIPT_WINDOW_SIZE, renders),
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(group.messages.length, TRANSCRIPT_WINDOW_SIZE, renders), end: null });
  }
  const [windowTerminal, setWindowTerminal] = useState(terminal);
  if (windowTerminal !== terminal) {
    setWindowTerminal(terminal);
    setTranscriptWindow({
      key: transcriptKey,
      start: tailWindowStart(shown.length, TRANSCRIPT_WINDOW_SIZE, (index) => messageVisible(shown[index], showToolCalls, showActivities)),
      end: null,
    });
  }
  // The window is index-based, so an older page landing on top shifts it.
  const loadOlder = useOlderMessages(dispatch, group.threadId, group.messages[0]?.id, group.hasMore);
  const revealOlder = useRef(false);
  const head = shown[0]?.id;
  const [windowHead, setWindowHead] = useState(head);
  const earlier = useMemo(() => createEarlierWindow(shown, {
    terminal, workers: rowWorkers, renders: (message) => messageVisible(message, showToolCalls, showActivities),
  }), [shown, terminal, rowWorkers, showToolCalls, showActivities]);
  if (windowHead !== head) {
    setWindowHead(head);
    const prepended = windowHead ? shown.findIndex((message) => message.id === windowHead) : -1;
    if (prepended > 0) {
      const reveal = revealOlder.current;
      revealOlder.current = false;
      setTranscriptWindow((w) => shiftForPrepend(w, prepended, reveal, reveal ? prepended - earlier.start(prepended, scrollRef.current) : undefined));
    }
  }
  const {
    visible: windowedMessages,
    hiddenCount,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(shown, follow && !jump.messages
      ? followedWindow(transcriptWindow, shown.length, TRANSCRIPT_WINDOW_SIZE, renders).start
      : transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [shown, follow, jump.messages, renders, transcriptWindow],
  );

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);

  useEffect(() => setBottomFollow(true), [transcriptKey, setBottomFollow]);

  // Docks like a 1:1 chat: under the reply while its text is streaming.
  const liveTail = laterCount === 0 && !jump.messages;
  const listedStreaming = liveTail ? streamingMessage : null;
  let tail: Message | null = listedStreaming;
  for (let i = windowedMessages.length - 1; liveTail && !tail && i >= 0; i--) {
    if (messageVisible(windowedMessages[i], showToolCalls, showActivities)) tail = windowedMessages[i];
  }
  const tailSlot = tail?.role === "bot" && tail.kind === "text" && !isVoiceLine(tail) ? replySlot(group.threadId, tail, shown) : null;
  const docked = useReplyDock(listedStreaming && waiting ? tailSlot : null, tailSlot, waiting);
  const dockSlot = docked?.slot;
  const dockLive = docked?.live ?? false;
  const lastUserAt = group.messages.findLast((m) => m.role === "user")?.at;
  const dock = useMemo<ReplyDock | null>(() => dockSlot ? {
    slot: dockSlot,
    live: dockLive,
    label: activityLabel,
    since: noReply ? undefined : lastUserAt,
    quiet: noReply?.quiet,
    wrap: Boolean(noReply),
    avatar: (
      <BotAvatar
        bot={presenceSpeaker ?? { name: group.name, color: DEFAULT_MAUS_COLOR }}
        state={toolInFlight ? "working" : "thinking"}
        size={16}
        forward={false}
        lookAround={1}
        trackPointer={false}
      />
    ),
  } : null, [dockSlot, dockLive, activityLabel, lastUserAt, noReply, presenceSpeaker, group.name, toolInFlight]);

  // the window holding a focus target commits before useFocusMessage scrolls
  const appliedFocus = useRef<number | null>(null);
  const [focusWindowNonce, setFocusWindowNonce] = useState<number | null>(null);
  const requestedFocus = useRef<number | null>(null);
  const { open: openJump, close: closeJump } = jump;
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== group.threadId || appliedFocus.current === focus.nonce) return;
    const liveIndex = group.messages.findIndex((message) => message.id === focus.messageId);
    const list = liveIndex >= 0 ? group.messages : shown;
    const targetIndex = liveIndex >= 0 ? liveIndex : shown.findIndex((message) => message.id === focus.messageId);
    // older than every loaded page: fetch one window around it
    if (targetIndex < 0) {
      if (group.hasMore && requestedFocus.current !== focus.nonce) {
        requestedFocus.current = focus.nonce;
        openJump(focus.messageId);
      }
      return;
    }
    appliedFocus.current = focus.nonce;
    if (liveIndex >= 0) closeJump();
    const listRenders = (index: number) => messageVisible(list[index], showToolCalls, showActivities);
    // a jump page fetched for this target has no window yet; a jump closing for a live target leaves the plain tail
    const switching = list !== shown;
    const current = requestedFocus.current === focus.nonce
      ? null
      : switching
        ? { start: tailWindowStart(list.length, TRANSCRIPT_WINDOW_SIZE, listRenders), end: null }
        : { start: startIndex, end: transcriptWindow.end === null ? null : endIndex };
    const next = focusWindow(current, list.length, targetIndex, TRANSCRIPT_WINDOW_SIZE, listRenders);
    setBottomFollow(false);
    if (switching || next !== current) setTranscriptWindow({ key: transcriptKey, ...next, expanded: next.end === null });
    setFocusWindowNonce(focus.nonce);
  }, [closeJump, endIndex, group.hasMore, group.messages, group.threadId, openJump, setBottomFollow, showActivities, showToolCalls, shown, startIndex, state.focusMessage, transcriptKey, transcriptWindow.end]);
  const focusPaging =
    Boolean(group.hasMore) &&
    state.focusMessage?.threadId === group.threadId &&
    !shown.some((message) => message.id === state.focusMessage?.messageId);
  useFocusMessage(group.threadId, shown.length > 0 && !focusPaging && focusWindowNonce === state.focusMessage?.nonce);
  useEffect(() => {
    if (!follow || jump.messages || followedWindow(transcriptWindow, group.messages.length, TRANSCRIPT_WINDOW_SIZE, renders) === transcriptWindow) return;
    setTranscriptWindow((w) => followedWindow(w, group.messages.length, TRANSCRIPT_WINDOW_SIZE, renders));
  }, [follow, jump.messages, group.messages.length, renders, transcriptWindow]);
  // A plain tail holds at least the newest window of visible rows - see ChatView.
  const tailStart = useMemo(() => tailWindowStart(group.messages.length, TRANSCRIPT_WINDOW_SIZE, renders), [group.messages.length, renders]);

  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo.
  // `follow` is intentionally omitted - see ChatView.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [group.id, group.messages.length, streaming, group.busyBotId, composerDock.pad]);

  // Late layout, images and viewport changes fire no scroll event, so the pill and fill read geometry here too.
  const [newestBelow, setNewestBelow] = useState(false);
  const [underfilled, setUnderfilled] = useState(false);
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setNewestBelow(newestBelowView(el, contentRef.current ? spaceAfterNewestRow(contentRef.current) : 0));
    setUnderfilled(transcriptUnderfilled(el));
  }, []);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const el = scrollRef.current;
      if (el && followRef.current) {
        el.scrollTo({ top: el.scrollHeight });
        previousScrollTop.current = el.scrollTop;
      }
      measure();
    });
    observer.observe(content);
    // a growing composer shrinks the viewport; re-pin before paint
    if (scrollRef.current) observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [measure, setupPending]);

  // A plain tail too short to scroll pages older rows in until it fills or the thread runs out.
  // A widening window still to commit is not short of rows.
  const fillPaging =
    Boolean(group.hasMore) && !jump.messages && !jump.pending && transcriptWindow.end === null && !transcriptWindow.expanded && transcriptWindow.start <= tailStart;
  useEffect(() => {
    const el = scrollRef.current;
    if (fillPaging && el && transcriptUnderfilled(el)) loadOlder();
  }, [fillPaging, loadOlder, underfilled]);

  const preExpandScroll = useRef<TranscriptScroll | null>(null);
  const expandEarlier = (onFail: () => void, beforeCommit: () => boolean, pages: number) => {
    // expanding means reading scrollback - never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
    if (startIndex === 0) {
      revealOlder.current = true;
      setTranscriptWindow((w) => ({ ...w, expanded: true }));
      (jump.messages ? jump.older : loadOlder)(() => {
        preExpandScroll.current = beforeCommit() ? null : captureTranscriptScroll(scrollRef.current);
      }, onFail, pages);
      return;
    }
    preExpandScroll.current = beforeCommit() ? null : captureTranscriptScroll(scrollRef.current);
    const start = earlier.start(startIndex, scrollRef.current);
    setTranscriptWindow((w) => ({ ...w, start, expanded: true }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (preExpandScroll.current === null || !el) return;
    restoreTranscriptScroll(el, preExpandScroll.current);
    preExpandScroll.current = null;
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    previousScrollTop.current = el.scrollTop;
  }, [transcriptWindow.start, head]);
  // After commit and after the restore above: the height read is the committed
  // layout, and the widened window's commit runs the restore.
  useLayoutEffect(() => {
    if (jump.messages || transcriptWindow.end !== null || transcriptWindow.expanded || transcriptWindow.start <= tailStart) return;
    // rows land above a reader in scrollback: the expand restore keeps their row put
    if (!followRef.current) preExpandScroll.current ??= captureTranscriptScroll(scrollRef.current);
    setTranscriptWindow((w) => (w.end === null && !w.expanded ? { ...w, start: Math.min(w.start, tailStart) } : w));
  }, [jump.messages, tailStart, transcriptWindow]);

  const [showEarlier, cancelEarlier] = useEarlierPage({
    key: transcriptKey, shown, startIndex, hasMore: hiddenCount > 0 || Boolean(jump.messages ? jump.hasMore : group.hasMore),
    scrollRef, previousScrollTop, expand: expandEarlier,
    settle: () => {
      const end = earlier.end(startIndex, scrollRef.current);
      if (end !== null) setTranscriptWindow((w) => (w.end === null || end < w.end ? { ...w, end } : w));
    },
  });
  const olderRow = useOlderOnScroll(scrollRef, `${head}:${startIndex}`, !jump.pending, follow, showEarlier);

  const advanceLater = useForwardWindow({
    key: transcriptKey, window: transcriptWindow, shown, startIndex, endIndex, jump, scrollRef, previousScrollTop,
    setWindow: setTranscriptWindow, pauseFollow: () => setBottomFollow(false),
    renders: (rows, index) => messageVisible(rows[index], showToolCalls, showActivities),
  });
  const showLater = () => advanceLater(true, true);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
  // a transcript too short to scroll has no scrollback to read, so an upward swipe there keeps follow
  const breakFollow = () => {
    const el = scrollRef.current;
    if (el && el.scrollHeight > el.clientHeight) setBottomFollow(false);
  };

  // Own send re-anchors even from scrollback; incoming content never yanks.
  const jumpToLatest = () => {
    closeJump();
    setBottomFollow(true);
    cancelEarlier();
    setTranscriptWindow({ key: transcriptKey, start: tailWindowStart(group.messages.length, TRANSCRIPT_WINDOW_SIZE, renders), end: null });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  return (
    <MediaViewerProvider threadId={group.threadId} messages={shown}>
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <GroupCallOverlay group={group} members={members} />
      <div
        className={cn(
          // md:min-h-18 matches the 1:1 header's 48px avatar row, so switching never jumps
          "@container/chathead flex items-center justify-between px-5 py-3 md:min-h-18",
          // Room for the drawer button, which overlays this corner below md.
          sidebarOnRight ? DRAWER_HEADER_RIGHT : DRAWER_HEADER_LEFT,
        )}
      >
        <div className="flex min-w-[4.5rem] flex-1 items-center gap-2">
          <RoomTitle name={group.name} picture={<RoomPicture key={group.id} src={group.hosted && roomPictureUrl(hostRoomBase(group.hosted.roomId), group.picture)} />} />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 max-md:gap-1">
          <WorkerChip name={group.name} runs={workers} livePanes={null} />
          {showChannelCallControl() && <GroupCallButton group={group} members={members} />}
          <RoomAlertsBell chat={group.id} />
          <ShowPaneButton threadId={group.threadId} />
        </div>
      </div>

      {findOpen && (
        <ChatFindBar
          key={find.findSeed?.nonce ?? "browse"}
          threadId={group.threadId}
          initialQuery={find.findSeed?.query ?? ""}
          initialMessageId={find.findSeed?.messageId ?? null}
          onClose={find.closeFind}
        />
      )}

      <AppErrorBanner />

      {/* Pinned message banner — resolves against the room's full transcript */}
      {group.hosted ? group.notice?.entryId && (
        <RoomNotice
          base={hostRoomBase(group.hosted.roomId)}
          line={hostLines(group.messages.filter((m) => m.roomEntryId === group.notice!.entryId))[0]}
          text={roomNoticeText(group)}
          onJump={(messageId) => dispatch({ type: "focusMessage", threadId: group.threadId, messageId })}
        />
      ) : (
        <PinnedBanner
          bot={{ name: t("chrome.aBot"), threadId: group.threadId, hasMore: group.hasMore }}
          pinnedId={group.pinnedMessageId}
          messages={group.messages}
          onJump={(messageId) => dispatch({ type: "focusMessage", threadId: group.threadId, messageId })}
          onUnpin={() => dispatch({ type: "patchGroup", groupId: group.id, patch: { pinnedMessageId: "" } })}
        />
      )}

      <ReconnectingCue />

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        data-orbit-transcript
        data-room-transcript
        className="isolate min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        style={{ overflowAnchor: follow ? "none" : "auto" }}
        onWheel={(e) => {
          if (e.deltaY < 0) breakFollow();
          else {
            advanceLater(e.deltaY > 0);
            if (!jump.messages && laterCount === 0 && atEnd()) setBottomFollow(true);
          }
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) breakFollow();
          else {
            advanceLater(y < touchY.current - 4);
            if (!jump.messages && laterCount === 0 && atEnd()) setBottomFollow(true);
          }
        }}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const scrollTop = el.scrollTop;
          advanceLater(scrollTop > previousScrollTop.current);
          const resume = shouldResumeBottomFollow({
            following: followRef.current,
            previousScrollTop: previousScrollTop.current,
            scrollTop,
            distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
          });
          previousScrollTop.current = scrollTop;
          if (resume && !jump.messages && laterCount === 0) setBottomFollow(true);
          measure();
        }}
        onClick={(e) => {
          if (findOpen) return;
          if (!shouldFocusComposerOnTranscriptClick(e.target, e, window.getSelection()?.isCollapsed ?? true, e.currentTarget)) return;
          focusComposer();
        }}
        onContextMenu={(e) => {
          // rows above open their own menu; this catches a selection in the gaps
          if (e.defaultPrevented || isTouchPrimary() || !(e.target instanceof Element)) return;
          if (contextClickKind(e.target, e.clientX, e.clientY) !== "selection") return;
          e.preventDefault();
          setMenu({ kind: "selection", x: e.clientX, y: e.clientY, opener: e.currentTarget, text: window.getSelection()?.toString() ?? "" });
        }}
      >
        {setupPending ? (
          <div
            className="flex min-h-full w-full items-center px-5 py-8"
            style={{ paddingBottom: TRANSCRIPT_GAP }}
          >
            <RoomSetup group={group} members={members} />
          </div>
        ) : (
        <div
          ref={contentRef}
          className={cn("flex w-full flex-col gap-3 px-5", CHAT_COLUMN_CLASS)}
          style={{ paddingBottom: TRANSCRIPT_GAP }}
          role="log"
          aria-live="polite"
          aria-label={t("chat.roomAria", { name: group.name })}
        >
          {group.messages.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
              <div className="flex -space-x-2">
                {members.slice(0, 3).map((b) => (
                  <BotAvatar
                    key={b.id}
                    bot={b}
                    state="happy"
                    size={44}
                    motion="none"
                    motionKey={0}
                    animated={false}
                  />
                ))}
              </div>
              <div className="text-[17px] font-semibold text-ink">{group.name}</div>
              <div className="max-w-[380px] text-[14px] text-ink-secondary">
                {groupResponseHint(group, members)}
              </div>
            </div>
          )}
          {(hiddenCount > 0 || (jump.messages ? jump.hasMore : group.hasMore)) && (
            <div ref={olderRow} className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("room.showOlder")}
              </button>
            </div>
          )}
          <Transcript
            key={`${transcriptKey}:${jump.messages ? `jump:${jump.messages.at(-1)?.id}` : "live"}`}
            group={group}
            members={members}
            messages={windowedMessages}
            transcript={shown}
            streamingMessage={listedStreaming}
            dock={dock}
            onReply={selectReply}
            onMessageMenu={setMenu}
            workers={rowWorkers}
            joins={archive ? undefined : roomJoins(group)}
            readOnly={Boolean(archive)}
          />
          {jump.forwardFailed && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("room.retryLater")}
              </button>
            </div>
          )}
          {(speaker || waiting) && !jump.messages && (
            <TurnPresence
              avatar={
                <BotAvatar
                  bot={presenceSpeaker ?? { name: group.name, color: DEFAULT_MAUS_COLOR }}
                  state={toolInFlight ? "working" : "thinking"}
                  size={36}
                  forward={false}
                  lookAround={1}
                  trackPointer={false}
                />
              }
              visible={waiting && !dockLive}
              docked={dockLive}
              label={activityLabel}
              quiet={noReply?.quiet}
              wrap={Boolean(noReply)}
              since={noReply ? undefined : lastUserAt}
            />
          )}
        </div>
        )}
      </div>

      {shownMenu?.kind === "message" ? (
        <MessageMenu key={`${shownMenu.x},${shownMenu.y}`} x={shownMenu.x} y={shownMenu.y} opener={shownMenu.opener} target={shownMenu.target} closing={menuClosing} onReply={selectReply} onPin={togglePin} onReact={(emoji) => dispatch({ type: "toggleReaction", threadId: shownMenu.target.threadId, messageId: shownMenu.target.message.id, emoji, message: shownMenu.target.message })} onClose={() => setMenu(null)} />
      ) : shownMenu ? (
        <SelectionMenu key={`${shownMenu.x},${shownMenu.y}`} x={shownMenu.x} y={shownMenu.y} opener={shownMenu.opener} text={shownMenu.text} closing={menuClosing} onClose={() => setMenu(null)} />
      ) : null}

      {(jump.messages || laterCount > 0 || (!follow && newestBelow)) && (
        <JumpToLatest bottom={composerDock.height} onJump={jumpToLatest} />
      )}

      <div ref={composerDockRef} className={cn("relative z-[2] w-full shrink-0", CHAT_COLUMN_CLASS)}>
      {archive ? (
        <GroupArchiveBar />
      ) : (
        <>
          {recoveryPacket && recoveryBot && (
            <TaskRecoveryCard
              key={`${recoveryBot.id}:${group.threadId}`}
              bot={recoveryBot}
              packet={recoveryPacket}
              turns={recoveryPacket?.turnsAtWrite ?? 0}
              busy={roomRecoveryBusy(group, recoveryBot.busy)}
            />
          )}
          <CallWidgetSlot className="px-3 pb-2 md:hidden" />
          <Composer
            key={group.threadId}
            group={group}
            members={members}
            composerRef={composerInputRef}
            onSend={jumpToLatest}
            locked={setupPending}
            replyTo={replyTo}
            onClearReply={clearReply}
            onConsumeReply={consumeReply}
            onRestoreReply={restoreReply}
          />
        </>
      )}
      </div>
      </div>
    </main>
    </MediaViewerProvider>
  );
}
