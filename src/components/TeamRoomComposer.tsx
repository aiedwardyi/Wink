import { useReplyDraft } from "@/lib/drafts";
import { useBackLayer } from "@/lib/use-back-layer";
import type { Message } from "@/state/store-types";

import { CallWidgetSlot } from "./CallSlots";
import { Composer, type RoomBotStatus, type RoomPerson } from "./Composer";

export function useTeamRoomReply(base: string, draftId: string, messages: Message[]) {
  const { replyTo, selectReply, clearReply } = useReplyDraft(base, draftId, messages);
  useBackLayer(Boolean(replyTo), clearReply);
  return { replyTo, selectReply, clearReply };
}

export function TeamRoomComposer({ name, base, draftId, people, bots, replyTo, onClearReply, offline, status, onStop }: {
  name: string; base: string; draftId: string; people?: readonly RoomPerson[]; bots?: readonly RoomPerson[]; replyTo: Message | null; onClearReply: () => void; offline?: boolean;
  status?: readonly RoomBotStatus[]; onStop?: () => void;
}) {
  return (
    <>
      <CallWidgetSlot className="px-3 pb-2 md:hidden" />
      <Composer room={{ name, base, draftId, people, bots, offline, status, onStop }} replyTo={replyTo} onClearReply={onClearReply} />
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
