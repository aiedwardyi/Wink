// Room details' People: the code and Remove for the host, the list for everyone.
import { useEffect, useRef, useState } from "react";
import { UserPlus } from "lucide-react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { inviteErrorKey, inviteToRoom, isTeamRoom, letBackIn, removeFromRoom, roomPeople, roomRemoved, shareErrorKey, shareGroup, type JoinedView, type RoomInviteCode } from "@/lib/team-rooms";
import { usePresence } from "@/lib/use-presence";
import { useStore, type Group } from "@/state/store";

import { InitialsAvatar, profileInitials } from "./Avatar";
import { DETAILS_BOX, DETAILS_ROW } from "./BotDetailsRows";
import { ConfirmDialog } from "./ConfirmDialog";
import { RoomCode } from "./RoomCode";
import { RoomOwnName } from "./RoomOwnName";

type Coded = RoomInviteCode | { problem: MessageKey };

export function HostPeople({ group }: { group: Group }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const teamRoom = isTeamRoom(group);
  const shared = Boolean(group.hosted && group.room && "people" in group.room);
  const [code, setCode] = useState<RoomInviteCode | null>(null);
  const [busy, setBusy] = useState(shared);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [codeChanged, setCodeChanged] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const confirm = usePresence(removing);
  const alive = useRef(true);
  const sharedHere = useRef(false);
  const people = roomPeople(group);
  const removed = roomRemoved(group);

  const fetchCode = async (): Promise<Coded> => {
    if (teamRoom) {
      const result = await inviteToRoom(group.hosted.roomId);
      return "code" in result ? result : { problem: inviteErrorKey(result.status) };
    }
    const result = await shareGroup(group.id);
    if (!("code" in result)) return { problem: shareErrorKey(result) };
    sharedHere.current = !shared;
    dispatch({ type: "groupPatched", group: result.group });
    return { code: result.code, short: result.short };
  };

  // Phone Access off says so only after a tap on Invite, never on open.
  const invite = async (tapped: boolean) => {
    setBusy(true);
    setProblem(null);
    const result = await fetchCode();
    if (!alive.current) return;
    setBusy(false);
    if ("problem" in result) return void (tapped && setProblem(result.problem));
    setCode({ code: result.code, short: result.short });
  };

  useEffect(() => {
    alive.current = true;
    // the tap that shared this group already holds its code
    if (!sharedHere.current) {
      setCode(null);
      if (shared) void invite(false);
    }
    sharedHere.current = false;
    return () => {
      alive.current = false;
    };
  }, [group.id, shared]);

  const remove = async (gone: { id: string; name: string }) => {
    if (!group.hosted) return;
    let result: Awaited<ReturnType<typeof removeFromRoom>>;
    try {
      result = await removeFromRoom(group.hosted.roomId, gone.id);
    } catch {
      return setProblem("errors.request");
    }
    if (!alive.current) return;
    if (result.codeChanged) setCodeChanged(true);
    // A retired code bars no one, so only a kept code lists them under Let back in.
    const barred = [...removed.filter((person) => person.id !== gone.id), ...(result.codeChanged ? [] : [gone])];
    if (group.room && "people" in group.room) dispatch({ type: "groupPatched", group: { id: group.id, room: { ...group.room, people: group.room.people.filter((person) => person.id !== gone.id), removed: barred } } });
    setCode(null);
    void invite(false);
  };

  const letBack = async (personId: string) => {
    if (!group.hosted) return;
    try {
      await letBackIn(group.hosted.roomId, personId);
    } catch {
      return setProblem("errors.request");
    }
    if (group.room && "people" in group.room) dispatch({ type: "groupPatched", group: { id: group.id, room: { ...group.room, removed: removed.filter((person) => person.id !== personId) } } });
  };

  return (
    <>
      <ul className={DETAILS_BOX} aria-label={t("teamRoom.people")}>
        <RoomOwnName name={state.config?.profile?.name || t("teamRoom.host")} />
        {people.map((person) => (
          <PersonRow key={person.id} name={person.name}>
            <button
              type="button"
              onClick={() => setRemoving(person)}
              aria-label={t("teamRoom.removeNamed", { name: person.name })}
              className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
            >
              {t("teamRoom.remove")}
            </button>
          </PersonRow>
        ))}
        {shared && people.length === 0 && <li className={`${DETAILS_ROW} text-[13px] text-ink-secondary`}>{t("teamRoom.nobody")}</li>}
        {removed.map((person) => (
          <PersonRow key={person.id} name={person.name} gone>
            <button
              type="button"
              onClick={() => void letBack(person.id)}
              aria-label={t("teamRoom.letBackNamed", { name: person.name })}
              className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-accent hover:bg-raised"
            >
              {t("teamRoom.letBack")}
            </button>
          </PersonRow>
        ))}
        {!code && !(shared && busy) && (
          <li className={DETAILS_ROW}>
            <button
              type="button"
              data-group-invite
              onClick={() => void invite(true)}
              disabled={busy}
              className="flex w-full items-center gap-2.5 text-left text-[14px] font-medium text-accent hover:brightness-110 disabled:opacity-40"
            >
              <UserPlus size={18} />
              {t("teamRoom.invite")}
            </button>
          </li>
        )}
      </ul>
      {code && <div className="mt-3"><RoomCode key={code.code} {...code} /></div>}
      {codeChanged && <p role="status" className="mt-1 px-3 text-[12.5px] text-ink-secondary">{t("teamRoom.codeChanged")}</p>}
      {problem && <p role="alert" className="mt-1 px-3 text-[12.5px] text-danger">{t(problem)}</p>}
      {problem === "teamRoom.phoneOff" && <button type="button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "companion" })} className="mt-1 px-3 text-[12.5px] font-medium text-accent hover:underline">{t("teamRoom.openPhoneAccess")}</button>}
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
    </>
  );
}

export function JoinedPeople({ room }: { room: JoinedView }) {
  const { t } = useI18n();
  const people = room.state?.people ?? [];
  return (
    <ul className={DETAILS_BOX} aria-label={t("teamRoom.people")}>
      <PersonRow name={room.state?.host ?? ""}>
        <span className="shrink-0 text-[12px] text-ink-secondary">{t("teamRoom.host")}</span>
      </PersonRow>
      {people.map((person) => person.id === room.me.id ? <RoomOwnName key={person.id} name={person.name} /> : <PersonRow key={person.id} name={person.name} />)}
    </ul>
  );
}

function PersonRow({ name, gone = false, children }: { name: string; gone?: boolean; children?: React.ReactNode }) {
  return (
    <li data-room-removed={gone || undefined} className={`${DETAILS_ROW} flex items-center gap-2.5 py-2`}>
      <InitialsAvatar initials={profileInitials({ name })} size={24} tone="bg-control" />
      <span className={`min-w-0 flex-1 truncate text-[14px] ${gone ? "text-ink-secondary" : "text-ink"}`}>{name}</span>
      {children}
    </li>
  );
}
