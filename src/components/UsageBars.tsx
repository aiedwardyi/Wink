// Style 5 meters (Edward's pick): ten boxes filled by % left and toned by % used, then "% left" and the reset. The grid is in UsageDesk.css.
import { cn } from "@/lib/cn";
import type { Translate } from "@/lib/i18n";
import { resetCompact, resetPhrase, windowExpired, type CompactReset } from "@/lib/usage";
import type { UsageBoardAccount, UsageBoardWindow } from "@/lib/usage-board";
import { leftOf, splitWindows } from "@/lib/usage-pace";

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

function Cells({ left, tone }: { left: number; tone: string }) {
  const filled = Math.round(left / CELLS);
  return (
    <span aria-hidden="true" data-cells={filled} className="grid h-2.5 min-w-0 grid-cols-10 gap-[3px]">
      {Array.from({ length: CELLS }, (_, index) => <span key={index} data-cell={index < filled ? "on" : "off"}
        className={cn("rounded-[2px] transition-colors duration-300 ease-out motion-reduce:transition-none", index < filled ? tone : "bg-ink/12")} />)}
    </span>
  );
}

/** "2h 6m" and "4d 7h"; a single unit stays as it is ("5h", "7d", "40m"). */
function resetTime(reset: CompactReset, t: Translate) {
  if (reset.key === "usage.limits.compactDh") return t("usage.desk.countDh", reset.vars);
  if (reset.key === "usage.limits.compactHm") return t("usage.desk.countHm", reset.vars);
  return t(reset.key, reset.vars);
}

export function WindowBar({ slot, now, t }: { slot: Slot; now: number; t: Translate }) {
  const { window, label } = slot;
  const left = windowExpired(window.resetsAt, now) ? null : Math.round(leftOf(window));
  const reached = left !== null && window.usedPercent >= 100;
  const reset = left === null ? null : resetCompact(window.resetsAt, now);
  // A window not started yet has no reset: it reads the same on every account, with no "not reported" words.
  const phrase = reset && resetPhrase(window.resetsAt, now);
  return (
    <div role="group" data-window={slot.key} data-model-window={window.id.includes("opus") ? "" : undefined} className="usage-meter mt-2 text-[13px] leading-[1.4] text-ink"
      aria-label={`${label}: ${left === null ? t("usage.desk.resetPassed") : t("usage.desk.windowLeft", { percent: left })}${phrase ? `, ${t(phrase.key, phrase.vars)}` : ""}`}>
      <span aria-hidden="true" className="whitespace-nowrap">{label}</span>
      <Cells left={left ?? 0} tone={barTone(window.usedPercent)} />
      <span aria-hidden="true" data-left="" className={cn("whitespace-nowrap tabular-nums", left === 0 && "text-danger")}>
        {left !== null && t("usage.desk.windowLeft", { percent: left })}
      </span>
      <span aria-hidden="true" data-reset={slot.key} className="min-w-0 text-[12px] tabular-nums text-ink-secondary">
        {left === null ? t("usage.desk.resetPassed") : <>
          {reached && <><span className="whitespace-nowrap font-medium text-danger">{t("usage.desk.limitReached")}</span>{reset && " · "}</>}
          {reset && <span className="whitespace-nowrap">{t("usage.desk.resetsIn", { time: resetTime(reset, t) })}</span>}
        </>}
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
