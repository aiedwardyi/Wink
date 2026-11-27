import { useReplyDraft } from "@/lib/drafts";
import { useReplyFocus } from "@/lib/reply-focus";
import { useBackLayer } from "@/lib/use-back-layer";
import { ChatPeekPart, useChatPreview } from "@/lib/chat-preview";
import type { Message } from "@/state/store-types";

import { CallWidgetSlot } from "./CallSlots";
import { Composer, type RoomBotStatus, type RoomPerson } from "./Composer";
import type { useCallControls } from "./CallControls";

export function useTeamRoomReply(base: string, draftId: string, messages: Message[]) {
  const preview = useChatPreview();
  const reply = useReplyDraft(base, draftId, messages);
  const selectReply = useReplyFocus(reply.selectReply);
  useBackLayer(!preview && Boolean(reply.replyTo), reply.clearReply);
  return { ...reply, selectReply };
}

export function TeamRoomComposer({ name, base, draftId, people, bots, replyTo, onClearReply, onConsumeReply, onRestoreReply, offline, status, onStop, chain, onSend, call }: {
  name: string; base: string; draftId: string; people?: readonly RoomPerson[]; bots?: readonly RoomPerson[]; replyTo: Message | null; onClearReply: () => void; offline?: boolean;
  onConsumeReply: () => void; onRestoreReply: (message: Message, threadId: string) => void;
  status?: readonly RoomBotStatus[]; onStop?: () => void; chain?: number; onSend?: () => void;
  call?: ReturnType<typeof useCallControls>;
}) {
  const preview = useChatPreview();
  return (
    <ChatPeekPart part="composer">
      {call?.bar}
      {!preview && <CallWidgetSlot className="px-3 pb-2 md:hidden" />}
      <Composer room={{ name, base, draftId, people, bots, offline, status, onStop, chain }} focusBlocked={preview} replyTo={replyTo} onSend={onSend} onClearReply={onClearReply} onConsumeReply={onConsumeReply} onRestoreReply={onRestoreReply} {...call?.composer} />
    </ChatPeekPart>
  );
}

/** Stands where the composer would, when this side can't send. */
export function TeamRoomStatus({ text }: { text: string }) {
  return (
    <div className="px-5 pb-3">
      <div role="status" className="rounded-3xl bg-raised px-4 py-3 text-center text-[13px] text-ink-secondary">
        {text}
      </div>
    </div>
  );
}
