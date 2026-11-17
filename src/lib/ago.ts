import type { MessageKey } from "./i18n-catalog";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** "Just now", "5m ago", "3h ago", "2d ago". */
export function agoText(at: number, now: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return t("team.justNow");
  if (minutes < 60) return t("team.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("team.hoursAgo", { n: hours });
  return t("team.daysAgo", { n: Math.floor(hours / 24) });
}
