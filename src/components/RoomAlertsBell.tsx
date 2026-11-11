// One room's alerts on this device. Desktop toasts need no push; on a phone the first turn-on asks for push permission.
import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { setRoomAlerts, useRoomAlertsOn } from "@/lib/room-alerts";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { enableWebPush, readWebPushState, syncWebPushRooms, webPushSupported, type WebPushState } from "@/lib/web-push";

export function RoomAlertsBell({ chat }: { chat: string }) {
  const { t } = useI18n();
  const wanted = useRoomAlertsOn(chat);
  const pushable = useIsPhone() && webPushSupported();
  const [push, setPush] = useState<WebPushState | null>(null);
  useEffect(() => {
    if (pushable) void readWebPushState().then(setPush).catch(() => {});
    else setPush(null);
  }, [pushable]);
  const on = wanted && (push === null || push === "on");
  const toggle = () => {
    setRoomAlerts(chat, !on);
    if (push === "off" || push === "blocked") void enableWebPush().then(setPush).catch(() => {});
    else if (pushable) void syncWebPushRooms().catch(() => {});
  };
  const label = t(on ? "teamRoom.alertsOff" : "teamRoom.alertsOn");
  return (
    <button
      type="button"
      data-room-bell={on ? "on" : "off"}
      onClick={toggle}
      aria-label={label}
      title={label}
      className="flex shrink-0 items-center rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"
    >
      {on ? <Bell size={18} /> : <BellOff size={18} />}
    </button>
  );
}
