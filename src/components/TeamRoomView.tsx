// The host's people-only room: the shared transcript, People, and a composer. No bot controls.
import { useMemo, useRef, useState } from "react";
import { Users } from "lucide-react";

import { CHAT_COLUMN_CLASS } from "@/lib/chat-column";
import { cn } from "@/lib/cn";
import { DRAWER_HEADER_LEFT, DRAWER_HEADER_RIGHT } from "@/lib/drawer-button";
import { useI18n } from "@/lib/i18n";
import { useOlderMessages } from "@/lib/message-pages";
import { useSidebarSide } from "@/lib/sidebar-preferences";
import { hostLines, hostRoomBase, roomPeople, type TeamRoom } from "@/lib/team-rooms";
import { Presence } from "@/lib/use-presence";
import { useStore } from "@/state/store";

import { ReconnectingCue } from "./ReconnectingCue";
import { ShowPaneButton } from "./ShowPaneButton";
import { RoomAlertsBell } from "./RoomAlertsBell";
import { TeamRoomPicture } from "./RoomPicture";
import { TeamRoomComposer, TeamRoomStatus, useTeamRoomReply } from "./TeamRoomComposer";
import { TeamRoomPeople } from "./TeamRoomPeople";
import { TeamRoomFilesMenu } from "./TeamRoomMenu";
import { TeamRoomTranscript } from "./TeamRoomRow";

export function TeamRoomView({ group }: { group: TeamRoom }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const loadOlder = useOlderMessages(dispatch, group.threadId, group.messages[0]?.id, group.hasMore);
  const sidebarOnRight = useSidebarSide() === "right";
  const [peopleOpen, setPeopleOpen] = useState(false);
  const peopleButton = useRef<HTMLButtonElement>(null);
  const lines = useMemo(() => hostLines(group.messages), [group.messages]);
  const base = hostRoomBase(group.hosted.roomId);
  const { replyTo, selectReply, clearReply } = useTeamRoomReply(base);
  const count = roomPeople(group).length;
  const missing = Boolean(group.room && "missing" in group.room);
  return (
    <main data-team-room="host" className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <Presence open={peopleOpen && !missing}>
        {(closing) => <TeamRoomPeople group={group} closing={closing} onClose={() => setPeopleOpen(false)} triggerRef={peopleButton} />}
      </Presence>
      <div className={cn("flex items-center justify-between px-5 py-3", sidebarOnRight ? DRAWER_HEADER_RIGHT : DRAWER_HEADER_LEFT)}>
        <div className="flex min-w-0 items-center gap-2.5">
          {!missing && <TeamRoomPicture key={group.id} group={group} />}
          <span className="min-w-0 truncate text-[15px] font-semibold text-ink">{group.name}</span>
        </div>
        {!missing && (
          <div className="flex shrink-0 items-center gap-1">
            <RoomAlertsBell chat={group.id} />
            <TeamRoomFilesMenu roomId={group.hosted.roomId} />
            <ShowPaneButton threadId={group.threadId} />
            <button
              ref={peopleButton}
              type="button"
              onClick={() => setPeopleOpen(true)}
              aria-label={t("teamRoom.people")}
              title={t("teamRoom.people")}
              className="flex shrink-0 items-center gap-1 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <Users size={18} />
              {count > 0 && <span className="text-[12.5px] tabular-nums">{count}</span>}
            </button>
          </div>
        )}
      </div>
      <ReconnectingCue />
      <TeamRoomTranscript key={base} lines={lines} mine={(line) => line.author.kind === "host"} base={base} label={t("chat.roomAria", { name: group.name })} hasMore={group.hasMore} loadOlder={loadOlder} people={roomPeople(group)} hostName={state.config?.profile?.name} onReply={selectReply} />
      <div className={cn("w-full shrink-0", CHAT_COLUMN_CLASS)}>
        {missing ? <TeamRoomStatus text={t("teamRoom.unavailable")} /> : <TeamRoomComposer key={group.id} name={group.name} base={base} draftId={group.id} people={roomPeople(group)} replyTo={replyTo} onClearReply={clearReply} />}
      </div>
    </main>
  );
}
