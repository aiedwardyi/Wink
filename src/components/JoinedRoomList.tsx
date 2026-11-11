// Rooms this PC joined on someone else's Wink, after the sidebar's own chats.
import { Users } from "lucide-react";

import { cn } from "@/lib/cn";
import { teamRoomsEnabled } from "@/lib/feature-flags";
import { useI18n } from "@/lib/i18n";
import { useJoinedRooms } from "@/lib/joined-rooms";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { joinedPhase, joinedSelection, type JoinedView } from "@/lib/team-rooms";
import { useStore } from "@/state/store";

function JoinedRoomRow({ room, density }: { room: JoinedView; density: SidebarDensity }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const id = joinedSelection(room.roomId);
  const selected = state.selectedId === id;
  const name = room.state?.roomName ?? "";
  const phase = joinedPhase(room);
  const line = phase === "removed" ? t("teamRoom.removed") : phase === "left" ? t("teamRoom.left") : (room.state?.host ?? "");
  return (
    <div className="group relative min-h-12 py-0.5" data-joined-room-row title={density === "icons" ? name : undefined}>
      <button
        type="button"
        onClick={() => dispatch({ type: "select", id })}
        className={cn(
          "flex w-full items-center rounded-xl text-left",
          density === "icons" ? "justify-center px-1 py-1.5" : density === "compact" ? "gap-2 px-2 py-1.5" : "gap-2 px-3 py-1.5",
          selected ? "bg-raised" : "hover:bg-raised/50",
        )}
        aria-label={density === "icons" ? name : undefined}
        aria-current={selected || undefined}
      >
        <span className={cn("flex shrink-0 items-center justify-center", density === "compact" ? "size-8" : "size-12")}>
          <Users size={24} className="text-ink-secondary" />
        </span>
        <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
          <div className="truncate text-[15px] font-semibold text-ink">{name}</div>
          <div className={cn("truncate text-ink-secondary", density === "compact" ? "text-xs leading-tight" : "text-[13px]")}>{line}</div>
        </div>
      </button>
    </div>
  );
}

export function JoinedRoomList({ density }: { density: SidebarDensity }) {
  const { state } = useStore();
  const rooms = useJoinedRooms(teamRoomsEnabled(state.config));
  if (!rooms.length) return null;
  return (
    <div data-joined-rooms>
      {rooms.map((room) => <JoinedRoomRow key={room.roomId} room={room} density={density} />)}
    </div>
  );
}
