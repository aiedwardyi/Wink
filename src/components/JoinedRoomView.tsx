// A room joined on someone else's Wink. Only its lines and files reach this screen.
import { useMemo, useRef, useState } from "react";
import { LogOut, Users } from "lucide-react";

import { request } from "@/lib/api-request";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { cn } from "@/lib/cn";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { useI18n } from "@/lib/i18n";
import { useJoinedRoom } from "@/lib/joined-rooms";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { joinedLines, joinedPhase, joinedRoomBase } from "@/lib/team-rooms";
import { Presence } from "@/lib/use-presence";

import { ConfirmDialog } from "./ConfirmDialog";
import { TeamRoomComposer, TeamRoomStatus } from "./TeamRoomComposer";
import { TeamRoomPeople } from "./TeamRoomPeople";
import { TeamRoomTranscript } from "./TeamRoomRow";

export function JoinedRoomView({ roomId }: { roomId: string }) {
  const { t } = useI18n();
  const sidebarOnRight = useSidebarSide() === "right";
  const room = useJoinedRoom(roomId);
  const [leaving, setLeaving] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const peopleButton = useRef<HTMLButtonElement>(null);
  const entries = room?.entries;
  const lines = useMemo(() => joinedLines(entries ?? []), [entries]);
  const base = joinedRoomBase(roomId);
  const name = room?.state?.roomName ?? "";
  const phase = room ? joinedPhase(room) : room === null ? null : "connecting";
  const status =
    phase === null ? t("teamRoom.gone")
    : phase === "connecting" ? t("teamRoom.connecting")
    : phase === "offline" ? t("teamRoom.offline", { host: room?.state?.host ?? "" })
    : phase === "removed" ? t("teamRoom.removed")
    : phase === "left" ? t("teamRoom.left")
    : null;
  const me = room?.me.id;
  const joined = phase === "connecting" || phase === "live" || phase === "offline";
  return (
    <main data-team-room="joined" data-team-room-phase={phase ?? "gone"} className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className={cn("flex min-h-[3.25rem] items-center justify-between px-5 py-3", sidebarOnRight ? DRAWER_HEADER_RIGHT : DRAWER_HEADER_LEFT)}>
        <span className="min-w-0 truncate text-[15px] font-semibold text-ink">{name}</span>
        <div className="flex shrink-0 items-center gap-1">
          {room?.state && <button ref={peopleButton} type="button" onClick={() => setPeopleOpen(true)} aria-label={t("teamRoom.people")} title={t("teamRoom.people")} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><Users size={18} /></button>}
        {room && joined && (
          <button
            type="button"
            onClick={() => setLeaving(true)}
            aria-label={t("teamRoom.leave")}
            title={t("teamRoom.leave")}
            className="flex shrink-0 items-center rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <LogOut size={18} />
          </button>
        )}
        </div>
      </div>
      <TeamRoomTranscript
        lines={lines}
        mine={(line) => line.author.kind === "person" && line.author.id === me}
        base={base}
        label={t("chat.roomAria", { name })}
        people={room?.state?.people}
        hostName={room?.state?.host}
      />
      <div className={cn("w-full shrink-0", CHAT_COLUMN_CLASS)}>
        {status === null ? <TeamRoomComposer key={roomId} name={name} base={base} draftId={`joined:${roomId}`} /> : <TeamRoomStatus text={status} />}
      </div>
      <Presence open={leaving}>
        {(closing) => (
          <ConfirmDialog
            closing={closing}
            title={t("teamRoom.leaveTitle", { name })}
            body={t("teamRoom.leaveBody")}
            confirmLabel={t("teamRoom.leave")}
            onCancel={() => setLeaving(false)}
            onConfirm={() => {
              setLeaving(false);
              void request(`${base}/leave`, { method: "POST" }).catch(() => {});
            }}
          />
        )}
      </Presence>
      <Presence open={peopleOpen && Boolean(room?.state)}>
        {(closing) => <TeamRoomPeople joined={room!} closing={closing} onClose={() => setPeopleOpen(false)} triggerRef={peopleButton} />}
      </Presence>
    </main>
  );
}
