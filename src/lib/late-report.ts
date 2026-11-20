import type { Translate } from "./i18n";

export function lateReportText(text: string, t: Translate): string {
  return text.replace(/\n\(sent (\d{2}:\d{2}) while Wink was closed\)(?=(?:\n\[truncated\]\nFull report: [^\n]+)?$)/, (_suffix, time: string) => `\n${t("chat.noteSentWhileClosed", { time })}`);
}
