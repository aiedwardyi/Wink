import { localeTag, useI18n, type LocaleId, type MessageKey } from "@/lib/i18n";
import { formatTime } from "@/state/store";

/** "Today" / "Yesterday" / "Mon, Aug 11": real dates, not a hardcoded label. */
function dayLabel(at: number, t: (key: MessageKey) => string, locale: LocaleId): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return t("chat.today");
  if (diffDays === 1) return t("chat.yesterday");
  return d.toLocaleDateString(localeTag(locale), { weekday: "short", month: "short", day: "numeric" });
}

export function DaySeparator({ at }: { at: number }) {
  const { t, locale } = useI18n();
  return (
    <div data-day-separator className="py-3 text-center text-[13px] text-ink-secondary">
      {dayLabel(at, t, locale)} {formatTime(at, localeTag(locale))}
    </div>
  );
}
