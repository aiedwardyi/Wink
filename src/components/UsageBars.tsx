// Today's bar: ten cells filled by % left, toned by % used, then the % and the time to reset.
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";
import type { Translate } from "@/lib/i18n";
import { resetCompact, resetPhrase, windowExpired } from "@/lib/usage";
import type { UsageBoardAccount, UsageBoardWindow } from "@/lib/usage-board";
import { leftOf, splitWindows } from "@/lib/usage-pace";

const CELLS = 10;
const SLIDING_CELLS = "relative inline-block [-webkit-text-fill-color:transparent] before:absolute before:left-0 before:top-0 before:content-['▱▱▱▱▱▱▱▱▱▱'] before:[-webkit-text-fill-color:currentColor] "
  + "after:absolute after:left-0 after:top-0 after:w-(--fill) after:overflow-hidden after:whitespace-nowrap after:content-['▰▰▰▰▰▰▰▰▰▰'] after:[-webkit-text-fill-color:currentColor] "
  + "after:transition-[width] after:duration-300 after:ease-out motion-reduce:after:transition-none";
/** Engines that report a 5h and a 7d window; the rest show their own windows (Gemini its daily one). */
const SESSION_WEEK = new Set(["claude", "codex", "grok"]);
/** Today's line: label, cells, then the % and the reset. Fixed label and % widths (the % fits "100%") keep every column on one edge. */
const LINE = "flex min-w-0 items-center gap-2 text-[12.5px] leading-5";
const LABEL = "min-w-6 shrink-0 whitespace-nowrap [&:lang(ko)]:min-w-10";
const NUMS = "flex items-center gap-1.5 whitespace-nowrap tabular-nums";

export function barTone(usedPercent: number) {
  return usedPercent >= 90 ? "text-danger" : usedPercent >= 75 ? "text-warning" : "text-accent";
}

export function windowLabel(window: Pick<UsageBoardWindow, "id" | "kind" | "windowMinutes">, t: Translate) {
  const minutes = window.windowMinutes;
  const base = window.kind === "session" ? t("usage.limits.sessionShort")
    : minutes === 10080 || (window.kind === "week" && minutes === null) ? t("usage.limits.weeklyShort")
      : minutes === null ? t("usage.limits.window")
        : minutes >= 2880 && minutes % 1440 === 0 ? t("usage.limits.compactD", { days: minutes / 1440 }) : t("usage.limits.compactH", { hours: Math.round(minutes / 60) });
  return window.id.includes("opus") ? `${t("usage.limits.opusShort")} ${base}` : base;
}

type Slot = { key: string; label: string; window?: UsageBoardWindow };

/** 5h then 7d for every account of a 5h/7d engine, reported or not; other engines list their own windows, shortest first. */
export function barSlots(engine: string, account: Pick<UsageBoardAccount, "windows">, t: Translate): Slot[] {
  if (SESSION_WEEK.has(engine)) {
    const { session, week, others } = splitWindows(account.windows);
    return [
      { key: "session", label: t("usage.limits.sessionShort"), window: session },
      { key: "week", label: t("usage.limits.weeklyShort"), window: week },
      ...others.map((window) => ({ key: window.id, label: windowLabel(window, t), window })),
    ];
  }
  const windows = [...account.windows].sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity));
  if (windows.length) return windows.map((window) => ({ key: window.id, label: windowLabel(window, t), window }));
  const daily = engine === "gemini";
  return [{ key: daily ? "daily" : "window", label: daily ? t("usage.limits.compactH", { hours: 24 }) : t("usage.limits.window") }];
}

function Cells({ left, tone, slide = true }: { left: number | null; tone: string; slide?: boolean }) {
  const filled = left === null ? 0 : Math.round(left / CELLS);
  return (
    <span aria-hidden="true" data-cells={filled} className={cn("shrink-0 font-mono tracking-tight", tone, slide && SLIDING_CELLS)}
      style={slide ? { "--fill": `${filled * CELLS}%` } as CSSProperties : undefined}>
      {"▰".repeat(filled) + "▱".repeat(CELLS - filled)}
    </span>
  );
}

/** The one empty state for a window with no reading, the same on every surface and engine. */
export function NoWindow({ label, text }: { label: string; text: string }) {
  return (
    <div role="group" aria-label={`${label}: ${text}`} data-window-empty="" className={cn(LINE, "text-ink-secondary")}>
      <span aria-hidden="true" className={LABEL}>{label}</span>
      <Cells left={null} tone="text-ink-secondary" slide={false} />
      <span aria-hidden="true" className={NUMS}>{text}</span>
    </div>
  );
}

export function WindowBar({ slot, now, muted = false, t }: { slot: Slot; now: number; muted?: boolean; t: Translate }) {
  const { window, label } = slot;
  if (!window) return <NoWindow label={label} text={t("usage.desk.noData")} />;
  if (windowExpired(window.resetsAt, now)) return <NoWindow label={label} text={t("usage.desk.resetPassed")} />;
  const left = Math.round(leftOf(window));
  const reset = resetCompact(window.resetsAt, now);
  const phrase = resetPhrase(window.resetsAt, now);
  return (
    <div role="group" data-window={slot.key} aria-label={`${label}: ${t("usage.desk.windowLeft", { percent: left })}, ${t(phrase.key, phrase.vars)}`}
      className={cn(LINE, muted ? "text-ink-secondary" : "text-ink")}>
      <span aria-hidden="true" className={LABEL}>{label}</span>
      <Cells left={left} tone={muted ? "text-ink-secondary" : barTone(window.usedPercent)} />
      <span aria-hidden="true" className={NUMS}>
        <span data-left="" className="min-w-[2.65em] [&:lang(ko)]:min-w-[2.45em]">{left}%</span>
        {reset && <span data-reset={slot.key} title={t(phrase.key, phrase.vars)} className="text-ink-secondary">({t(reset.key, reset.vars)})</span>}
      </span>
    </div>
  );
}

export function AccountBars({ engine, account, now, muted, t }: {
  engine: string; account: Pick<UsageBoardAccount, "windows">; now: number; muted?: boolean; t: Translate;
}) {
  return (
    <div data-account-bars="" className="flex min-w-0 flex-col items-start gap-1.5">
      {barSlots(engine, account, t).map((slot) => <WindowBar key={slot.key} slot={slot} now={now} muted={muted} t={t} />)}
    </div>
  );
}
