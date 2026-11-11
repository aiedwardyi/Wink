// Rooms this PC joined on someone else's Wink, after the sidebar's own chats.
import { Users } from "lucide-react";

import { cn } from "@/lib/cn";
import { localeTag, useI18n } from "@/lib/i18n";
import { useJoinedRooms } from "@/lib/joined-rooms";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { joinedPhase, joinedSelection, type JoinedView } from "@/lib/team-rooms";
import { formatTime, useStore } from "@/state/store";

import { UnreadCountBadge } from "./SidebarConversations";

function JoinedRoomRow({ room, density }: { room: JoinedView; density: SidebarDensity }) {
  const { t, locale } = useI18n();
  const { state, dispatch } = useStore();
  const id = joinedSelection(room.roomId);
  const selected = state.selectedId === id;
  const name = room.state?.roomName ?? "";
  const phase = joinedPhase(room);
  const last = room.lastEntry;
  const line = phase === "removed" ? t("teamRoom.removed") : phase === "left" ? t("teamRoom.left") : last ? t(last.author.kind === "person" && last.author.id === room.me.id ? "chrome.youPrefix" : "chrome.speakerPrefix", {
    name: last.author.name, text: last.text || last.files?.map((file) => file.name).join(", ") || "",
  }) : (room.state?.host ?? "");
  return (
    <div className="group relative min-h-12 py-0.5" data-sidebar-row data-joined-room-row title={density === "icons" ? name : undefined}>
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
        <span className={cn("relative flex shrink-0 items-center justify-center", density === "compact" ? "size-8" : "size-12")}>
          <Users size={24} className="text-ink-secondary" />
          <UnreadCountBadge count={room.unread ?? 0} selected={selected} />
        </span>
        <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
          <div className="flex min-w-0 items-baseline gap-2 overflow-hidden">
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{name}</span>
            {last && <span className="shrink-0 text-xs text-ink-secondary">{formatTime(last.at, localeTag(locale))}</span>}
          </div>
          <div className={cn("truncate text-ink-secondary", density === "compact" ? "text-xs leading-tight" : "text-[13px]")}>{line}</div>
        </div>
      </button>
    </div>
  );
}

export function JoinedRoomList({ density }: { density: SidebarDensity }) {
  const rooms = useJoinedRooms();
  if (!rooms.length) return null;
  return (
    <div data-joined-rooms>
      {rooms.map((room) => <JoinedRoomRow key={room.roomId} room={room} density={density} />)}
    </div>
  );
}
