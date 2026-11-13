// A room joined on someone else's Wink. Only its lines and files reach this screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { request } from "@/lib/api-request";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { cn } from "@/lib/cn";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { useI18n } from "@/lib/i18n";
import { useJoinedRoom } from "@/lib/joined-rooms";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { joinedLines, joinedPhase, joinedRoomBase, joinedSelection, reactInJoinedRoom, reactionNames, roomPictureUrl, setJoinedNotice } from "@/lib/team-rooms";
import { shouldClearSelectedUnread, useStore } from "@/state/store";

import { AppErrorBanner } from "./AppErrorBanner";
import { RoomAlertsBell } from "./RoomAlertsBell";
import { RoomPicture } from "./RoomPicture";
import { RoomTitle } from "./RoomTitle";
import { TeamRoomComposer, TeamRoomStatus, useTeamRoomReply } from "./TeamRoomComposer";
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
  const entries = room?.entries;
  const hostBots = room?.state?.bots;
  const teamBots = room?.state?.teamBots;
  // Tags include every room bot; routing still enforces ownership.
  const bots = useMemo(() => (teamBots?.length ? [...(hostBots ?? []), ...teamBots] : hostBots), [hostBots, teamBots]);
  const myBots = room?.myBots;
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
        <RoomTitle name={name} picture={<RoomPicture src={roomPictureUrl(base, room?.state?.picture)} retry={room?.link} />} disabled={!room?.state} />
        {room && joined && <RoomAlertsBell chat={joinedSelection(roomId)} />}
      </div>
      <AppErrorBanner />
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
            {status === null && myBots?.map((bot) => {
              const botName = teamBots?.find((candidate) => candidate.id === bot.id)?.name ?? "";
              const text = bot.waiting ? t("teamRoom.botBusy", { name: botName }) : bot.working ? t("teamRoom.botWorking", { name: botName }) : bot.error ? t("teamRoom.botFailed", { name: botName }) : null;
              return text && <p key={bot.id} data-my-bot-turn role="status" className={cn("px-5 pb-1 text-[12.5px]", bot.error ? "text-danger" : "text-ink-secondary")}>{text}</p>;
            })}
            <TeamRoomComposer key={roomId} name={name} base={base} draftId={`joined:${roomId}`} people={composerPeople} bots={bots} replyTo={replyTo} onClearReply={clearReply} offline={phase !== "live"} />
          </>
        ) : <TeamRoomStatus text={status ?? ""} />}
      </div>
    </main>
  );
}
