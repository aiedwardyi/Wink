import { useI18n } from "@/lib/i18n";
import { useFirstSync } from "@/lib/use-first-sync";

export function SyncingBotsLine({ recheck, onOpen }: { recheck: string; onOpen: () => void }) {
  const { t } = useI18n();
  const sync = useFirstSync(recheck);
  if (!sync) return null;
  const text = sync === "finishing"
    ? t("sidebar.firstSync.finishing")
    : t("sidebar.firstSync.syncing", { done: sync.done.toLocaleString(), total: sync.total.toLocaleString() });
  return (
    <button type="button" data-first-sync onClick={onOpen} className="w-full px-3 pb-1.5 pt-0.5 text-left text-[13px] text-ink-secondary hover:text-ink">
      {text}
    </button>
  );
}
