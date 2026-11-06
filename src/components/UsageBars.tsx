import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { Translate } from "@/lib/i18n";
import { resetCompact, resetPhrase, windowExpired, type CompactReset } from "@/lib/usage";
import type { UsageBoardAccount, UsageBoardWindow } from "@/lib/usage-board";
import { leftOf, splitWindows } from "@/lib/usage-pace";
import { reducedMotion } from "@/lib/phone-swipe";
import { useUsageMode, type UsageMode } from "@/lib/usage-preferences";

const CELLS = 10;
/** Engines that report a 5h and a 7d window; the rest show their own windows (Gemini its daily one). */
const SESSION_WEEK = new Set(["claude", "codex", "grok"]);

export function barTone(usedPercent: number) {
  return usedPercent >= 90 ? "bg-danger" : usedPercent >= 75 ? "bg-warning" : "bg-accent";
}

export function windowLabel(window: Pick<UsageBoardWindow, "id" | "kind" | "windowMinutes">, t: Translate) {
  const minutes = window.windowMinutes;
  const base = window.kind === "session" ? t("usage.limits.sessionShort")
    : minutes === 10080 || (window.kind === "week" && minutes === null) ? t("usage.limits.weeklyShort")
      : minutes === null ? t("usage.limits.window")
        : minutes >= 2880 && minutes % 1440 === 0 ? t("usage.limits.compactD", { days: minutes / 1440 }) : t("usage.limits.compactH", { hours: Math.round(minutes / 60) });
  return window.id.includes("opus") ? `${t("usage.limits.opusShort")} ${base}` : base;
}

type Slot = { key: string; label: string; window: UsageBoardWindow };

/** The windows an account reports, 5h then 7d then the rest, shortest first: a weekly-only or daily report shows one row, never an empty one. */
export function barSlots(engine: string, account: Pick<UsageBoardAccount, "windows">, t: Translate): Slot[] {
  const slot = (key: string, window: UsageBoardWindow, label = windowLabel(window, t)): Slot => ({ key, label, window });
  if (SESSION_WEEK.has(engine)) {
    const { session, week, others } = splitWindows(account.windows);
    return [
      ...session ? [slot("session", session, t("usage.limits.sessionShort"))] : [],
      ...week ? [slot("week", week)] : [],
      ...others.map((window) => slot(window.id, window)),
    ];
  }
  return [...account.windows].sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity)).map((window) => slot(window.id, window));
}

function litCells(percent: number) {
  return percent > 0 ? Math.min(CELLS, Math.max(1, Math.round(percent / CELLS))) : 0;
}

function useShownPercent(target: number | null, mode: UsageMode) {
  const [shown, setShown] = useState(target);
  const current = useRef(target);
  const last = useRef({ target, mode });
  useEffect(() => {
    const from = current.current;
    const switching = last.current.mode !== mode;
    last.current = { target, mode };
    if (!switching || target === null || from === null || reducedMotion() || from === target) {
      current.current = target;
      setShown(target);
      return;
    }
    let frame = 0;
    let start: number | undefined;
    const step = (now: number) => {
      start ??= now;
      const p = Math.min(1, (now - start) / 420);
      const eased = p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
      current.current = Math.round(from + (target - from) * eased);
      setShown(current.current);
      if (p < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, mode]);
  return target === null ? null : last.current.mode === mode && last.current.target !== target ? target : shown;
}

function Cells({ percent, used, mini = false }: { percent: number; used: number; mini?: boolean }) {
  const filled = litCells(percent);
  return (
    <span aria-hidden="true" data-cells={filled} className={cn("usage-cells", mini && "usage-cells-mini", used >= 90 ? "text-danger" : used >= 75 ? "text-warning" : "text-accent")}>
      {Array.from({ length: CELLS }, (_, index) => <span key={index} data-cell={index < filled ? "on" : "off"}
        className={index < filled ? barTone(used) : "bg-transparent"} />)}
    </span>
  );
}

/** "2h 6m" and "4d 7h"; a single unit stays as it is ("5h", "7d", "40m"). */
function resetTime(reset: CompactReset, t: Translate) {
  if (reset.key === "usage.limits.compactDh") return t("usage.desk.countDh", reset.vars);
  if (reset.key === "usage.limits.compactHm") return t("usage.desk.countHm", reset.vars);
  return t(reset.key, reset.vars);
}

export function WindowBar({ slot, now, t, compact = false, chat = false }: { slot: Slot; now: number; t: Translate; compact?: boolean; chat?: boolean }) {
  const { window, label } = slot;
  const mode = useUsageMode();
  const rawLeft = leftOf(window);
  const left = windowExpired(window.resetsAt, now) ? null : rawLeft > 0 ? Math.max(1, Math.round(rawLeft)) : 0;
  const used = Math.max(0, Math.min(window.usedPercent >= 100 ? 100 : 99, Math.round(window.usedPercent)));
  const percent = useShownPercent(left === null ? null : mode === "remaining" ? left : used, mode);
  const reached = left !== null && window.usedPercent >= 100;
  const reset = left === null ? null : resetCompact(window.resetsAt, now);
  // A window not started yet has no reset: it reads the same on every account, with no "not reported" words.
  const phrase = reset && resetPhrase(window.resetsAt, now);
  return (
    <div role="group" data-window={slot.key} data-model-window={window.id.includes("opus") ? "" : undefined} data-reached={reached || undefined}
      className={cn("usage-meter", compact && "usage-meter-summary", chat && "usage-meter-chat")}
      aria-label={`${label}: ${percent === null ? t("usage.desk.resetPassed") : t(mode === "remaining" ? "usage.desk.windowLeft" : "usage.limits.used", { percent })}${phrase ? `, ${t(phrase.key, phrase.vars)}` : ""}`}>
      <span aria-hidden="true" className="whitespace-nowrap">{label}</span>
      <Cells percent={percent ?? 0} used={window.usedPercent} mini={compact} />
      <span className="usage-figures">
      <span aria-hidden="true" data-left="" className={cn("whitespace-nowrap tabular-nums", window.usedPercent >= 90 && "text-danger")}>
        {percent !== null && t(chat ? "usage.limits.percentUsed" : mode === "remaining" ? "usage.desk.windowLeft" : "usage.limits.used", { percent })}
      </span>
      <span aria-hidden="true" data-reset={slot.key} className="usage-reset min-w-0 tabular-nums text-ink-secondary">
        {left === null ? t("usage.desk.resetPassed") : <>
          {reached && <span className="whitespace-nowrap font-medium text-danger">{t("usage.desk.limitReached")}</span>}
          {reset && <><span className="usage-reset-long whitespace-nowrap">{reached && " · "}{t("usage.desk.resetsIn", { time: resetTime(reset, t) })}</span><span className="usage-reset-short whitespace-nowrap">{reached && " · "}({resetTime(reset, t)})</span></>}
        </>}
      </span>
      </span>
    </div>
  );
}

/** Every reported window as a meter; with none, the one empty state. */
export function AccountBars({ engine, account, now, t, muted = false }: { engine: string; account: Pick<UsageBoardAccount, "windows">; now: number; t: Translate; muted?: boolean }) {
  const slots = barSlots(engine, account, t);
  if (!slots.length) return <div data-window-empty="" className="mt-1.5 text-[12px] text-ink-secondary">{t("usage.desk.noUsage")}</div>;
  return <div data-account-bars="" className={cn("min-w-0", muted && "opacity-60")}>{slots.map((slot) => <WindowBar key={slot.key} slot={slot} now={now} t={t} />)}</div>;
}
