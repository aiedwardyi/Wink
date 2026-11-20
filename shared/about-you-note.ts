import type { MessageKey } from "../src/lib/i18n-catalog.ts";

export type AboutYouCounts = { added: number; found: number; hidden: number; full: number };

/** What Import Memory says after a paste, in Settings and in a bot's chat alike. */
export function aboutYouNote(body: AboutYouCounts, t: (key: MessageKey, vars?: { count: number }) => string): string {
  return [
    body.added ? t("aboutYou.added", { count: body.added }) : body.found ? t("aboutYou.nothingNew") : t("aboutYou.noFacts"),
    body.hidden ? t("aboutYou.hidden", { count: body.hidden }) : "",
    body.full ? t("aboutYou.full", { count: body.full }) : "",
  ].filter(Boolean).join(" ");
}
