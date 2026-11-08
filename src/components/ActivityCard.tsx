import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReplyActivity } from "../../server/reply-activity.ts";
import { localeTag, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { EASE_ENTRANCE, MOTION_LARGE_MS } from "@/lib/motion";
import { reducedMotion } from "@/lib/phone-swipe";
import { placeTooltip } from "@/lib/tooltip-position";
import { PLAIN_TOOLTIP_CLASS } from "@/lib/tooltips";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

const SHADES = ["bg-control", "bg-accent/25", "bg-accent/50", "bg-accent/75", "bg-accent"];
const WEEK_GRID = "grid grid-cols-[repeat(26,minmax(0,1fr))] gap-x-[2px] @[30rem]/activity:gap-x-[3px]";
const KEY = "omb-activity";
/** Per column, so the whole wave lands inside 450 ms. */
const WAVE_STEP_MS = 8;

let last: ReplyActivity | null = null;

const isActivity = (body: Partial<ReplyActivity> | null | undefined): body is ReplyActivity =>
  Array.isArray(body?.counts) && String(body.start) === body.start && /^\d{4}-\d{2}-\d{2}$/.test(body.start) && Number.isFinite(body.streak) && Number.isFinite(body.total);

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

/** Tests only: forget the last result. */
export function resetActivity(): void {
  last = null;
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
  return { start, counts: Array<number>(25 * 7 + today.getDay() + 1).fill(0), since: null, streak: 0, busiest: null, total: 0 };
}

export function ActivityCard() {
  const { t, locale } = useI18n();
  const [fetched, setFetched] = useState<ReplyActivity | null>(cachedActivity);
  const [failed, setFailed] = useState(false);
  const [tip, setTip] = useState<{ day: number; anchor: DOMRect } | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const pointer = useRef("");
  useEffect(() => {
    let gone = false;
    void api("/api/activity").then((body: Partial<ReplyActivity> | null) => {
      if (gone) return;
      if (!isActivity(body)) return setFailed(true);
      keepActivity(body);
      setFetched(body);
    }).catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, []);
  useLayoutEffect(() => {
    if (reducedMotion()) return;
    const squares = grid.current?.querySelectorAll<HTMLElement>("[data-day]") ?? [];
    for (const [day, square] of [...squares].entries()) square.animate?.(
      [{ opacity: 0, transform: "scale(0.4)" }, { opacity: 1, transform: "none" }],
      { duration: MOTION_LARGE_MS, delay: Math.floor(day / 7) * WAVE_STEP_MS, easing: EASE_ENTRANCE, fill: "backwards" },
    );
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
    <div className="min-w-0 @[30rem]/activity:flex @[30rem]/activity:items-baseline @[30rem]/activity:gap-1.5">
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
              className={cn(WEEK_GRID, "grid-flow-col grid-rows-7 gap-y-[2px] @[30rem]/activity:gap-y-[3px]")}
              onPointerOver={(event) => {
                const square = squareAt(event.target);
                if (event.pointerType === "mouse" && square && fetched) setTip(tipFor(square));
              }}
              onPointerLeave={(event) => { if (event.pointerType === "mouse") setTip(null); }}
              onPointerDown={(event) => { pointer.current = event.pointerType; }}
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
            </div>
          </div>
          {activity.total || !fetched ? (
            <div className={cn("flex justify-between gap-4 @[30rem]/activity:flex-col @[30rem]/activity:gap-5", !fetched && "invisible")}>
              {stat(activity.streak.toLocaleString(tag), t("settings.activity.streak"))}
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
