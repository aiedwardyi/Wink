// The host's people-only room: the shared transcript and a composer; Room details holds People and Bots.
import { useMemo } from "react";

import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { cn } from "@/lib/cn";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { useI18n } from "@/lib/i18n";
import { useOlderMessages } from "@/lib/message-pages";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { hostLines, hostRoomBase, reactionNames, roomNoticeText, roomPeople, roomPictureUrl, roomTeamBots, setHostNotice, type TeamRoom } from "@/lib/team-rooms";
import { useStore } from "@/state/store";

import { AppErrorBanner } from "./AppErrorBanner";
import { ReconnectingCue } from "./ReconnectingCue";
import { ShowPaneButton } from "./ShowPaneButton";
import { RoomAlertsBell } from "./RoomAlertsBell";
import { RoomPicture } from "./RoomPicture";
import { RoomTitle } from "./RoomTitle";
import { TeamRoomComposer, TeamRoomStatus, useTeamRoomReply } from "./TeamRoomComposer";
import { TeamRoomTranscript } from "./TeamRoomRow";

export function TeamRoomView({ group }: { group: TeamRoom }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const loadOlder = useOlderMessages(dispatch, group.threadId, group.messages[0]?.id, group.hasMore);
  const sidebarOnRight = useSidebarSide() === "right";
  const lines = useMemo(() => hostLines(group.messages), [group.messages]);
  const base = hostRoomBase(group.hosted.roomId);
  const { replyTo, selectReply, clearReply } = useTeamRoomReply(base);
  const names = useMemo(() => reactionNames(roomPeople(group)), [group]);
  const noticeEntry = group.notice?.entryId;
  const missing = Boolean(group.room && "missing" in group.room);
  return (
    <main data-team-room="host" className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <div className={cn("flex items-center justify-between px-5 py-3", sidebarOnRight ? DRAWER_HEADER_RIGHT : DRAWER_HEADER_LEFT)}>
        <RoomTitle name={group.name} picture={!missing && <RoomPicture key={group.id} src={roomPictureUrl(base, group.picture)} />} disabled={missing} />
        {!missing && (
          <div className="flex shrink-0 items-center gap-1">
            <RoomAlertsBell chat={group.id} />
            <ShowPaneButton threadId={group.threadId} />
          </div>
        )}
      </div>
      <AppErrorBanner />
      <ReconnectingCue />
      <TeamRoomTranscript key={base} lines={lines} mine={(line) => line.author.kind === "host"} base={base} label={t("chat.roomAria", { name: group.name })} hasMore={group.hasMore} loadOlder={loadOlder} people={roomPeople(group)} hostName={state.config?.profile?.name} onReply={selectReply}
        reactionNames={names}
        onReact={(message, emoji) => dispatch({ type: "toggleReaction", threadId: group.threadId, messageId: message.id, emoji, message })}
        notice={{ entryId: noticeEntry, text: roomNoticeText(group), canUnpin: true, set: (entryId) => void setHostNotice(group.id, entryId).catch(() => {}) }}
      />
      <div className={cn("w-full shrink-0", CHAT_COLUMN_CLASS)}>
        {missing ? <TeamRoomStatus text={t("teamRoom.unavailable")} /> : <TeamRoomComposer key={group.id} name={group.name} base={base} draftId={group.id} people={roomPeople(group)} bots={roomTeamBots(group)} replyTo={replyTo} onClearReply={clearReply} />}
      </div>
    </main>
  );
}
