import { useEffect, useState } from "react";

import { useBackLayer } from "@/lib/use-back-layer";
import type { Message } from "@/state/store-types";

import { CallWidgetSlot } from "./CallSlots";
import { Composer, type RoomPerson } from "./Composer";

export function useTeamRoomReply(base: string) {
  const [draft, setDraft] = useState<{ base: string; message: Message } | null>(null);
  const replyTo = draft?.base === base ? draft.message : null;
  const clearReply = () => setDraft(null);
  useBackLayer(Boolean(replyTo), clearReply);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[data-message-menu], [data-selection-menu]")) setDraft(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setDraft]);
  return { replyTo, selectReply: (message: Message) => setDraft({ base, message }), clearReply };
}

export function TeamRoomComposer({ name, base, draftId, people, bots, replyTo, onClearReply }: { name: string; base: string; draftId: string; people?: readonly RoomPerson[]; bots?: readonly RoomPerson[]; replyTo: Message | null; onClearReply: () => void }) {
  return (
    <>
      <CallWidgetSlot className="px-3 pb-2 md:hidden" />
      <Composer room={{ name, base, draftId, people, bots }} replyTo={replyTo} onClearReply={onClearReply} />
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
