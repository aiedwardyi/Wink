import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Check, Pin, RefreshCw, TrendingDown } from "lucide-react";
import { EngineMark } from "./EngineMark";
import { MausAvatar } from "./Avatar";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { useUsageMode, setUsageMode } from "@/lib/usage-preferences";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { useStore, type InstanceInfo } from "@/state/store";
import {
  CLAUDE_PACE_SAMPLES,
  CLAUDE_PROJECTED_AT_RESET_PCT,
  DAILY_7D_BURN,
  TRADER_ACCOUNT_META,
  type AccountTraderMeta,
} from "@/lib/trader-fixtures";

type ChartRange = "5h" | "24h" | "7d";

function useKo(): boolean {
  const { locale } = useI18n();
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("locale") === "ko") {
    return true;
  }
  return locale === "ko";
}

function getWindowPct(instance: InstanceInfo | undefined, kind: "five_hour" | "seven_day", mode: "remaining" | "used"): number | null {
  if (!instance?.rateLimits) return null;
  const win = instance.rateLimits.windows.find((w) =>
    kind === "five_hour"
      ? w.id === "five_hour" || w.id === "primary" || w.windowMinutes === 300
      : w.id === "seven_day" || w.id === "secondary" || w.windowMinutes === 10080,
  );
  if (!win) return null;
  const used = Math.min(100, Math.max(0, Math.round(win.usedPercent)));
  return mode === "remaining" ? Math.max(0, 100 - used) : used;
}

function getWindowUsed(instance: InstanceInfo | undefined, kind: "five_hour" | "seven_day"): number | null {
  if (!instance?.rateLimits) return null;
  const win = instance.rateLimits.windows.find((w) =>
    kind === "five_hour"
      ? w.id === "five_hour" || w.id === "primary" || w.windowMinutes === 300
      : w.id === "seven_day" || w.id === "secondary" || w.windowMinutes === 10080,
  );
  if (!win) return null;
  return Math.min(100, Math.max(0, Math.round(win.usedPercent)));
}

function toneForUsed(used: number | null) {
  if (used === null) {
    return {
      text: "text-ink-secondary",
      bar: "bg-ink/25",
      badge: "border-hairline/50 bg-raised/60 text-ink-secondary",
    };
  }
  if (used >= 100) {
    return {
      text: "text-danger",
      bar: "bg-danger",
      badge: "border-danger/40 bg-danger/10 text-danger",
    };
  }
  if (used >= 75) {
    return {
      text: "text-warning",
      bar: "bg-warning",
      badge: "border-warning/40 bg-warning/10 text-warning",
    };
  }
  return {
    text: "text-accent",
    bar: "bg-accent",
    badge: "border-accent/40 bg-accent/10 text-accent",
  };
}

export function TickerBadge({
  ticker,
  active,
  exhausted,
  size = "md",
}: {
  ticker: string;
  active?: boolean;
  exhausted?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[3px] border font-mono font-semibold tracking-tight tabular-nums",
        size === "sm" ? "h-4.5 min-w-6 px-1 text-[10.5px]" : "h-5 min-w-7 px-1.5 text-[11px]",
        exhausted
          ? "border-danger/40 bg-danger/10 text-danger"
          : active
            ? "border-accent/50 bg-accent/15 text-accent"
            : "border-hairline/60 bg-raised/80 text-ink-secondary",
      )}
    >
      {ticker}
    </span>
  );
}

/** Living SVG Burndown & Pace Chart with 7d normal band, even-pace diagonal, C2->C1 auto-switch marker, and projection ray. */
export function PaceBurndownChart({
  mode,
  range,
  ko,
  compact = false,
  liveRemaining5h = 66,
  projectedAtReset = CLAUDE_PROJECTED_AT_RESET_PCT,
  activeTicker = "C1",
  autoSwitchFlash = false,
}: {
  mode: "remaining" | "used";
  range: ChartRange;
  ko: boolean;
  compact?: boolean;
  liveRemaining5h?: number;
  projectedAtReset?: number;
  activeTicker?: "C1" | "C3";
  autoSwitchFlash?: boolean;
}) {
  const width = 560;
  const height = compact ? 118 : 164;
  const padL = 32;
  const padR = 46;
  const padT = compact ? 16 : 22;
  const padB = compact ? 22 : 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  // Time domain: -6.0h (9:00 AM) to +3.67h (6:40 PM reset) => total 9.67h
  const minH = -6.0;
  const maxH = 3.67;
  const xOf = (offsetHours: number) => padL + ((offsetHours - minH) / (maxH - minH)) * plotW;
  const yVal = (remainingPct: number) => (mode === "remaining" ? remainingPct : 100 - remainingPct);
  const yOf = (remainingPct: number) => padT + ((100 - yVal(remainingPct)) / 100) * plotH;

  const samples = useMemo(() => {
    const cloned = CLAUDE_PACE_SAMPLES.map((pt, idx) =>
      idx === CLAUDE_PACE_SAMPLES.length - 1 ? { ...pt, remainingPct: liveRemaining5h } : pt,
    );
    return cloned;
  }, [liveRemaining5h]);

  const c2Segment = samples.filter((s) => s.accountTicker === "C2");
  const c1Segment = samples.filter((s) => s.accountTicker === "C1");

  const toPath = (pts: Array<{ x: number; y: number }>) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const c2Path = toPath(c2Segment.map((s) => ({ x: xOf(s.offsetHours), y: yOf(s.remainingPct) })));
  const c1Pts = c1Segment.map((s) => ({ x: xOf(s.offsetHours), y: yOf(s.remainingPct) }));
  const c1Path = toPath(c1Pts);

  const areaBottomY = padT + plotH;
  const c1AreaPath =
    c1Pts.length > 1
      ? `${c1Path} L${c1Pts[c1Pts.length - 1]!.x.toFixed(1)},${areaBottomY.toFixed(1)} L${c1Pts[0]!.x.toFixed(1)},${areaBottomY.toFixed(1)} Z`
      : "";

  // 7-day normal curve path (from 11:53 AM window start to 6:40 PM reset)
  const normalPts = [
    ...c1Segment.map((s) => ({ x: xOf(s.offsetHours), y: yOf(s.normal7dPct) })),
    { x: xOf(maxH), y: yOf(34) },
  ];
  const normalPath = toPath(normalPts);

  // Even-pace linear guide line (from 11:53 AM 100% left -> 6:40 PM 0% left)
  const guideStart = { x: xOf(-3.1), y: yOf(100) };
  const guideEnd = { x: xOf(maxH), y: yOf(0) };

  // Projection ray from Now (offsetHours = 0) to Reset (offsetHours = 3.67)
  const nowPt = { x: xOf(0), y: yOf(liveRemaining5h) };
  const projPt = { x: xOf(maxH), y: yOf(projectedAtReset) };
  const switchX = xOf(-3.13);

  const dispNow = Math.round(yVal(liveRemaining5h));
  const dispProj = Math.round(yVal(projectedAtReset));

  return (
    <div className="relative select-none">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={cn("w-full overflow-visible", compact ? "h-[116px]" : "h-[160px]")}
        role="img"
        aria-label={ko ? "5시간 사용 속도 및 예상 잔여량 차트" : "5-hour usage pace and reset projection chart"}
      >
        <defs>
          <linearGradient id="trader-c1-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.24" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="trader-c2-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-danger)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--color-danger)" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Horizontal grid lines: 100%, 50%, 0% */}
        {[100, 50, 0].map((pct) => {
          const y = padT + ((100 - pct) / 100) * plotH;
          return (
            <g key={pct}>
              <line
                x1={padL}
                y1={y}
                x2={width - padR}
                y2={y}
                stroke="currentColor"
                className="text-hairline/40"
                strokeDasharray={pct === 50 ? "2 3" : undefined}
              />
              <text
                x={padL - 5}
                y={y + 3.5}
                textAnchor="end"
                className="fill-ink-secondary font-mono text-[9.5px] tabular-nums"
              >
                {pct}%
              </text>
            </g>
          );
        })}

        {/* Morning C2 burn shaded area */}
        {c2Segment.length > 1 && (
          <path
            d={`${c2Path} L${xOf(-3.13).toFixed(1)},${areaBottomY.toFixed(1)} L${xOf(-6.0).toFixed(1)},${areaBottomY.toFixed(1)} Z`}
            fill="url(#trader-c2-fill)"
          />
        )}

        {/* Active C1 shaded area */}
        {c1AreaPath && <path d={c1AreaPath} fill="url(#trader-c1-fill)" />}

        {/* 7d normal pace curve */}
        <path
          d={normalPath}
          fill="none"
          stroke="currentColor"
          className="text-ink-secondary/45"
          strokeWidth={1.25}
          strokeDasharray="4 3"
        />

        {/* Even-pace diagonal reference guide */}
        <line
          x1={guideStart.x}
          y1={guideStart.y}
          x2={guideEnd.x}
          y2={guideEnd.y}
          stroke="currentColor"
          className="text-ink-secondary/60"
          strokeWidth={1.15}
          strokeDasharray="2 3"
        />

        {/* Morning burn line on C2 (9:00 AM -> 11:52 AM 0%) */}
        <path
          d={c2Path}
          fill="none"
          stroke="var(--color-danger)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Auto-switch vertical event marker at 11:52 AM */}
        <line
          x1={switchX}
          y1={padT}
          x2={switchX}
          y2={areaBottomY}
          stroke="var(--color-warning)"
          strokeWidth={1.2}
          strokeDasharray="2 2"
        />
        <rect
          x={switchX - 44}
          y={padT - 12}
          width={88}
          height={14}
          rx={2}
          className="fill-raised stroke-warning/50"
          strokeWidth={0.8}
        />
        <text
          x={switchX}
          y={padT - 2.5}
          textAnchor="middle"
          className="fill-warning font-mono text-[8.5px] font-medium"
        >
          {ko ? "11:52 C2->C1 전환" : "11:52a C2->C1"}
        </text>

        {/* Active C1 remaining curve (11:53 AM -> 3:00 PM Now) */}
        <path
          d={c1Path}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Dotted projection ray from Now (3:00 PM) to Reset (6:40 PM) */}
        <line
          x1={nowPt.x}
          y1={nowPt.y}
          x2={projPt.x}
          y2={projPt.y}
          stroke="var(--color-accent)"
          strokeWidth={1.9}
          strokeDasharray="3 3"
        />

        {/* Vertical Now divider & Reset boundary */}
        <line
          x1={nowPt.x}
          y1={padT}
          x2={nowPt.x}
          y2={areaBottomY}
          stroke="currentColor"
          className="text-accent/35"
          strokeWidth={1}
        />
        <line
          x1={projPt.x}
          y1={padT}
          x2={projPt.x}
          y2={areaBottomY}
          stroke="currentColor"
          className="text-hairline/60"
          strokeWidth={1}
        />

        {/* Pulsing Now dot */}
        <circle cx={nowPt.x} cy={nowPt.y} r={5.5} className="fill-accent/25" />
        <circle
          cx={nowPt.x}
          cy={nowPt.y}
          r={3.2}
          className={cn("fill-accent stroke-surface", autoSwitchFlash && "fill-warning")}
          strokeWidth={1.4}
        />

        {/* Now callout pill */}
        <rect
          x={nowPt.x - 28}
          y={Math.max(padT + 2, nowPt.y - 21)}
          width={56}
          height={15}
          rx={2.5}
          className="fill-raised stroke-accent/50"
          strokeWidth={0.9}
        />
        <text
          x={nowPt.x}
          y={Math.max(padT + 12, nowPt.y - 11)}
          textAnchor="middle"
          className="fill-ink font-mono text-[9px] font-semibold tabular-nums"
        >
          {activeTicker} {dispNow}%
        </text>

        {/* Projected at Reset endpoint & right-axis pill */}
        <circle cx={projPt.x} cy={projPt.y} r={2.8} className="fill-accent" />
        <rect
          x={projPt.x + 4}
          y={projPt.y - 8}
          width={38}
          height={15}
          rx={2.5}
          className="fill-accent/15 stroke-accent/50"
          strokeWidth={0.8}
        />
        <text
          x={projPt.x + 23}
          y={projPt.y + 2.5}
          textAnchor="middle"
          className="fill-accent font-mono text-[9px] font-semibold tabular-nums"
        >
          {mode === "remaining" ? `+${dispProj}%` : `${dispProj}%`}
        </text>

        {/* X-axis timestamps */}
        {[
          { h: -6.0, label: ko ? "오전 9:00" : "9:00a" },
          { h: -3.13, label: ko ? "11:52" : "11:52a" },
          { h: -1.33, label: ko ? "오후 1:40" : "1:40p" },
          { h: 0, label: ko ? "현재 3:00" : "Now 3:00p", accent: true },
          { h: 3.67, label: ko ? "초기화 6:40" : "Reset 6:40p" },
        ].map((tick) => {
          const x = xOf(tick.h);
          return (
            <text
              key={tick.label}
              x={x}
              y={height - 5}
              textAnchor={tick.h === -6.0 ? "start" : tick.h === 3.67 ? "end" : "middle"}
              className={cn(
                "font-mono text-[9.5px] tabular-nums",
                tick.accent ? "fill-accent font-semibold" : "fill-ink-secondary",
              )}
            >
              {tick.label}
            </text>
          );
        })}
      </svg>

      {/* Legend + Range bar beneath chart */}
      {!compact && (
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-hairline/30 pt-2 text-[11px] text-ink-secondary">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5 text-ink">
              <span className="h-2 w-2 rounded-full bg-accent" />
              {ko ? "실제 잔여량 (C1)" : "Actual pace (C1)"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-3 bg-danger" />
              {ko ? "오전 소진 (C2 0%)" : "Morning burn (C2 0%)"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-3 border-t border-dashed border-ink-secondary" />
              {ko ? "균등 기준선 / 7일 평균" : "Even guide / 7d avg"}
            </span>
          </div>
          <span className="font-mono text-[10.5px] text-ink-secondary">
            {range === "5h"
              ? ko
                ? "창: 오후 1:40 - 6:40 (5시간)"
                : "Window: 1:40 PM - 6:40 PM (5h)"
              : range === "24h"
                ? ko
                  ? "최근 24시간 추세"
                  : "Last 24h trajectory"
                : ko
                  ? "주간 7일 추세"
                  : "7-day weekly trajectory"}
          </span>
        </div>
      )}
    </div>
  );
}

/** Single-engine multi-account rotation row in fixed slot order (never re-sorts on switch). */
function TraderAccountRow({
  account,
  meta,
  mode,
  ko,
  phone,
  isMain,
  isNext,
  pinnedToCurrent,
  onUseAccount,
  onTogglePin,
}: {
  account: InstanceInfo;
  meta: AccountTraderMeta;
  mode: "remaining" | "used";
  ko: boolean;
  phone: boolean;
  isMain: boolean;
  isNext: boolean;
  pinnedToCurrent: boolean;
  onUseAccount: (instanceId: string) => void;
  onTogglePin: () => void;
}) {
  const pct5h = getWindowPct(account, "five_hour", mode);
  const pct7d = getWindowPct(account, "seven_day", mode);
  const used5h = getWindowUsed(account, "five_hour");
  const used7d = getWindowUsed(account, "seven_day");
  const exhausted = (used5h !== null && used5h >= 100) || (used7d !== null && used7d >= 100);
  const tone5h = toneForUsed(used5h);
  const tone7d = toneForUsed(used7d);

  const reset5hText =
    meta.ticker === "C1"
      ? ko
        ? "3시간 40분 · 오후 6:40"
        : "3h 40m · 6:40 PM"
      : meta.ticker === "C2"
        ? ko
          ? "월 오후 5:00"
          : "Mon 5:00 PM"
        : meta.ticker === "C3"
          ? ko
            ? "2시간 15분 · 오후 5:15"
            : "2h 15m · 5:15 PM"
          : meta.ticker === "X2"
            ? ko
              ? "2시간 50분 · 오후 5:50"
              : "2h 50m · 5:50 PM"
            : ko
              ? "주간 전용"
              : "Weekly only";

  const reset7dText =
    meta.ticker === "C1"
      ? ko
        ? "금 오전 5:00 (14시간)"
        : "Fri 5:00 AM (14h)"
      : meta.ticker === "C2"
        ? ko
          ? "월 오후 5:00 (4일)"
          : "Mon 5:00 PM (4d)"
        : meta.ticker === "C3"
          ? ko
            ? "화 오전 11:00 (4일)"
            : "Tue 11:00 AM (4d)"
          : meta.ticker === "X1"
            ? ko
              ? "수 오후 3:30 (6일)"
              : "Wed 3:30 PM (6d)"
            : meta.ticker === "X2"
              ? ko
                ? "월 오전 9:00 (3일)"
                : "Mon 9:00 AM (3d)"
              : "";

  const statusBadge = isMain ? (
    <span className="inline-flex items-center gap-1 rounded-[3px] border border-accent/40 bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-medium text-accent">
      <span className="size-1.5 rounded-full bg-accent" />
      {ko ? "사용 중" : "In use"}
    </span>
  ) : exhausted ? (
    <span className="inline-flex items-center gap-1 rounded-[3px] border border-danger/40 bg-danger/10 px-1.5 py-0.5 text-[10.5px] font-medium text-danger">
      {ko ? "소진됨" : "Out"}
    </span>
  ) : isNext ? (
    <span className="inline-flex items-center gap-1 rounded-[3px] border border-hairline/60 bg-raised px-1.5 py-0.5 text-[10.5px] font-medium text-ink-secondary">
      {ko ? "다음 순번" : "Next"}
    </span>
  ) : null;

  const actionControl = isMain ? (
    <button
      type="button"
      onClick={onTogglePin}
      aria-pressed={pinnedToCurrent}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-[3px] border px-2 text-[11px] font-medium transition-colors",
        pinnedToCurrent
          ? "border-accent/50 bg-accent/15 text-accent"
          : "border-hairline/50 bg-raised/50 text-ink-secondary hover:bg-raised-hover hover:text-ink",
      )}
    >
      <Pin size={11} className={pinnedToCurrent ? "rotate-45" : undefined} />
      {pinnedToCurrent
        ? ko
          ? `${meta.ticker} 고정됨`
          : `Pinned ${meta.ticker}`
        : ko
          ? `${meta.ticker} 유지`
          : `Stay on ${meta.ticker}`}
    </button>
  ) : exhausted ? (
    <span className="inline-flex h-7 shrink-0 items-center rounded-[3px] border border-hairline/30 px-2 font-mono text-[11px] text-ink-secondary">
      {ko ? "월 오후 5:00 해제" : "Mon 5:00 PM"}
    </span>
  ) : (
    <button
      type="button"
      onClick={() => onUseAccount(account.instanceId)}
      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[3px] border border-hairline/60 bg-raised/70 px-2.5 text-[11.5px] font-medium text-ink hover:border-accent/50 hover:bg-accent/10 hover:text-accent"
    >
      {ko ? `${meta.ticker} 사용` : `Use ${meta.ticker}`}
    </button>
  );

  // No-data or unsupported single-account rows (Grok G1, Gemini M1)
  if (!account.rateLimits) {
    return (
      <div
        data-account-ticker={meta.ticker}
        className="flex items-center justify-between gap-3 rounded-[4px] border border-hairline/40 bg-raised/25 px-3 py-2 text-[12px]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <EngineMark instance={account} size={15} />
          <TickerBadge ticker={meta.ticker} size="sm" />
          <span className="font-medium text-ink">{account.displayName}</span>
          <span className="truncate text-ink-secondary">{ko ? meta.spendersKo : meta.spendersEn}</span>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-ink-secondary">
          {account.capabilities?.rateLimits ? (ko ? "대기 중" : "Pending turn") : ko ? "미지원" : "No limit API"}
        </span>
      </div>
    );
  }

  return (
    <div
      data-account-ticker={meta.ticker}
      className={cn(
        "rounded-[4px] border px-3 py-2.5 transition-colors",
        isMain
          ? "border-accent/45 bg-accent/[0.05]"
          : exhausted
            ? "border-hairline/35 bg-raised/15 opacity-75"
            : "border-hairline/45 bg-raised/30",
      )}
    >
      {/* Top header row: Ticker + Account slot + Status pill + Provenance + Right-aligned single action */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <EngineMark instance={account} size={15} />
          <TickerBadge ticker={meta.ticker} active={isMain} exhausted={exhausted} />
          <span className="text-[12.5px] font-medium text-ink">
            {ko ? `계정 ${meta.slotIndex}` : `Account ${meta.slotIndex}`}
          </span>
          {statusBadge}
          {!phone && (meta.provenanceEn || meta.provenanceKo) && (
            <span className="inline-flex items-center gap-1 rounded-[3px] bg-warning/10 px-1.5 py-0.5 font-mono text-[10.5px] text-warning">
              <ArrowRightLeft size={10} />
              {ko ? meta.provenanceKo : meta.provenanceEn}
            </span>
          )}
        </div>
        {actionControl}
      </div>

      {/* Middle 2-column meter grid: 5h window and 7d window */}
      <div className="mt-2 grid grid-cols-2 gap-3">
        {/* 5h Window */}
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-1 text-[11.5px]">
            <span className="font-mono text-ink-secondary">{ko ? "5시간" : "5h"}</span>
            {pct5h !== null ? (
              <span className={cn("font-mono font-semibold tabular-nums", tone5h.text)}>
                {pct5h}% {mode === "remaining" ? (ko ? "남음" : "left") : ko ? "사용" : "used"}
              </span>
            ) : (
              <span className="font-mono text-[11px] text-ink-secondary">{ko ? "주간 전용" : "Weekly only"}</span>
            )}
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
            <div
              className={cn("h-full rounded-full transition-all duration-300", tone5h.bar)}
              style={{ width: `${pct5h ?? 0}%` }}
            />
          </div>
          <div className="mt-1 truncate font-mono text-[10.5px] text-ink-secondary tabular-nums">{reset5hText}</div>
        </div>

        {/* 7d Window */}
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-1 text-[11.5px]">
            <span className="font-mono text-ink-secondary">{ko ? "7일" : "7d"}</span>
            {pct7d !== null && (
              <span className={cn("font-mono font-semibold tabular-nums", tone7d.text)}>
                {pct7d}% {mode === "remaining" ? (ko ? "남음" : "left") : ko ? "사용" : "used"}
              </span>
            )}
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink/10">
            <div
              className={cn("h-full rounded-full transition-all duration-300", tone7d.bar)}
              style={{ width: `${pct7d ?? 0}%` }}
            />
          </div>
          <div className="mt-1 truncate font-mono text-[10.5px] text-ink-secondary tabular-nums">{reset7dText}</div>
        </div>
      </div>

      {/* Footer spender & provenance strip */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-1 border-t border-hairline/25 pt-1.5 text-[11px] text-ink-secondary">
        <span className="truncate font-mono">{ko ? meta.spendersKo : meta.spendersEn}</span>
        {phone && (meta.provenanceEn || meta.provenanceKo) && (
          <span className="font-mono text-[10.5px] text-warning">{ko ? meta.provenanceKo : meta.provenanceEn}</span>
        )}
      </div>
    </div>
  );
}

/** Main Trader Usage & Multi-Account Deck rendered inside Settings -> Usage. */
export function TraderUsageDeck({
  externalMainClaudeId,
  onSelectMainClaude,
  liveRemaining5hOverride,
  autoSwitchFlash,
}: {
  externalMainClaudeId?: "claudeAgent" | "claudeAgent~3";
  onSelectMainClaude?: (id: "claudeAgent" | "claudeAgent~3") => void;
  liveRemaining5hOverride?: number;
  autoSwitchFlash?: boolean;
} = {}) {
  const { state } = useStore();
  const ko = useKo();
  const phone = useIsPhone();
  const mode = useUsageMode();
  const [range, setRange] = useState<ChartRange>("5h");
  const [selectedEngine, setSelectedEngine] = useState<"claudeAgent" | "codex">("claudeAgent");
  const [localMainClaude, setLocalMainClaude] = useState<"claudeAgent" | "claudeAgent~3">("claudeAgent");
  const [pinnedClaude, setPinnedClaude] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const mainClaudeId = externalMainClaudeId ?? localMainClaude;
  const setMainClaude = (id: "claudeAgent" | "claudeAgent~3") => {
    setLocalMainClaude(id);
    onSelectMainClaude?.(id);
  };

  const instances = state.instances;
  const claudeAccounts = useMemo(
    () => instances.filter((i) => (i.accountOf ?? i.instanceId) === "claudeAgent"),
    [instances],
  );
  const codexAccounts = useMemo(
    () => instances.filter((i) => (i.accountOf ?? i.instanceId) === "codex"),
    [instances],
  );
  const otherAccounts = useMemo(
    () => instances.filter((i) => !["claudeAgent", "codex"].includes(i.accountOf ?? i.instanceId)),
    [instances],
  );

  const activeClaude = claudeAccounts.find((a) => a.instanceId === mainClaudeId) ?? claudeAccounts[0];
  const activeTicker: "C1" | "C3" = mainClaudeId === "claudeAgent~3" ? "C3" : "C1";
  const base5hLeft = mainClaudeId === "claudeAgent~3" ? 40 : (liveRemaining5hOverride ?? 66);
  const base7dLeft = mainClaudeId === "claudeAgent~3" ? 72 : 39;
  const hero5h = mode === "remaining" ? Math.round(base5hLeft) : Math.round(100 - base5hLeft);
  const hero7d = mode === "remaining" ? base7dLeft : 100 - base7dLeft;
  const projectedLeft = mainClaudeId === "claudeAgent~3" ? 37 : Math.max(0, Math.round(base5hLeft - 18));

  return (
    <div className="flex flex-col gap-3.5" data-trader-usage-deck="">
      {/* Card 1: The Trader Pace Deck */}
      <Card>
        {/* Top bar: Engine Ticker Tabs + Left/Used toggle + Refresh */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline/40 pb-2.5">
          <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Engines">
            <button
              type="button"
              role="tab"
              aria-selected={selectedEngine === "claudeAgent"}
              onClick={() => setSelectedEngine("claudeAgent")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-[3px] border px-2 text-[12px] font-medium transition-colors",
                selectedEngine === "claudeAgent"
                  ? "border-accent/50 bg-accent/15 text-ink"
                  : "border-hairline/40 bg-raised/40 text-ink-secondary hover:text-ink",
              )}
            >
              {activeClaude && <EngineMark instance={activeClaude} size={13} />}
              <span>Claude</span>
              <span className="font-mono text-[11px] font-semibold text-accent tabular-nums">{hero5h}%</span>
              <span className="rounded bg-ink/10 px-1 font-mono text-[10px] text-ink-secondary">x3</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={selectedEngine === "codex"}
              onClick={() => setSelectedEngine("codex")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-[3px] border px-2 text-[12px] font-medium transition-colors",
                selectedEngine === "codex"
                  ? "border-accent/50 bg-accent/15 text-ink"
                  : "border-hairline/40 bg-raised/40 text-ink-secondary hover:text-ink",
              )}
            >
              {codexAccounts[0] && <EngineMark instance={codexAccounts[0]} size={13} />}
              <span>Codex</span>
              <span className="font-mono text-[11px] font-semibold text-accent tabular-nums">
                {mode === "remaining" ? "82%" : "18%"}
              </span>
              <span className="rounded bg-ink/10 px-1 font-mono text-[10px] text-ink-secondary">x2</span>
            </button>
            {!phone && (
              <>
                <span className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-hairline/30 px-2 font-mono text-[11px] text-ink-secondary">
                  G1 Grok · {ko ? "대기" : "pending"}
                </span>
                <span className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-hairline/30 px-2 font-mono text-[11px] text-ink-secondary">
                  M1 Gemini · {ko ? "미지원" : "n/a"}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <div className="inline-flex rounded-[3px] border border-hairline/50 bg-raised/40 p-0.5" role="group">
              {(["remaining", "used"] as const).map((val) => (
                <button
                  key={val}
                  type="button"
                  aria-pressed={mode === val}
                  onClick={() => setUsageMode(val)}
                  className={cn(
                    "rounded-[2px] px-2 py-0.5 text-[11px] font-medium transition-colors",
                    mode === val ? "bg-accent/20 text-ink" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {val === "remaining" ? (ko ? "남음" : "Left") : ko ? "사용" : "Used"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setRefreshing(true);
                setTimeout(() => setRefreshing(false), 350);
              }}
              aria-label={ko ? "사용량 새로고침" : "Refresh usage"}
              title="Alt+R"
              className="inline-flex size-7 items-center justify-center rounded-[3px] border border-hairline/50 bg-raised/40 text-ink-secondary hover:text-ink"
            >
              <RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} />
            </button>
          </div>
        </div>

        {/* Hero Readout + Pace Verdict Banner */}
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <TickerBadge ticker={activeTicker} active />
              <span className="text-[13px] font-semibold text-ink">
                {activeTicker === "C1"
                  ? ko
                    ? "Claude 계정 1 (주 계정)"
                    : "Claude Account 1 (Main)"
                  : ko
                    ? "Claude 계정 3 (대기 계정)"
                    : "Claude Account 3 (Active)"}
              </span>
              <span className="font-mono text-[11px] text-ink-secondary">
                {activeTicker === "C1"
                  ? ko
                    ? "Kai · 워커 3개"
                    : "Kai · 3 workers"
                  : ko
                    ? "워커 1개 · 고정됨"
                    : "1 worker · pinned"}
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline gap-4">
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-[28px] leading-none font-bold tracking-tight text-ink tabular-nums">
                  {hero5h}%
                </span>
                <span className="font-mono text-[11.5px] text-ink-secondary">
                  {ko ? "5시간" : "5h"} {mode === "remaining" ? (ko ? "남음" : "left") : ko ? "사용" : "used"} ·{" "}
                  {activeTicker === "C1" ? (ko ? "3시간 40분" : "3h 40m") : ko ? "2시간 15분" : "2h 15m"}
                </span>
              </div>
              <div className="flex items-baseline gap-1.5 border-l border-hairline/40 pl-3">
                <span className="font-mono text-[18px] leading-none font-semibold text-ink tabular-nums">
                  {hero7d}%
                </span>
                <span className="font-mono text-[11px] text-ink-secondary">
                  {ko ? "7일 · 금 오전 5:00" : "7d · Fri 5:00 AM"}
                </span>
              </div>
            </div>
          </div>

          {/* Range selector + Pace Verdict pill */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-[3px] border border-accent/40 bg-accent/10 px-2.5 py-1 font-mono text-[11.5px] font-medium text-accent">
              <TrendingDown size={13} />
              <span>
                {ko
                  ? `오후 6:40 초기화 통과 · +${projectedLeft}% 여유 · -4.8%/시간`
                  : `Clears 6:40 PM reset · +${projectedLeft}% left · -4.8%/h`}
              </span>
            </div>
            <div className="inline-flex rounded-[3px] border border-hairline/50 bg-raised/40 p-0.5">
              {(["5h", "24h", "7d"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={cn(
                    "rounded-[2px] px-2 py-0.5 font-mono text-[10.5px] font-medium",
                    range === r ? "bg-ink/15 text-ink" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Living SVG Burndown & Pace Chart */}
        <div className="mt-2.5 rounded-[4px] border border-hairline/35 bg-surface/50 px-2.5 pt-2 pb-1.5">
          <PaceBurndownChart
            mode={mode}
            range={range}
            ko={ko}
            liveRemaining5h={base5hLeft}
            projectedAtReset={projectedLeft}
            activeTicker={activeTicker}
            autoSwitchFlash={autoSwitchFlash}
          />
        </div>

        {/* 7-Day Daily Burn Strip */}
        <div className="mt-2.5 grid grid-cols-7 gap-1.5">
          {DAILY_7D_BURN.map((d) => {
            const val = mode === "remaining" ? d.leftPct : d.usedPct;
            return (
              <div
                key={d.dayEn}
                className={cn(
                  "rounded-[3px] border px-1.5 py-1 text-center font-mono",
                  d.active ? "border-accent/45 bg-accent/10" : "border-hairline/35 bg-raised/25",
                )}
              >
                <div className="text-[10px] text-ink-secondary">{ko ? d.dayKo : d.dayEn}</div>
                <div className={cn("text-[11px] font-semibold tabular-nums", d.active ? "text-accent" : "text-ink")}>
                  {val}%
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Card 2: Fixed-Order Multi-Account Rotation Tape */}
      <Card>
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-ink">
              {ko ? "계정 로테이션 및 한도" : "Account Rotation"}
            </span>
            <span className="shrink-0 whitespace-nowrap rounded-[3px] border border-hairline/50 bg-raised/50 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-secondary">
              {ko ? "자동 전환: C1 -> C3" : "Auto 0%: C1 -> C3"}
            </span>
          </div>
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-ink-secondary">
            Alt+U
          </span>
        </div>

        {/* Claude x3 fixed order: C1, C2, C3 */}
        <div className="flex flex-col gap-2">
          {claudeAccounts.map((acct) => {
            const meta = TRADER_ACCOUNT_META[acct.instanceId]!;
            const isMain = acct.instanceId === mainClaudeId;
            const isNext = !isMain && acct.instanceId === (mainClaudeId === "claudeAgent" ? "claudeAgent~3" : "claudeAgent");
            return (
              <TraderAccountRow
                key={acct.instanceId}
                account={acct}
                meta={meta}
                mode={mode}
                ko={ko}
                phone={phone}
                isMain={isMain}
                isNext={isNext}
                pinnedToCurrent={pinnedClaude}
                onUseAccount={(id) => {
                  if (id === "claudeAgent" || id === "claudeAgent~3") setMainClaude(id);
                }}
                onTogglePin={() => setPinnedClaude((p) => !p)}
              />
            );
          })}

          {/* Codex x2 fixed order: X1, X2 */}
          <div className="mt-1 grid grid-cols-1 gap-2 md:grid-cols-2">
            {codexAccounts.map((acct) => {
              const meta = TRADER_ACCOUNT_META[acct.instanceId]!;
              return (
                <TraderAccountRow
                  key={acct.instanceId}
                  account={acct}
                  meta={meta}
                  mode={mode}
                  ko={ko}
                  phone={phone}
                  isMain={Boolean(acct.accountMain)}
                  isNext={!acct.accountMain}
                  pinnedToCurrent={false}
                  onUseAccount={() => {}}
                  onTogglePin={() => {}}
                />
              );
            })}
          </div>

          {/* Grok G1 & Gemini M1 honest rows */}
          <div className="mt-1 grid grid-cols-1 gap-2 md:grid-cols-2">
            {otherAccounts.map((acct) => {
              const meta = TRADER_ACCOUNT_META[acct.instanceId]!;
              return (
                <TraderAccountRow
                  key={acct.instanceId}
                  account={acct}
                  meta={meta}
                  mode={mode}
                  ko={ko}
                  phone={phone}
                  isMain={false}
                  isNext={false}
                  pinnedToCurrent={false}
                  onUseAccount={() => {}}
                  onTogglePin={() => {}}
                />
              );
            })}
          </div>
        </div>
      </Card>
    </div>
  );
}

/** Chat Meter with inline sparkline + Quick View HUD (Alt+U) + Usage Wait Card. */
export function TraderChatSurface({
  initialQuickHudOpen = true,
  showWaitCard = true,
  mainClaudeId = "claudeAgent",
  onSelectMainClaude,
  liveRemaining5h = 66,
  autoSwitchBanner,
}: {
  initialQuickHudOpen?: boolean;
  showWaitCard?: boolean;
  mainClaudeId?: "claudeAgent" | "claudeAgent~3";
  onSelectMainClaude?: (id: "claudeAgent" | "claudeAgent~3") => void;
  liveRemaining5h?: number;
  autoSwitchBanner?: string | null;
}) {
  const ko = useKo();
  const phone = useIsPhone();
  const mode = useUsageMode();
  const [hudOpen, setHudOpen] = useState(initialQuickHudOpen);
  const [stayPinned, setStayPinned] = useState(false);
  const [localMain, setLocalMain] = useState<"claudeAgent" | "claudeAgent~3">(mainClaudeId);

  useEffect(() => {
    setLocalMain(mainClaudeId);
  }, [mainClaudeId]);

  const activeMain = onSelectMainClaude ? mainClaudeId : localMain;
  const switchAccount = (id: "claudeAgent" | "claudeAgent~3") => {
    setLocalMain(id);
    onSelectMainClaude?.(id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.code === "KeyU" || e.key.toLowerCase() === "u")) {
        e.preventDefault();
        setHudOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ticker = activeMain === "claudeAgent~3" ? "C3" : "C1";
  const pct5hLeft = activeMain === "claudeAgent~3" ? 40 : Math.round(liveRemaining5h);
  const pct7dLeft = activeMain === "claudeAgent~3" ? 72 : 39;
  const disp5h = mode === "remaining" ? pct5hLeft : 100 - pct5hLeft;
  const disp7d = mode === "remaining" ? pct7dLeft : 100 - pct7dLeft;
  const projLeft = activeMain === "claudeAgent~3" ? 37 : Math.max(0, Math.round(pct5hLeft - 18));

  return (
    <div className="flex flex-col justify-between bg-surface text-ink">
      {/* Top Chat Header */}
      <div className="flex items-center justify-between gap-2 border-b border-hairline/40 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <MausAvatar color="coral" state="idle" size={20} animated={false} />
          <span className="text-[13px] font-semibold text-ink">Kai</span>
          <TickerBadge ticker={ticker} active size="sm" />
          <span className="truncate font-mono text-[11px] text-ink-secondary">
            {phone ? (ko ? "Opus 4.6 · 워커 3" : "Opus 4.6 · 3w") : ko ? "Opus 4.6 · 워커 3개 실행 중" : "Opus 4.6 · 3 workers active"}
          </span>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-[3px] border border-hairline/50 bg-raised/60 px-2 py-0.5 font-mono text-[10.5px] text-ink-secondary">
          {ko ? "자동 전환 켜짐" : "Auto-rotate: ON"}
        </span>
      </div>

      {/* Chat Messages + Usage Wait Card */}
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <div className="max-w-[88%] rounded-[6px] border border-hairline/35 bg-raised/35 px-3 py-2 text-[12.5px] text-ink">
          {ko
            ? "오전 병렬 워커 작업 중 C2가 주간 한도(0%)에 도달하여 오전 11:52에 C1으로 자동 전환되었습니다."
            : "Morning parallel worker batch finished. C2 hit 0% at 11:52 AM and handed off cleanly to C1."}
        </div>

        {/* Usage Wait / Auto-Switch Provenance Card in Chat */}
        {showWaitCard && (
          <div
            data-usage-wait-card=""
            className="rounded-[5px] border border-warning/45 bg-warning/[0.07] px-3 py-2.5 text-[12px]"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 font-medium text-ink">
                <TickerBadge ticker="C2" exhausted size="sm" />
                <span>
                  {ko
                    ? "C2 한도 도달 (0% 남음 · 월 오후 5:00 초기화)"
                    : "C2 is out until Mon 5:00 PM (0% left)"}
                </span>
              </div>
              <span className="inline-flex items-center gap-1 rounded-[3px] bg-accent/15 px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-accent">
                <ArrowRightLeft size={10} />
                {ko ? "오전 11:52 C2 -> C1 이동됨" : "Moved C2 -> C1 · 11:52 AM"}
              </span>
            </div>
            <div className="mt-1 text-[11.5px] text-ink-secondary">
              {ko
                ? "새 작업과 활성 워커 3개가 C1(66% 남음)으로 이동했습니다. 다른 계정을 직접 선택할 수도 있습니다:"
                : "New turns and 3 active workers moved to C1 (66% left). Switch or pin anytime:"}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => switchAccount("claudeAgent")}
                className={cn(
                  "inline-flex h-6.5 items-center gap-1 rounded-[3px] border px-2 font-mono text-[11px] font-medium",
                  activeMain === "claudeAgent"
                    ? "border-accent/50 bg-accent/20 text-accent"
                    : "border-hairline/50 bg-raised/60 text-ink hover:border-accent/40",
                )}
              >
                <Check size={11} className={activeMain === "claudeAgent" ? "opacity-100" : "opacity-0"} />
                {ko ? `C1 계속 사용 · ${pct5hLeft}%` : `Continue on C1 · ${pct5hLeft}%`}
              </button>
              <button
                type="button"
                onClick={() => switchAccount("claudeAgent~3")}
                className={cn(
                  "inline-flex h-6.5 items-center gap-1 rounded-[3px] border px-2 font-mono text-[11px] font-medium",
                  activeMain === "claudeAgent~3"
                    ? "border-accent/50 bg-accent/20 text-accent"
                    : "border-hairline/50 bg-raised/60 text-ink hover:border-accent/40",
                )}
              >
                {ko ? "C3로 전환 · 40%" : "Use C3 · 40%"}
              </button>
              <span className="ml-auto font-mono text-[10.5px] text-ink-secondary">
                {ko ? "C2 대기: 4일 2시간" : "C2 resets in 4d 2h"}
              </span>
            </div>
          </div>
        )}

        {autoSwitchBanner && (
          <div className="flex items-center justify-between rounded-[4px] border border-accent/50 bg-accent/15 px-3 py-1.5 font-mono text-[11.5px] font-medium text-accent">
            <span>{autoSwitchBanner}</span>
            <span>66% left</span>
          </div>
        )}

        {/* Quick View HUD Popover (Alt+U) anchored right above the chat meter */}
        {hudOpen && (
          <div
            data-quick-view-hud=""
            className="rounded-[6px] border border-hairline/70 bg-raised/95 p-3 shadow-lg backdrop-blur-sm"
          >
            <div className="flex items-center justify-between gap-2 border-b border-hairline/40 pb-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <TickerBadge ticker={ticker} active size="sm" />
                <span className="truncate text-[12px] font-semibold text-ink">
                  {ko ? "실시간 속도 및 계정" : phone ? "Pace & Accounts" : "Live Pace & Account Switcher"}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <span className="whitespace-nowrap rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent">
                  {ko ? `6:40 초기화 (+${projLeft}%)` : `6:40p (+${projLeft}%)`}
                </span>
                <span className="whitespace-nowrap rounded border border-hairline/50 px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">
                  Alt+U
                </span>
              </div>
            </div>

            {/* Compact SVG Burndown inside HUD */}
            <div className="mt-2">
              <PaceBurndownChart
                mode={mode}
                range="5h"
                ko={ko}
                compact
                liveRemaining5h={pct5hLeft}
                projectedAtReset={projLeft}
                activeTicker={ticker}
              />
            </div>

            {/* Fixed-order 3-account switcher row inside HUD */}
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => switchAccount("claudeAgent")}
                className={cn(
                  "flex flex-col rounded-[3px] border p-1.5 text-left font-mono transition-colors",
                  activeMain === "claudeAgent"
                    ? "border-accent/55 bg-accent/15"
                    : "border-hairline/50 bg-surface/60 hover:border-accent/40",
                )}
              >
                <div className="flex items-center justify-between whitespace-nowrap text-[11px] font-semibold text-ink">
                  <span>C1 {ko ? "사용중" : "Active"}</span>
                  <span className="text-accent">{activeMain === "claudeAgent" ? `${pct5hLeft}%` : "66%"}</span>
                </div>
                <div className="mt-0.5 whitespace-nowrap text-[10px] text-ink-secondary">
                  {ko ? "7일 39% · 6:40" : "7d 39% · 6:40p"}
                </div>
              </button>

              <div className="flex flex-col rounded-[3px] border border-danger/35 bg-danger/[0.06] p-1.5 text-left font-mono opacity-80">
                <div className="flex items-center justify-between whitespace-nowrap text-[11px] font-semibold text-danger">
                  <span>C2 {ko ? "소진" : "Out"}</span>
                  <span>0%</span>
                </div>
                <div className="mt-0.5 whitespace-nowrap text-[10px] text-ink-secondary">
                  {ko ? "월 오후 5:00" : "Mon 5:00 PM"}
                </div>
              </div>

              <button
                type="button"
                onClick={() => switchAccount("claudeAgent~3")}
                className={cn(
                  "flex flex-col rounded-[3px] border p-1.5 text-left font-mono transition-colors",
                  activeMain === "claudeAgent~3"
                    ? "border-accent/55 bg-accent/15"
                    : "border-hairline/50 bg-surface/60 hover:border-accent/40",
                )}
              >
                <div className="flex items-center justify-between whitespace-nowrap text-[11px] font-semibold text-ink">
                  <span>C3 {ko ? "다음" : "Next"}</span>
                  <span className="text-accent">40%</span>
                </div>
                <div className="mt-0.5 whitespace-nowrap text-[10px] text-ink-secondary">
                  {ko ? "7일 72% · 5:15" : "7d 72% · 5:15p"}
                </div>
              </button>
            </div>

            {/* Stay on current account pin bar */}
            <div className="mt-2 flex items-center justify-between border-t border-hairline/35 pt-1.5 text-[11px]">
              <span className="font-mono text-ink-secondary">
                {ko ? "Kai + 워커 3개 (-4.8%/시간)" : "Kai + 3 workers (-4.8%/h est.)"}
              </span>
              <button
                type="button"
                onClick={() => setStayPinned((s) => !s)}
                aria-pressed={stayPinned}
                className={cn(
                  "inline-flex items-center gap-1 rounded-[3px] border px-2 py-0.5 font-mono text-[10.5px] font-medium",
                  stayPinned
                    ? "border-accent/50 bg-accent/20 text-accent"
                    : "border-hairline/50 bg-surface/60 text-ink-secondary hover:text-ink",
                )}
              >
                <Pin size={10} />
                {stayPinned
                  ? ko
                    ? `${ticker} 고정됨`
                    : `Pinned to ${ticker}`
                  : ko
                    ? `${ticker}에 고정`
                    : `Stay on ${ticker}`}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Chat Meter + Composer Footer */}
      <div className="border-t border-hairline/40 bg-raised/30 px-3 pt-1.5 pb-2.5">
        {/* Single-line Trader Chat Meter */}
        <button
          type="button"
          onClick={() => setHudOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-2 rounded-[4px] border border-hairline/45 bg-surface/75 px-2.5 py-1.5 text-left font-mono text-[11.5px] hover:border-accent/45"
        >
          <div className="flex min-w-0 items-center gap-2">
            <TickerBadge ticker={ticker} active size="sm" />
            <span className="font-semibold text-ink tabular-nums">
              {ko ? "5시간" : "5h"} <span className="text-accent">{disp5h}%</span>
            </span>
            <span className="text-[10.5px] text-ink-secondary tabular-nums">
              ({activeMain === "claudeAgent~3" ? "2h 15m" : "3h 40m"})
            </span>
            {/* Inline micro pace sparkline */}
            <svg width="34" height="12" viewBox="0 0 34 12" className="shrink-0 overflow-visible" aria-hidden="true">
              <line x1="0" y1="2" x2="34" y2="11" stroke="currentColor" className="text-ink-secondary/40" strokeWidth="1" strokeDasharray="1.5 1.5" />
              <polyline points="0,3 14,5 22,5.5 34,6.5" fill="none" stroke="var(--color-accent)" strokeWidth="1.5" />
              <circle cx="22" cy="5.5" r="2" className="fill-accent" />
            </svg>
            <span className="text-[10.5px] font-medium text-accent tabular-nums">+{projLeft}%</span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="text-ink tabular-nums">
              {ko ? "7일" : "7d"} <span className="font-semibold">{disp7d}%</span>
            </span>
            {!phone && (
              <span className="text-[10.5px] text-ink-secondary">
                {ko ? "금 오전 5:00" : "Fri 5:00a"}
              </span>
            )}
            <span className="rounded border border-hairline/50 bg-raised px-1.5 py-0.5 text-[10px] text-ink-secondary">
              Alt+U
            </span>
          </div>
        </button>

        {/* Composer Input Mock */}
        <div className="mt-1.5 flex h-9 items-center justify-between rounded-[5px] border border-hairline/50 bg-surface px-3 text-[12.5px] text-ink-secondary">
          <span className="truncate">
            {ko ? "Kai에게 메시지 보내기 (C1 · Opus 4.6)..." : "Message Kai on C1 (Opus 4.6)..."}
          </span>
          <span className="font-mono text-[11px] text-ink-secondary">↵</span>
        </div>
      </div>
    </div>
  );
}

/** Settings -> Connections surface: the ONLY place where email addresses (@) appear, paired with C1/C2/C3/X1/X2/G1/M1 ticker tiles. */
export function TraderConnectionsCard() {
  const { state } = useStore();
  const ko = useKo();
  const mode = useUsageMode();

  return (
    <Card
      title={ko ? "연결된 계정 (Connections)" : "Connections"}
      subtitle={
        ko
          ? "이메일 주소는 이 화면에서만 표시됩니다. 다른 모든 화면에서는 C1, C2, X1 티커로 표시됩니다."
          : "Full account emails appear only here. Everywhere else uses compact C1, C2, X1 tickers."
      }
    >
      <div className="flex flex-col divide-y divide-hairline/30" data-connections-surface="">
        {state.instances.map((acct) => {
          const meta = TRADER_ACCOUNT_META[acct.instanceId];
          if (!meta) return null;
          const pct5h = getWindowPct(acct, "five_hour", mode);
          const pct7d = getWindowPct(acct, "seven_day", mode);
          const exhausted = pct5h === 0 || pct7d === 0;
          return (
            <div key={acct.instanceId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12.5px]">
              <div className="flex min-w-0 items-center gap-2">
                <EngineMark instance={acct} size={15} />
                <TickerBadge ticker={meta.ticker} active={Boolean(acct.accountMain)} exhausted={exhausted} size="sm" />
                <span className="truncate font-mono text-[12px] text-ink">{meta.email}</span>
                {acct.accountMain && (
                  <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-medium text-accent">
                    {ko ? "주 계정" : "In use"}
                  </span>
                )}
                {exhausted && (
                  <span className="rounded bg-danger/10 px-1.5 py-0.5 text-[10.5px] font-medium text-danger">
                    {ko ? "한도 도달" : "Out · Mon 5:00 PM"}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 font-mono text-[11.5px] text-ink-secondary">
                {pct5h !== null && <span>5h {pct5h}%</span>}
                {pct7d !== null && <span>7d {pct7d}%</span>}
                <button type="button" className="text-ink hover:underline">
                  {ko ? "로그아웃" : "Sign out"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
