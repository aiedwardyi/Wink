// A room joined on someone else's Wink. Only its lines and files reach this screen.
import { useEffect, useMemo } from "react";

import { request } from "@/lib/api-request";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { cn } from "@/lib/cn";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { useI18n } from "@/lib/i18n";
import { useJoinedRoom } from "@/lib/joined-rooms";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { joinedLines, joinedPhase, joinedRoomBase, joinedSelection, reactInJoinedRoom, reactionNames, roomPictureUrl, setJoinedNotice } from "@/lib/team-rooms";
import { shouldClearSelectedUnread, useStore } from "@/state/store";

import { RoomAlertsBell } from "./RoomAlertsBell";
import { RoomPicture } from "./RoomPicture";
import { RoomTitle } from "./RoomTitle";
import { TeamRoomComposer, TeamRoomStatus, useTeamRoomReply } from "./TeamRoomComposer";
import { TeamRoomTranscript } from "./TeamRoomRow";

export function JoinedRoomView({ roomId }: { roomId: string }) {
  const { t } = useI18n();
  const { state } = useStore();
  const sidebarOnRight = useSidebarSide() === "right";
  const room = useJoinedRoom(roomId);
  const entries = room?.entries;
  const bots = room?.state?.bots;
  const meId = room?.me.id;
  const lines = useMemo(() => joinedLines(entries ?? [], bots, meId), [entries, bots, meId]);
  const people = room?.state?.people;
  const host = room?.state?.host;
  const names = useMemo(() => reactionNames(people ?? [], host, bots), [people, host, bots]);
  const notice = room?.state?.notice;
  const base = joinedRoomBase(roomId);
  const { replyTo, selectReply, clearReply } = useTeamRoomReply(base);
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
  const composerPeople = room?.state ? [{ id: "host", name: room.state.host }, ...room.state.people.filter((person) => person.id !== me)] : undefined;
  const joined = phase === "connecting" || phase === "live" || phase === "offline";
  const seq = entries?.at(-1)?.seq;
  useEffect(() => {
    const read = () => {
      if (seq === undefined || !shouldClearSelectedUnread(state, { id: joinedSelection(roomId), unread: Boolean(room?.unread) }, document.visibilityState === "visible" && document.hasFocus())) return;
      void request(`${base}/read`, { method: "POST", body: JSON.stringify({ seq }) }).catch(() => {});
    };
    read();
    window.addEventListener("focus", read);
    document.addEventListener("visibilitychange", read);
    return () => {
      window.removeEventListener("focus", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [base, roomId, room?.unread, seq, state.selectedId, state.workspaceOpen]);
  return (
    <main data-team-room="joined" data-team-room-phase={phase ?? "gone"} className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className={cn("flex min-h-[3.25rem] items-center justify-between px-5 py-3", sidebarOnRight ? DRAWER_HEADER_RIGHT : DRAWER_HEADER_LEFT)}>
        <RoomTitle name={name} picture={<RoomPicture src={roomPictureUrl(base, room?.state?.picture)} retry={room?.link} />} disabled={!room?.state} />
        {room && joined && <RoomAlertsBell chat={joinedSelection(roomId)} />}
      </div>
      <TeamRoomTranscript
        key={base}
        lines={lines}
        mine={(line) => line.author.kind === "person" && line.author.id === me}
        base={base}
        label={t("chat.roomAria", { name })}
        people={room?.state?.people}
        hostName={room?.state?.host}
        onReply={selectReply}
        reactionNames={names}
        onReact={room?.canReact ? (message, emoji) => void reactInJoinedRoom(roomId, message.roomEntryId ?? message.id, emoji).catch(() => {}) : undefined}
        notice={{
          entryId: notice?.entryId,
          text: room?.noticeEntry?.text ?? notice?.text,
          canUnpin: notice?.by === `person:${meId}`,
          set: room?.canReact ? (entryId) => void setJoinedNotice(roomId, entryId).catch(() => {}) : undefined,
        }}
      />
      <div className={cn("w-full shrink-0", CHAT_COLUMN_CLASS)}>
        {status === null ? <TeamRoomComposer key={roomId} name={name} base={base} draftId={`joined:${roomId}`} people={composerPeople} bots={room?.state?.bots} replyTo={replyTo} onClearReply={clearReply} /> : <TeamRoomStatus text={status} />}
      </div>
    </main>
  );
}
