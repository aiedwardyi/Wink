// People can edit their own Wink name; the host also has Invite and Remove.
import { useEffect, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { inviteErrorKey, inviteToRoom, removeFromRoom, roomPeople, type JoinedView, type RoomInviteCode, type TeamRoom } from "@/lib/team-rooms";
import { useBackLayer } from "@/lib/use-back-layer";
import { useStore } from "@/state/store";

import { RoomCode } from "./RoomCode";
import { RoomOwnName } from "./RoomOwnName";

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const roomId = group?.hosted.roomId;
  const people = group ? roomPeople(group) : joined?.state?.people ?? [];
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

  const remove = async (personId: string) => {
    const room = group?.room && "people" in group.room ? group.room : null;
    if (!room || !group || !roomId) return;
    try {
      await removeFromRoom(roomId, personId);
      setCodeVersion((version) => version + 1);
      dispatch({ type: "groupPatched", group: { id: group.id, room: { ...room, people: room.people.filter((person) => person.id !== personId) } } });
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
                onClick={() => void remove(person.id)}
                aria-label={t("teamRoom.removeNamed", { name: person.name })}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
              >
                {t("teamRoom.remove")}
              </button>}
            </li>
          ))}
          {people.length === 0 && <li className="px-2 py-1.5 text-[13px] text-ink-secondary">{t("teamRoom.nobody")}</li>}
        </ul>
      </div>
    </div>
  );
}
