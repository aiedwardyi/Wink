import type { Message } from "@/state/store";
import { isVoiceLine } from "../../shared/live-call";

/** A live turn's plain text may turn out to be a step, so its buzz, speech and sidebar glow wait for the turn's end, where only its answer plays.
 * A steer reply, a peer turn, a sidekick line and a summary play as they land, as before. */
export function holdsReply(message: Message, live: boolean, earlier: readonly Message[]): boolean {
  if (!live || message.role !== "bot" || message.kind !== "text") return false;
  if (message.quick || message.comm || message.roomEcho || message.summarized || isVoiceLine(message)) return false;
  if (earlier.findLast((m) => m.role === "user" && m.kind === "text" && !m.steered && !isVoiceLine(m))?.from) return false;
  const anchor = earlier.findLast((m) => m.id !== message.id && !isVoiceLine(m) && (m.role === "user" || (m.role === "bot" && m.kind === "text")));
  return !(anchor?.role === "user" && anchor.steered && !anchor.queueId);
}
