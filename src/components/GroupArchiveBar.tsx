import { closeGroupArchive } from "@/lib/group-archive";
import { useI18n } from "@/lib/i18n";

export function GroupArchiveBar() {
  const { t } = useI18n();
  return (
    <div data-group-archive className="flex items-center gap-3 px-5 pb-4 pt-2">
      <span className="min-w-0 flex-1 text-[13px] text-ink-secondary">{t("room.olderTask")}</span>
      <button
        type="button"
        onClick={closeGroupArchive}
        className="shrink-0 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110"
      >
        {t("room.backToShared")}
      </button>
    </div>
  );
}
