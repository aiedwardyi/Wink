import { useReplyDraft } from "@/lib/drafts";
import { useBackLayer } from "@/lib/use-back-layer";
import type { Message } from "@/state/store-types";

import { CallWidgetSlot } from "./CallSlots";
import { Composer, type RoomBotStatus, type RoomPerson } from "./Composer";

export function useTeamRoomReply(base: string, draftId: string, messages: Message[]) {
  const reply = useReplyDraft(base, draftId, messages);
  useBackLayer(Boolean(reply.replyTo), reply.clearReply);
  return reply;
}

export function TeamRoomComposer({ name, base, draftId, people, bots, replyTo, onClearReply, onConsumeReply, onRestoreReply, offline, status, onStop, chain }: {
  name: string; base: string; draftId: string; people?: readonly RoomPerson[]; bots?: readonly RoomPerson[]; replyTo: Message | null; onClearReply: () => void; offline?: boolean;
  onConsumeReply: () => void; onRestoreReply: (message: Message, threadId: string) => void;
  status?: readonly RoomBotStatus[]; onStop?: () => void; chain?: number;
}) {
  return (
    <>
      <CallWidgetSlot className="px-3 pb-2 md:hidden" />
      <Composer room={{ name, base, draftId, people, bots, offline, status, onStop, chain }} replyTo={replyTo} onClearReply={onClearReply} onConsumeReply={onConsumeReply} onRestoreReply={onRestoreReply} />
    </>
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
