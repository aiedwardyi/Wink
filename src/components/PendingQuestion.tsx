// A bot's open ask_user question, pinned above the composer. It arrives as
// one quote row that glows once; a tap opens the full card in the
// PendingApproval style. Unlike an approval it never takes the composer
// over: the bot keeps working, and typing a reply answers it only when it has
// no choices. The row's x or a sideways swipe only hides it here; the bot
// still waits, and a count on the composer brings it back.
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, X } from "lucide-react";
import type { Message } from "@/state/store";
import { ARRIVAL_GLOW_ANIMATION } from "@/lib/arrival-glow";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { lockAxis, reducedMotion, swipeStep, type SwipeAxis } from "@/lib/phone-swipe";
import { Fold } from "./Fold";
import { QuoteRow } from "./ReplyQuote";

// Per question id, outside the store, so each chat's question stays as it was left.
const openQuestions = new Set<string>();
const hiddenQuestions = new Set<string>();
const glowedQuestions = new Set<string>();
const watchers = new Set<() => void>();
function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}
function mark(questions: Set<string>, id: string, value: boolean) {
  if (value) questions.add(id);
  else questions.delete(id);
  for (const notify of watchers) notify();
}
const useMarked = (questions: Set<string>, id: string) => useSyncExternalStore(subscribe, () => questions.has(id), () => false);

const BADGE = "flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-ink";

export const PendingQuestionPanel = memo(function PendingQuestionPanel({
  message,
  askerName,
  count,
  onPick,
  onDismiss,
}: {
  message: Message;
  askerName: string;
  /** open questions in this chat */
  count: number;
  onPick: (choice: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const open = useMarked(openQuestions, message.id);
  const hidden = useMarked(hiddenQuestions, message.id);
  const [glowing, setGlowing] = useState(() => !glowedQuestions.has(message.id) && !reducedMotion());
  useEffect(() => { glowedQuestions.add(message.id); }, [message.id]);
  const touch = useRef<{ x: number; y: number; id: string } | null>(null);
  const slide = useRef<{ x: number; y: number; at: number; axis: SwipeAxis } | null>(null);
  const fold = (value: boolean) => mark(openQuestions, message.id, !value);
  const card = message.card;
  if (!card || hidden) return null;
  return (
    <>
      <Fold open={!open} className="mb-2 px-1">
        <QuoteRow
          data-pending-question={message.id}
          data-question-row=""
          data-no-swipe=""
          className={cn("relative touch-pan-y", glowing && "arrival-glow")}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && event.animationName === ARRIVAL_GLOW_ANIMATION) setGlowing(false);
          }}
          onTouchStart={(event) => {
            const point = event.touches[0];
            slide.current = event.touches.length === 1 && point ? { x: point.clientX, y: point.clientY, at: event.timeStamp, axis: null } : null;
          }}
          onTouchMove={(event) => {
            const start = slide.current;
            const point = event.touches[0];
            if (!start || !point) return;
            start.axis ??= lockAxis(point.clientX - start.x, point.clientY - start.y);
            if (start.axis === "x") event.currentTarget.style.transform = `translateX(${point.clientX - start.x}px)`;
          }}
          onTouchEnd={(event) => {
            const start = slide.current;
            const end = event.changedTouches[0];
            slide.current = null;
            event.currentTarget.style.transform = "";
            if (!start || !end) return;
            const dx = end.clientX - start.x;
            if ((start.axis ?? lockAxis(dx, end.clientY - start.y)) !== "x") return;
            if (swipeStep(dx, dx / Math.max(1, event.timeStamp - start.at), event.currentTarget.offsetWidth)) mark(hiddenQuestions, message.id, true);
          }}
          onTouchCancel={(event) => {
            slide.current = null;
            event.currentTarget.style.transform = "";
          }}
          icon={<span className={BADGE}>{count}</span>}
          label={t("ask.asks", { name: askerName })}
          text={card.subtitle.trim().split(/\r?\n/, 1)[0]}
          jump={{ onClick: () => fold(false), "aria-expanded": false, "aria-label": `${t("ask.expandQuestion")}: ${card.subtitle}` }}
          onClear={() => mark(hiddenQuestions, message.id, true)}
          clearLabel={t("ask.hideQuestion")}
        />
      </Fold>
      <Fold open={open} className="mb-2">
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
          className="overflow-hidden rounded-2xl border border-accent/40 bg-card"
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
      </Fold>
    </>
  );
});

/** A hidden question's count on the composer's edge: a tap brings its row back. */
export function HiddenQuestionDot({ id, count }: { id: string; count: number }) {
  const { t } = useI18n();
  const hidden = useMarked(hiddenQuestions, id);
  if (!hidden) return null;
  return (
    <button
      type="button"
      data-hidden-question={id}
      onClick={() => mark(hiddenQuestions, id, false)}
      aria-label={t("ask.showQuestion")}
      title={t("ask.showQuestion")}
      className={cn(BADGE, "absolute -left-0.5 -top-0.5 z-10 pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5")}
    >
      {count}
    </button>
  );
}

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
