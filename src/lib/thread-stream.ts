import { useMemo } from "react";

import { useStreamSelect, type Message } from "@/state/store";
import { liveReply, sameLiveReply, sameThreadTurn, threadTurn, type ThreadTurn } from "./turn-stage";

export function useThreadTurn(threadId: string, lastMessageId?: string): ThreadTurn {
  return useStreamSelect((stream) => threadTurn(stream, threadId, lastMessageId), sameThreadTurn);
}

// The row carries no text: only the transcript that draws it re-renders per typed frame.
export function useLiveReply(row: Message | null, threadId: string): Message | null {
  const reply = useStreamSelect((stream) => (row ? liveReply(stream, threadId, row.parentId ?? undefined) : null), sameLiveReply);
  return useMemo(() => (row && reply ? { ...row, text: reply.text, streamWhole: reply.whole } : null), [row, reply]);
}
