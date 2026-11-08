import { Check } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { useI18n } from "@/lib/i18n";
import { usePresence } from "@/lib/use-presence";
import { descriptionSaveStatus, watchDescriptionSaveStatus } from "@/state/description-save-status";

export function SaveStatus({ botId }: { botId: string }) {
  const { t } = useI18n();
  const value = useSyncExternalStore(
    useCallback((changed) => watchDescriptionSaveStatus(botId, changed), [botId]),
    () => descriptionSaveStatus(botId),
    () => null,
  );
  const [expired, setExpired] = useState<number | null>(null);
  useEffect(() => {
    if (typeof value !== "number") return;
    const timer = setTimeout(() => setExpired(value), Math.max(0, value + 2000 - Date.now()));
    return () => clearTimeout(timer);
  }, [value]);
  const { mounted, closing } = usePresence(typeof value === "number" && value !== expired && value + 2000 > Date.now());
  return (
    <span role="status" className="absolute right-0 top-0.5 text-[12px] font-normal leading-4">
      {mounted && value !== "saving" && (
        <span data-closing={closing || undefined} className="inline-flex items-center gap-1 text-success animate-fade-in motion-reduce:animate-none">
          <Check size={12} aria-hidden="true" />
          {t("bot.memorySaved")}
        </span>
      )}
    </span>
  );
}
