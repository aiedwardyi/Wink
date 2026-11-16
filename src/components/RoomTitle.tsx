// A room header's picture and name: one tap opens Room details, as a bot's opens Bot details.
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { openRoomDetails } from "@/lib/room-details";
import { useStore } from "@/state/store";

export function RoomTitle({ name, picture, disabled = false }: { name: string; picture?: ReactNode; disabled?: boolean }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  return (
    <button
      type="button"
      data-room-title
      disabled={disabled}
      onClick={() => openRoomDetails(dispatch)}
      title={t("room.openDetails")}
      aria-label={`${name}, ${t("room.openDetails")}`}
      className="-mx-1.5 flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-0.5 pointer-coarse:-my-2.5 pointer-coarse:py-3 text-left enabled:hover:bg-raised/50"
    >
      {picture}
      <span className="min-w-0 truncate text-[15px] font-semibold text-ink">{name}</span>
      {!disabled && <ChevronRight size={15} aria-hidden="true" className="-ml-1 shrink-0 text-ink-secondary" />}
    </button>
  );
}
