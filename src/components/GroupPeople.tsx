// People in a group: Members' Invite, code and list; the header's faces; the chat's join lines.
import { useEffect, useRef, useState } from "react";
import { UserPlus } from "lucide-react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { removeFromRoom, roomPeople, shareErrorKey, shareGroup, type RoomInviteCode } from "@/lib/team-rooms";
import { useStore, type Group } from "@/state/store";

import { InitialsAvatar, profileInitials } from "./Avatar";
import { RoomCode } from "./RoomCode";

export function GroupPeople({ group }: { group: Group }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const shared = Boolean(group.hosted && group.room && "people" in group.room);
  const [code, setCode] = useState<RoomInviteCode | null>(null);
  const [busy, setBusy] = useState(shared);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const alive = useRef(true);
  const people = roomPeople(group);

  const invite = async () => {
    setBusy(true);
    setProblem(null);
    const result = await shareGroup(group.id);
    if (!alive.current) return;
    setBusy(false);
    if (!("code" in result)) return setProblem(shareErrorKey(result));
    setCode({ code: result.code, short: result.short });
    dispatch({ type: "groupPatched", group: result.group });
  };

  // A group that is already shared shows its code on open; a missing room waits for Invite.
  useEffect(() => {
    alive.current = true;
    if (shared) void invite();
    return () => {
      alive.current = false;
    };
  }, [group.id, shared]);

  const remove = async (personId: string) => {
    if (!group.hosted) return;
    try {
      await removeFromRoom(group.hosted.roomId, personId);
    } catch {
      return setProblem("errors.request");
    }
    if (!alive.current) return;
    // Remove retires the old code.
    setCode(null);
    void invite();
  };

  return (
    <section data-group-people aria-label={t("teamRoom.people")} className="mb-3">
      <div className="mb-1.5 px-3 text-[12.5px] font-medium text-ink-secondary">{t("teamRoom.people")}</div>
      {code ? <RoomCode {...code} /> : (
        <button
          type="button"
          data-group-invite
          onClick={() => void invite()}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-accent hover:bg-raised/50 disabled:opacity-40"
        >
          <UserPlus size={15} />
          {t("teamRoom.invite")}
        </button>
      )}
      {problem && <p role="alert" className="mt-1 px-3 text-[12.5px] text-danger">{t(problem)}</p>}
      {people.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5" aria-label={t("teamRoom.people")}>
          {people.map((person) => (
            <li key={person.id} className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 hover:bg-raised/50">
              <InitialsAvatar initials={profileInitials({ name: person.name })} size={24} />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{person.name}</span>
              <button
                type="button"
                onClick={() => void remove(person.id)}
                aria-label={t("teamRoom.removeNamed", { name: person.name })}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
              >
                {t("teamRoom.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const FACES = 3;

/** The header's people, after the bots: a few initials, then a count. */
export function GroupPeopleFaces({ group }: { group: Group }) {
  const people = roomPeople(group);
  if (!people.length) return null;
  const more = people.length - FACES;
  return (
    <span data-group-people-faces className="flex shrink-0 items-center -space-x-1.5" title={people.map((person) => person.name).join(", ")}>
      {people.slice(0, FACES).map((person) => (
        <span key={person.id} className="rounded-full ring-2 ring-app">
          <InitialsAvatar initials={profileInitials({ name: person.name })} size={24} />
        </span>
      ))}
      {more > 0 && <span className="pl-2.5 text-[12px] tabular-nums text-ink-secondary">+{more}</span>}
    </span>
  );
}

export function RoomJoinLine({ name }: { name: string }) {
  const { t } = useI18n();
  return <div data-room-join className="py-2 text-center text-[12px] text-ink-secondary">{t("room.joined", { name })}</div>;
}

/** A teammate's name over their lines, the way a bot's name sits over its own. */
export function PersonLabel({ name }: { name: string }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 pl-0.5">
      <InitialsAvatar initials={profileInitials({ name })} size={16} />
      <span className="text-[11px] font-medium text-ink-secondary">{name}</span>
    </div>
  );
}
