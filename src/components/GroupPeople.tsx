// People in a group: the header's faces and the chat's join lines.
import { useI18n } from "@/lib/i18n";
import { roomPeople } from "@/lib/team-rooms";
import type { Group } from "@/state/store";

import { InitialsAvatar, profileInitials } from "./Avatar";

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
