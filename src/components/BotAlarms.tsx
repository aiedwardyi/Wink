import { ChevronDown, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import type { Routine } from "@/lib/routines";
import { formatTime } from "@/state/store";
import { DETAILS_BOX, DETAILS_ROW } from "./BotDetailsRows";
import { Fold } from "./Fold";

function when(schedule: Routine["schedule"], tag: string, everyDay: string) {
  if (schedule.type === "once") return `${new Date(schedule.at).toLocaleDateString(tag, { month: "short", day: "numeric" })} ${formatTime(schedule.at, tag)}`;
  const [hour, minute] = schedule.time.split(":").map(Number);
  const time = formatTime(new Date(2026, 0, 4, hour, minute).getTime(), tag);
  if (schedule.weekdays.length === 7) return `${everyDay} ${time}`;
  // 2026-01-04 is a Sunday, so day n of the week is the 4th plus n
  const days = [...schedule.weekdays].sort((a, b) => a - b).map((day) => new Date(2026, 0, 4 + day).toLocaleDateString(tag, { weekday: "short" }));
  return `${days.join(", ")} ${time}`;
}

/** A bot's routines, behind one Alarms line that shows only when it has some. Its own wake_me wakes are not alarms. */
export function BotAlarms({ routines: all, onDelete }: { routines: Routine[]; onDelete: (routineId: string) => Promise<unknown> | void }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  // a second DELETE for an id already gone fails and shows an error toast
  const deleting = useRef(new Set<string>());
  const routines = all.filter((routine) => !routine.wake);
  if (!routines.length) return null;
  const tag = localeTag(locale);
  return (
    <div className={DETAILS_BOX}>
      <div className={DETAILS_ROW}>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="relative flex w-full items-center gap-2 text-left [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-3 [@media(pointer:coarse)]:after:inset-x-0">
          <span className="flex-1 text-[14px] font-medium text-ink">{t("bot.alarms")}</span>
          <span className="text-[12px] text-ink-secondary">{routines.length}</span>
          <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none", open && "rotate-180")} />
        </button>
        <Fold open={open}>
          <ul className="mt-2 space-y-2">
            {routines.map((routine) => (
              <li key={routine.id} data-alarm="" className="group flex min-w-0 items-center gap-2 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ink">{routine.name}</div>
                  <div className="text-[12px] text-ink-secondary">
                    {when(routine.schedule, tag, t("bot.alarmsEveryDay"))}
                    {!routine.enabled && ` · ${t("bot.alarmsPaused")}`}
                  </div>
                </div>
                {/* focus reveals it as hover does; touch has no hover, so it always shows there */}
                <button
                  type="button"
                  aria-label={`${t("chrome.delete")} ${routine.name}`}
                  onClick={() => {
                    if (deleting.current.has(routine.id)) return;
                    deleting.current.add(routine.id);
                    void Promise.resolve(onDelete(routine.id)).finally(() => deleting.current.delete(routine.id));
                  }}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:size-9 pointer-coarse:opacity-100"
                >
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        </Fold>
      </div>
    </div>
  );
}
