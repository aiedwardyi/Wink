// A room joined on someone else's Wink. Only its lines and files reach this screen.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { request } from "@/lib/api-request";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { cn } from "@/lib/cn";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { useI18n } from "@/lib/i18n";
import { useJoinedRoom } from "@/lib/joined-rooms";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { DEFAULT_MAUS_COLOR, type MausColor } from "@/lib/mascot";
import { joinedLines, joinedPhase, joinedRoomBase, joinedSelection, reactInJoinedRoom, reactionNames, roomMessage, roomPictureUrl, setJoinedNotice } from "@/lib/team-rooms";
import { shouldClearSelectedUnread, useStore } from "@/state/store";

import { AppErrorBanner } from "./AppErrorBanner";
import { BotAvatar } from "./Avatar";
import { RoomAlertsBell } from "./RoomAlertsBell";
import { RoomPicture } from "./RoomPicture";
import { RoomTitle } from "./RoomTitle";
import { TeamRoomComposer, TeamRoomStatus, useTeamRoomReply } from "./TeamRoomComposer";
import { TeamRoomTranscript } from "./TeamRoomRow";
import { TurnPresence } from "./TurnPresence";

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
  const draftId = `joined:${roomId}`;
  const messages = useMemo(() => lines.map(roomMessage), [lines]);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useTeamRoomReply(base, draftId, messages);
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
  const myTurns = (status === null ? myBots ?? [] : []).map((bot) => {
    const listed = teamBots?.find((candidate) => candidate.id === bot.id);
    return { ...bot, name: listed?.name ?? "", color: (listed?.color || DEFAULT_MAUS_COLOR) as MausColor };
  });
  const working = myTurns.some((bot) => bot.working);
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
        empty={entries && room?.state ? { name, members: [room.state.host, ...room.state.people.map((person) => person.name)], picture: roomPictureUrl(base, room.state.picture), retry: room.link } : undefined}
        presence={myTurns.map((bot) => (
          <TurnPresence
            key={bot.id}
            avatar={<BotAvatar bot={state.bots.find((local) => local.id === bot.botId) ?? { name: bot.name, color: bot.color }} state="thinking" size={36} forward={false} lookAround={1} trackPointer={false} />}
            visible={Boolean(bot.working)}
            label={t("teamRoom.botWorking", { name: bot.name })}
            since={bot.since}
          />
        ))}
      />
      <div className={cn("w-full shrink-0", CHAT_COLUMN_CLASS)}>
        {joined ? (
          <>
            {status !== null && <div role="status" className="mb-2 px-5 text-center text-[13px] text-ink-secondary">{status}</div>}
            <TeamRoomComposer
              key={roomId}
              name={name}
              base={base}
              draftId={draftId}
              people={composerPeople}
              bots={bots}
              replyTo={replyTo}
              onClearReply={clearReply}
              onConsumeReply={consumeReply}
              onRestoreReply={restoreReply}
              offline={phase !== "live"}
              status={myTurns.flatMap((bot) => bot.waiting ? [{ id: bot.id, text: t("teamRoom.botBusy", { name: bot.name }) }] : bot.error ? [{ id: bot.id, text: t("teamRoom.botFailed", { name: bot.name }), failed: true }] : [])}
              onStop={working ? () => void request(`${base}/stop`, { method: "POST" }).catch(() => {}) : undefined}
            />
          </>
        ) : <TeamRoomStatus text={status ?? ""} />}
      </div>
    </main>
  );
}
