// Room details: People, Bots and the room itself, in the slot and look of Bot details.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, LogOut, X } from "lucide-react";

import { request } from "@/lib/api-request";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { useLoadedJoinedRooms } from "@/lib/joined-rooms";
import { hapticTick } from "@/lib/phone-swipe";
import { nextRename } from "@/lib/rename";
import { nextBulletin } from "@/lib/room-bulletin";
import { useRoomDetailsTarget, type RoomDetailsSection } from "@/lib/room-details";
import { joinedRoomBase, joinedSelection, roomPictureUrl, type TeamRoom } from "@/lib/team-rooms";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { Presence } from "@/lib/use-presence";
import { useSettingsSwipe } from "@/lib/use-settings-swipe";
import { useStore, type Group } from "@/state/store";

import { DETAILS_BOX, DETAILS_INPUT, DETAILS_ROW, FitTextarea, SwitchRow } from "./BotDetailsRows";
import { ConfirmDialog } from "./ConfirmDialog";
import { useRoomAlerts } from "./RoomAlertsBell";
import { RoomDetailsBots } from "./RoomDetailsBots";
import { HostPeople, JoinedPeople } from "./RoomDetailsPeople";
import { RoomPicture, TeamRoomPicture } from "./RoomPicture";

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

  const section = (id: RoomDetailsSection, label: string, children: ReactNode) => (
    <section ref={(node) => void (sections.current[id] = node)} data-room-details-section={id} aria-label={label} className="scroll-mt-4">
      <h3 className="mb-1.5 px-1 text-[12.5px] font-medium text-ink-secondary">{label}</h3>
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
            {section("people", t("teamRoom.people"), <HostPeople group={group} />)}
            {!group.dm && section("bots", t("chrome.bots"), <RoomDetailsBots group={group} />)}
            {section("room", t("room.section"), <HostRoom group={group} />)}
          </>
        ) : joined && (
          <>
            {joined.state && section("people", t("teamRoom.people"), <JoinedPeople room={joined} />)}
            {section("room", t("room.section"), <JoinedRoom roomId={joined.roomId} name={joined.state?.roomName ?? ""} picture={roomPictureUrl(joinedRoomBase(joined.roomId), joined.state?.picture)} retry={joined.link} canLeave={joined.status === "joined"} />)}
          </>
        )}
      </div>
    </aside>
  );
}

function HostRoom({ group }: { group: Group }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [name, setName] = useState(group.name);
  const [bulletin, setBulletin] = useState(group.bulletin);
  const editing = useRef<"name" | "bulletin" | null>(null);
  // an open draft outranks an incoming patch: resyncing under the cursor loses the edit
  useEffect(() => void (editing.current !== "name" && setName(group.name)), [group.name]);
  useEffect(() => void (editing.current !== "bulletin" && setBulletin(group.bulletin)), [group.bulletin]);
  const saveName = () => {
    editing.current = null;
    const next = nextRename(group.name, name);
    if (next) dispatch({ type: "patchGroup", groupId: group.id, patch: { name: next } });
    else setName(group.name);
  };
  const saveBulletin = () => {
    editing.current = null;
    const next = nextBulletin(group.bulletin, bulletin);
    if (next !== null) dispatch({ type: "patchGroup", groupId: group.id, patch: { bulletin: next } });
  };
  return (
    <div className={cn(DETAILS_BOX, "overflow-visible")}>
      <div className={cn(DETAILS_ROW, "flex items-center gap-3")}>
        {hostedRoom(group) && <TeamRoomPicture group={group} />}
        <input
          aria-label={t("bot.name")}
          className={DETAILS_INPUT}
          value={name}
          onFocus={() => (editing.current = "name")}
          onChange={(event) => setName(event.target.value)}
          onBlur={saveName}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();
          }}
        />
      </div>
      <label className={cn(DETAILS_ROW, "block")}>
        <div className="mb-1.5 text-[14px] font-medium text-ink">{t("room.bulletinTitle")}</div>
        <FitTextarea
          className={cn(DETAILS_INPUT, "min-h-[72px]")}
          placeholder={t("room.bulletinPlaceholder")}
          value={bulletin}
          onFocus={() => (editing.current = "bulletin")}
          onChange={(event) => setBulletin(event.target.value)}
          onBlur={saveBulletin}
        />
      </label>
      {group.hosted && <AlertsRow chat={group.id} />}
    </div>
  );
}

function JoinedRoom({ roomId, name, picture, retry, canLeave }: { roomId: string; name: string; picture?: string; retry?: unknown; canLeave: boolean }) {
  const { t } = useI18n();
  const [leaving, setLeaving] = useState(false);
  return (
    <>
      <div className={DETAILS_BOX}>
        <div className={cn(DETAILS_ROW, "flex items-center gap-3")}>
          <RoomPicture src={picture} retry={retry} />
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{name}</span>
        </div>
        {canLeave && <AlertsRow chat={joinedSelection(roomId)} />}
        {canLeave && (
          <button type="button" onClick={() => setLeaving(true)} className={cn(DETAILS_ROW, "flex w-full items-center gap-2 text-left text-[14px] text-danger hover:bg-danger/5")}>
            <LogOut size={16} />
            {t("teamRoom.leave")}
          </button>
        )}
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
