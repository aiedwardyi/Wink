// A bot's open ask_user question, pinned above the composer in the
// PendingApproval style. Unlike an approval it never takes the composer
// over: the bot keeps working, and typing a reply answers it only when it has
// no choices. The question is never truncated (it scrolls instead).
import { memo, useRef, useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { Message } from "@/state/store";
import { useI18n } from "@/lib/i18n";

const foldedQuestions = new Set<string>();
const watchers = new Set<() => void>();
function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

export const PendingQuestionPanel = memo(function PendingQuestionPanel({
  message,
  askerName,
  onPick,
  onDismiss,
}: {
  message: Message;
  askerName: string;
  onPick: (choice: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const folded = useSyncExternalStore(subscribe, () => foldedQuestions.has(message.id), () => false);
  const touch = useRef<{ x: number; y: number; id: string } | null>(null);
  const fold = (value: boolean) => {
    if (value) foldedQuestions.add(message.id);
    else foldedQuestions.delete(message.id);
    for (const notify of watchers) notify();
  };
  const card = message.card;
  if (!card) return null;
  if (folded) return (
    <button
      type="button"
      data-pending-question={message.id}
      data-question-folded="true"
      aria-expanded={false}
      aria-label={`${t("ask.expandQuestion")}: ${card.subtitle}`}
      onClick={() => fold(false)}
      className="mb-2 flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-full border border-accent/40 bg-card px-4 py-2 text-left text-[13px] text-ink hover:bg-control pointer-coarse:min-h-11"
    >
      <span className="shrink-0 text-ink-secondary">{t("ask.asks", { name: askerName })}</span>
      <span className="min-w-0 flex-1 truncate">{card.subtitle}</span>
      <ChevronUp size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
    </button>
  );
  return (
    <div
      role="region"
      aria-label={t("ask.asks", { name: askerName })}
      data-pending-question={message.id}
      onTouchStart={(event) => {
        touch.current = null;
        if (event.touches.length !== 1 || (event.target as Element).closest("button")) return;
        for (let el = event.target as Element | null; el && el !== event.currentTarget; el = el.parentElement) {
          if (el.scrollTop > 0) return;
        }
        const point = event.touches[0];
        touch.current = { x: point.clientX, y: point.clientY, id: message.id };
      }}
      onTouchEnd={(event) => {
        const start = touch.current;
        touch.current = null;
        const end = event.changedTouches[0];
        if (start?.id === message.id && end && end.clientY - start.y > 48 && Math.abs(end.clientX - start.x) < 24) fold(true);
      }}
      onTouchCancel={() => { touch.current = null; }}
      className="mb-2 overflow-hidden rounded-2xl border border-accent/40 bg-card"
    >
      <div className="bg-control/40 px-4 py-3">
        <div className="flex items-start gap-2" aria-live="polite">
          <span className="min-w-0 flex-1 truncate pt-0.5 text-[11px] uppercase tracking-[0.18em] text-ink-secondary">
            {t("ask.asks", { name: askerName })}
          </span>
          <button
            type="button"
            onClick={() => fold(true)}
            aria-label={t("ask.foldQuestion")}
            aria-expanded={true}
            title={t("ask.foldQuestion")}
            className="-mt-0.5 shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink pointer-coarse:-my-3 pointer-coarse:px-[15px] pointer-coarse:pt-[14px] pointer-coarse:pb-4"
          >
            <ChevronDown size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t("chat.dismissQuestion")}
            title={t("chat.dismissQuestion")}
            className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink pointer-coarse:-my-3 pointer-coarse:-mr-[15px] pointer-coarse:px-[15px] pointer-coarse:pt-[14px] pointer-coarse:pb-4"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div
          tabIndex={0}
          className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink"
        >
          {card.subtitle}
        </div>
        <AskChoices options={card.options} onPick={onPick} />
      </div>
    </div>
  );
});

export function AskChoices({ options, onPick }: { options: string[]; onPick: (choice: string) => void }) {
  if (!options.length) return null;
  return (
    <div data-term-choices className="mt-2.5 flex flex-wrap gap-2">
      {options.map((choice) => (
        <button
          key={choice}
          type="button"
          onClick={() => onPick(choice)}
          className="max-w-full break-words rounded-full border border-ink-secondary bg-control px-3.5 py-1.5 text-left text-[13px] text-ink hover:bg-raised-hover pointer-coarse:min-h-11"
        >
          {choice}
        </button>
      ))}
    </div>
  );
}
