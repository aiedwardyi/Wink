import { useEffect, useState } from "react";
import type { ReplyActivity } from "../../server/reply-activity.ts";
import { localeTag, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { api } from "@/state/store";
import { Card } from "./SettingsPrimitives";

const SHADES = ["bg-control", "bg-accent/25", "bg-accent/50", "bg-accent/75", "bg-accent"];
const WEEK_GRID = "grid grid-cols-[repeat(26,minmax(0,1fr))] gap-x-[2px] @[30rem]/activity:gap-x-[3px]";

const dayDate = (iso: string, offset = 0) => {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year!, month! - 1, day! + offset);
};

export function ActivityCard() {
  const { t, locale } = useI18n();
  const [activity, setActivity] = useState<ReplyActivity | null>(null);
  useEffect(() => {
    let gone = false;
    void api("/api/activity").then((body: ReplyActivity) => {
      if (!gone && Array.isArray(body?.counts)) setActivity(body);
    }).catch(() => {});
    return () => { gone = true; };
  }, []);
  if (!activity) return null;
  const tag = localeTag(locale);
  const month = new Intl.DateTimeFormat(tag, { month: "short" });
  const busiest = activity.busiest && new Intl.DateTimeFormat(tag, { month: "short", day: "numeric" }).format(dayDate(activity.busiest.day));
  const active = activity.counts.filter(Boolean).sort((a, b) => a - b);
  const cuts = [1, 2, 3].map((quarter) => active[Math.floor((quarter / 4) * (active.length - 1))]!);
  const shade = (count: number) => (count ? 1 + cuts.filter((cut) => count > cut).length : 0);
  const months = Array.from({ length: 26 }, (_, week) => dayDate(activity.start, week * 7))
    .map((date, week, weeks) => (week === 0 || date.getMonth() !== weeks[week - 1]!.getMonth() ? { week, label: month.format(date) } : null))
    .filter((label) => label !== null)
    .filter((label, index, labels) => label.week > 0 || (labels[index + 1]?.week ?? 26) >= 3);
  const stat = (value: string, label: React.ReactNode) => (
    <div className="min-w-0 @[30rem]/activity:flex @[30rem]/activity:items-baseline @[30rem]/activity:gap-1.5">
      <div className="text-[22px] font-semibold leading-tight tracking-tight text-ink tabular-nums @[30rem]/activity:text-[15px]">{value}</div>
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
            <div className={cn(WEEK_GRID, "grid-flow-col grid-rows-7 gap-y-[2px] @[30rem]/activity:gap-y-[3px]")}>
              {activity.counts.map((count, day) => (
                <span key={day} className={cn("aspect-square rounded-[2px]", SHADES[shade(count)])} />
              ))}
            </div>
          </div>
          {activity.total ? (
            <div className="flex justify-between gap-4 @[30rem]/activity:flex-col @[30rem]/activity:gap-5">
              {stat(activity.streak.toLocaleString(tag), t("settings.activity.streak"))}
              {stat(activity.busiest!.count.toLocaleString(tag), (
                <>
                  {t("settings.activity.busiest")}
                  <span className="block whitespace-nowrap @[30rem]/activity:inline"><span className="hidden @[30rem]/activity:inline"> · </span>{busiest}</span>
                </>
              ))}
              {stat(activity.total.toLocaleString(tag), t("settings.activity.replies"))}
            </div>
          ) : (
            <p className="text-[13px] leading-relaxed text-ink-secondary @[30rem]/activity:max-w-40">{t("settings.activity.empty")}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
