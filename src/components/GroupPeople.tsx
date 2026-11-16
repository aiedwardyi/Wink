// People in a group: the chat's join lines and names.
import { useI18n } from "@/lib/i18n";

import { InitialsAvatar, profileInitials } from "./Avatar";

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
