import type { Message } from "@/state/store";
import { busyRetryLabel } from "./activity-runs";
import { liveActivityLabel } from "./live-activity";
import { useNoReply } from "./no-reply";
import { buffersForTurn, currentTurnId, turnPhase, turnStageLabel, type TurnStreamState } from "./turn-stage";

// A room has no rerun path, so unlike 1:1 a silent engine offers no model switch.
export function useRoomTurnStage(threadId: string, messages: Message[], stream: TurnStreamState, showActivities: boolean, driverKind?: string) {
  const last = messages.at(-1);
  const live = buffersForTurn(stream, threadId, last?.id);
  const phase = turnPhase({ signal: stream.signal[threadId], lastMessage: last, messages, streaming: live.streaming, reasoning: live.reasoning });
  const noReply = useNoReply(phase === "waiting" ? `${threadId}:${currentTurnId(stream, threadId, last?.id)}:${stream.heard?.[threadId] ?? 0}` : null, driverKind);
  return { label: turnStageLabel(phase, liveActivityLabel(last, showActivities), busyRetryLabel(last), noReply?.label), noReply };
}
