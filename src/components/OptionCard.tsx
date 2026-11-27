import { useState } from "react";
import { X } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { useI18n } from "@/lib/i18n";
import { QuestionChoiceCard } from "./QuestionChoiceCard";

/** The first-run quiz older builds seeded, not a live provider ask (those
 * carry requestId) and not a bot's ask_user question (marked askUser). */
export function isOnboardingCard(message: Message): boolean {
  return message.kind === "options" && !!message.card && !message.card.requestId && !message.card.askUser;
}

/** A new chat opens on the composer alone, so a seeded quiz never shows. Live asks are never this card. */
export function shouldHideOnboardingCard(message: Message): boolean {
  return isOnboardingCard(message);
}

export function OptionCard({
  botId,
  message,
}: {
  botId: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const { t } = useI18n();
  const [custom, setCustom] = useState("");
  const [pending, setPending] = useState(false);
  const card = message.card;
  if (!card || shouldHideOnboardingCard(message)) return null;
  const { title, subtitle, options } = card;
  const answered = card.answered ?? null;
  const selectedOption = answered && options.includes(answered) ? answered : null;
  const customAnswered = Boolean(answered) && !selectedOption;

  const answer = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending || card.answered) return;
    setPending(true);
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: trimmed });
  };

  return (
    <div className="flex w-full flex-col gap-2">
      <QuestionChoiceCard
        question={title}
        subtitle={subtitle || null}
        options={options}
        pending={pending}
        selectedOption={selectedOption}
        customAnswered={customAnswered}
        onPick={answer}
        headerEnd={
          <button
            type="button"
            onClick={() => dispatch({ type: "dismissCard", botId, messageId: message.id })}
            aria-label={t("chat.dismissQuestion")}
            className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink focus-visible:bg-control focus-visible:text-ink"
          >
            <X size={16} aria-hidden="true" />
          </button>
        }
      />

      {/* a permission ask has no free-text answer — the broker only accepts
          allow/deny, so typing here used to fail silently */}
      {!card.answered && !card.tool && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) answer(custom);
          }}
          placeholder={t("chat.ownAnswer")}
          className="w-full max-w-[560px] rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none max-md:text-[16px]"
        />
      )}
    </div>
  );
}
