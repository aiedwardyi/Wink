import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type SetStateAction } from "react";
import { createPortal, flushSync } from "react-dom";
import { ArrowUp, Mic, Paperclip, Phone, Square, TerminalSquare, User, Users, X } from "lucide-react";
import { useStore, visibleMessages, type Bot, type Group, type Message, api } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  botDraftId,
  claimRoomHolds,
  draftRevision,
  forgetFailedComposerSend,
  getRoomHolds,
  markDraftEdited,
  recoverFailedComposerSend,
  restoreComposerDraft,
  rememberFailedComposerSend,
  rememberQueuedDraft,
  returnSendsToComposer,
  setRoomHolds,
  settleRoomSend,
  takeRestoredSendId,
  updateDraftAttachment,
  useComposerDraft,
  useFailedComposerSends,
  type ComposerSendSnapshot,
  type FailedComposerSend,
  type PersistedRoomHold,
} from "@/lib/drafts";
import { BotAvatar, RoomBotAvatar } from "./Avatar";
import { BotModelLine } from "./BotModelLine";
import { CallGear } from "./CallSettings";
import { ComposerAttachments, pathForFile } from "./ComposerAttachments";
import {
  appendPastedText,
  attachmentBasename,
  composeMessage,
  fileAttachment,
  imageSupportForTargets,
  imageSupportNotice,
  intakeFiles,
  isImageFile,
  isLongPaste,
  pasteAttachment,
  rereadEmptyImages,
  roomCopyPath,
  shrinksImage,
  uploadAttachment,
  uploadAttachmentFile,
  visibleComposerNotice,
  type Attachment,
  type ComposerThreadNotice,
  type FileAttachment,
  type ImageAttachment,
  type PasteAttachment,
  type UploadAttachment,
} from "@/lib/composer-attachments";
import {
  dropUpload,
  forgetUpload,
  onUploadJobs,
  queueUpload,
  retryUpload,
  uploadJobs,
  type UploadDone,
} from "@/lib/big-upload";
import { forgetTrayMedia } from "@/lib/tray-media";
import { shrunkPicture } from "@/lib/shrink-image";
import { normalizeState } from "@/lib/mascot";
import { groupComposerHint, roomRespondersForComposer } from "@/lib/group-routing";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { foldQuestion, HiddenQuestionDot, PendingQuestionPanel } from "./PendingQuestion";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import {
  composerBusyChrome,
  composerBusySendAction,
  composerSendSourceText,
  modelForNextSend,
  peelNextBusyRoomSend,
  rearmRoomFlushHold,
  roomLineSteers,
} from "@/lib/composer-busy";
import { composerIsBusy } from "@/lib/send-accept";
import { composerEnterIntent, isComposerEnterKey } from "@/lib/composer-enter";
import { holdToSendAfter, markSent, stopTooSoon } from "@/lib/send-hold";
import { fitComposerHeight } from "@/lib/composer-dock";
import { composerNeedsTap, focusComposerOnActivation } from "@/lib/focus-composer";
import { dropRoomFile, holdRoomFiles, roomFile, startRoomSend, useRoomSending } from "@/lib/room-drafts";
import { filesProblem, isRoomPicture, roomPeople, roomTeamBots, sendToRoom, type RoomProblem } from "@/lib/team-rooms";
import { holdReload } from "@/lib/reload-hold";
import { hapticTick } from "@/lib/phone-swipe";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { warmCallAudio } from "@/lib/live-call/warm-audio";
import { useRainbowBox } from "@/lib/rainbow-box";
import { RainbowRing } from "./RainbowRing";
import { useI18n } from "@/lib/i18n";
import { useChatPreview } from "@/lib/chat-preview";
import { chatMovedOn, openQuestions, pinnedQuestion } from "@/lib/open-question";
import { usePresence } from "@/lib/use-presence";
import { MOTION_LARGE_MS } from "@/lib/motion";
import { useBackLayer } from "@/lib/use-back-layer";
import { useCatchingUp } from "@/lib/use-catching-up";
import { ReplyQuote } from "./ReplyQuote";
import { ConfirmDialog } from "./ConfirmDialog";
import { Bubble, versionProps } from "./ChatBubble";
import { MessageMenu, type MessageMenuRequest } from "./MessageMenu";
import { trackFeature } from "@/lib/usage-stats";

/** The active @mention query at the caret: the text between an `@` that
 * starts a word and the caret. null = no mention being typed. */
function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // user@host, not a tag
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || /^\s/.test(query) || query.includes("\n")) return null;
  return { start: at, query };
}

type MentionChoice = { id: string; name: string; bot?: Bot; person?: boolean; agent?: boolean; owner?: string; label?: string };

export type RoomPerson = { id: string; name: string; owner?: string };

export type RoomBotStatus = { id: string; text: string; failed?: boolean };

/** A people room: same box, but its sends upload through the room route. `offline` keeps the box but holds Send and files. `onStop` backs the box's Stop. `chain` counts a live bot handoff. */
export type ComposerRoom = { name: string; base: string; draftId: string; people?: readonly RoomPerson[]; bots?: readonly RoomPerson[]; offline?: boolean; status?: readonly RoomBotStatus[]; onStop?: () => void; chain?: number };


const roomPicture = (id: string) => {
  const file = roomFile(id);
  return file && { file, picture: isRoomPicture(file) };
};

function uploadedFile(id: string, result: UploadDone, uploadId?: string, picture?: UploadAttachment["picture"]): FileAttachment | ImageAttachment {
  if (picture === "image") return { kind: "image", id, path: result.path, name: result.name, size: result.size, mime: result.type };
  const file = fileAttachment(result.name, result.path, result.size, result.type);
  file.id = id;
  file.uploadId = uploadId;
  if (result.preview) file.preview = result.preview;
  return file;
}

const saveUpload = (draftId: string, chipId: string) => (result: UploadDone, uploadId?: string) =>
  updateDraftAttachment(draftId, chipId, (a) => (a.kind === "upload" ? uploadedFile(chipId, result, uploadId, a.picture) : a));

const sendPicture = (file: File, chip: UploadAttachment) => chip.document ? async (signal: AbortSignal): Promise<UploadDone> => {
  const saved = await uploadAttachmentFile(file, true, signal);
  return { path: saved.path, name: saved.name ?? attachmentBasename(file.name), size: saved.bytes, type: file.type };
} : chip.picture ? async (signal: AbortSignal): Promise<UploadDone> => {
  const saved = await uploadAttachmentFile(file, false, signal);
  return { path: saved.path, name: file.name || "pasted image", size: saved.bytes, type: saved.mime };
} : undefined;

interface ComposerDraftSnapshot extends ComposerSendSnapshot {
  reply: Message | null;
}

interface QueuedGroupSend {
  text: string;
  replyToId?: string;
  at: number;
  draft: ComposerDraftSnapshot;
}

type TerminalSendPreview = {
  text: string;
  snapshot: TerminalBotSnapshot & { sessionId: string; generation: number; cwd: string };
};

function composerDraftStore() {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function roomHoldFromQueued(entry: QueuedGroupSend): PersistedRoomHold {
  return {
    text: entry.draft.text,
    requestText: entry.draft.requestText,
    sendId: entry.draft.sendId,
    threadId: entry.draft.threadId,
    revision: entry.draft.revision,
    replyToId: entry.replyToId,
    attachments: entry.draft.attachments,
    at: entry.at,
  };
}

function queuedFromRoomHold(hold: PersistedRoomHold, draftId: string): QueuedGroupSend {
  return {
    text: hold.requestText,
    replyToId: hold.replyToId,
    at: hold.at ?? Date.now(),
    draft: {
      draftId,
      revision: hold.revision,
      sendId: hold.sendId,
      text: hold.text,
      requestText: hold.requestText,
      attachments: hold.attachments,
      reply: null,
      replyToId: hold.replyToId,
      threadId: hold.threadId,
    },
  };
}

/** Renders the editable message composer and its pending attachments. */
export function Composer({
  bot,
  group,
  room,
  members,
  onEditLast,
  onSend,
  replyTo,
  onClearReply,
  onConsumeReply,
  onRestoreReply,
  composerRef,
  locked = false,
  focusBlocked = false,
  call,
  onCall,
  callButton,
  callBot,
  heldSlot,
}: {
  bot?: Bot;
  group?: Group;
  room?: ComposerRoom;
  members?: Bot[];
  onEditLast?: () => void;
  /** Fired on the user's own send (or retry): the view re-anchors to latest. */
  onSend?: () => void;
  replyTo?: Message | null;
  onClearReply?: () => void;
  onConsumeReply?: () => void;
  onRestoreReply?: (message: Message, threadId: string) => void;
  composerRef?: { current: HTMLTextAreaElement | null };
  /** New rooms keep the composer inert until their setup is saved or skipped. */
  locked?: boolean;
  focusBlocked?: boolean;
  /** A live call's controls and caption, placed in the frame's grid. */
  call?: (box: { closing: boolean }) => ReactNode;
  /** Starts a call from the empty box's Send spot; absent where calls can't work. */
  onCall?: () => void;
  callButton?: ReactNode;
  /** Who a room's call button calls; a bot chat calls its own bot. */
  callBot?: Bot;
  /** The room transcript's tail, where Ctrl+Enter holds show as 1:1 queued bubbles. */
  heldSlot?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const preview = useChatPreview();
  const phone = useIsPhone();
  const nativeSizing = phone && window.CSS?.supports?.("field-sizing", "content") === true;
  const { capabilities } = useDesktopCapabilities();
  const rainbow = useRainbowBox();
  const caller = bot ?? callBot;
  // Unified target: a 1:1 bot thread or a room. In a room the @ picker
  // offers members plus @everyone; explicit mentions override the room's
  // configured default responder.
  const threadId = group?.threadId ?? bot?.threadId ?? room?.base ?? "";
  const acceptedSends = state.acceptedSends[threadId];
  const busy = composerIsBusy(group ? Boolean(group.working) : Boolean(bot?.busy), acceptedSends);
  const chain = group?.botChain || room?.chain;
  // room Stop also ends a handoff no host bot is working on
  const stoppable = busy || Boolean(room?.onStop) || Boolean(group?.botChain);
  // a room steers into its working member's turn
  const steerBot = group ? members?.find((member) => member.id === group.busyBotId) : bot;
  const canSteer =
    Boolean(steerBot) && state.instances.find((i) => i.instanceId === steerBot!.modelSelection.instanceId)?.capabilities?.queueing === true;
  // only a line that member alone would answer joins its turn
  const roomSteers = (message: string, reply: Message | null) => Boolean(group && canSteer && roomLineSteers(message, members ?? [], group.busyBotId, reply));
  // the VISIBLE branch only — an approval left on a branch you edited away
  // from must not keep blocking the composer
  const threadMessages = group ? group.messages : bot ? visibleMessages(bot) : [];
  const approvals = pendingApprovals(threadMessages);
  const approval = approvals[0];
  const repliedTo = (id?: string) => (id && threadMessages.find((message) => message.id === id)) || null;
  // A bot's open ask_user question pins above the composer but never locks
  // it; a pending approval shows first and the pin waits behind it.
  const chatMessages = group ? group.messages : (bot?.messages ?? []);
  const pinned = pinnedQuestion(chatMessages, threadMessages);
  const questions = pinned ? openQuestions(chatMessages) : [];
  // the row's arrows show an older open question until a newer one arrives
  const [questionPick, setQuestionPick] = useState<{ id: string; newest: string } | null>(null);
  const question = (questionPick?.newest === pinned?.id && questions.find((open) => open.id === questionPick?.id)) || pinned;
  const questionIndex = question ? questions.indexOf(question) : -1;
  const questionMovedOn = question ? chatMovedOn(chatMessages, question) : false;
  const questionAsker = question
    ? group
      ? (members?.find((member) => member.id === question.from?.botId)?.name ?? question.from?.name ?? t("chrome.aBot"))
      : (bot?.name ?? t("chrome.aBot"))
    : "";
  const approvalBot = group
    ? members?.find((member) => member.id === approval?.message.from?.botId) ??
      members?.find((member) => member.id === group.busyBotId)
    : bot;
  // Per-thread draft: switching bots unmounts this component, so both the
  // text and its attachment chips have to outlive it (see lib/drafts).
  const draftId = room
    ? room.draftId
    : group
    ? `group:${group.id}:${group.threadId}`
    : botDraftId(bot?.id ?? "", bot?.threadId ?? "");
  const peopleRoom = Boolean(room);
  const roomSending = useRoomSending(peopleRoom ? draftId : "");
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    draftId,
    !group && bot ? `bot:${bot.id}` : undefined,
  );
  const failedSends = useFailedComposerSends(draftId);
  const editText = useCallback(
    (next: string) => {
      markDraftEdited(draftId);
      setText(next);
    },
    [draftId, setText],
  );
  const editAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      markDraftEdited(draftId);
      setAttachments(next);
    },
    [draftId, setAttachments],
  );
  const restoreDraft = useCallback(
    (sent: ComposerDraftSnapshot) => {
      // Shared recovery reaches a newly mounted view after navigation and
      // falls back to a separate retry item when a newer draft already exists.
      if (recoverFailedComposerSend(sent) === "restored" && sent.reply) {
        onRestoreReply?.(sent.reply, sent.threadId);
      }
    },
    [onRestoreReply],
  );
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  // an intake that attaches clears only a notice that showed before it started
  const noticeAt = useRef(0);
  const showNotice = useCallback((notice: string | null) => {
    noticeAt.current = performance.now();
    setAttachmentNotice(notice);
  }, []);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // an upload's reload hold ends right after this, so the chip must be in storage by then
  const addAttachments = useCallback(
    (next: Attachment[], uploads: { id: string; file: File }[] = [], startedAt = 0) => {
      if (startedAt > noticeAt.current) setAttachmentNotice(null);
      if (next.length) trackFeature("attach.add", { n: next.length });
      flushSync(() => editAttachments((prev) => [...prev, ...next]));
      for (const upload of uploads) {
        const chip = next.find((a) => a.id === upload.id);
        if (chip?.kind === "upload") queueUpload(upload.id, upload.file, undefined, saveUpload(draftId, upload.id), chip.shrink, sendPicture(upload.file, chip));
      }
    },
    [draftId, editAttachments],
  );
  const removeAttachment = useCallback(
    (id: string) => {
      const removed = attachmentsRef.current.find((a) => a.id === id);
      if (peopleRoom) {
        if (roomSending) return;
        dropRoomFile(id);
      // a finished file may already be in a sent message, so only unfinished uploads are cancelled
      } else if (removed?.kind === "upload") dropUpload(id, removed.uploadId);
      forgetTrayMedia(id);
      editAttachments((prev) => prev.filter((a) => a.id !== id));
    },
    [editAttachments, peopleRoom, roomSending],
  );
  // Uploads outlive this component. A finished one becomes a plain file chip;
  // an upload chip with no job is from before a reload.
  const jobs = useSyncExternalStore(onUploadJobs, uploadJobs, uploadJobs);
  useEffect(() => {
    if (preview) return;
    for (const a of attachments) if ((a.kind === "file" || a.kind === "image") && jobs.get(a.id)?.phase === "done") forgetUpload(a.id);
    const changed = attachments.filter((a) => {
      const job = a.kind === "upload" ? jobs.get(a.id) : undefined;
      return job && a.kind === "upload" && (job.phase === "done" || (job.uploadId && job.uploadId !== a.uploadId));
    });
    if (!changed.length) return;
    setAttachments((prev) =>
      prev.map((a) => {
        const job = a.kind === "upload" ? jobs.get(a.id) : undefined;
        if (a.kind !== "upload" || !job) return a;
        if (job.phase === "done" && job.result) return uploadedFile(a.id, job.result, job.uploadId, a.picture);
        return job.uploadId ? { ...a, uploadId: job.uploadId } : a;
      }),
    );
    for (const a of changed) if (jobs.get(a.id)?.phase === "done") forgetUpload(a.id);
  }, [attachments, jobs, setAttachments, preview]);
  const shownAttachments = useMemo(
    () =>
      attachments.map((a): Attachment => {
        if (a.kind !== "upload") return a;
        if (peopleRoom) return roomFile(a.id) ? a : { ...a, state: "repick" };
        const job = jobs.get(a.id);
        if (!job) return { ...a, state: "repick" };
        const state = job.phase === "failed" ? "failed" : job.phase === "resuming" ? "resuming" : "uploading";
        return { ...a, sent: job.sent, state };
      }),
    [attachments, jobs, peopleRoom],
  );
  // why an upload is stuck or failed goes in the notice above the box, not only on its small chip
  const uploadProblems = attachments
    .flatMap((a) => {
      const job = a.kind === "upload" ? jobs.get(a.id) : undefined;
      const key = job?.phase === "resuming" ? "composer.uploadStuck" : job?.error;
      return key && a.kind === "upload" ? [t(key, { name: a.name })] : [];
    })
    .join(" ");
  const shownProblems = useRef("");
  useEffect(() => {
    const last = shownProblems.current;
    shownProblems.current = uploadProblems;
    if (uploadProblems) showNotice(uploadProblems);
    else if (last) setAttachmentNotice((notice) => (notice === last ? null : notice));
  }, [uploadProblems, showNotice]);
  const repickInput = useRef<HTMLInputElement>(null);
  const repickTarget = useRef<string | null>(null);
  const repick = (file: File | undefined) => {
    const target = attachmentsRef.current.find((a) => a.id === repickTarget.current);
    repickTarget.current = null;
    if (!file || target?.kind !== "upload") return;
    if (room) {
      const [next] = holdRoomFiles([file], target.id);
      editAttachments((prev) => prev.map((a) => (a.id === target.id ? next : a)));
      return;
    }
    // the saved session answers with its finished file or its offset
    if (file.name === target.name && file.size === target.size && file.lastModified === target.lastModified) {
      queueUpload(target.id, file, target.uploadId, saveUpload(draftId, target.id), target.shrink, sendPicture(file, target));
      return;
    }
    dropUpload(target.id, target.uploadId);
    const next = uploadAttachment(file, Boolean(target.shrink) && shrinksImage(file));
    editAttachments((prev) => prev.map((a) => (a.id === target.id ? next : a)));
    queueUpload(next.id, file, undefined, saveUpload(draftId, next.id), next.shrink);
  };
  // A value set from code never reaches the textarea's native undo stack, so
  // Ctrl+Z right after a long paste or "Display in chat box" restores this
  // snapshot instead. `restore` touches only the chip the edit moved, so one
  // added in between (an image paste, say) survives the undo.
  const pasteUndo = useRef<{ text: string; shown: string; restore: (prev: Attachment[]) => Attachment[] } | null>(null);
  const displayPasteInChatBox = useCallback(
    /** Moves one pasted attachment into the editable draft and restores focus. */
    function displayPasteInChatBox(attachment: PasteAttachment) {
      const nextText = appendPastedText(text, attachment.text);
      const index = attachments.findIndex((a) => a.id === attachment.id);
      pasteUndo.current = {
        text,
        shown: nextText,
        restore: (prev) => [...prev.slice(0, index), attachment, ...prev.slice(index)],
      };
      editText(nextText);
      editAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      setCaret(nextText.length);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(nextText.length, nextText.length);
      });
    },
    [text, attachments, editText, editAttachments],
  );
  const undoPasteDisplay = () => {
    const undo = pasteUndo.current;
    pasteUndo.current = null;
    if (!undo || text !== undo.shown) return false;
    editText(undo.text);
    editAttachments(undo.restore);
    setCaret(undo.text.length);
    return true;
  };
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [terminalSendPreview, setTerminalSendPreview] = useState<TerminalSendPreview | null>(null);
  const sendPreview = usePresence(terminalSendPreview);
  const callSlot = usePresence(call, MOTION_LARGE_MS);
  const [terminalSendBusy, setTerminalSendBusy] = useState(false);
  const [terminalSendError, setTerminalSendError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd or pressed away from this @ until the next edit
  const [stoppingBotId, setStoppingBotId] = useState<string | null>(null);
  const stopping = !group && Boolean(bot) && stoppingBotId === bot?.id;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const framePress = useRef(true);
  const frameControl = "button, a, input, textarea, select, label, [role='button'], [role='link'], [role='option'], [contenteditable], [tabindex]";
  const setComposerRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      inputRef.current = element;
      if (composerRef) composerRef.current = element;
    },
    [composerRef],
  );
  // A remounted box holds its restored draft with the caret at 0, and focusing keeps that selection.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || document.activeElement === input) return;
    input.setSelectionRange(input.value.length, input.value.length);
    setCaret(input.value.length);
  }, [draftId]);
  // IME composition: native isComposing can stay true after Hangul
  // commits, which used to make Enter insert a newline instead of send.
  const composingRef = useRef(false);
  const requestBotPrewarm = useCallback((botId: string | undefined) => {
    if (!botId) return;
    void api(`/api/bots/${botId}/prewarm`, { method: "POST" }).catch(() => {});
  }, []);

  const compositionEndedAtRef = useRef(0);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  useEffect(() => {
    if (preview || !bot || focusBlocked || state.composerFocusBotId !== bot.id) return;
    const active = document.activeElement;
    if (active instanceof Element && active.closest('[role="dialog"][aria-modal="true"]')) return;
    const input = inputRef.current;
    if (!input || input.disabled) return;
    if (!composerNeedsTap()) input.focus();
    requestBotPrewarm(bot.id);
    dispatch({ type: "composerFocused", botId: bot.id });
  }, [bot, dispatch, focusBlocked, locked, requestBotPrewarm, state.composerFocusBotId, preview]);

  useEffect(() => {
    if (peopleRoom && !preview) focusComposerOnActivation({ composer: inputRef.current });
  }, [peopleRoom, preview]);

  // Reply chip alone leaves the cursor wherever it was, so a reply looks
  // picked but the user still has to click the box before typing. A failed
  // send restores replyTo, so this can also fire long after the click, with the
  // palette or a modal open, and has to yield the same way autofocus does.
  useEffect(() => {
    if (preview || !replyTo || focusBlocked || composerNeedsTap()) return;
    const active = document.activeElement;
    if (active instanceof Element && active.closest('[role="dialog"][aria-modal="true"]')) return;
    const input = inputRef.current;
    if (!input || input.disabled) return;
    input.focus();
  }, [focusBlocked, locked, replyTo, preview]);

  // Image paste is offered unless a known responder refuses it. A missing
  // instance is still hydrating, so keep the image and validate before send.
  const imageTargetsSupport = (message: string, after: boolean, reply: Message | null) => {
    if (room) return "supported";
    const responders = group
      ? busy && !after && steerBot && roomSteers(message, reply) ? [steerBot] : roomRespondersForComposer(message, members ?? [], group, reply)
      : bot
        ? [{ modelSelection: modelForNextSend(bot, { busy, canSteer: canSteer && !after }) }]
        : [];
    return imageSupportForTargets(state.instances, responders);
  };
  const imageSupport = imageTargetsSupport(text, false, replyTo ?? null);
  const engineSupportsImages = imageSupport !== "unsupported";
  // `draft` marks a refusal of the box's own picture, sent with `after`
  const [imageNotice, setImageNotice] = useState<(ComposerThreadNotice & { draft?: { after: boolean } }) | null>(null);
  const refused = imageNotice?.draft;
  const draftRefusalGone = refused !== undefined &&
    (!attachments.some((attachment) => attachment.kind === "image") || imageTargetsSupport(text, refused.after, replyTo ?? null) === "supported");
  const shownImageNotice = draftRefusalGone ? null : visibleComposerNotice(imageNotice, threadId);
  const catchingUp = useCatchingUp(!preview && bot && !group ? threadId : null);
  const showImageSupportNotice = (support: ReturnType<typeof imageTargetsSupport>, draft?: { after: boolean }) => {
    const text = imageSupportNotice(support, {
      unsupported: t("composer.imageUnsupported"),
      loading: t("composer.imageLoading"),
    });
    if (text && threadId) setImageNotice({ threadId, text, draft });
  };
  useEffect(() => {
    setImageNotice(null);
  }, [draftId]);
  useLayoutEffect(() => {
    if (draftRefusalGone) setImageNotice(null);
  }, [draftRefusalGone]);

  // ── @mention picker (tag another bot; the agent reaches it via ask_bot) ──
  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const people = room?.people ?? (group?.hosted ? roomPeople(group) : []);
    const pool: MentionChoice[] = room
      ? [
          ...(room.bots ?? []).map((roomBot) => ({ id: roomBot.id, name: roomBot.name, owner: roomBot.owner, agent: true })),
          ...(room.people ?? []).map((person) => ({ id: person.id, name: person.name, person: true })),
        ]
      : group
      ? [
          { id: "__everyone__", name: "everyone" },
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
          ...(group.hosted ? roomTeamBots(group) : []).map((roomBot) => ({ id: roomBot.id, name: roomBot.name, owner: roomBot.owner, agent: true })),
          ...people.map((person) => ({ id: person.id, name: person.name, person: true })),
        ]
      : state.bots
          .filter((member) => member.id !== bot?.id && !member.hidden)
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    const q = mention.query.trim().toLowerCase();
    // "@Scout " — the full name plus a space — is a COMPLETED tag, not a
    // search: keep the picker closed so Enter sends instead of re-picking
    if (mention.query.endsWith(" ") && pool.some((b) => b.name.toLowerCase() === q)) return [];
    return pool.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 6).map((peer) => {
      const owner = peer.owner && people.find((person) => person.id === peer.owner);
      return owner ? { ...peer, label: t("teamRoom.botOwner", { name: peer.name, owner: owner.name }) } : peer;
    });
  }, [mention, dismissedAt, state.bots, bot?.id, group, members, room?.people, room?.bots, t]);
  const pickerOpen = candidates.length > 0;
  useBackLayer(!preview && pickerOpen, () => setDismissedAt(mention?.start ?? null));
  const pickerRef = useRef<HTMLDivElement>(null);
  const mentionStart = mention?.start ?? null;
  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setDismissedAt(mentionStart);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [pickerOpen, mentionStart]);

  useEffect(() => setHighlight(0), [mention?.start, mention?.query]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (nativeSizing) el.style.height = "";
    else fitComposerHeight(el, parseFloat(getComputedStyle(el).lineHeight) || 24);
  }, [text, nativeSizing]);

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    editText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  // Rooms hold client-side lines while a member speaks and flush them FIFO
  // once the room settles. 1:1 mid-turn sends still POST (the harness
  // queue), but stay off the transcript until drain — the chips here are
  // the pending rows so they cannot become the active leaf mid-turn.
  // Persist the full FIFO (not one draft slot) so unmount cannot drop
  // the later queued lines after a mid-queue peel.
  const [queued, setQueued] = useState<QueuedGroupSend[]>(() =>
    getRoomHolds(composerDraftStore(), draftId).map((hold) => queuedFromRoomHold(hold, draftId)),
  );
  const queuedRef = useRef<QueuedGroupSend[]>(queued);
  const holdsRoom = Boolean(group) && !preview;
  useEffect(() => (holdsRoom ? claimRoomHolds(draftId) : undefined), [holdsRoom, draftId]);
  const roomFlushLock = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const commitQueued = useCallback((next: QueuedGroupSend[]) => {
    queuedRef.current = next;
    setQueued(next);
    setRoomHolds(composerDraftStore(), draftId, next.map(roomHoldFromQueued));
  }, [draftId]);
  const dropQueued = useCallback((sendId: string) => {
    commitQueued(queuedRef.current.filter((entry) => entry.draft.sendId !== sendId));
  }, [commitQueued]);
  const stopRoom = (groupId: string) => {
    // held lines would otherwise flush the moment the room settles
    returnSendsToComposer(draftId, queuedRef.current.map((entry) => entry.draft));
    commitQueued([]);
    dispatch({ type: "interruptGroup", groupId });
  };
  const [queuedMenu, setQueuedMenu] = useState<MessageMenuRequest | null>(null);
  const queuedActions = (entry: QueuedGroupSend) => ({
    cancel: () => dropQueued(entry.draft.sendId),
    sendNow: group && roomSteers(entry.text, repliedTo(entry.replyToId)) ? () => {
      // the hold may have flushed while its menu was open
      if (!queuedRef.current.some((held) => held.draft.sendId === entry.draft.sendId)) return;
      dropQueued(entry.draft.sendId);
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: entry.text,
        sendId: entry.draft.sendId,
        replyToId: entry.replyToId,
        threadId: entry.draft.threadId,
        actedAt: entry.at,
        onError: () => restoreDraft(entry.draft),
      });
    } : undefined,
  });
  // a chip on its own is a message: the send control has to appear for it
  const fileInput = useRef<HTMLInputElement>(null);
  const showRoomProblem = (problem: RoomProblem | null) =>
    setImageNotice(problem ? { threadId, text: t(problem.key, problem.vars) } : null);
  const pickFiles = async (picked: readonly File[], startedAt = performance.now()) => {
    if (!picked.length || room?.offline) return;
    if (room) {
      const kept = attachmentsRef.current.filter((a): a is UploadAttachment => a.kind === "upload");
      const problem = filesProblem([...kept, ...picked]);
      showRoomProblem(problem);
      if (!problem) editAttachments((prev) => [...prev, ...holdRoomFiles(picked)]);
      return;
    }
    const { attachments: added, uploads, notice } = await intakeFiles(picked, {
      t,
      allowImages: engineSupportsImages,
      getPath: pathForFile,
      shrunkPath: shrunkPicture,
      roomCopy: group?.hosted ? roomCopyPath : undefined,
    });
    if (added.length) addAttachments(added, uploads, startedAt);
    // Keep file-specific failures beside the attachments. A successful
    // overlapping intake must not erase an earlier failure before it is read.
    if (notice) showNotice(notice);
  };
  const pasteImages = async (pasted: readonly File[]) => {
    const startedAt = performance.now();
    const images = await rereadEmptyImages(pasted, window.ogb?.readClipboardImage);
    if (images.length < pasted.length) showNotice(t("composer.pasteImageFailed"));
    await pickFiles(images, startedAt);
  };
  const idlePlaceholder = room
    ? t("composer.roomLead", { name: room.name })
    : group
    ? groupComposerHint(group, members ?? [], t)
    : t("composer.placeholder", { name: bot?.name ?? "" });
  const busyChrome = composerBusyChrome({ busy, canSteer: group ? roomSteers(text, replyTo ?? null) : canSteer, idlePlaceholder, touch: window.matchMedia?.("(pointer: coarse)").matches });
  const hasContent = Boolean(text.trim()) || attachments.length > 0;
  const uploading = room
    ? roomSending || attachments.some((attachment) => attachment.kind === "upload" && !roomFile(attachment.id))
    : attachments.some((attachment) => attachment.kind === "upload");
  // The text leaves the box at send like a bot chat; file chips stay as the upload's sign until the room accepts it.
  const sendRoom = async (target: ComposerRoom) => {
    const liveText = composerSendSourceText(inputRef.current?.value, text).trim();
    const held = attachments;
    const sent = held.filter((attachment) => attachment.kind === "upload");
    const files = sent.flatMap((attachment) => roomFile(attachment.id) ?? []);
    if (!liveText && !files.length) return;
    const sentReply = replyTo ?? null;
    const request = startRoomSend(draftId, (sendId) => sendToRoom(target.base, liveText, files, sendId, sentReply?.roomEntryId ?? sentReply?.id));
    if (!request) return;
    hapticTick();
    onSend?.();
    onConsumeReply?.();
    restoreComposerDraft(draftId, { text: "", attachments: held });
    const failed = await request;
    showRoomProblem(failed);
    settleRoomSend(draftId, liveText, new Set(held.map((attachment) => attachment.id)), Boolean(failed));
    if (failed) {
      if (sentReply) onRestoreReply?.(sentReply, target.base);
      return;
    }
    for (const attachment of sent) dropRoomFile(attachment.id);
  };
  const terminalBridge = typeof window === "undefined" ? undefined : window.ogb?.terminal;
  const canSendToTerminal = Boolean(
    bot && !group && terminalBridge?.readBot && terminalBridge?.sendBot,
  );
  const retryFailedSend = (failed: FailedComposerSend) => {
    if (locked) return;
    if (failed.requestText.includes("<attached-image ")) {
      const support = imageTargetsSupport(failed.requestText, Boolean(failed.after), repliedTo(failed.replyToId));
      if (support !== "supported") {
        showImageSupportNotice(support);
        return;
      }
    }
    forgetFailedComposerSend(draftId, failed.id);
    const retry = {
      sendId: failed.sendId,
      text: failed.requestText,
      replyToId: failed.replyToId,
      threadId: failed.threadId,
      after: failed.after,
      onError: () => {
        rememberFailedComposerSend(draftId, {
          sendId: failed.sendId,
          text: failed.text,
          requestText: failed.requestText,
          replyToId: failed.replyToId,
          threadId: failed.threadId,
          after: failed.after,
        });
      },
    };
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, ...retry });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, ...retry });
    }
    onSend?.();
  };
  const send = (requestedAfter = false) => {
    // a turn waiting on an approval takes the line after it, not mid-decision
    const after = requestedAfter || Boolean(approval);
    const action = composerBusySendAction({
      locked,
      isRoom: Boolean(group),
      busy,
      after,
      heldCount: queuedRef.current.length,
    });
    if (action === "block" || uploading || room?.offline) return;
    if (room) {
      void sendRoom(room);
      return;
    }
    const liveText = composerSendSourceText(inputRef.current?.value, text);
    if (attachments.some((attachment) => attachment.kind === "image")) {
      const support = imageTargetsSupport(liveText, after, replyTo ?? null);
      if (support !== "supported") {
        showImageSupportNotice(support, { after });
        return;
      }
    }
    const t = composeMessage(liveText, attachments);
    if (!t) return;
    markSent();
    hapticTick();
    const sentDraft: ComposerDraftSnapshot = {
      draftId,
      revision: draftRevision(draftId),
      sendId: takeRestoredSendId(draftId) ?? crypto.randomUUID(),
      text: liveText,
      requestText: t,
      attachments: [...attachments],
      reply: replyTo ?? null,
      replyToId: replyTo?.id,
      threadId,
      after,
    };
    // Clear the live box before React re-renders so a second Enter in this
    // tick cannot resend the same line, and the next fill+Enter reads the
    // new DOM value instead of a stale QUEUE-0 draft.
    if (inputRef.current) inputRef.current.value = "";
    setAttachmentNotice(null);
    if (action === "enqueue" && group) {
      const pending = { text: t, replyToId: replyTo?.id, at: Date.now(), draft: sentDraft };
      commitQueued([...queuedRef.current, pending]);
      setText("");
      for (const a of attachmentsRef.current) forgetTrayMedia(a.id);
      setAttachments([]);
      onConsumeReply?.();
      onSend?.();
      return;
    }
    if (group) {
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: t,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        onError: () => restoreDraft(sentDraft),
      });
    } else if (bot) {
      rememberQueuedDraft(sentDraft.sendId, { text: liveText, attachments: sentDraft.attachments });
      dispatch({
        type: "send",
        botId: bot.id,
        text: t,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        after,
        onError: () => restoreDraft(sentDraft),
      });
    }
    setText("");
    for (const a of attachmentsRef.current) forgetTrayMedia(a.id);
    setAttachments([]);
    onConsumeReply?.();
    onSend?.();
  };
  const previewTerminalSend = async () => {
    if (locked || !bot || group || !canSendToTerminal || !terminalBridge?.readBot) return;
    const liveText = composerSendSourceText(inputRef.current?.value, text);
    if (!liveText.trim()) return;
    if (attachments.length) {
      setTerminalSendError(t("terminal.attachmentsNotSupported"));
      return;
    }
    setTerminalSendError(null);
    setTerminalSendBusy(true);
    try {
      const snapshot = await terminalBridge.readBot(bot.id);
      if (snapshot.state === "no-terminal" || !snapshot.sessionId || snapshot.generation === undefined || !snapshot.cwd) {
        setTerminalSendError(t("terminal.noActiveTerminal"));
        return;
      }
      setTerminalSendPreview({
        text: liveText,
        snapshot: snapshot as TerminalSendPreview["snapshot"],
      });
    } catch (cause) {
      setTerminalSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTerminalSendBusy(false);
    }
  };
  const confirmTerminalSend = async () => {
    if (locked || !bot || !terminalSendPreview || terminalSendBusy || !canSendToTerminal || !terminalBridge?.sendBot) {
      if (locked || !canSendToTerminal) setTerminalSendPreview(null);
      return;
    }
    setTerminalSendBusy(true);
    setTerminalSendError(null);
    try {
      await terminalBridge.sendBot(bot.id, {
        sessionId: terminalSendPreview.snapshot.sessionId,
        generation: terminalSendPreview.snapshot.generation,
        text: terminalSendPreview.text,
      });
      if (inputRef.current) inputRef.current.value = "";
      setText("");
      for (const a of attachmentsRef.current) forgetTrayMedia(a.id);
      setAttachments([]);
      setTerminalSendPreview(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/stale|changed|generation/i.test(message)) {
        setTerminalSendError(t("terminal.staleTerminal"));
        setTerminalSendPreview(null);
      } else {
        setTerminalSendError(message);
      }
    } finally {
      setTerminalSendBusy(false);
    }
  };
  useEffect(() => {
    if (preview || !group) return;
    if (locked) return;
    if (busy) {
      roomFlushLock.current = false;
      return;
    }
    if (roomFlushLock.current || queued.length === 0) return;
    const { next, rest } = peelNextBusyRoomSend(queued);
    if (!next) return;
    if (next.text.includes("<attached-image ")) {
      const support = imageTargetsSupport(next.text, false, repliedTo(next.replyToId));
      if (support !== "supported") {
        showImageSupportNotice(support, { after: false });
        commitQueued(rest);
        restoreDraft(next.draft);
        return;
      }
    }
    roomFlushLock.current = true;
    commitQueued(rest);
    dispatch({
      type: "sendGroup",
      groupId: group.id,
      text: next.text,
      sendId: next.draft.sendId,
      replyToId: next.replyToId,
      threadId: next.draft.threadId,
      actedAt: next.at,
      onError: () => {
        restoreDraft(next.draft);
        if (!mountedRef.current) return;
        roomFlushLock.current = false;
        commitQueued(rearmRoomFlushHold(queuedRef.current));
      },
    });
  }, [busy, queued, group, members, state.instances, dispatch, restoreDraft, commitQueued, locked, preview]);

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    if (locked) {
      setRecording(false);
      return;
    }
    const bridge = window.ogb;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text === "string") {
        const base = baseText.current;
        editText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      if (code === 2) {
        setSpeechError(t("composer.dictationMacOnly"));
      } else if (code === 1) {
        setSpeechError(t("composer.dictationPermission"));
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording, editText, locked]);

  const toggleMic = () => {
    if (locked) return;
    if (!capabilities.dictation.available || !window.ogb) {
      setSpeechError(t("composer.dictationUnavailable"));
      return;
    }
    baseText.current = text.trim();
    setRecording((r) => !r);
  };

  // Beside a call's End it gets tapped as the hang-up, so a call moves it to the far side.
  const callStop = stoppable && !locked && callSlot.mounted;
  const stopButton = (
    <button
      onClick={() => {
        if (stopTooSoon()) return;
        if (room?.onStop) room.onStop();
        else if (group) stopRoom(group.id);
        else if (bot && !stopping) {
          const botId = bot.id;
          setStoppingBotId(botId);
          dispatch({
            type: "interrupt",
            botId,
            onSettled: () => setStoppingBotId((current) => (current === botId ? null : current)),
          });
        }
      }}
      aria-label={t("composer.stopTurn")}
      aria-busy={stopping}
      data-orbit-composer-stop=""
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-app hover:opacity-80",
        stopping && "animate-pulse",
      )}
      title={t("composer.stop")}
    >
      <Square size={12} className="fill-current" />
    </button>
  );

  return (
    <div className="pointer-events-none relative px-5 pb-3">
      {/* No fill or hairline on this wrapper — those were the black frame
          in the pill's top corners. The dock overlays the transcript. */}
      {speechError && (
        <div className="pointer-events-auto mb-2 w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
      {shownImageNotice && (
        <div role="alert" className="pointer-events-auto mb-2 flex w-full items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          <span className="min-w-0 flex-1">{shownImageNotice}</span>
          <button
            type="button"
            onClick={() => setImageNotice(null)}
            aria-label={t("chat.dismiss")}
            title={t("chat.dismiss")}
            className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-danger/10"
          >
            <X size={13} strokeWidth={2.5} />
          </button>
        </div>
      )}
      {terminalSendError && (
        <div className="pointer-events-auto mb-2 flex w-full items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          <span className="min-w-0 flex-1">{terminalSendError}</span>
          <button
            type="button"
            onClick={() => setTerminalSendError(null)}
            aria-label={t("chat.dismiss")}
            title={t("chat.dismiss")}
            className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-danger/10"
          >
            <X size={13} strokeWidth={2.5} />
          </button>
        </div>
      )}
      <div className="pointer-events-auto relative flex max-h-[60dvh] w-full flex-col">
        {pickerOpen && (
          <div
            ref={pickerRef}
            role="listbox"
            aria-label={t("composer.tagBot")}
            className="absolute bottom-full left-2 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            {candidates.map((peer, i) => (
              <button
                key={peer.id}
                role="option"
                aria-selected={i === highlight}
                onClick={() => pickMention(peer)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                {peer.person ? (
                  <span className="flex size-6 items-center justify-center rounded-full bg-raised text-ink-secondary">
                    <User size={14} aria-hidden="true" />
                  </span>
                ) : peer.bot ? (
                  <BotAvatar
                    bot={peer.bot}
                    state={normalizeState(peer.bot.mascotExpression) ?? "happy"}
                    size={24}
                  />
                ) : peer.agent ? (
                  <RoomBotAvatar
                    bot={(room?.bots ?? (group ? roomTeamBots(group) : [])).find((roomBot) => roomBot.id === peer.id) ?? peer}
                    state="happy"
                    size={24}
                  />
                ) : (
                  <span className="flex size-6 items-center justify-center rounded-full bg-raised text-ink-secondary">
                    <Users size={14} aria-hidden="true" />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">{peer.label ?? peer.name}</span>
                  {peer.bot && <BotModelLine bot={peer.bot} />}
                </span>
                <span className="shrink-0 text-xs text-ink-secondary">{peer.person ? t("composer.person") : peer.bot || peer.agent ? t("composer.agent") : t("composer.channel")}</span>
              </button>
            ))}
          </div>
        )}
        {/* Notices, reply/approval banners and the attachment tray scroll here
            first, so a long list of them shrinks instead of pushing the send
            row (below, shrink-0) off the screen. */}
        <div data-composer-tray="" className="min-h-0 max-h-[35dvh] shrink overflow-y-auto max-md:max-h-[30dvh]">
        {group?.waitingBotIds?.map((id) => (
          <p key={id} data-room-bot-wait role="status" className="mb-1.5 px-1 text-[12px] text-ink-secondary">
            {t("teamRoom.botBusy", { name: members?.find((member) => member.id === id)?.name ?? t("chrome.aBot") })}
          </p>
        ))}
        {chain ? (
          <p data-bot-chain role="status" className="mb-1.5 px-1 text-[12px] text-ink-secondary">
            {t("teamRoom.botChain", { n: chain })}
          </p>
        ) : null}
        {room?.status?.map((row) => (
          <p key={row.id} data-my-bot-turn role="status" className={cn("mb-1.5 px-1 text-[12px]", row.failed ? "text-danger" : "text-ink-secondary")}>
            {row.text}
          </p>
        ))}
        {catchingUp && (
          <p data-catching-up role="status" className="mb-1.5 px-1 text-[12px] text-ink-secondary">
            {t("composer.catchingUp")}
          </p>
        )}
        {failedSends.map((failed) => (
          <div
            key={failed.id}
            className="mb-2 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger"
          >
            <span className="min-w-0 flex-1 truncate">
              {t("composer.notSent", { text: failed.text.trim() || t("composer.attachment") })}
            </span>
            <button
              type="button"
              onClick={() => retryFailedSend(failed)}
              disabled={locked}
              className="shrink-0 rounded px-2 py-1 font-medium hover:bg-danger/10"
            >
              {t("composer.retry")}
            </button>
            <button
              type="button"
              onClick={() => forgetFailedComposerSend(draftId, failed.id)}
              aria-label={t("composer.dismissFailed")}
              title={t("chat.dismiss")}
              className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-danger/10"
            >
              <X size={13} strokeWidth={2.5} />
            </button>
          </div>
        ))}
        {heldSlot && createPortal(queued.map((entry, index) => {
          const message: Message = { id: entry.draft.sendId, role: "user", kind: "text", text: entry.text, at: entry.at, placeholder: true };
          return (
            <div key={entry.draft.sendId} className="contents" data-mid={entry.draft.sendId}>
              <Bubble
                botId={steerBot?.id ?? ""}
                threadId={threadId}
                botName={steerBot?.name ?? ""}
                botFolder={undefined}
                busy
                hasMore={false}
                {...versionProps([message], message)}
                pinned={false}
                message={message}
                editing={false}
                isLastBotText={false}
                sendsNext={busy && index === 0}
                queuedActions={queuedActions(entry)}
                onStartEdit={() => {}}
                onCancelEdit={() => {}}
                onSubmitEdit={() => {}}
                onReply={() => {}}
                onMessageMenu={setQueuedMenu}
              />
            </div>
          );
        }), heldSlot)}
        {/* An approval sits on the composer so a waiting bot is impossible to miss. */}
        {approval && (
          <div data-pending-approval className="mb-2 overflow-hidden rounded-2xl border border-accent/40 bg-card">
            <PendingApprovalPanel pending={approval} count={approvals.length} index={0} />
            <PendingApprovalActions
              pending={approval}
              threadId={threadId}
              bot={approvalBot}
              onCancelTurn={() => {
                if (group) stopRoom(group.id);
                else if (bot) dispatch({ type: "interrupt", botId: bot.id });
              }}
            />
          </div>
        )}
        {question && (
          <PendingQuestionPanel
            key={question.id}
            message={question}
            askerName={questionAsker}
            count={questions.length}
            index={questionIndex}
            onStep={(step) => {
              const next = questions[questionIndex + step];
              if (!next || !pinned) return;
              foldQuestion(next.id);
              setQuestionPick({ id: next.id, newest: pinned.id });
            }}
            typed={text}
            attached={attachments.length}
            replying={Boolean(replyTo)}
            movedOn={questionMovedOn}
            onPick={(choice) => {
              if (group) dispatch({ type: "answerGroupCard", groupId: group.id, messageId: question.id, answer: choice });
              else if (bot) dispatch({ type: "answerCard", botId: bot.id, messageId: question.id, answer: choice });
            }}
            onDismiss={() => {
              if (group) dispatch({ type: "dismissGroupCard", groupId: group.id, messageId: question.id });
              else if (bot) dispatch({ type: "dismissCard", botId: bot.id, messageId: question.id });
            }}
          />
        )}
        <div inert={locked}>
        <ComposerAttachments
          disabled={locked}
          items={shownAttachments}
          onAdd={addAttachments}
          onRemove={removeAttachment}
          onRetryUpload={retryUpload}
          onRepickUpload={(id) => {
            repickTarget.current = id;
            repickInput.current?.click();
          }}
          onDisplayInChatBox={displayPasteInChatBox}
          allowImages={engineSupportsImages}
          notice={attachmentNotice}
          onNotice={showNotice}
          localFile={room ? roomPicture : undefined}
          onDropFiles={room ? (files) => void pickFiles(files) : undefined}
          dropLabel={room ? t("teamRoom.dropToAttach") : undefined}
          roomCopy={group?.hosted ? roomCopyPath : undefined}
          quote={replyTo && <ReplyQuote message={replyTo} fallbackName={room ? replyTo.author?.name : bot?.name} onClear={onClearReply} />}
        />
        </div>
        </div>
        <div data-orbit-composer-host className="relative shrink-0">
          {/* App-ground from the pill's bottom radius down, full-bleed.
              Bubbles may tuck into the pill; they must not paint under it. */}
          <div
            aria-hidden
            className="absolute -left-5 -right-5 top-[calc(100%-1.5rem)] h-[50vh] bg-app"
          />
        <div
          data-orbit-composer-frame
          data-rainbow={rainbow === "off" ? undefined : ""}
          className="relative grid cursor-text grid-cols-[auto_1fr_auto] items-center gap-x-2 rounded-3xl bg-raised px-3 pb-2 pt-1"
          onPointerDownCapture={(e) => {
            framePress.current = e.button === 0 && !(e.target as Element).closest(frameControl);
            if (framePress.current && !inputRef.current?.disabled) e.preventDefault();
          }}
          onClick={(e) => {
            const input = inputRef.current;
            if (!framePress.current || e.defaultPrevented || !input || input.disabled || (e.target as Element).closest(frameControl)) return;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            setCaret(input.value.length);
          }}
        >
          {rainbow !== "off" && <RainbowRing theme={rainbow === "theme"} />}
          {question && <HiddenQuestionDot id={question.id} count={questions.length} />}
          <input
            ref={fileInput}
            disabled={locked}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void holdReload(pickFiles(Array.from(e.target.files ?? [])));
              // same file twice in a row still fires onChange
              e.target.value = "";
            }}
          />
          <input
            ref={repickInput}
            disabled={locked}
            type="file"
            className="hidden"
            onChange={(e) => {
              repick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {((!locked && !room?.offline) || callStop) && (
            <div className="col-start-1 row-start-3 mt-1 flex items-center gap-1">
              {!locked && !room?.offline && <button
                type="button"
                onClick={() => fileInput.current?.click()}
                aria-label={t("composer.attach")}
                title={t("composer.attach")}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
              >
                <Paperclip size={17} />
              </button>}
              {callStop && stopButton}
            </div>
          )}
          {callSlot.mounted && callSlot.value?.({ closing: callSlot.closing })}
          <textarea
          ref={setComposerRef}
          data-orbit-composer=""
          rows={1}
          style={nativeSizing ? { fieldSizing: "content" } : undefined}
          value={text}
          onChange={(e) => {
            pasteUndo.current = null;
            editText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
          }}
          onPaste={(e) => {
            const imageFiles = Array.from(e.clipboardData.files).filter((file) => room || isImageFile(file));
            if (imageFiles.length) {
              e.preventDefault();
              // same intake as a pick, so an oversized image takes the big-file route
              void holdReload(pasteImages(imageFiles));
              return;
            }
            // a wall of text becomes a chip instead of burying the input
            const pasted = e.clipboardData.getData("text/plain");
            // A pasted-text chip reaches people as raw markup.
            if (room || !isLongPaste(pasted)) return;
            e.preventDefault();
            // Preserve native paste replacement semantics: if text was
            // selected, the attachment replaces that selection.
            const start = e.currentTarget.selectionStart;
            const end = e.currentTarget.selectionEnd;
            const nextText = start === end ? text : `${text.slice(0, start)}${text.slice(end)}`;
            const added = pasteAttachment(pasted);
            pasteUndo.current = { text, shown: nextText, restore: (prev) => prev.filter((a) => a.id !== added.id) };
            if (start !== end) {
              editText(nextText);
              setCaret(start);
            }
            editAttachments((prev) => [...prev, added]);
          }}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onCompositionStart={() => {
            composingRef.current = true;
            compositionEndedAtRef.current = 0;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            compositionEndedAtRef.current = Date.now();
          }}
          onBlur={() => {
            composingRef.current = false;
            compositionEndedAtRef.current = 0;
          }}
          onFocus={() => {
            if (bot?.id) requestBotPrewarm(bot.id);
          }}
          onKeyDown={(e) => {
            if (bot?.id && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
              requestBotPrewarm(bot.id);
            }

            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !e.altKey && undoPasteDisplay()) {
              e.preventDefault();
              return;
            }
            if (pickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                return;
              }
              if ((isComposerEnterKey(e) && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
                e.preventDefault();
                pickMention(candidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(mention?.start ?? null);
                return;
              }
            }
            // an empty composer + ArrowUp = edit your last message (like a chat app)
            if (e.key === "ArrowUp" && !hasContent && onEditLast) {
              e.preventDefault();
              onEditLast();
              return;
            }
            // Shift+Enter inserts a newline; plain Enter sends, except on touch
            const enter = composerEnterIntent(e, {
              composing: composingRef.current,
              justEnded: Date.now() - compositionEndedAtRef.current < 50,
              touch: window.matchMedia?.("(pointer: coarse)").matches,
            });
            if (enter === "send" || enter === "send-after") {
              e.preventDefault();
              send(enter === "send-after");
            }
            if (e.key === "Escape" && recording) setRecording(false);
          }}
          disabled={locked}
          placeholder={
            locked
              ? t("composer.finishSetup")
              : recording
              ? t("composer.listening")
              : pinned && !pinned.card?.options.length
              ? t("ask.typeAnswer")
              : busyChrome.placeholder
          }
          aria-label={t("composer.messageAria", { name: group ? group.name : room ? room.name : (bot?.name ?? "") })}
            className="col-span-full row-start-2 max-h-[9rem] min-h-6 w-full resize-none overflow-y-auto self-center bg-transparent px-1 py-1 text-[15px] leading-6 text-ink placeholder:text-ink-secondary focus:outline-none max-md:text-[16px]"
          />
        <div className="col-start-3 row-start-3 mt-1 flex items-center gap-1">
          {stoppable && !locked && !callSlot.mounted && stopButton}
        {!locked && !stoppable && !hasContent && !callSlot.mounted && capabilities.dictation.available && (
          <button
            onClick={toggleMic}
            aria-label={recording ? t("composer.stopDictation") : t("composer.startDictation")}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : "text-ink-secondary hover:bg-raised hover:text-ink",
            )}
            title={recording ? t("composer.stopDictationEsc") : t("composer.dictate")}
          >
            <Mic size={18} />
          </button>
        )}
        {hasContent && !locked && (
          <>
          {/* Hidden while sharing is on: the bot types into its own panes. */}
          {canSendToTerminal && bot?.shareTerminalWithChat === false && !busy && (
            <button
              type="button"
              onClick={() => void previewTerminalSend()}
              aria-label={t("terminal.sendToTerminal")}
              title={t("terminal.sendToTerminalTitle", { name: bot?.name ?? "" })}
              disabled={terminalSendBusy}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            >
              <TerminalSquare size={16} />
            </button>
          )}
          <button
            {...holdToSendAfter(send)}
            disabled={uploading || room?.offline}
            aria-label={t(busyChrome.sendAriaKey)}
            title={uploading ? t("composer.uploadWaiting") : t(busyChrome.sendTitleKey)}
            className="flex size-8 shrink-0 select-none items-center justify-center rounded-full bg-accent text-accent-ink hover:brightness-110 [-webkit-touch-callout:none] disabled:opacity-40"
          >
            <ArrowUp size={17} />
          </button>
          </>
          )}
          {(callButton || onCall) && caller && !hasContent && !locked && !callSlot.mounted && (callButton ?? (
            <>
              <CallGear bot={caller} className="max-md:-my-1" />
              <button
                type="button"
                onClick={onCall}
                onPointerEnter={(event) => { if (event.pointerType === "mouse") warmCallAudio(); }}
                onFocus={warmCallAudio}
                aria-label={t("composer.call", { name: caller.name })}
                title={t("composer.call", { name: caller.name })}
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink hover:brightness-110"
              >
                <Phone size={16} />
              </button>
            </>
          ))}
          </div>
        </div>
        </div>
      </div>
      {queuedMenu?.kind === "message" && (
        <MessageMenu
          x={queuedMenu.x} y={queuedMenu.y} opener={queuedMenu.opener} target={queuedMenu.target}
          onReply={() => {}} onPin={() => {}} onClose={() => setQueuedMenu(null)}
        />
      )}
      {sendPreview.value && (
        <ConfirmDialog
          closing={sendPreview.closing}
          title={t("terminal.sendToTerminalTitle", { name: bot?.name ?? "" })}
          body={
            <span className="block">
              <span className="block">{t("terminal.sendToTerminalHelp")}</span>
              <span className="mt-2 block text-[11px] text-ink-secondary">
                {sendPreview.value.snapshot.cwd} · session {sendPreview.value.snapshot.sessionId.slice(0, 8)} · generation {sendPreview.value.snapshot.generation}
              </span>
              <span className="mt-3 block max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-raised px-3 py-2 font-mono text-[12px] text-ink">
                {sendPreview.value.text}
              </span>
            </span>
          }
          confirmLabel={t("terminal.sendToTerminal")}
          danger={false}
          onConfirm={() => void confirmTerminalSend()}
          onCancel={() => {
            if (!terminalSendBusy) setTerminalSendPreview(null);
          }}
        />
      )}
    </div>
  );
}
