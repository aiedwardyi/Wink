import type { Message } from "@/state/store";
import { busyRetryLabel } from "./activity-runs";
import { liveActivityLabel } from "./live-activity";
import { useNoReply } from "./no-reply";
import { turnPhase, turnStageLabel, type ThreadTurn } from "./turn-stage";

// A room has no rerun path, so unlike 1:1 a silent engine offers no model switch.
export function useRoomTurnStage(threadId: string, messages: Message[], turn: ThreadTurn, showActivities: boolean, driverKind?: string, quiet = false) {
  const last = messages.at(-1);
  const phase = turnPhase({ signal: turn.signal, lastMessage: last, messages, streaming: turn.streaming, reasoning: turn.reasoning });
  const noReply = useNoReply(phase === "waiting" ? `${threadId}:${turn.turnId}:${turn.heard}` : null, driverKind);
  return { label: turnStageLabel(phase, liveActivityLabel(last, showActivities, quiet), busyRetryLabel(last), noReply?.label), noReply, responding: phase === "responding" };
}
