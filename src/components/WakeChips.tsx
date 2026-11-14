import { AlarmClock, X } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { pendingWakesFor, wakeTime } from "@/lib/routines";
import { api, useStore } from "@/state/store";

/** A bot's pending wake_me wakes in this chat; tapping one cancels it. */
export function WakeChips({ botIds, threadId }: { botIds: readonly string[]; threadId: string }) {
  const { state, dispatch } = useStore();
  const { t, locale } = useI18n();
  const wakes = pendingWakesFor(state.routines, botIds, threadId);
  if (!wakes.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-5 pb-2 max-md:px-4">
      {wakes.map((wake) => {
        const time = wakeTime(wake.nextRunAt, Date.now(), locale);
        return (
          <button
            key={wake.id}
            type="button"
            data-wake-chip={wake.id}
            title={wake.prompt}
            aria-label={t("wake.cancel", { time })}
            onClick={() => void api(`/api/routines/${wake.id}`, { method: "DELETE" }).catch((error) =>
              dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) }))}
            className="group flex items-center gap-1.5 rounded-full bg-raised px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-raised-hover hover:text-ink"
          >
            <AlarmClock size={12} className="shrink-0 text-accent" />
            {t("wake.chip", { time })}
            <X size={11} className="shrink-0 opacity-60 group-hover:opacity-100" />
          </button>
        );
      })}
    </div>
  );
}
