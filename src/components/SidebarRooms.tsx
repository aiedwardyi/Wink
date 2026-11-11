import { useEffect, useState, type ComponentProps } from "react";

import { useI18n } from "@/lib/i18n";
import { useJoinedRooms } from "@/lib/joined-rooms";
import { loadJoinedRoomLayout, ROOM_LAYOUT_EVENT, saveJoinedRoomLayout, type JoinedRoomLayout } from "@/lib/sidebar-order";
import { joinedPhase, joinedRoomIdOf, joinedSelection } from "@/lib/team-rooms";
import { useStore, type Group } from "@/state/store";

import { GroupListItem } from "./SidebarConversations";

export function useSidebarRooms() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const rooms = useJoinedRooms();
  const [layout, setLayout] = useState(loadJoinedRoomLayout);
  useEffect(() => {
    const changed = (event: Event) => setLayout((event as CustomEvent<JoinedRoomLayout>).detail);
    window.addEventListener(ROOM_LAYOUT_EVENT, changed);
    return () => window.removeEventListener(ROOM_LAYOUT_EVENT, changed);
  }, []);
  // Sidebar models only; joined rooms never enter the application store.
  const groups: Group[] = rooms.map((room) => {
    const phase = joinedPhase(room);
    const preview = phase === "removed" ? t("teamRoom.removed") : phase === "left" ? t("teamRoom.left") : room.state?.host ?? "";
    return {
      id: joinedSelection(room.roomId), threadId: joinedSelection(room.roomId),
      name: room.state?.roomName ?? "", memberIds: [], messages: [], bulletin: preview, createdAt: 0, unread: false,
      defaultResponder: { kind: "everyone" }, ...layout[room.roomId],
    };
  });
  return {
    state: { ...state, groups: [...state.groups, ...groups] },
    dispatch: ((action) => {
      const id = action.type === "patchGroup" ? joinedRoomIdOf(action.groupId) : null;
      if (id && action.type === "patchGroup") {
        const next = { ...layout, [id]: { ...layout[id], ...action.patch } };
        setLayout(next);
        saveJoinedRoomLayout(next);
      } else dispatch(action);
    }) as typeof dispatch,
  };
}

export function SidebarGroupListItem(props: ComponentProps<typeof GroupListItem>) {
  const joined = joinedRoomIdOf(props.group.id) !== null;
  return <GroupListItem {...props} joined={joined} preview={joined ? props.group.bulletin : undefined} />;
}
