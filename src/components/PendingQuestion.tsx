// A bot's open ask_user question, pinned above the composer. It arrives as
// the full card in the PendingApproval style and glows once; once the person
// types, attaches or the chat moves on it shrinks to one quote row that keeps
// its choices, and a tap on the row opens the card again. Unlike an approval
// it never takes the composer over: the bot keeps working, and typing a reply
// answers it only when it has no choices. The row's x or a sideways swipe only
// hides it here; the bot still waits, and a count on the composer brings it back.
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { Message } from "@/state/store";
import { ARRIVAL_GLOW_ANIMATION } from "@/lib/arrival-glow";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { lockAxis, reducedMotion, swipeStep, type SwipeAxis } from "@/lib/phone-swipe";
import { Fold } from "./Fold";
import { QuoteRow } from "./ReplyQuote";

// Per question id, outside the store, so each chat's question stays as it was left.
const rowQuestions = new Set<string>();
const shrunkQuestions = new Set<string>();
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

/** Shows a question as its row from now on; it never shrinks by itself after that. */
export function foldQuestion(id: string) {
  shrunkQuestions.add(id);
  mark(rowQuestions, id, true);
}

// the arrow pressed unmounts with its question, so the next question's row takes the focus
let stepFocus = 0;

const BADGE = "flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-ink";
const ARROW = "relative rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent pointer-coarse:after:absolute pointer-coarse:after:-inset-2";

export const PendingQuestionPanel = memo(function PendingQuestionPanel({
  message,
  askerName,
  count,
  index = count - 1,
  onStep,
  typed = "",
  attached = 0,
  movedOn = false,
  onPick,
  onDismiss,
}: {
  message: Message;
  askerName: string;
  /** open questions in this chat */
  count: number;
  /** this question's place among them, oldest first */
  index?: number;
  /** shows the question `step` places away */
  onStep?: (step: number) => void;
  /** the message box's text and attachment count: a change after arrival shrinks the card */
  typed?: string;
  attached?: number;
  /** the person sent a message, or the asker replied, after the question */
  movedOn?: boolean;
  onPick: (choice: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const folded = useMarked(rowQuestions, message.id);
  const hidden = useMarked(hiddenQuestions, message.id);
  const [glowing, setGlowing] = useState(() => !glowedQuestions.has(message.id) && !reducedMotion());
  useEffect(() => { glowedQuestions.add(message.id); }, [message.id]);
  const draft = useRef({ typed, attached });
  useEffect(() => {
    const was = draft.current;
    draft.current = { typed, attached };
    if (shrunkQuestions.has(message.id) || !(movedOn || typed !== was.typed || attached > was.attached)) return;
    setGlowing(false);
    foldQuestion(message.id);
  }, [typed, attached, movedOn, message.id]);
  const touch = useRef<{ x: number; y: number; id: string } | null>(null);
  const slide = useRef<{ x: number; y: number; at: number; axis: SwipeAxis } | null>(null);
  const rowButton = useRef<HTMLButtonElement>(null);
  const foldButton = useRef<HTMLButtonElement>(null);
  const arrows = useRef<HTMLSpanElement>(null);
  const moveFocus = useRef(false);
  // the control you used unmounts, so focus follows to its counterpart
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    (folded ? rowButton : foldButton).current?.focus();
  }, [folded]);
  useEffect(() => {
    const [previous, next] = arrows.current?.querySelectorAll("button") ?? [];
    if (stepFocus && previous && next) {
      const [toward, back] = stepFocus < 0 ? [previous, next] : [next, previous];
      (toward.disabled ? back : toward).focus();
    }
    stepFocus = 0;
  }, []);
  // a question that leaves mid-glow must not pulse again when it comes back
  const fold = (value: boolean) => {
    setGlowing(false);
    moveFocus.current = true;
    if (value) foldQuestion(message.id);
    else mark(rowQuestions, message.id, false);
  };
  const hide = () => {
    setGlowing(false);
    mark(hiddenQuestions, message.id, true);
  };
  const step = (by: number) => {
    stepFocus = by;
    onStep?.(by);
  };
  const card = message.card;
  if (!card || hidden) return null;
  return (
    <>
      <Fold open={folded} className="mb-2 px-1">
        <QuoteRow
          data-pending-question={message.id}
          data-question-row=""
          data-no-swipe=""
          className="relative touch-pan-y"
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
            if (swipeStep(dx, dx / Math.max(1, event.timeStamp - start.at), event.currentTarget.offsetWidth)) hide();
          }}
          onTouchCancel={(event) => {
            slide.current = null;
            event.currentTarget.style.transform = "";
          }}
          lead={count > 1 && (
            <span ref={arrows} className="flex shrink-0 items-center gap-0.5">
              <button type="button" onClick={() => step(-1)} disabled={index <= 0} aria-label={t("ask.previousQuestion")} title={t("ask.previousQuestion")} className={ARROW}>
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <span className={cn(BADGE, "tabular-nums")}>{index + 1}/{count}</span>
              <button type="button" onClick={() => step(1)} disabled={index >= count - 1} aria-label={t("ask.nextQuestion")} title={t("ask.nextQuestion")} className={ARROW}>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </span>
          )}
          icon={count > 1 ? null : <span className={BADGE}>{count}</span>}
          label={t("ask.asks", { name: askerName })}
          text={card.subtitle.trim().split(/\r?\n/, 1)[0]}
          jump={{
            ref: rowButton,
            onClick: () => fold(false),
            "aria-expanded": false,
            "aria-label": `${t("ask.expandQuestion")}: ${card.subtitle}`,
            className: card.options.length ? "min-w-[40%]" : undefined,
          }}
          trail={<RowChoices options={card.options} onPick={onPick} />}
          onClear={hide}
          clearLabel={t("ask.hideQuestion")}
        />
      </Fold>
      <Fold open={!folded} className="mb-2">
        <div
          ref={fitChoices}
          role="region"
          aria-label={t("ask.asks", { name: askerName })}
          data-pending-question={message.id}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && event.animationName === ARRIVAL_GLOW_ANIMATION) setGlowing(false);
          }}
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
          className={cn("relative flex max-h-[30dvh] flex-col rounded-2xl border border-accent/40 bg-card", glowing && "arrival-glow")}
        >
          <div className="flex min-h-0 flex-col rounded-[15px] bg-control/40 px-4 py-3">
            <div className="flex shrink-0 items-start gap-2" aria-live="polite">
              <span className="min-w-0 flex-1 truncate pt-0.5 text-[11px] uppercase tracking-[0.18em] text-ink-secondary">
                {t("ask.asks", { name: askerName })}
              </span>
              <button
                type="button"
                ref={foldButton}
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
            {/* only a long question's text scrolls, so the card stays a third of the chat with its choices in sight */}
            <div tabIndex={0} data-question-body="" onScroll={(event) => markCut(event.currentTarget)} className="mt-1.5 min-h-[1lh] overflow-y-auto whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink data-[cut]:[mask-image:linear-gradient(to_bottom,black_60%,transparent)]">{card.subtitle}</div>
            <AskChoices options={card.options} onPick={onPick} />
          </div>
        </div>
      </Fold>
    </>
  );
});

// all of the card but its question text and choices, in px: border 2 + padding 24 + heading 20 + gaps 16
const CARD_REST = 62;
const LINE = 22;
const KEPT_LINES = 3;

/** A cut question fades out at its foot, as a long user message does (USER_FOLD_CLASS), until it is scrolled to its end. */
function markCut(body: HTMLElement) {
  body.toggleAttribute("data-cut", body.scrollHeight - body.scrollTop - body.clientHeight > 1);
}

/** The card's cap gives way so its choices always show under three lines of the question; when the composer has no more room to give, the question goes down to one line, and past that the choices scroll. */
function fitChoices(card: HTMLDivElement | null) {
  const body = card?.querySelector<HTMLElement>("[data-question-body]");
  const choices = card?.querySelector<HTMLElement>("[data-term-choices]");
  if (!card || !body || typeof ResizeObserver === "undefined") return;
  let pane = card.parentElement;
  while (pane && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
  const fit = () => {
    if (choices) {
      const line = parseFloat(getComputedStyle(body).lineHeight) || LINE;
      // the last fit's min-height would be read back as the text's own height
      body.style.minHeight = "";
      const kept = Math.min(body.scrollHeight, KEPT_LINES * line);
      body.style.minHeight = `${kept}px`;
      choices.style.maxHeight = choices.style.overflowY = "";
      const tall = choices.offsetHeight;
      card.style.maxHeight = `max(30dvh, ${tall + CARD_REST + kept}px)`;
      const over = pane ? pane.scrollHeight - pane.clientHeight : 0;
      if (over > 0) {
        // other content in the pane can overflow it too: the card keeps its heading, a line of the question and a line of choices
        const room = Math.max(CARD_REST + 2 * line, card.offsetHeight - over);
        card.style.maxHeight = `${room}px`;
        // the question gives lines back, down to one, while that keeps every choice in sight
        if (tall + CARD_REST + line <= room || room - CARD_REST - kept < line) body.style.minHeight = "";
        if (tall + CARD_REST + line > room) {
          choices.style.maxHeight = `${Math.max(line, room - CARD_REST - kept)}px`;
          choices.style.overflowY = "auto";
        }
      }
    }
    markCut(body);
  };
  fit();
  const watch = new ResizeObserver(fit);
  watch.observe(body);
  if (choices) watch.observe(choices);
  const fold = card.closest("[data-fold]");
  window.addEventListener("resize", fit);
  fold?.addEventListener("animationend", fit);
  return () => {
    watch.disconnect();
    window.removeEventListener("resize", fit);
    fold?.removeEventListener("animationend", fit);
  };
}

/** The row's choices on one line: the ones past its width drop out, and a tap on the row still opens them all. */
function RowChoices({ options, onPick }: { options: string[]; onPick: (choice: string) => void }) {
  const list = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const chips = list.current;
    const row = chips?.parentElement;
    if (!chips || !row || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      chips.hidden = false;
      const all = [...chips.children] as HTMLElement[];
      for (const chip of all) chip.hidden = false;
      for (let last = all.length - 1; last >= 0 && chips.scrollWidth > chips.clientWidth; last--) all[last].hidden = true;
      chips.hidden = all.every((chip) => chip.hidden);
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(row);
    return () => watch.disconnect();
  }, [options]);
  if (!options.length) return null;
  return (
    <span ref={list} data-row-choices="" className="flex min-w-0 items-center gap-1 overflow-hidden">
      {options.map((choice) => (
        <button
          key={choice}
          type="button"
          onClick={() => onPick(choice)}
          className="relative shrink-0 whitespace-nowrap rounded-full border border-ink-secondary bg-control px-2.5 py-0.5 text-[12px] text-ink hover:bg-raised-hover pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-2.5"
        >
          {choice}
        </button>
      ))}
    </span>
  );
}

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
    <div data-term-choices className="mt-2.5 flex shrink-0 flex-wrap gap-2">
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
