// One room's alerts on this device. Desktop toasts need no push; on a phone the first turn-on asks for push permission.
import { useEffect, useRef, useState } from "react";
import { Bell, BellOff } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { fallbackError } from "@/lib/error-text";
import { setRoomAlerts, useRoomAlertsOn } from "@/lib/room-alerts";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { enableWebPush, readWebPushState, syncWebPushRooms, webPushSupported, type WebPushState } from "@/lib/web-push";
import { useStore } from "@/state/store";

export function useRoomAlerts(chat: string) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const wanted = useRoomAlertsOn(chat);
  const pushable = useIsPhone() && webPushSupported();
  const [push, setPush] = useState<WebPushState | null>(null);
  const [enabling, setEnabling] = useState(false);
  const version = useRef(0);
  const pending = useRef<Promise<WebPushState> | null>(null);
  const note = useRef<string | null>(null);
  useEffect(() => {
    const current = ++version.current;
    setPush(null);
    setEnabling(false);
    if (pushable) void readWebPushState().then((next) => {
      if (version.current === current) setPush(next);
    }).catch(() => {});
    return () => { version.current++; };
  }, [chat, pushable]);
  const on = wanted && (enabling || push === null || push === "on");
  const toggle = () => {
    if (note.current && state.error === note.current) dispatch({ type: "error", message: null });
    note.current = null;
    const current = ++version.current;
    const next = !on;
    setRoomAlerts(chat, next);
    setEnabling(next && pushable && push !== "on");
    if (next && pushable && push !== "on") {
      const settle = (state: WebPushState, cause?: unknown) => {
        // A denied permission can resolve before the optimistic bell has painted.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (version.current !== current) return;
          setPush(state);
          setEnabling(false);
          if (state === "on") return;
          setRoomAlerts(chat, false);
          const message = state === "blocked" ? t("settings.phoneNotifications.state.blocked")
            : state === "unsupported" ? t("settings.phoneNotifications.state.unsupported")
            : fallbackError(cause, t("settings.phoneNotifications.enableError"));
          note.current = message;
          dispatch({ type: "error", message });
        }));
      };
      pending.current ??= enableWebPush().finally(() => { pending.current = null; });
      void pending.current.then((state) => {
        if (state === "on") void syncWebPushRooms().catch(() => {});
        settle(state);
      }, (cause) => settle("off", cause));
    } else if (pushable) void syncWebPushRooms().catch(() => {});
  };
  return { on, toggle };
}

export function RoomAlertsBell({ chat }: { chat: string }) {
  const { t } = useI18n();
  const { on, toggle } = useRoomAlerts(chat);
  // Touch browsers can keep :active briefly after release.
  const [pressed, setPressed] = useState(false);
  const label = t(on ? "teamRoom.alertsOff" : "teamRoom.alertsOn");
  return (
    <button
      type="button"
      data-room-bell={on ? "on" : "off"}
      data-down={pressed || undefined}
      onClick={toggle}
      onPointerDown={(event) => { if (event.pointerType !== "mouse") setPressed(true); }}
      onPointerUp={() => setPressed(false)}
      onPointerCancel={() => setPressed(false)}
      onPointerLeave={() => setPressed(false)}
      aria-pressed={on}
      aria-label={label}
      title={label}
      className="flex shrink-0 items-center rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink data-[down]:bg-raised data-[down]:text-ink"
    >
      {on ? <Bell size={18} /> : <BellOff size={18} />}
    </button>
  );
}
