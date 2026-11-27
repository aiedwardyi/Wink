import { ArrowDown } from "lucide-react";

import { useI18n } from "@/lib/i18n";

export function JumpToLatest({ bottom, onJump }: { bottom: number; onJump: () => void }) {
  const { t } = useI18n();
  return (
    <button
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
