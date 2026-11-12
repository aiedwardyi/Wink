// People can edit their own Wink name; the host also has Invite, Remove and Let back in.
import { useEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { inviteErrorKey, inviteToRoom, letBackIn, removeFromRoom, roomPeople, roomRemoved, roomTeamBots, type JoinedView, type RoomInviteCode, type TeamRoom } from "@/lib/team-rooms";
import { useBackLayer } from "@/lib/use-back-layer";
import { usePresence } from "@/lib/use-presence";
import { useStore } from "@/state/store";

import { ConfirmDialog } from "./ConfirmDialog";
import { RoomCode } from "./RoomCode";
import { RoomOwnName } from "./RoomOwnName";
import { MyRoomBots, TeammateBots } from "./RoomTeamBots";

export function TeamRoomPeople({ group, joined, closing = false, onClose, triggerRef }: {
  group?: TeamRoom;
  joined?: JoinedView;
  closing?: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const [code, setCode] = useState<RoomInviteCode | null>(null);
  const [codeVersion, setCodeVersion] = useState(0);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [codeChanged, setCodeChanged] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const confirm = usePresence(removing);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const roomId = group?.hosted.roomId;
  const people = group ? roomPeople(group) : joined?.state?.people ?? [];
  const removed = group ? roomRemoved(group) : [];
  useBackLayer(!closing, onClose);

  useEffect(() => {
    if (closing || !roomId) return;
    setCode(null);
    let alive = true;
    void inviteToRoom(roomId).then((result) => {
      if (!alive) return;
      if ("code" in result) setCode(result);
      else setProblem(inviteErrorKey(result.status));
    });
    return () => {
      alive = false;
    };
  }, [closing, roomId, codeVersion]);

  useEffect(() => {
    if (closing) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
    dialog.querySelector<HTMLElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return event.preventDefault();
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => {
      dialog.removeEventListener("keydown", onKey);
      triggerRef.current?.focus();
    };
  }, [closing, triggerRef]);

  const remove = async (gone: { id: string; name: string }) => {
    const room = group?.room && "people" in group.room ? group.room : null;
    if (!room || !group || !roomId) return;
    try {
      const result = await removeFromRoom(roomId, gone.id);
      setCodeVersion((version) => version + 1);
      if (result.codeChanged) setCodeChanged(true);
      const barred = [...(room.removed ?? []).filter((person) => person.id !== gone.id), ...(result.codeChanged ? [] : [gone])];
      dispatch({ type: "groupPatched", group: { id: group.id, room: { ...room, people: room.people.filter((person) => person.id !== gone.id), removed: barred } } });
    } catch {
      setProblem("errors.request");
    }
  };

  const letBack = async (personId: string) => {
    const room = group?.room && "people" in group.room ? group.room : null;
    if (!room || !group || !roomId) return;
    try {
      await letBackIn(roomId, personId);
      dispatch({ type: "groupPatched", group: { id: group.id, room: { ...room, removed: (room.removed ?? []).filter((person) => person.id !== personId) } } });
    } catch {
      setProblem("errors.request");
    }
  };

  return (
    <div
      data-closing={closing || undefined}
      inert={closing}
      className="animate-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role={closing ? undefined : "dialog"}
        aria-modal={!closing || undefined}
        aria-label={t("teamRoom.people")}
        className="animate-pop-in w-[340px] max-w-[calc(100vw-2rem)] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl"
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="text-[15px] font-semibold text-ink">{t("teamRoom.people")}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("chat.dismiss")}
            title={t("chat.dismiss")}
            className="flex size-7 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
        <div className="mb-3 truncate text-[13px] text-ink-secondary">{group?.name ?? joined?.state?.roomName}</div>
        {code && <RoomCode {...code} />}
        {codeChanged && <p role="status" className="mt-2 text-[12.5px] text-ink-secondary">{t("teamRoom.codeChanged")}</p>}
        {problem && <p role="alert" className="mt-2 text-[12.5px] text-danger">{t(problem)}</p>}
        <ul className="mt-3 flex flex-col gap-0.5" aria-label={t("teamRoom.people")}>
          {group ? <RoomOwnName name={state.config?.profile?.name || t("teamRoom.host")} /> : (
            <li className="flex items-center gap-2 px-2 py-1.5"><span className="min-w-0 flex-1 truncate text-[14px] text-ink">{joined?.state?.host}</span><span className="text-[12px] text-ink-secondary">{t("teamRoom.host")}</span></li>
          )}
          {people.map((person) => (
            person.id === joined?.me.id ? <RoomOwnName key={person.id} name={person.name} /> : <li key={person.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-raised/50">
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{person.name}</span>
              {group && <button
                type="button"
                onClick={() => setRemoving(person)}
                aria-label={t("teamRoom.removeNamed", { name: person.name })}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
              >
                {t("teamRoom.remove")}
              </button>}
            </li>
          ))}
          {people.length === 0 && <li className="px-2 py-1.5 text-[13px] text-ink-secondary">{t("teamRoom.nobody")}</li>}
          {removed.map((person) => (
            <li key={person.id} data-room-removed className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-raised/50">
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink-secondary">{person.name}</span>
              <button
                type="button"
                onClick={() => void letBack(person.id)}
                aria-label={t("teamRoom.letBackNamed", { name: person.name })}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-accent hover:bg-raised"
              >
                {t("teamRoom.letBack")}
              </button>
            </li>
          ))}
        </ul>
        {group && roomId && <TeammateBots roomId={roomId} bots={roomTeamBots(group)} people={people} onProblem={() => setProblem("errors.request")} />}
        {joined?.status === "joined" && joined.state?.teamBots && <MyRoomBots room={joined} onProblem={() => setProblem("errors.request")} />}
      </div>
      {confirm.mounted && confirm.value && (
        <ConfirmDialog
          closing={confirm.closing}
          title={t("teamRoom.removeTitle", { name: confirm.value.name })}
          body={t("teamRoom.removeBody")}
          confirmLabel={t("teamRoom.remove")}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            setRemoving(null);
            void remove(confirm.value!);
          }}
        />
      )}
    </div>
  );
}
