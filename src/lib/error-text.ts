import { classifyChatError } from "../../shared/chat-error";
import { t, type Translate } from "./i18n";

export function chatErrorText(line: string, bot: string, translate: Translate) {
  const error = classifyChatError(line);
  if (error.kind === "quiet") return null;
  if (error.kind === "keep") return { text: error.raw };
  if (error.kind === "known") return { text: translate(error.key, error.vars), raw: error.raw };
  return { text: translate("errors.unfinished", { bot }), raw: error.raw };
}

export class ConnectionError extends TypeError {
  constructor() {
    super(t("errors.connection"));
  }
}

export function fallbackError(cause: unknown, fallback: string): string {
  return cause instanceof ConnectionError ? cause.message : fallback;
}

export function chatBannerError(cause: unknown): string | null {
  const line = cause instanceof Error ? cause.message : String(cause);
  const error = classifyChatError(line);
  if (error.kind === "quiet") return null;
  return error.kind === "known" ? t(error.key, error.vars) : line;
}
