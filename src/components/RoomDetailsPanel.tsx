// Room details: People, Bots and the room itself, in the slot and look of Bot details.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, LogOut, Pencil, X } from "lucide-react";

import { request } from "@/lib/api-request";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { useLoadedJoinedRooms } from "@/lib/joined-rooms";
import { hapticTick } from "@/lib/phone-swipe";
import { nextRename } from "@/lib/rename";
import { nextBulletin } from "@/lib/room-bulletin";
import { useRoomDetailsTarget, type RoomDetailsSection } from "@/lib/room-details";
import { isTeamRoom, joinedRoomBase, joinedSelection, roomPeople, roomPictureUrl, roomTeamBots, type TeamRoom } from "@/lib/team-rooms";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { Presence } from "@/lib/use-presence";
import { useSettingsSwipe } from "@/lib/use-settings-swipe";
import { useStore, type Group } from "@/state/store";

import { DETAILS_BOX, DETAILS_INPUT, DETAILS_ROW, FitTextarea, SwitchRow } from "./BotDetailsRows";
import { ConfirmDialog } from "./ConfirmDialog";
import { RenameActions } from "./RenameActions";
import { useRoomAlerts } from "./RoomAlertsBell";
import { RoomDetailsBots } from "./RoomDetailsBots";
import { HostPeople, JoinedPeople } from "./RoomDetailsPeople";
import { RoomFolderRow, SearchChatRow } from "./RoomDetailsRows";
import { RoomPicture, TeamRoomPicture } from "./RoomPicture";
import { SaveStatus } from "./SaveStatus";
import { JoinedBots } from "./RoomTeamBots";
import { trackFeature } from "@/lib/usage-stats";

const hostedRoom = (group: Group): group is TeamRoom => Boolean(group.hosted);

export function RoomDetailsPanel({ group, joinedId, closing = false }: { group?: Group; joinedId?: string; closing?: boolean }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const phone = useIsPhone();
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocusOnClose = useRef(false);
  const sections = useRef<Partial<Record<RoomDetailsSection, HTMLElement | null>>>({});
  const target = useRoomDetailsTarget();
  const joined = useLoadedJoinedRooms().find((room) => room.roomId === joinedId);

  const close = () => {
    restoreFocusOnClose.current = true;
    dispatch({ type: "toggleSettings", open: false });
  };
  useSettingsSwipe(panelRef, phone && !closing, false, () => {
    hapticTick();
    if (panelRef.current) panelRef.current.style.animation = "none";
    close();
  });

  useEffect(() => {
    sections.current[target.section]?.scrollIntoView({ block: "start" });
  }, [target.nonce]);

  useEffect(() => {
    if (closing) return;
    restoreFocusOnClose.current = false;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
      event.preventDefault();
      restoreFocusOnClose.current = true;
      dispatch({ type: "toggleSettings", open: false });
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      if (!restoreFocusOnClose.current) return;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active !== document.body && !panelRef.current?.contains(active)) return;
        if (previousFocus?.isConnected) previousFocus.focus();
      });
    };
  }, [closing, dispatch]);

  const section = (id: RoomDetailsSection | "leave", label: string, children: ReactNode, titled = true) => (
    <section ref={(node) => void (id !== "leave" && (sections.current[id] = node))} data-room-details-section={id} aria-label={label} className="scroll-mt-4">
      {titled && <h3 className="mb-1.5 px-1 text-[12.5px] font-medium text-ink-secondary">{label}</h3>}
      {children}
    </section>
  );

  return (
    <aside ref={panelRef} data-room-details="" data-side-panel="" data-closing={closing || undefined} inert={closing} className="max-md:animate-panel-in md:animate-panel-slide relative z-20 flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel [&_:is(button:not(:disabled),summary)]:cursor-pointer md:data-closing:-ml-[400px] max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30 max-md:w-full">
      <div className="flex items-center justify-between px-4 py-3">
        <button onClick={close} aria-label={t("room.collapseDetails")} title={t("room.collapseDetails")} className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink">
          <ChevronRight size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">{t("room.details")}</span>
        <button onClick={close} aria-label={t("room.closeDetails")} title={t("room.closeDetails")} className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink">
          <X size={18} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5 pt-2">
        {group ? (
          <>
            {section("room", t("room.section"), <HostRoom group={group} phone={phone} />, false)}
            {!group.dm && section("people", `${t("teamRoom.people")} (${1 + roomPeople(group).length})`, <HostPeople group={group} />)}
            {!group.dm && section("bots", `${t("chrome.bots")} (${group.memberIds.length + roomTeamBots(group).length})`, <RoomDetailsBots group={group} />)}
          </>
        ) : joined && (
          <>
            {section("room", t("room.section"), <JoinedRoom roomId={joined.roomId} name={joined.state?.roomName ?? ""} picture={roomPictureUrl(joinedRoomBase(joined.roomId), joined.state?.picture)} retry={joined.link} canLeave={joined.status === "joined"} />, false)}
            {joined.state && section("people", `${t("teamRoom.people")} (${1 + joined.state.people.length})`, <JoinedPeople room={joined} />)}
            {joined.state?.teamBots && section("bots", `${t("chrome.bots")} (${(joined.state.bots?.length ?? 0) + joined.state.teamBots.length})`, <JoinedBots room={joined} />)}
            {joined.status === "joined" && section("leave", t("teamRoom.leave"), <LeaveRoom roomId={joined.roomId} name={joined.state?.roomName ?? ""} />, false)}
          </>
        )}
      </div>
    </aside>
  );
}

function HostRoom({ group, phone }: { group: Group; phone: boolean }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [name, setName] = useState<string | null>(null);
  const [bulletin, setBulletin] = useState(group.bulletin);
  const editing = useRef(false);
  const unsaved = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // an open draft outranks an incoming patch: resyncing under the cursor loses the edit
  useEffect(() => void (!editing.current && setBulletin(group.bulletin)), [group.bulletin]);
  // a close can unmount without a blur, so the last keystrokes go out here
  useEffect(() => () => saveBulletin(), []);
  const saveName = () => {
    const next = name === null ? null : nextRename(group.name, name);
    if (next) dispatch({ type: "patchGroup", groupId: group.id, patch: { name: next } });
    setName(null);
  };
  const saveBulletin = () => {
    clearTimeout(timer.current);
    if (unsaved.current !== null) dispatch({ type: "patchGroup", groupId: group.id, patch: { bulletin: unsaved.current } });
    unsaved.current = null;
  };
  const editBulletin = (text: string) => {
    setBulletin(text);
    unsaved.current = nextBulletin(group.bulletin, text);
    clearTimeout(timer.current);
    if (unsaved.current !== null) timer.current = setTimeout(saveBulletin, 400);
  };
  const leaveBulletin = () => {
    editing.current = false;
    if (unsaved.current !== null) saveBulletin();
    else setBulletin(group.bulletin);
  };
  return (
    <>
      <div className="flex items-center gap-3 px-1">
        {hostedRoom(group) && <TeamRoomPicture group={group} size={48} />}
        {name === null ? (
          <>
            <span className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">{group.name}</span>
            <button type="button" onClick={() => setName(group.name)} aria-label={t("rename.aria")} title={t("rename.aria")} className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink">
              <Pencil size={15} />
            </button>
          </>
        ) : (
          <>
            <input
              autoFocus
              aria-label={t("bot.name")}
              className={DETAILS_INPUT}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") saveName();
                if (event.key === "Escape") {
                  event.preventDefault();
                  setName(null);
                }
              }}
            />
            <RenameActions onSave={saveName} onCancel={() => setName(null)} />
          </>
        )}
      </div>
      <div className={cn(DETAILS_BOX, "mt-4")}>
        <div className={DETAILS_ROW}>
          <div className="relative mb-1.5 text-[14px] font-medium text-ink">
            {t("room.bulletinTitle")}
            <SaveStatus id={group.id} />
          </div>
          <FitTextarea
            rows={1}
            aria-label={t("room.bulletinTitle")}
            className={DETAILS_INPUT}
            placeholder={t("room.instructionsHint")}
            value={bulletin}
            onFocus={() => (editing.current = true)}
            onChange={(event) => editBulletin(event.target.value)}
            onBlur={leaveBulletin}
          />
        </div>
        {!group.dm && group.memberIds.length > 0 && <RoomFolderRow group={group} />}
        <AlertsRow chat={group.id} />
        {phone && !isTeamRoom(group) && <SearchChatRow />}
      </div>
    </>
  );
}

function JoinedRoom({ roomId, name, picture, retry, canLeave }: { roomId: string; name: string; picture?: string; retry?: unknown; canLeave: boolean }) {
  return (
    <>
      <div className="flex items-center gap-3 px-1">
        <RoomPicture src={picture} size={48} retry={retry} />
        <span className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">{name}</span>
      </div>
      {canLeave && <div className={cn(DETAILS_BOX, "mt-4")}><AlertsRow chat={joinedSelection(roomId)} /></div>}
    </>
  );
}

function LeaveRoom({ roomId, name }: { roomId: string; name: string }) {
  const { t } = useI18n();
  const [leaving, setLeaving] = useState(false);
  return (
    <>
      <div className={DETAILS_BOX}>
        <button type="button" onClick={() => setLeaving(true)} className={cn(DETAILS_ROW, "flex w-full items-center gap-2 text-left text-[14px] text-danger hover:bg-danger/5")}>
          <LogOut size={16} />
          {t("teamRoom.leave")}
        </button>
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
              trackFeature("room.leave");
              void request(`${joinedRoomBase(roomId)}/leave`, { method: "POST" }).catch(() => {});
            }}
          />
        )}
      </Presence>
    </>
  );
}

function AlertsRow({ chat }: { chat: string }) {
  const { t } = useI18n();
  const { on, toggle } = useRoomAlerts(chat);
  return <SwitchRow label={t("room.alerts")} aria={t(on ? "teamRoom.alertsOff" : "teamRoom.alertsOn")} on={on} onToggle={toggle} />;
}
