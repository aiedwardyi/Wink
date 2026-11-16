// A bot's ask_user question as it reads in the transcript. The pinned one is
// answered above the composer; an older one still waiting keeps its choices here.
import { Check, CircleHelp, X } from "lucide-react";
import type { Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { ANSWERED_IN_CHAT, askUserStatus } from "@/lib/open-question";
import { AskChoices } from "./PendingQuestion";

export function AskUserRecord({
  message,
  transcript,
  askerName,
  pinned = false,
  onPick,
}: {
  message: Message;
  /** the chat's messages, to see whether it was answered or asked again */
  transcript: readonly Message[];
  askerName?: string;
  /** the composer pins this question, so the record need not repeat it */
  pinned?: boolean;
  /** absent on a read-only transcript */
  onPick?: (choice: string) => void;
}) {
  const { t } = useI18n();
  const card = message.card;
  if (!card) return null;
  const status = askUserStatus(transcript, message);
  const waiting = status.state === "waiting";
  if (waiting && pinned) return null;
  return (
    <div
      data-ask-user-record={status.state}
      className={cn(
        "w-full max-w-[840px] rounded-2xl border bg-card p-4",
        waiting ? "border-accent/40" : "border-hairline/30 opacity-70",
      )}
    >
      {askerName && <div className="text-[13px] font-semibold text-ink">{t("ask.asks", { name: askerName })}</div>}
      <div className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">{card.subtitle}</div>
      {waiting && onPick && <AskChoices options={card.options} onPick={onPick} />}
      <div className="mt-3 flex min-w-0 items-center gap-1.5 text-[13px] text-ink-secondary">
        {status.state === "answered" ? (
          <>
            <Check size={14} className="shrink-0 text-success" />
            <span className="min-w-0 truncate">{status.reply === ANSWERED_IN_CHAT ? t("ask.answeredInChat") : t("ask.answered", { reply: status.reply })}</span>
          </>
        ) : status.state === "dismissed" ? (
          <>
            <X size={14} className="shrink-0" /> {t("ask.dismissed")}
          </>
        ) : status.state === "superseded" || status.state === "askedAgain" ? (
          <>
            <X size={14} className="shrink-0" /> {t(status.state === "askedAgain" ? "ask.askedAgain" : "ask.superseded")}
          </>
        ) : (
          <>
            <CircleHelp size={14} className="shrink-0 text-accent" /> {t("ask.waiting")}
          </>
        )}
      </div>
    </div>
  );
}
