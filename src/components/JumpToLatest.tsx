import { ArrowDown } from "lucide-react";

import { useI18n } from "@/lib/i18n";

export function JumpToLatest({ bottom, inline = false, onJump }: { bottom?: number; inline?: boolean; onJump: () => void }) {
  const { t } = useI18n();
  if (inline) {
    return (
      <button
        type="button"
        data-jump-latest
        onClick={onJump}
        aria-label={t("chat.jumpToLatest")}
        className="animate-pop-in relative flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-hairline/50 bg-raised px-2.5 py-0.5 text-[11.5px] font-medium leading-[18px] text-ink shadow-sm hover:bg-raised-hover pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-2.5"
      >
        <ArrowDown size={12} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="max-md:hidden">{t("chat.jumpToLatest")}</span>
        <span className="md:hidden">{t("chat.jumpToLatestShort")}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      data-jump-latest
      onClick={onJump}
      aria-label={t("chat.jumpToLatest")}
      className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
      style={{ bottom }}
    >
      <ArrowDown size={13} /> {t("chat.jumpToLatest")}
    </button>
  );
}
