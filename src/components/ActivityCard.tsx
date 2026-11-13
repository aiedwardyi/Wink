import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReplyActivity } from "../../server/reply-activity.ts";
import { localeTag, useI18n } from "@/lib/i18n";
import { ripple } from "@/lib/activity-glitter";
import { cn } from "@/lib/cn";
import { EASE_ENTRANCE, MOTION_LARGE_MS } from "@/lib/motion";
import { reducedMotion } from "@/lib/phone-swipe";
import { LIGHT_SKIN_IDS, readSkin } from "@/lib/skins";
import { placeTooltip } from "@/lib/tooltip-position";
import { PLAIN_TOOLTIP_CLASS } from "@/lib/tooltips";
import { api } from "@/state/store";
import { ProviderMark } from "./ProviderIcons";
import { Card } from "./SettingsPrimitives";

const SHADES = ["bg-control", "bg-accent/25", "bg-accent/50", "bg-accent/75", "bg-accent"];
const WEEK_GRID = "grid grid-cols-[repeat(26,minmax(0,1fr))] gap-x-[2px] @[30rem]/activity:gap-x-[3px]";
const KEY = "omb-activity";
/** When the last square starts, so the whole sweep lands inside 700 ms. */
const SWEEP_MS = 300;
const GLINT_PEAK = 1.7;
/** Pale squares clip to white and vanish into the card at the dark peak. */
const GLINT_PEAK_LIGHT = 1.05;
const ENGINE_NAMES: Record<string, string> = {
  claudeAgent: "Claude", codex: "OpenAI", grok: "Grok", grokAgent: "Grok", geminiAgent: "Gemini", antigravityAgent: "Gemini", museAgent: "Muse", kimiAgent: "Kimi", qwenAgent: "Qwen",
};

let last: ReplyActivity | null = null;

const isActivity = (body: Partial<ReplyActivity> | null | undefined): body is ReplyActivity =>
  Array.isArray(body?.counts) && String(body.start) === body.start && /^\d{4}-\d{2}-\d{2}$/.test(body.start) && Number.isFinite(body.total) && Number.isFinite(body.workers) && Array.isArray(body.engines);

function cachedActivity(): ReplyActivity | null {
  if (last) return last;
  try {
    const body = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (isActivity(body)) last = body;
  } catch {
    /* A fresh fetch fills it in. */
  }
  return last;
}

function keepActivity(activity: ReplyActivity) {
  last = activity;
  try {
    localStorage.setItem(KEY, JSON.stringify(activity));
  } catch {
    /* It still paints from memory this session. */
  }
}

let pending: Promise<ReplyActivity | null> | null = null;

/** Fetches and keeps the newest result; the app calls it at idle so Settings opens painted. */
export function warmActivity(): Promise<ReplyActivity | null> {
  pending ??= api("/api/activity")
    .then((body: Partial<ReplyActivity> | null) => {
      if (!isActivity(body)) return null;
      keepActivity(body);
      return body;
    })
    .finally(() => { pending = null; });
  return pending;
}

/** Each engine's share of replies, biggest first; engines that share a lab share a row. */
export function engineShares(engines: ReplyActivity["engines"]): Array<{ name: string; kind: string; share: string }> {
  const named = new Map<string, { kind: string; count: number }>();
  for (const { engine, count } of [...engines].sort((a, b) => b.count - a.count)) {
    const name = ENGINE_NAMES[engine] ?? engine.replace(/Agent$/, "").replace(/^./, (first) => first.toUpperCase());
    const row = named.get(name);
    if (row) row.count += count;
    else if (count > 0) named.set(name, { kind: engine, count });
  }
  const total = [...named.values()].reduce((sum, row) => sum + row.count, 0);
  return [...named]
    .sort(([a, x], [b, y]) => y.count - x.count || a.localeCompare(b))
    .map(([name, { kind, count }]) => {
      const percent = Math.round((count / total) * 100);
      return { name, kind, share: percent ? `${percent}%` : "<1%" };
    });
}

/** Tests only: forget the last result. */
export function resetActivity(): void {
  last = null;
  pending = null;
}

const dayDate = (iso: string, offset = 0) => {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year!, month! - 1, day! + offset);
};

/** The server's grid with no replies yet, so the card holds its height. */
function emptyActivity(): ReplyActivity {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay() - 25 * 7);
  const start = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(first.getDate()).padStart(2, "0")}`;
  return { start, counts: Array<number>(25 * 7 + today.getDay() + 1).fill(0), since: null, busiest: null, total: 0, workers: 0, engines: [] };
}

export function ActivityCard({ waved }: { waved?: { current: boolean } }) {
  const { t, locale } = useI18n();
  const [fetched, setFetched] = useState<ReplyActivity | null>(cachedActivity);
  const [failed, setFailed] = useState(false);
  const [tip, setTip] = useState<{ day: number; anchor: DOMRect } | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const glints = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const pointer = useRef("");
  useEffect(() => {
    let gone = false;
    void warmActivity().then((body) => {
      if (gone) return;
      if (!body) return setFailed(true);
      setFetched(body);
    }).catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, []);
  useLayoutEffect(() => {
    if (waved?.current || reducedMotion()) return;
    if (waved) waved.current = true;
    const squares = grid.current?.querySelectorAll<HTMLElement>("[data-day]") ?? [];
    const peak = LIGHT_SKIN_IDS.has(readSkin()) ? GLINT_PEAK_LIGHT : GLINT_PEAK;
    for (const [day, square] of [...squares].entries()) {
      const week = Math.floor(day / 7);
      const delay = SWEEP_MS * week / 25;
      // One animation per square: a second layer each halves the frame rate at 4x.
      square.animate?.([
        { opacity: 0.35, transform: "translateY(-3px)", filter: "brightness(1)" },
        { filter: "brightness(1)", offset: 0.25 },
        { filter: `brightness(${peak})`, offset: 0.55 },
        { filter: "brightness(1)", offset: 0.85 },
        { opacity: 1, transform: "none", filter: "brightness(1)" },
      ], { duration: MOTION_LARGE_MS, delay, easing: EASE_ENTRANCE, fill: "backwards" });
    }
  }, []);
  useEffect(() => {
    if (!tip) return;
    const away = (event: Event) => {
      if (!(event.target instanceof Node && grid.current?.contains(event.target))) setTip(null);
    };
    const scrolled = () => setTip(null);
    document.addEventListener("pointerdown", away);
    document.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("scroll", scrolled, true);
    };
  }, [tip]);
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const size = el.getBoundingClientRect();
    const box = placeTooltip({ anchor: tip.anchor, size, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
    el.style.top = `${box.top}px`;
    el.style.left = `${box.left}px`;
    el.style.visibility = "visible";
  }, [tip]);
  if (!fetched && failed) return null;
  const activity = fetched ?? emptyActivity();
  const tag = localeTag(locale);
  const month = new Intl.DateTimeFormat(tag, { month: "short" });
  const dayName = new Intl.DateTimeFormat(tag, { month: "short", day: "numeric" });
  const busiest = activity.busiest && dayName.format(dayDate(activity.busiest.day));
  const since = activity.since && new Intl.DateTimeFormat(tag, { month: "short", year: "numeric" }).format(dayDate(activity.since));
  const shares = engineShares(activity.engines);
  const active = activity.counts.filter(Boolean).sort((a, b) => a - b);
  const cuts = [1, 2, 3].map((quarter) => active[Math.floor((quarter / 4) * (active.length - 1))]!);
  const shade = (count: number) => (count ? 1 + cuts.filter((cut) => count > cut).length : 0);
  const months = Array.from({ length: 26 }, (_, week) => dayDate(activity.start, week * 7))
    .map((date, week, weeks) => (week === 0 || date.getMonth() !== weeks[week - 1]!.getMonth() ? { week, label: month.format(date) } : null))
    .filter((label) => label !== null)
    .filter((label, index, labels) => label.week > 0 || (labels[index + 1]?.week ?? 26) >= 3);
  const squareAt = (target: EventTarget) => (target instanceof HTMLElement && target.dataset.day !== undefined ? target : null);
  const tipFor = (square: HTMLElement) => ({ day: Number(square.dataset.day), anchor: square.getBoundingClientRect() });
  const tipText = (day: number) => {
    const count = activity.counts[day] ?? 0;
    const vars = { day: dayName.format(dayDate(activity.start, day)), n: count.toLocaleString(tag) };
    return t(count === 0 ? "settings.activity.tipNone" : count === 1 ? "settings.activity.tipOne" : "settings.activity.tip", vars);
  };
  const stat = (value: string, label: React.ReactNode, title?: string) => (
    <div className="@[30rem]/activity:flex @[30rem]/activity:items-baseline @[30rem]/activity:gap-1.5">
      <div title={title} className="text-[22px] font-semibold leading-tight tracking-tight text-ink tabular-nums @[30rem]/activity:text-[15px]">{value}</div>
      <div className="text-[12px] text-ink-secondary">{label}</div>
    </div>
  );
  return (
    <Card title={t("settings.activity.title")}>
      <div className="@container/activity">
        <div className="flex flex-col-reverse gap-4 @[30rem]/activity:flex-row @[30rem]/activity:items-center @[30rem]/activity:gap-7">
          <div aria-hidden className="min-w-0 flex-1 @[30rem]/activity:max-w-[23rem]">
            <div className={cn(WEEK_GRID, "mb-1.5 text-[10px] leading-none text-ink-secondary")}>
              {months.map(({ week, label }) => {
                const column = Math.min(week, 24);
                return <span key={week} className="whitespace-nowrap" style={{ gridColumn: `${column + 1} / span ${Math.min(3, 26 - column)}` }}>{label}</span>;
              })}
            </div>
            <div
              ref={grid}
              data-no-swipe
              className={cn(WEEK_GRID, "relative touch-pan-y touch-pinch-zoom grid-flow-col grid-rows-7 gap-y-[2px] @[30rem]/activity:gap-y-[3px]")}
              onPointerOver={(event) => {
                const square = squareAt(event.target);
                if (square && glints.current) ripple(glints.current, Number(square.dataset.day), activity.counts.length, (day) => shade(activity.counts[day]!) < 3);
                if (event.pointerType === "mouse" && square && fetched) setTip(tipFor(square));
              }}
              onPointerLeave={(event) => { if (event.pointerType === "mouse") setTip(null); }}
              onPointerDown={(event) => {
                pointer.current = event.pointerType;
                // A touch holds the square it landed on, so a drag would never reach the next one.
                if (event.target instanceof Element && event.target.hasPointerCapture?.(event.pointerId)) event.target.releasePointerCapture(event.pointerId);
              }}
              onClick={(event) => {
                const square = squareAt(event.target);
                if (!square || !fetched || pointer.current === "mouse") return;
                setTip((open) => (open?.day === Number(square.dataset.day) ? null : tipFor(square)));
              }}
            >
              {activity.counts.map((count, day) => (
                <span
                  key={day}
                  data-day={day}
                  className={cn(
                    "aspect-square rounded-[2px] transition-transform",
                    SHADES[shade(count)],
                    tip?.day === day && "relative z-10 scale-125 ring-1 ring-accent ring-offset-1 ring-offset-card",
                  )}
                />
              ))}
              <canvas ref={glints} className="pointer-events-none absolute left-0 top-0 size-full" />
            </div>
          </div>
          {activity.total || !fetched ? (
            <div className={cn("flex justify-between gap-4 @[30rem]/activity:flex-col @[30rem]/activity:gap-5", !fetched && "invisible")}>
              {stat(activity.workers.toLocaleString(tag), t("settings.activity.workers"))}
              {stat((activity.busiest?.count ?? 0).toLocaleString(tag), (
                <>
                  {t("settings.activity.busiest")}
                  <span className="block whitespace-nowrap @[30rem]/activity:inline"><span className="hidden @[30rem]/activity:inline"> · </span>{busiest}</span>
                </>
              ))}
              {stat(activity.total.toLocaleString(tag), t("settings.activity.replies"), since ? t("settings.activity.since", { month: since }) : undefined)}
            </div>
          ) : (
            <p className="text-[13px] leading-relaxed text-ink-secondary @[30rem]/activity:max-w-40">{t("settings.activity.empty")}</p>
          )}
        </div>
        {shares.length > 0 && (
          <div data-activity-engines className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-secondary">
            {shares.map(({ name, kind, share }) => (
              <span key={name} className="inline-flex items-center gap-1 whitespace-nowrap">
                <ProviderMark driverKind={kind} size={12} />
                <span className="text-ink">{name}</span>
                <span className="tabular-nums">{share}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      {tip && createPortal(
        <div ref={tipRef} data-activity-tip="" role="tooltip" className={PLAIN_TOOLTIP_CLASS} style={{ top: 0, left: 0, visibility: "hidden" }}>
          {tipText(tip.day)}
        </div>,
        document.body,
      )}
    </Card>
  );
}
