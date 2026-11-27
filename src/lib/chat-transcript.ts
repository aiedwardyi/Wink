// Which 1:1 ChatView rows render, and where a day divider belongs. ChatView
// hides tool activity and screen frames unless Show tool calls is on, so
// dating against the previous ITEM can drop the divider off the next visible
// line. Failed tools and turn-level errors stay visible so a broken step
// is not a blank chat.
import { shouldHideOnboardingCard } from "@/components/OptionCard";
import { readContextCompaction } from "../../shared/context-compaction";
import { activityRunVisible, activityVisibleInChat, isStepText, type TranscriptItem } from "./activity-runs";
import { isShownMessage } from "./shown-message";
import type { Message } from "@/state/store";

export interface ChatTranscriptOptions {
  showToolCalls: boolean;
  showActivities?: boolean;
  /** the newest reply, animating in above the transcript instead of inside it */
  emergingId?: string | null;
  /** Full active-branch transcript, used to hide a talked-past onboarding card. */
  transcript: Message[];
}

export interface ChatTranscriptRow {
  visible: boolean;
  newDay: boolean;
}

/** Mirrors the row ChatView's Transcript renders for one message. */
export function messageVisible(message: Message, options: ChatTranscriptOptions): boolean {
  if (message.id === options.emergingId || (!isShownMessage(message) && !isStepText(message))) return false;
  switch (message.kind) {
    case "compaction": {
      const parsed = readContextCompaction({ value: message.compaction });
      if (parsed.status !== "valid") return parsed.status !== "invalid";
      // The first row on a boundary stays so the line marks where the summary happened; a repair row lands later in the path.
      const index = options.transcript.findIndex((item) => item.id === message.id);
      return !options.transcript.slice(0, Math.max(0, index)).some((earlier) => {
        if (earlier.kind !== "compaction") return false;
        const read = readContextCompaction({ value: earlier.compaction });
        return read.status === "valid" && read.value.coveredThroughId === parsed.value.coveredThroughId;
      });
    }
    case "secret":
      return Boolean(message.secret);
    case "connector":
      return Boolean(message.connector);
    case "options":
      if (message.card?.requestId && message.card.tool) return true;
      if (shouldHideOnboardingCard(message)) return false;
      return Boolean(message.card);
    case "routine.run":
      return !message.routineRun?.wake;
    case "activity":
      return Boolean(
        message.tool?.name.startsWith("error:") || activityVisibleInChat(message, options.showActivities ?? options.showToolCalls),
      );
    case "screen":
      return Boolean(message.png || message.image || message.hasImage) && (message.shown || options.showToolCalls);
    default:
      return true;
  }
}

/** Window-boundary visibility: a Steps fold counts once (on its first step) so
 * compact windows like phone peek never slice a Steps (n) run in half. */
export function windowRowVisible(
  messages: readonly Message[],
  index: number,
  options: ChatTranscriptOptions,
): boolean {
  const message = messages[index];
  if (!message || !messageVisible(message, options)) return false;
  if (!isStepText(message)) return true;
  const day = new Date(message.at).toDateString();
  for (let i = index - 1; i >= 0; i--) {
    const prev = messages[i];
    if (prev.role !== message.role || prev.from?.botId !== message.from?.botId || new Date(prev.at).toDateString() !== day) break;
    if (isStepText(prev)) return false;
    if (prev.kind === "activity" && prev.tool && !prev.comm && !prev.tool.name.startsWith("error:") && prev.tool.name !== "memory.save") continue;
    break;
  }
  return true;
}

export function chatTranscriptRows(
  items: TranscriptItem[],
  options: ChatTranscriptOptions,
): ChatTranscriptRow[] {
  let prev: Message | undefined;
  return items.map((item) => {
    const first = item.kind === "message" ? item.message : item.messages[0];
    const visible =
      item.kind === "run"
        ? activityRunVisible(item.messages, options.showActivities ?? options.showToolCalls)
        : messageVisible(first, options);
    if (!visible) return { visible, newDay: false };
    const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
    prev = item.kind === "message" ? item.message : item.messages.at(-1);
    return { visible, newDay };
  });
}
