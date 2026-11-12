// A room joined on someone else's Wink. Only its lines and files reach this screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LogOut, Users } from "lucide-react";

import { request } from "@/lib/api-request";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { cn } from "@/lib/cn";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { useI18n } from "@/lib/i18n";
import { useJoinedRoom } from "@/lib/joined-rooms";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { joinedLines, joinedPhase, joinedRoomBase, joinedSelection, reactInJoinedRoom, reactionNames, roomPictureUrl, setJoinedNotice } from "@/lib/team-rooms";
import { Presence } from "@/lib/use-presence";
import { shouldClearSelectedUnread, useStore } from "@/state/store";

import { ConfirmDialog } from "./ConfirmDialog";
import { RoomAlertsBell } from "./RoomAlertsBell";
import { RoomPicture } from "./RoomPicture";
import { TeamRoomComposer, TeamRoomStatus, useTeamRoomReply } from "./TeamRoomComposer";
import { TeamRoomPeople } from "./TeamRoomPeople";
import { TeamRoomTranscript } from "./TeamRoomRow";

const PAGE = 200;

export function JoinedRoomView({ roomId }: { roomId: string }) {
  const { t } = useI18n();
  const { state } = useStore();
  const sidebarOnRight = useSidebarSide() === "right";
  const [limit, setLimit] = useState(PAGE);
  const beforeOlder = useRef<(() => void) | null>(null);
  const paging = useRef<number | null>(null);
  const room = useJoinedRoom(roomId, limit, beforeOlder);
  const [leaving, setLeaving] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const peopleButton = useRef<HTMLButtonElement>(null);
  const entries = room?.entries;
  const first = entries?.[0]?.seq;
  const loadOlder = useCallback((beforeCommit: () => void) => {
    // Held per oldest row, so a scroll before the bigger page lands asks once; nothing more stops it.
    if (first === undefined || paging.current === first) return;
    paging.current = first;
    void request(`${joinedRoomBase(roomId)}/older`, { method: "POST", body: JSON.stringify({ before: first }) })
      .then(({ more }) => {
        if (!more) return;
        beforeOlder.current = beforeCommit;
        setLimit((shown) => shown + PAGE);
      })
      .catch(() => { paging.current = null; });
  }, [roomId, first]);
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
    : phase === "left" ? t(room?.gone ? "teamRoom.gone" : "teamRoom.left")
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
        <div className="flex min-w-0 items-center gap-2.5">
          <RoomPicture src={roomPictureUrl(base, room?.state?.picture)} retry={room?.link} />
          <span className="min-w-0 truncate text-[15px] font-semibold text-ink">{name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {room?.state && <button ref={peopleButton} type="button" onClick={() => setPeopleOpen(true)} aria-label={t("teamRoom.people")} title={t("teamRoom.people")} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><Users size={18} /></button>}
          {room && joined && (
            <>
              <RoomAlertsBell chat={joinedSelection(roomId)} />
              <button
                type="button"
                onClick={() => setLeaving(true)}
                aria-label={t("teamRoom.leave")}
                title={t("teamRoom.leave")}
                className="flex shrink-0 items-center rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <LogOut size={18} />
              </button>
            </>
          )}
        </div>
      </div>
      <TeamRoomTranscript
        key={base}
        lines={lines}
        hasMore={Boolean(room?.hasMore)}
        loadOlder={loadOlder}
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
        {joined ? (
          <>
            {status !== null && <div role="status" className="mb-2 px-5 text-center text-[13px] text-ink-secondary">{status}</div>}
            <TeamRoomComposer key={roomId} name={name} base={base} draftId={`joined:${roomId}`} people={composerPeople} bots={room?.state?.bots} replyTo={replyTo} onClearReply={clearReply} offline={phase !== "live"} />
          </>
        ) : <TeamRoomStatus text={status ?? ""} />}
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
